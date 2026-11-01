import { asc, eq } from "drizzle-orm";
import { db, ensureDb, schema } from "@/db";
import { STAGES, type Stage } from "@/db/schema";
import { retrieveExcerpts } from "../context";
import { htmlToPdf } from "../pdf";
import { getProvider, type AudioInput, type LectureContext, type Repair, type Transcript, type LectureSummary } from "../providers";
import { applyRepairs, isTranscriptThin, cleanTranscript } from "../providers/prompts";
import { dedupeTranscript } from "../providers/dedupe";
import { deleteFileUrl, saveArtifact } from "../storage";
import { renderStudyHtml } from "./render";
import { figuresEnabled, pickFigures, lastFigureNote, type SlideDeck } from "../figures";
import { readFileUrl } from "../storage";

export interface Artifacts {
  asr?: Transcript; /** ASR before dedupe (append-only), so later dedupe changes can be re-applied from it */ asrRaw?: Transcript; asrParts?: number; /** next ASR window start (s) inside the current part */ asrWindowStart?: number; asrComplete?: boolean; repair?: Repair[]; repaired?: Transcript;
  summary?: LectureSummary; /** figures embedded in the PDF (metadata only) */ figures?: { page: number; deck?: string; section: number; caption: string }[]; figuresNote?: string; html?: string; pdf?: string; audioDeleted?: boolean;
  /** No audio on the server: summary built from lecture slides/PDFs (or course files) only; ASR+repair skipped. */
  slidesOnly?: boolean;
  /** Detail about the next/current unit of work, for client progress text. */
  progressDetail?: ProgressDetail;
}

export interface ProgressDetail {
  stage: string; label: string; part?: number; parts?: number; window?: number; windows?: number | null;
}

const STAGE_LABEL: Record<string, string> = { queued: "Queued", asr: "Transcribing", repair: "Fixing terms", summary: "Summarizing", pdf: "Building PDF", done: "Done", failed: "Failed" };
export function stageLabel(s: string) { return STAGE_LABEL[s] ?? s; }


/** ASR window length (s): long audio is transcribed in windows so Gemini's JSON output is not truncated. */
const ASR_WINDOW_SEC = Number(process.env.ASR_WINDOW_SEC || 600);
/** A known-duration part up to ASR_WINDOW_SEC × this goes in one call (10-min segments are not split 6+4). */
const ASR_SPLIT_FACTOR = Number(process.env.ASR_SPLIT_FACTOR || 1.25);
/** ASR windows/parts transcribed concurrently per advanceJob call (each call must stay under Vercel's 300s). */
const ASR_PARALLEL = Math.max(1, Number(process.env.ASR_PARALLEL || 3));
const ASR_MAX_WINDOWS = 60;

export async function audioInputs(lectureId: string, legacyUrl: string | null): Promise<(AudioInput & { seq?: number })[]> {
  const segs = await db.select().from(schema.segments).where(eq(schema.segments.lectureId, lectureId)).orderBy(asc(schema.segments.seq));
  let off = 0;
  const out: (AudioInput & { seq?: number })[] = [];
  for (const s of segs) { if (s.url) out.push({ seq: s.seq, url: s.url, mime: s.mime, offsetSec: off, durationSec: s.duration ?? undefined }); off += s.duration ?? 0; }
  if (!out.length && legacyUrl) out.push({ url: legacyUrl, mime: "audio/mp4", offsetSec: 0 });
  return out;
}

/** Delete raw audio once the job is done (free Blob quota hygiene). DELETE_RAW_AUDIO=false to keep. */
async function cleanupAudio(lectureId: string) {
  const segs = await db.select().from(schema.segments).where(eq(schema.segments.lectureId, lectureId));
  for (const s of segs) if (s.url) await deleteFileUrl(s.url);
  await db.update(schema.segments).set({ url: null }).where(eq(schema.segments.lectureId, lectureId));
  const l = await db.query.lectures.findFirst({ where: eq(schema.lectures.id, lectureId) });
  if (l?.audioUrl) { await deleteFileUrl(l.audioUrl); await db.update(schema.lectures).set({ audioUrl: null }).where(eq(schema.lectures.id, lectureId)); }
}

