/**
 * Reclaim Vercel Blob quota:
 *  1) leftover audio on lectures that already finished (or finished ASR)
 *  2) study HTML blobs when a real PDF exists (HTML can be regenerated)
 *  3) superseded study PDFs (older done jobs for the same lecture+density)
 *  4) orphan blobs not referenced by the DB
 *
 * Call runBlobGc from admin/cron. After each PDF write, pruneSupersededStudyBlobs
 * (scoped to that lecture) + releaseStudyBlobs on replace keep quota from climbing.
 */
import { list, del } from "@vercel/blob";
import { eq, and, isNotNull, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { deleteFileUrl } from "./storage";
import { parseDensity, type Density } from "./providers/types";

const fmt = (n: number) => Math.round((n / (1024 * 1024)) * 10) / 10;

function norm(u: string) { return u.split("?")[0]; }

/** Best-effort delete of study PDF/HTML URLs (deduped). */
export async function releaseStudyBlobs(a: { pdf?: string | null; html?: string | null }) {
  const urls = [...new Set([a.pdf, a.html].filter((u): u is string => !!u && u.length > 0))];
  await Promise.all(urls.map((u) => deleteFileUrl(u).catch(() => {})));
}

async function allBlobUrls(): Promise<{ url: string; size: number; pathname: string }[]> {
  const out: { url: string; size: number; pathname: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ cursor, limit: 1000 });
    for (const b of page.blobs) out.push({ url: b.url, size: b.size || 0, pathname: b.pathname || "" });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

function jobDensityOf(artifacts: string): Density {
  try {
    const a = JSON.parse(artifacts || "{}") as { options?: { density?: string }; summary?: unknown };
    return parseDensity(a.options?.density) ?? (a.summary && !a.options?.density ? "detailed" : "standard");
  } catch {
    return "standard";
  }
}

/** Pure: among done jobs, which ids are older than the newest per (lectureId, density)? */
export function supersededJobIds(
  jobs: { id: string; lectureId: string; updatedAt: number; artifacts: string }[],
): string[] {
  const byKey = new Map<string, { id: string; updatedAt: number }[]>();
  for (const r of jobs) {
    const key = `${r.lectureId}:${jobDensityOf(r.artifacts)}`;
    const list = byKey.get(key) ?? [];
    list.push({ id: r.id, updatedAt: r.updatedAt });
    byKey.set(key, list);
  }
  const out: string[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of group.slice(1)) out.push(old.id);
  }
  return out;
}

export type BlobGcReport = {
  dryRun: boolean;
  store?: { files: number; mb: number };
  deleted: { audio: number; html: number; superseded: number; orphans: number };
  failed: number;
  freedMb: number;
  details?: string[];
};

/**
 * Keep the newest done job's study PDF per (lectureId, density); delete older done jobs' pdf/html
 * and clear those artifact fields so orphan GC (and the DB) stay honest.
 */
export async function pruneSupersededStudyBlobs(opts: {
  lectureId?: string;
  dryRun?: boolean;
} = {}): Promise<{ deleted: number; failed: number; freedMb: number; details: string[] }> {
  const dryRun = !!opts.dryRun;
  const details: string[] = [];
  let deleted = 0, failed = 0, freed = 0;

  const rows = opts.lectureId
    ? await db.select().from(schema.jobs).where(and(eq(schema.jobs.lectureId, opts.lectureId), eq(schema.jobs.stage, "done")))
    : await db.select().from(schema.jobs).where(eq(schema.jobs.stage, "done"));

  const dropIds = new Set(supersededJobIds(rows));
  for (const old of rows) {
    if (!dropIds.has(old.id)) continue;
    let a: { pdf?: string; html?: string };
    try { a = JSON.parse(old.artifacts || "{}"); } catch { continue; }
    const urls = [...new Set([a.pdf, a.html].filter((u): u is string => !!u))];
    if (!urls.length) continue;
    details.push(`superseded job ${old.id.slice(0, 8)} ×${urls.length}`);
    if (dryRun) { deleted += urls.length; continue; }
    for (const u of urls) {
      try { await deleteFileUrl(u); deleted++; }
      catch (e) { failed++; details.push(`superseded-fail ${(e as Error).message}`); }
    }
    try {
      const fresh = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, old.id) });
      if (!fresh) continue;
      const next = JSON.parse(fresh.artifacts || "{}") as { pdf?: string; html?: string };
      delete next.pdf; delete next.html;
      await db.update(schema.jobs).set({ artifacts: JSON.stringify(next) }).where(eq(schema.jobs.id, old.id));
    } catch (e) { failed++; details.push(`superseded-db ${(e as Error).message}`); }
  }

  return { deleted, failed, freedMb: fmt(freed), details };
}

