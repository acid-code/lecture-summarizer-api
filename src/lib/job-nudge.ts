/**
 * Periodic recovery for soft-held / stuck jobs.
 * Safe defaults: probe Blob before clearing capacity holds, advance few jobs per tick,
 * at most one pdf stage, skip busy leases, drop superseded density orphans.
 */
import { put, del } from "@vercel/blob";
import { and, inArray, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  advanceJob,
  isBlobCapacityError,
  jobDensity,
  retryJob,
  RUN_LEASE_MS,
  STUCK_MS,
  type Artifacts,
} from "./pipeline";
import { parseDensity, type Density } from "./providers/types";

export type NudgeCandidate = {
  id: string;
  lectureId: string;
  stage: string;
  updatedAt: number;
  density: Density | null;
  blobHold: boolean;
  holdUntil: number | null;
  busy: boolean;
  stuck: boolean;
  superseded: boolean;
};

export type JobNudgeReport = {
  dryRun: boolean;
  blobWritable: boolean | null;
  scanned: number;
  superseded: string[];
  advanced: string[];
  retried: string[];
  skipped: { id: string; reason: string }[];
  errors: { id: string; error: string }[];
};

const BLOB_HOLD_RE = /Blob storage suspended|blob capacity|store has been suspended/i;

export function isBlobHoldArtifacts(a: Artifacts, now = Date.now()): boolean {
  if (a.blobHold) return true;
  if (a.progressDetail?.label && BLOB_HOLD_RE.test(a.progressDetail.label)) return true;
  // Legacy rows may only have holdUntil from a blob capacity catch (no overloadHolds).
  return !!(a.holdUntil && a.holdUntil > now && !a.overloadHolds);
}

export function pickNudgeBatch(
  candidates: NudgeCandidate[],
  opts: { maxAdvance?: number; now?: number } = {},
): { advance: NudgeCandidate[]; supersede: NudgeCandidate[]; skip: { c: NudgeCandidate; reason: string }[] } {
  const maxAdvance = Math.max(1, opts.maxAdvance ?? Number(process.env.JOB_NUDGE_MAX || 3));
  const now = opts.now ?? Date.now();
  const advance: NudgeCandidate[] = [];
  const supersede: NudgeCandidate[] = [];
  const skip: { c: NudgeCandidate; reason: string }[] = [];
  let pdfTaken = false;

  for (const c of candidates) {
    if (c.superseded) {
      supersede.push(c);
      continue;
    }
    if (c.busy) {
      skip.push({ c, reason: "busy" });
      continue;
    }
    if (c.holdUntil && c.holdUntil > now && !c.blobHold) {
      skip.push({ c, reason: "gemini_hold" });
      continue;
    }
    // Blob-held jobs are only eligible when the caller already confirmed writes work (or dry-run listing).
    if (c.stage === "pdf") {
      if (pdfTaken) {
        skip.push({ c, reason: "pdf_limit" });
        continue;
      }
      pdfTaken = true;
    }
    if (advance.length >= maxAdvance) {
      skip.push({ c, reason: "batch_full" });
      continue;
    }
    advance.push(c);
  }
  return { advance, supersede, skip };
}

/** Prefer oldest blob-held / stuck work; keep one job per lecture when possible. */
export function rankNudgeCandidates(rows: NudgeCandidate[]): NudgeCandidate[] {
  const byLecture = new Map<string, NudgeCandidate>();
  const sorted = [...rows].sort((a, b) => {
    if (a.blobHold !== b.blobHold) return a.blobHold ? -1 : 1;
    if (a.stuck !== b.stuck) return a.stuck ? -1 : 1;
    return a.updatedAt - b.updatedAt;
  });
  const out: NudgeCandidate[] = [];
  for (const c of sorted) {
    if (c.superseded) {
      out.push(c);
      continue;
    }
    if (byLecture.has(c.lectureId)) continue;
    byLecture.set(c.lectureId, c);
    out.push(c);
  }
  // Append remaining superseded-only leftovers already pushed; also add non-picked for supersede scan.
  for (const c of sorted) {
    if (c.superseded && !out.includes(c)) out.push(c);
  }
  return out;
}

export async function probeBlobWritable(): Promise<boolean | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  const pathname = `artifacts/nudge-probe-${Date.now()}.txt`;
  try {
    const blob = await put(pathname, "ok", {
      access: "private",
      token,
      contentType: "text/plain",
      addRandomSuffix: true,
    });
    await del(blob.url, { token });
    return true;
  } catch (e) {
    if (isBlobCapacityError(e)) return false;
    // Auth / transient errors: don't clear blob holds blindly.
    console.warn("blob probe inconclusive:", (e as Error).message);
    return false;
  }
}

function parseArtifacts(raw: string): Artifacts {
  try {
    return JSON.parse(raw || "{}") as Artifacts;
  } catch {
    return {};
  }
}

function densityOf(a: Artifacts): Density | null {
  try {
    return jobDensity(a);
  } catch {
    return parseDensity(a.options?.density) ?? null;
  }
}