/** PDF/PPTX decks attached to the lecture (for figure embedding). Unreadable files are skipped. */
async function slideDecks(lecture: { id: string; slidesUrl: string | null }): Promise<SlideDeck[]> {
  const rows = await db.select().from(schema.lectureFiles).where(eq(schema.lectureFiles.lectureId, lecture.id)).orderBy(asc(schema.lectureFiles.createdAt));
  const files = rows.length ? rows.map((r) => ({ name: r.name, mime: r.mime, url: r.url }))
    : lecture.slidesUrl ? [{ name: decodeURIComponent(lecture.slidesUrl.split("/").pop()!.split("?")[0]), mime: "", url: lecture.slidesUrl }] : [];
  const out: SlideDeck[] = [];
  for (const f of files) {
    if (!/pdf|presentationml/.test(f.mime) && !/\.(pdf|pptx)$/i.test(f.name)) continue;
    try { const r = await readFileUrl(f.url); out.push({ name: f.name, mime: f.mime || r.mime || "", data: new Uint8Array(r.data) }); }
    catch (e) { console.warn("deck unreadable, skipped for figures:", f.name, (e as Error).message); }
  }
  return out;
}

/** Materials text usable for a slides-only summary: lecture decks first, else course files. */
export function materialsText(lecture: { slidesText: string | null }, course?: { contextText: string | null } | null): string | null {
  const t = lecture.slidesText?.trim() ? lecture.slidesText : course?.contextText?.trim() ? course.contextText : null;
  return t || null;
}

/** 0-100 progress for the Android client. */
export function progressOf(stage: string): number {
  const i = STAGES.indexOf(stage as Stage);
  return i < 0 ? 0 : Math.round((i / (STAGES.length - 1)) * 100);
}

/** First stage whose output is missing — prior successful stage outputs are kept and not redone. */
export function resumeStage(a: Artifacts): Stage {
  if (!a.asrComplete) return "asr";
  return (["repair", "summary", "pdf"] as const).find((s) => !a[s]) ?? "done";
}

/**
 * Re-run summary+pdf only: clears summary/html/pdf, keeps asr/repair (no ASR quota spent).
 * Allowed for done/failed jobs (or any with ?force). Requires a complete ASR.
 */
export async function resummarizeJob(jobId: string, force = false): Promise<RetryResult> {
  await ensureDb();
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job) return { ok: false, reason: "not_found" };
  const a = JSON.parse(job.artifacts) as Artifacts;
  const stuck = Date.now() - job.updatedAt > STUCK_MS;
  if (!a.asrComplete || (job.stage !== "done" && job.stage !== "failed" && !stuck && !force)) return { ok: false, reason: "not_retryable", job };
  delete a.summary; delete a.html; delete a.pdf;
  const stage = resumeStage(a);
  const [row] = await db.update(schema.jobs).set({ stage, error: null, artifacts: JSON.stringify(a), updatedAt: Date.now() })
    .where(eq(schema.jobs.id, jobId)).returning();
  return { ok: true, job: row };
}

/**
 * Re-run repair+summary+pdf from the existing ASR (no ASR quota spent) — picks up improved repair/spelling prompts.
 */
export async function rerepairJob(jobId: string, force = false): Promise<RetryResult> {
  await ensureDb();
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job) return { ok: false, reason: "not_found" };
  const a = JSON.parse(job.artifacts) as Artifacts;
  const stuck = Date.now() - job.updatedAt > STUCK_MS;
  if (!a.asrComplete || (job.stage !== "done" && job.stage !== "failed" && !stuck && !force)) return { ok: false, reason: "not_retryable", job };
  delete a.repair; delete a.repaired; delete a.summary; delete a.html; delete a.pdf;
  const stage = resumeStage(a);
  const [row] = await db.update(schema.jobs).set({ stage, error: null, artifacts: JSON.stringify(a), updatedAt: Date.now() })
    .where(eq(schema.jobs.id, jobId)).returning();
  return { ok: true, job: row };
}

/**
 * Full redo: if the lecture's raw audio is still on the server, wipe all stage outputs and restart from ASR.
 * Without audio: with fallback=true (and a complete ASR) behaves like resummarize; else not_retryable/audio_missing.
 */