export async function runBlobGc(opts: { dryRun?: boolean; orphans?: boolean } = {}): Promise<BlobGcReport> {
  const dryRun = !!opts.dryRun;
  const wantOrphans = opts.orphans !== false;
  const details: string[] = [];
  let freed = 0, failed = 0;
  const deleted = { audio: 0, html: 0, superseded: 0, orphans: 0 };

  const doneIds = new Set(
    (await db.select({ id: schema.jobs.lectureId }).from(schema.jobs).where(eq(schema.jobs.stage, "done")))
      .map((r) => r.id),
  );

  // Lectures whose ASR finished (asrComplete) — audio is no longer needed even if PDF failed.
  const asrDoneJobs = await db.select({ lectureId: schema.jobs.lectureId, artifacts: schema.jobs.artifacts }).from(schema.jobs);
  const asrCompleteIds = new Set<string>();
  for (const j of asrDoneJobs) {
    try {
      const a = JSON.parse(j.artifacts || "{}") as { asrComplete?: boolean; slidesOnly?: boolean };
      if (a.asrComplete || a.slidesOnly || doneIds.has(j.lectureId)) asrCompleteIds.add(j.lectureId);
    } catch { /* ignore */ }
  }

  const audioTargets: { url: string; clear: () => Promise<void> }[] = [];
  const segs = await db.select().from(schema.segments).where(and(isNotNull(schema.segments.url), ne(schema.segments.url, "")));
  for (const s of segs) {
    if (!s.url || !asrCompleteIds.has(s.lectureId)) continue;
    if (!s.url.includes("blob.vercel-storage.com") && !s.url.startsWith("local:")) continue;
    audioTargets.push({
      url: s.url,
      clear: async () => { await db.update(schema.segments).set({ url: null }).where(eq(schema.segments.id, s.id)); },
    });
  }
  const lecs = await db.select().from(schema.lectures).where(and(isNotNull(schema.lectures.audioUrl), ne(schema.lectures.audioUrl, "")));
  for (const l of lecs) {
    if (!l.audioUrl || !asrCompleteIds.has(l.id)) continue;
    if (!l.audioUrl.includes("blob.vercel-storage.com") && !l.audioUrl.startsWith("local:")) continue;
    audioTargets.push({
      url: l.audioUrl,
      clear: async () => { await db.update(schema.lectures).set({ audioUrl: null }).where(eq(schema.lectures.id, l.id)); },
    });
  }

  // Prefer list() sizes when available so we can free accurately without per-URL head().
  let blobs: { url: string; size: number; pathname: string }[] = [];
  const sizeByUrl = new Map<string, number>();
  if (wantOrphans && process.env.BLOB_READ_WRITE_TOKEN) {
    blobs = await allBlobUrls();
    for (const b of blobs) sizeByUrl.set(norm(b.url), b.size);
  }

  const seenAudio = new Set<string>();
  for (const t of audioTargets) {
    const key = norm(t.url);
    if (seenAudio.has(key)) { if (!dryRun) await t.clear(); continue; }
    seenAudio.add(key);
    const sz = sizeByUrl.get(key) || 0;
    details.push(`audio ${fmt(sz)}MB ${key.slice(-40)}`);
    if (!dryRun) {
      try { await deleteFileUrl(t.url); await t.clear(); deleted.audio++; freed += sz; }
      catch (e) { failed++; details.push(`audio-fail ${(e as Error).message}`); }
    } else { deleted.audio++; freed += sz; }
  }

  const htmlTargets: { jobId: string; html: string }[] = [];
  const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.stage, "done"));
  for (const job of jobs) {
    let a: { pdf?: string; html?: string };
    try { a = JSON.parse(job.artifacts || "{}"); } catch { continue; }
    if (!a.pdf || !a.html || a.pdf === a.html) continue;
    if (a.pdf.endsWith(".html")) continue;
    if (!a.html.includes("blob.vercel-storage.com") && !a.html.startsWith("local:")) continue;
    htmlTargets.push({ jobId: job.id, html: a.html });
  }
  const seenHtml = new Set<string>();
  for (const t of htmlTargets) {
    const key = norm(t.html);
    if (seenHtml.has(key)) continue;
    seenHtml.add(key);
    const sz = sizeByUrl.get(key) || 0;
    details.push(`html ${fmt(sz)}MB ${key.slice(-40)}`);
    if (!dryRun) {
      try {
        await deleteFileUrl(t.html);
        const row = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, t.jobId) });
        if (row) {
          const a = JSON.parse(row.artifacts || "{}");
          if (a.html && norm(a.html) === key) { delete a.html; await db.update(schema.jobs).set({ artifacts: JSON.stringify(a) }).where(eq(schema.jobs.id, t.jobId)); }
        }
        deleted.html++; freed += sz;
      } catch (e) { failed++; details.push(`html-fail ${(e as Error).message}`); }
    } else { deleted.html++; freed += sz; }
  }

  const pruned = await pruneSupersededStudyBlobs({ dryRun });
  deleted.superseded = pruned.deleted;
  failed += pruned.failed;
  details.push(...pruned.details.slice(0, 20));

  let store: BlobGcReport["store"];
  if (blobs.length) {
    store = { files: blobs.length, mb: fmt(blobs.reduce((s, b) => s + b.size, 0)) };

    const referenced = new Set<string>();
    const add = (u?: string | null) => { if (u?.startsWith("http")) referenced.add(norm(u)); };
    for (const l of await db.select().from(schema.lectures)) { add(l.audioUrl); add(l.slidesUrl); }
    for (const s of await db.select().from(schema.segments)) add(s.url);
    for (const f of await db.select().from(schema.lectureFiles)) add(f.url);
    for (const f of await db.select().from(schema.courseFiles)) add(f.url);
    for (const c of await db.select().from(schema.courses)) {
      add(c.contextPdfUrl);
      add((c as { examPdfUrl?: string | null }).examPdfUrl);
      add((c as { examJsonUrl?: string | null }).examJsonUrl);
    }
    for (const j of await db.select().from(schema.jobs)) {
      try { const a = JSON.parse(j.artifacts || "{}"); add(a.pdf); add(a.html); } catch { /* ignore */ }
    }
    // Don't treat URLs we're about to delete as referenced for orphan calc after audio/html pass.
    for (const u of seenAudio) referenced.delete(u);
    for (const u of seenHtml) referenced.delete(u);

    // Skip URLs already counted/deleted as leftover audio or redundant HTML.
    const orphans = blobs.filter((b) => {
      const u = norm(b.url);
      return !referenced.has(u) && !seenAudio.has(u) && !seenHtml.has(u);
    });
    if (orphans.length) {
      details.push(`orphans ${orphans.length} (~${fmt(orphans.reduce((s, b) => s + b.size, 0))}MB)`);
      if (!dryRun) {
        const BATCH = 40;
        for (let i = 0; i < orphans.length; i += BATCH) {
          const batch = orphans.slice(i, i + BATCH);
          try {
            await del(batch.map((b) => b.url));
            deleted.orphans += batch.length;
            freed += batch.reduce((s, b) => s + b.size, 0);
          } catch {
            for (const b of batch) {
              try { await del(b.url); deleted.orphans++; freed += b.size; }
              catch (e) { failed++; details.push(`orphan-fail ${(e as Error).message}`); }
            }
          }
        }
      } else {
        deleted.orphans = orphans.length;
        freed += orphans.reduce((s, b) => s + b.size, 0);
      }
    }
  }

  return { dryRun, store, deleted, failed, freedMb: fmt(freed), details: details.slice(0, 40) };
}

/** Fire-and-forget lecture-scoped prune after a PDF write (BLOB_AUTO_GC=0 to disable). */
export function scheduleLectureBlobHygiene(lectureId: string) {
  if (process.env.BLOB_AUTO_GC === "0") return;
  void pruneSupersededStudyBlobs({ lectureId }).catch((e) =>
    console.warn("auto lecture blob prune:", (e as Error).message),
  );
}