export async function runJobNudge(opts: { dryRun?: boolean; forceBlob?: boolean } = {}): Promise<JobNudgeReport> {
  const dryRun = !!opts.dryRun;
  const now = Date.now();
  const blobWritable = opts.forceBlob ? true : await probeBlobWritable();

  const open = await db
    .select()
    .from(schema.jobs)
    .where(and(ne(schema.jobs.stage, "done"), ne(schema.jobs.stage, "failed")))
    .orderBy(schema.jobs.updatedAt)
    .limit(Math.max(20, Number(process.env.JOB_NUDGE_SCAN || 80)));

  // Newest done timestamp per lecture+density — orphan open jobs older than that are superseded.
  const lectureIds = [...new Set(open.map((r) => r.lectureId))];
  const doneNewest = new Map<string, number>();
  if (lectureIds.length) {
    const doneRows = await db
      .select({
        lectureId: schema.jobs.lectureId,
        artifacts: schema.jobs.artifacts,
        updatedAt: schema.jobs.updatedAt,
      })
      .from(schema.jobs)
      .where(and(inArray(schema.jobs.lectureId, lectureIds), sql`${schema.jobs.stage} = 'done'`));
    for (const r of doneRows) {
      const d = densityOf(parseArtifacts(r.artifacts));
      if (!d) continue;
      const key = `${r.lectureId}:${d}`;
      const prev = doneNewest.get(key) ?? 0;
      if (r.updatedAt > prev) doneNewest.set(key, r.updatedAt);
    }
  }

  const built: { c: NudgeCandidate; eligible: boolean }[] = open.map((row) => {
    const a = parseArtifacts(row.artifacts);
    const density = densityOf(a);
    const doneAt = density ? doneNewest.get(`${row.lectureId}:${density}`) : undefined;
    const superseded = doneAt != null && row.updatedAt < doneAt;
    const blobHold = isBlobHoldArtifacts(a, now);
    const holdUntil = a.holdUntil && a.holdUntil > now ? a.holdUntil : null;
    const leaseBusy = !!(a.run && a.run.stage === row.stage && now - a.run.at < RUN_LEASE_MS && row.updatedAt <= a.run.at);
    const stuck = now - row.updatedAt > STUCK_MS;
    const holdExpired = !!(a.holdUntil && a.holdUntil <= now);
    const eligible =
      superseded ||
      stuck ||
      holdExpired ||
      (blobHold && blobWritable !== false);
    const c: NudgeCandidate = {
      id: row.id,
      lectureId: row.lectureId,
      stage: row.stage,
      updatedAt: row.updatedAt,
      density,
      blobHold,
      holdUntil,
      busy: leaseBusy,
      stuck,
      superseded,
    };
    return { c, eligible };
  });

  const eligible = built.filter((x) => x.eligible).map((x) => x.c);
  // If blob is known unwritable, drop blob-held from advance (still supersede orphans).
  const filtered =
    blobWritable === false
      ? eligible.filter((c) => c.superseded || (!c.blobHold && c.stuck))
      : eligible;

  const ranked = rankNudgeCandidates(filtered);
  const { advance, supersede, skip } = pickNudgeBatch(ranked, { now });

  const report: JobNudgeReport = {
    dryRun,
    blobWritable,
    scanned: open.length,
    superseded: [],
    advanced: [],
    retried: [],
    skipped: skip.map(({ c, reason }) => ({ id: c.id, reason })),
    errors: [],
  };

  if (blobWritable === false) {
    for (const c of eligible.filter((x) => x.blobHold && !x.superseded)) {
      report.skipped.push({ id: c.id, reason: "blob_unwritable" });
    }
  }

  for (const c of supersede) {
    report.superseded.push(c.id);
    if (dryRun) continue;
    const row = open.find((r) => r.id === c.id);
    if (!row) continue;
    const a = parseArtifacts(row.artifacts);
    delete a.run;
    delete a.holdUntil;
    a.progressDetail = { stage: "failed", label: "Failed" };
    await db
      .update(schema.jobs)
      .set({
        stage: "failed",
        error: "superseded: same density already done (auto nudge)",
        artifacts: JSON.stringify(a),
        updatedAt: Date.now(),
      })
      .where(sql`${schema.jobs.id} = ${c.id}`);
  }

  for (const c of advance) {
    if (dryRun) {
      report.advanced.push(c.id);
      continue;
    }
    try {
      // Clear soft holds / dead leases, then advance one unit.
      if (c.blobHold || c.stuck || (c.holdUntil && c.holdUntil <= now)) {
        const r = await retryJob(c.id, true);
        if (!r.ok) {
          report.errors.push({ id: c.id, error: r.reason });
          continue;
        }
        report.retried.push(c.id);
      }
      await advanceJob(c.id);
      report.advanced.push(c.id);
    } catch (e) {
      report.errors.push({ id: c.id, error: (e as Error).message?.slice(0, 200) || String(e) });
    }
  }

  return report;
}