export async function reprocessJob(jobId: string, fallback: boolean, force = false): Promise<RetryResult & { mode?: "full" | "resummarize"; audioMissing?: boolean }> {
  await ensureDb();
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job) return { ok: false, reason: "not_found" };
  const stuck = Date.now() - job.updatedAt > STUCK_MS;
  if (job.stage !== "done" && job.stage !== "failed" && !stuck && !force) return { ok: false, reason: "not_retryable", job };
  const lecture = await db.query.lectures.findFirst({ where: eq(schema.lectures.id, job.lectureId) });
  const inputs = lecture ? await audioInputs(lecture.id, lecture.audioUrl) : [];
  const course = lecture ? await db.query.courses.findFirst({ where: eq(schema.courses.id, lecture.courseId) }) : null;
  const old0 = JSON.parse(job.artifacts) as Artifacts;
  // No audio but materials and no real transcript to fall back on → slides-only full redo (the asr stage switches to slides-only).
  const slidesOnlyRedo = !inputs.length && !!lecture && !!materialsText(lecture, course) && (old0.slidesOnly || !(old0.asr?.segments?.length));
  if (inputs.length || slidesOnlyRedo || getProvider().name === "mock") {
    const old = JSON.parse(job.artifacts) as Artifacts & { options?: unknown };
    const a = { options: old.options ?? {} };
    const [row] = await db.update(schema.jobs).set({ stage: "asr", error: null, artifacts: JSON.stringify(a), updatedAt: Date.now() })
      .where(eq(schema.jobs.id, jobId)).returning();
    return { ok: true, job: row, mode: "full" };
  }
  // Fallback re-runs repair (terms + Hebrew spelling) + summary from the existing ASR; mode stays "resummarize" for clients.
  if (!fallback) return { ok: false, reason: "not_retryable", job, audioMissing: true };
  const r = await rerepairJob(jobId, true);
  return r.ok ? { ...r, mode: "resummarize", audioMissing: true } : { ...r, audioMissing: true };
}

/** A non-terminal job not updated for this long is considered stuck (crashed/timed-out invocation). */
export const STUCK_MS = Number(process.env.JOB_STUCK_MS || 10 * 60 * 1000);

export type RetryResult = { ok: true; job: typeof schema.jobs.$inferSelect } | { ok: false; reason: "not_found" | "not_retryable"; job?: typeof schema.jobs.$inferSelect };

/**
 * Reset a failed (or stuck) job to its first incomplete stage and clear the error.
 * Artifacts are kept, so e.g. a completed ASR is not redone after a Gemini 503 in summary.
 * `force` also allows retrying a running job that is not (yet) considered stuck.
 */
export async function retryJob(jobId: string, force = false): Promise<RetryResult> {
  await ensureDb();
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job) return { ok: false, reason: "not_found" };
  const stuck = job.stage !== "done" && job.stage !== "failed" && Date.now() - job.updatedAt > STUCK_MS;
  if (job.stage === "done" || (job.stage !== "failed" && !stuck && !force)) return { ok: false, reason: "not_retryable", job };
  const a = JSON.parse(job.artifacts) as Artifacts;
  const stage = resumeStage(a);
  const [row] = await db.update(schema.jobs).set({ stage, error: null, updatedAt: Date.now() })
    .where(eq(schema.jobs.id, jobId)).returning();
  return { ok: true, job: row };
}

/**
 * Runs exactly ONE unit of work per call so each invocation fits the Vercel Hobby 300s limit.
 * ASR runs up to ASR_PARALLEL windows/segments per call in parallel (stays in "asr" until all segments are transcribed).
 * Stages are idempotent: artifacts are stored per stage, so a failed job can be re-advanced.
 */
export async function advanceJob(jobId: string) {
  await ensureDb();
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job) throw new Error("job not found");
  if (job.stage === "done") return job;
  const lecture = (await db.query.lectures.findFirst({ where: eq(schema.lectures.id, job.lectureId) }))!;
  const course = await db.query.courses.findFirst({ where: eq(schema.courses.id, lecture.courseId) });
  const ctx: LectureContext = {
    title: lecture.title, slidesUrl: lecture.slidesUrl, slidesText: lecture.slidesText,
    courseExcerpts: (q, budget) => retrieveExcerpts(course?.contextText, q, budget),
  };
  const a = JSON.parse(job.artifacts) as Artifacts;
  const ai = getProvider();
  if (a.slidesOnly) { ctx.slidesOnly = true; ctx.slidesText = materialsText(lecture, course); }

  const current: Stage = job.stage === "failed" ? resumeStage(a) : job.stage;
  let next = STAGES[STAGES.indexOf(current) + 1] as Stage | undefined;
  try {
    switch (current) {
      case "queued":
        break;
      case "asr": {
        // Live job (options.live): started mid-lecture to transcribe parts as they upload; it waits in "asr" for more
        // audio until a final POST /process clears the flag. Only the contiguous seq prefix is used (offsets stay right).
        const live = !!(a as { options?: { live?: boolean } }).options?.live;
        const all = await audioInputs(lecture.id, lecture.audioUrl);
        const inputs = live ? all.filter((x, i) => x.seq === undefined || x.seq === (all[0].seq ?? 0) + i) : all;
        if (live && !inputs.length) { next = "asr"; a.progressDetail = { stage: "asr", label: "Waiting for audio" }; break; }
        // Voice wins: options.slides_only is honored only when there is no audio.
        if (!inputs.length && ai.name !== "mock" && materialsText(lecture, course)) {
          // Slides-only: no recording, summarize from presentation/PDF text. Skip ASR + repair.
          a.slidesOnly = true; a.asr = { language: course?.langPrimary ?? "he", segments: [] }; a.asrComplete = true;
          a.repair = []; a.repaired = a.asr;
          next = "summary";
          break;
        }
        if (!inputs.length && ai.name !== "mock") throw new Error("lecture has no audio and no slides/PDF materials");
        if (!inputs.length && ai.name !== "mock") throw new Error("lecture has no audio");
        const list = inputs.length ? inputs : [{ url: "", mime: "audio/mp4", offsetSec: 0 }];
        const winOf = (p: AudioInput) => ai.name !== "mock" && !(p.durationSec! > 0 && p.durationSec! <= ASR_WINDOW_SEC * ASR_SPLIT_FACTOR);
        // Plan up to ASR_PARALLEL units (one window, or one whole short part) from the current position. Planning stops
        // after a window of unknown-duration audio, since only the transcript tells whether that part has ended.
        const units: { p: number; ws: number; we?: number }[] = [];
        for (let p = a.asrParts ?? 0, ws = a.asrWindowStart ?? 0; p < list.length && units.length < ASR_PARALLEL;) {
          const cur = list[p], known = cur.durationSec! > 0;
          if (!winOf(cur)) { units.push({ p, ws: 0 }); p++; ws = 0; continue; }
          const we = known ? Math.min(cur.durationSec!, ws + ASR_WINDOW_SEC) : ws + ASR_WINDOW_SEC;
          units.push({ p, ws, we });
          if (!known) break;
          if (we >= cur.durationSec!) { p++; ws = 0; } else ws = we;
        }
        const prevText = units[0]?.ws ? a.asr?.segments.slice(-2).map((s) => s.text).join(" ").slice(-300) : undefined;
        const results = await Promise.allSettled(units.map((u, i) =>
          ai.transcribe(u.we !== undefined ? { ...list[u.p], windowStart: u.ws, windowEnd: u.we, prevText: i ? undefined : prevText } : list[u.p], ctx)));
        // Merge in time order up to the first failure; the failed unit (and later ones) are retried on the next call.
        for (const [i, r] of results.entries()) {
          if (r.status === "rejected") { if (i === 0) throw r.reason; console.warn(`ASR unit ${i + 1}/${units.length} failed, retried next call:`, (r.reason as Error)?.message); break; }
          const u = units[i], t = r.value, cur = list[u.p];
          // Dedupe across windows: Gemini may re-transcribe earlier speech with later timestamps.
          a.asrRaw = { language: t.language, segments: [...(a.asrRaw?.segments ?? a.asr?.segments ?? []), ...cleanTranscript(t).segments] };
          const partDone = u.we === undefined || (cur.durationSec! > 0 ? u.we >= cur.durationSec! : (t.audioEnded || !t.segments.length || u.ws / ASR_WINDOW_SEC >= ASR_MAX_WINDOWS - 1));
          if (partDone) { a.asrParts = u.p + 1; a.asrWindowStart = 0; } else a.asrWindowStart = u.we;
        }
        if (a.asrRaw) { a.asr = dedupeTranscript(a.asrRaw); delete (a.asr as { dedupedCount?: number }).dedupedCount; }
        if ((a.asrParts ?? 0) < list.length || live) {
          next = "asr";
          const pn = a.asrParts ?? 0, np = list[pn], nws = a.asrWindowStart ?? 0;
          if (!np) a.progressDetail = { stage: "asr", part: pn, parts: list.length, label: `Transcribed ${pn} part${pn === 1 ? "" : "s"} · waiting for more audio` };
          else {
            const windows = !winOf(np) ? 1 : np.durationSec! > 0 ? Math.ceil(np.durationSec! / ASR_WINDOW_SEC) : null;
            const window = Math.floor(nws / ASR_WINDOW_SEC) + 1;
            // Next call runs up to ASR_PARALLEL units; show the span it covers when that is more than one.
            const left = list.slice(pn).reduce((n, p, i) => n + (!winOf(p) ? 1 : p.durationSec! > 0 ? Math.ceil(p.durationSec! / ASR_WINDOW_SEC) - (i ? 0 : window - 1) : 1), 0);
            const batch = Math.min(ASR_PARALLEL, left);
            a.progressDetail = { stage: "asr", part: pn + 1, parts: list.length, window, windows,
              label: `ASR part ${pn + 1}/${list.length}` + (windows === 1 ? "" : ` · window ${window}/${windows ?? "?"}`) + (batch > 1 ? ` (+${batch - 1} more in parallel)` : "") };
          }
        } else a.asrComplete = true;
        break;
      }
      case "repair":
        if (a.slidesOnly) { a.repair = []; a.repaired = a.asr; break; }
        a.asr = dedupeTranscript(cleanTranscript(a.asrRaw ?? a.asr!)); // also cleans/dedupes ASR stored before these fixes existed
        delete (a.asr as { dedupedCount?: number }).dedupedCount;
        a.repair = await ai.repairTerms(a.asr, ctx);
        a.repaired = applyRepairs(a.asr!, a.repair);
        break;
      case "summary":
      {
        const tr = a.repaired ?? a.asr ?? { language: "he", segments: [] };
        a.summary = await ai.summarize(tr, a.repair ?? [], ctx);
        // Server-side truth wins over the model's flag.
        a.summary.transcript_thin = a.slidesOnly ? false : isTranscriptThin(tr, ctx.slidesText) || !!a.summary.transcript_thin;
        break;
      }
      case "pdf": {
        const figures = figuresEnabled() ? await pickFigures(await slideDecks(lecture), a.summary!) : [];
        a.figures = figures.map(({ src: _src, ...f }) => f); a.figuresNote = figuresEnabled() ? lastFigureNote : "FIGURES=off";
        const html = renderStudyHtml(a.summary!, figures);
        a.html = await saveArtifact(`${lecture.id}-study.html`, html, "text/html; charset=utf-8");
        const pdf = await htmlToPdf(html).catch((e) => { console.warn("pdf render failed, HTML only:", e); return null; });
        a.pdf = pdf ? await saveArtifact(`${lecture.id}-study.pdf`, pdf, "application/pdf") : a.html;
        if (process.env.DELETE_RAW_AUDIO !== "false") { await cleanupAudio(lecture.id); a.audioDeleted = true; }
        break;
      }
    }
    // A final POST /process may clear options.live while this (long) ASR call runs; don't overwrite it with our stale copy.
    const fresh = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
    if (fresh) { const fo = (JSON.parse(fresh.artifacts) as { options?: object }).options; if (fo) (a as { options?: object }).options = fo; }
    const ns = next ?? "done";
    if (ns !== "asr" || current !== "asr") a.progressDetail = { stage: ns, label: stageLabel(ns) };
    const [row] = await db.update(schema.jobs)
      .set({ stage: next ?? "done", artifacts: JSON.stringify(a), error: null, updatedAt: Date.now() })
      .where(eq(schema.jobs.id, jobId)).returning();
    return row;
  } catch (e) {
    const [row] = await db.update(schema.jobs)
      .set({ stage: "failed", error: `${current}: ${shortErr(e)}`, artifacts: JSON.stringify(a), updatedAt: Date.now() })
      .where(eq(schema.jobs.id, jobId)).returning();
    return row;
  }
}

/** Keep job errors short and readable (Google errors embed huge JSON). */
function shortErr(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/daily quota \(RPD\)/.test(m)) return m;
  if (/\b429\b|RESOURCE_EXHAUSTED/i.test(m)) return "Gemini rate limit / quota hit; retry later";
  return m.length > 400 ? m.slice(0, 400) + "…" : m;
}
