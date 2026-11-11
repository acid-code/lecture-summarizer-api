import { memoryPairs } from "../study/memory";
import { storedSlideRange } from "../slide-ranges";
import { asrSpan, type HierState } from "../providers/hierarchical";
import { asrCompleteness, computeCoverage, mergeTranscripts, fixBackwardRanges, fmtWin, mergeGapSections, sliceTranscript, type Coverage } from "./coverage";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db, ensureDb, schema } from "@/db";
import { STAGES, type Stage } from "@/db/schema";
import { retrieveExcerpts } from "../context";
import { htmlToPdf } from "../pdf";
import { parseDensity, type Density } from "../providers/types";
import { getProvider, type AudioInput, type LectureContext, type Repair, type Transcript, type LectureSummary } from "../providers";
import { applyRepairs, isTranscriptThin, cleanTranscript, transcriptSpanSec, transcriptChars } from "../providers/prompts";
import { dedupeTranscript } from "../providers/dedupe";
import { GeminiOverloadedError, overloadHoldMs } from "../providers/overload";
import { deleteFileUrl, saveArtifact } from "../storage";
import { renderStudyHtml, studyFooterTemplate } from "./render";
import { figuresEnabled, pickFigures, lastFigureNote, type SlideDeck } from "../figures";
import { readFileUrl } from "../storage";

export interface Artifacts {
  asr?: Transcript; /** ASR before dedupe (append-only), so later dedupe changes can be re-applied from it */ asrRaw?: Transcript; asrParts?: number; /** next ASR window start (s) inside the current part */ asrWindowStart?: number; asrComplete?: boolean; /** ASR ended well before the uploaded audio (e.g. parts whose blobs expired) */ asrIncomplete?: boolean; asrCheck?: ReturnType<typeof asrCompleteness>; coverage?: Coverage | null; coverageBefore?: Coverage | null; repair?: Repair[]; repaired?: Transcript;
  summary?: LectureSummary; /** resumable hierarchical-summary state (long lectures) */ hier?: HierState; hierFailed?: string; summaryMode?: "hierarchical" | "single"; /** figures embedded in the PDF (metadata only) */ figures?: { page: number; deck?: string; section: number; caption: string }[]; figuresNote?: string; html?: string; pdf?: string; audioDeleted?: boolean;
  /** No audio on the server: summary built from lecture slides/PDFs (or course files) only; ASR+repair skipped. */
  slidesOnly?: boolean;
  /** Job options from /process or resummarize. density = summary level; densities = extra levels to spawn after done. */
  options?: { live?: boolean; density?: Density; densities?: Density[]; source?: string; [k: string]: unknown };
  /** Where the ASR came from: our audio ASR (unset) or an imported external transcript (e.g. "panopto"). */
  asrSource?: string; asrExternalId?: string;
  /** Detail about the next/current unit of work, for client progress text. */
  progressDetail?: ProgressDetail;
  /** Gemini 503 soft hold: advance is a no-op until this epoch ms; overloadHolds counts consecutive holds. */
  holdUntil?: number;
  overloadHolds?: number;
  /** Soft hold specifically from Blob quota/suspend — cron probe clears these when writes work again. */
  blobHold?: boolean;
  /** Heavy-stage run lease: set (and persisted) before repair/summary/pdf work starts, cleared when the invocation writes back. */
  run?: { stage: string; n: number; at: number };
}

/**
 * Silent-stall guard. A Vercel invocation killed at maxDuration (long summary / Chromium PDF) never reaches the catch, so the
 * job used to sit in "summary"/"pdf" forever with no error. Now each heavy run takes a lease first:
 *  - a run of the same stage started < RUN_LEASE_MS ago (and not superseded by a retry) is still in flight → don't start a 2nd;
 *  - an expired lease means the previous invocation died → re-run (auto-requeue), up to MAX_STAGE_RUNS, then fail with a real error.
 */
export const RUN_LEASE_MS = Number(process.env.JOB_RUN_LEASE_MS || 330_000);
export const MAX_STAGE_RUNS = Number(process.env.JOB_MAX_STAGE_RUNS || 3);
export function stageRunDecision(run: Artifacts["run"], stage: string, jobUpdatedAt: number, now = Date.now()):
  { action: "busy" } | { action: "fail"; runs: number } | { action: "run"; n: number } {
  const same = run && run.stage === stage && jobUpdatedAt <= run.at; // a retry/reset bumps updatedAt past the lease → fresh
  if (!same) return { action: "run", n: 1 };
  if (now - run!.at < RUN_LEASE_MS) return { action: "busy" };
  if (run!.n >= MAX_STAGE_RUNS) return { action: "fail", runs: run!.n };
  return { action: "run", n: run!.n + 1 };
}
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) => new Promise<T>((res, rej) => {
  const t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

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
  const files = rows.length ? rows.map((r) => ({ name: r.name, mime: r.mime, url: r.url, range:storedSlideRange(r.slideRange) }))
    : lecture.slidesUrl ? [{ name: decodeURIComponent(lecture.slidesUrl.split("/").pop()!.split("?")[0]), mime: "", url: lecture.slidesUrl,range:null }] : [];
  const out: SlideDeck[] = [];
  for (const f of files) {
    if (!/pdf|presentationml/.test(f.mime) && !/\.(pdf|pptx)$/i.test(f.name)) continue;
    try { const r = await readFileUrl(f.url); out.push({ name: f.name, mime: f.mime || r.mime || "", data: new Uint8Array(r.data),range:f.range }); }
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
/** Summary level of a job; jobs created before density existed were the exhaustive style → "detailed". */
export function jobDensity(a: Artifacts): Density {
  return parseDensity(a.options?.density) ?? (a.summary && !a.options?.density ? "detailed" : "standard");
}

/** New job for the same lecture at `density`, starting from the done job's ASR+repair (summary/pdf cleared). */
async function cloneForDensity(lectureId: string, src: Artifacts, density: Density) {
  const a: Artifacts = JSON.parse(JSON.stringify(src));
  delete a.summary; delete a.html; delete a.pdf; delete a.hier; delete a.hierFailed; delete a.figures; delete a.coverage; delete a.coverageBefore;
  a.options = { ...(a.options ?? {}), density, densities: undefined, live: false };
  const stage = resumeStage(a); a.progressDetail = { stage, label: stageLabel(stage) };
  const job_id = crypto.randomUUID();
  const [row] = await db.insert(schema.jobs).values({ id: job_id, lectureId, stage, artifacts: JSON.stringify(a), updatedAt: Date.now() }).returning();
  return row;
}

/** Resummarize. With a density different from the job's, a NEW job is created so each level keeps its own summary. */
export async function resummarizeJob(jobId: string, force = false, density?: Density): Promise<RetryResult> {
  await ensureDb();
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job) return { ok: false, reason: "not_found" };
  const a = JSON.parse(job.artifacts) as Artifacts;
  if (density && density !== jobDensity(a) && a.asrComplete) {
    await withSiblingAsr(job.lectureId, jobId, a);
    return { ok: true, job: await cloneForDensity(job.lectureId, a, density) };
  }
  if (!a.options?.density) a.options = { ...(a.options ?? {}), density: jobDensity(a) };
  const stuck = Date.now() - job.updatedAt > STUCK_MS;
  // Incomplete terminal work (summary/pdf missing, e.g. a crashed/timed-out summary call) is always restartable.
  const incomplete = !!a.asrComplete && (!a.summary || !a.pdf) && a.progressDetail?.stage !== job.stage; // honest in-flight work still needs stuck/force
  if (!a.asrComplete || (job.stage !== "done" && job.stage !== "failed" && !stuck && !force && !incomplete)) return { ok: false, reason: "not_retryable", job };
  delete a.summary; delete a.html; delete a.pdf; delete a.hier; delete a.hierFailed;
  await withSiblingAsr(job.lectureId, jobId, a); // always pull earlier sessions' transcripts, even without redoing ASR/repair
  const stage = resumeStage(a);
  a.progressDetail = { stage, label: stageLabel(stage) }; // never leave a stale "Done" behind
  const [row] = await db.update(schema.jobs).set({ stage, error: null, artifacts: JSON.stringify(a), updatedAt: Date.now() })
    .where(eq(schema.jobs.id, jobId)).returning();
  return { ok: true, job: row };
}

/**
 * Re-run repair+summary+pdf from the existing ASR (no ASR quota spent) — picks up improved repair/spelling prompts.
 */

/**
 * A lecture recorded in several sessions ("Record another") gets a new job per /process; by then the earlier parts'
 * raw audio was deleted on the previous job's completion, so the new job only transcribes the new parts. Pull the
 * missing stretches from the lecture's other jobs' transcripts so the summary covers the whole timeline.
 */
async function withSiblingAsr(lectureId: string, jobId: string, a: Artifacts) {
  if (a.slidesOnly || !a.asr) return 0;
  const rows = await db.select().from(schema.jobs).where(and(eq(schema.jobs.lectureId, lectureId), ne(schema.jobs.id, jobId))).orderBy(desc(schema.jobs.updatedAt));
  const sib = rows.map((r) => { try { const x = JSON.parse(r.artifacts) as Artifacts; return x.asrComplete && !x.slidesOnly ? x : undefined; } catch { return undefined; } });
  return mergeSiblingArtifacts(a, sib);
}

/** Merge sibling jobs' transcripts into asr/asrRaw/repaired (repaired gets the siblings' repaired text when present). */
export function mergeSiblingArtifacts(a: Artifacts, sib: (Artifacts | undefined)[]): number {
  if (a.slidesOnly || !a.asr) return 0;
  const m = mergeTranscripts(a.asr, sib.map((x) => x?.asr));
  if (!m.added) return 0;
  console.warn(`merged ${m.added} ASR segments from earlier jobs`);
  a.asr = m.t;
  if (a.asrRaw) a.asrRaw = mergeTranscripts(a.asrRaw, sib.map((x) => x?.asrRaw ?? x?.asr)).t;
  if (a.repaired) a.repaired = mergeTranscripts(a.repaired, sib.map((x) => x?.repaired ?? x?.asr)).t;
  return m.added;
}

export async function rerepairJob(jobId: string, force = false): Promise<RetryResult> {
  await ensureDb();
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job) return { ok: false, reason: "not_found" };
  const a = JSON.parse(job.artifacts) as Artifacts;
  const stuck = Date.now() - job.updatedAt > STUCK_MS;
  // Incomplete terminal work (summary/pdf missing, e.g. a crashed/timed-out summary call) is always restartable.
  const incomplete = !!a.asrComplete && (!a.summary || !a.pdf) && a.progressDetail?.stage !== job.stage; // honest in-flight work still needs stuck/force
  if (!a.asrComplete || (job.stage !== "done" && job.stage !== "failed" && !stuck && !force && !incomplete)) return { ok: false, reason: "not_retryable", job };
  delete a.repair; delete a.repaired; delete a.summary; delete a.html; delete a.pdf; delete a.hier; delete a.hierFailed; delete a.hier; delete a.hierFailed;
  await withSiblingAsr(job.lectureId, jobId, a);
  { const segRows = await db.select().from(schema.segments).where(eq(schema.segments.lectureId, job.lectureId));
    a.asrCheck = asrCompleteness(a.asr, segRows.reduce((n, r) => n + (r.duration ?? 0), 0)); a.asrIncomplete = a.asrCheck.incomplete || undefined; }
  const stage = resumeStage(a);
  a.progressDetail = { stage, label: stageLabel(stage) }; // never leave a stale "Done" behind
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
  // Drop dead leases / overload / blob holds so the next poll actually runs work.
  delete a.run; delete a.holdUntil; delete a.overloadHolds; delete a.blobHold;
  a.progressDetail = { stage: resumeStage(a), label: stageLabel(resumeStage(a)) };
  const stage = resumeStage(a);
  const [row] = await db.update(schema.jobs).set({ stage, error: null, artifacts: JSON.stringify(a), updatedAt: Date.now() })
    .where(eq(schema.jobs.id, jobId)).returning();
  return { ok: true, job: row };
}

/** User stop: mark failed, clear leases/holds, keep finished stage artifacts. Idempotent for done/failed. */
export async function cancelJob(jobId: string): Promise<RetryResult> {
  await ensureDb();
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job) return { ok: false, reason: "not_found" };
  if (job.stage === "done" || job.stage === "failed") return { ok: true, job };
  const a = JSON.parse(job.artifacts) as Artifacts;
  delete a.run; delete a.holdUntil; delete a.overloadHolds; delete a.blobHold;
  a.progressDetail = { stage: "failed", label: stageLabel("failed") };
  const [row] = await db.update(schema.jobs)
    .set({ stage: "failed", error: "cancelled_by_user", artifacts: JSON.stringify(a), updatedAt: Date.now() })
    .where(eq(schema.jobs.id, jobId)).returning();
  return { ok: true, job: row };
}

/**
 * Runs exactly ONE unit of work per call so each invocation fits the Vercel Hobby 300s limit.
 * ASR runs up to ASR_PARALLEL windows/segments per call in parallel (stays in "asr" until all segments are transcribed).
 * Stages are idempotent: artifacts are stored per stage, so a failed job can be re-advanced.
 */
const DENSITY_LABEL: Record<string, string> = { compact: "תמציתי", standard: "רגיל", detailed: "מפורט" };

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
  if (job.stage !== "failed" && a.holdUntil && a.holdUntil > Date.now()) return job; // soft hold: don't call Gemini / Blob yet
  delete a.holdUntil; delete a.blobHold;
  const ai = getProvider();
  if (a.slidesOnly) { ctx.slidesOnly = true; ctx.slidesText = materialsText(lecture, course); }
  ctx.density = jobDensity(a);

  const current: Stage = job.stage === "failed" ? resumeStage(a) : job.stage;
  let next = STAGES[STAGES.indexOf(current) + 1] as Stage | undefined;
  if (current === "repair" || current === "summary" || current === "pdf") {
    const d = stageRunDecision(a.run, current, job.updatedAt);
    if (d.action === "busy") {
      // Surface wait state so clients keep polling instead of looking "frozen".
      const left = Math.max(1, Math.ceil((RUN_LEASE_MS - (Date.now() - (a.run?.at ?? job.updatedAt))) / 1000));
      a.progressDetail = { stage: current, label: `${stageLabel(current)} · server still working (retry in ~${left}s)` };
      const [busy] = await db.update(schema.jobs).set({ artifacts: JSON.stringify(a) }).where(eq(schema.jobs.id, jobId)).returning();
      return busy;
    }
    if (d.action === "fail") {
      delete a.run;
      const err = `${current}: stalled — ${d.runs} runs never finished (invocation timed out/crashed); retry to resume`;
      console.error(`job ${jobId} ${err}`);
      const [row] = await db.update(schema.jobs).set({ stage: "failed", error: err, artifacts: JSON.stringify(a), updatedAt: Date.now() })
        .where(eq(schema.jobs.id, jobId)).returning();
      return row;
    }
    if (d.n > 1) console.warn(`job ${jobId} ${current}: previous run never finished — auto re-run ${d.n}/${MAX_STAGE_RUNS}`);
    const at = Date.now();
    a.run = { stage: current, n: d.n, at };
    await db.update(schema.jobs).set({ artifacts: JSON.stringify(a), updatedAt: at }).where(eq(schema.jobs.id, jobId));
  }
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
        } else {
          a.asrComplete = true;
          await withSiblingAsr(lecture.id, jobId, a);
          const segRows = await db.select().from(schema.segments).where(eq(schema.segments.lectureId, lecture.id));
          a.asrCheck = asrCompleteness(a.asr, segRows.reduce((n, r) => n + (r.duration ?? 0), 0));
          a.asrIncomplete = a.asrCheck.incomplete || undefined;
          if (a.asrIncomplete) console.warn(`ASR incomplete: ends ${a.asrCheck.asrEndSec}s of ${a.asrCheck.uploadedSec}s uploaded (${segRows.filter((r) => !r.url).length} parts without audio URL)`);
        }
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
        const t0 = Date.now();
        let hs: LectureSummary | null = null;
        if (!a.slidesOnly && ai.hierarchicalStep && !a.hierFailed && useHierarchical(tr)) {
          try { a.hier ??= {}; hs = await ai.hierarchicalStep(tr, ctx, a.hier, t0 + HIER_BUDGET_MS); }
          catch (e) { a.hierFailed = (e as Error).message.slice(0, 300); console.warn("hierarchical summary failed, falling back to single-call:", a.hierFailed); }
          if (!hs) {
            // Not finished (time budget) → continue next invocation; failed → single-call path next invocation (fresh 300 s).
            next = "summary";
            const h = a.hier ?? {}, n = h.outline?.sections?.length;
            a.progressDetail = { stage: "summary", label: a.hierFailed ? "Summarizing (fallback)" : n ? `Summarizing sections ${h.sections?.length ?? 0}/${n}` : `Summarizing notes ${h.parts?.length ?? 0} parts` };
            break;
          }
          delete a.hier;
        }
        a.summaryMode = hs ? "hierarchical" : "single";
        a.summary = hs ?? await ai.summarize(tr, a.repair ?? [], ctx);
        if (!a.slidesOnly) {
          const cov = computeCoverage(tr, a.summary);
          a.coverageBefore = cov;
          if (cov && !cov.ok && process.env.COVERAGE_FILL !== "0") {
            // Focused "fill gaps" pass over the uncovered windows (plus a short lead-in), merged into the summary.
            const wins = gapsAll(cov).map(([x, y]) => [Math.max(cov.asrStart, x - 60), y] as [number, number]);
            console.warn(`summary coverage ${cov.ratio} (gaps ${wins.map(fmtWin).join(", ")}); filling gaps`);
            const extra = await ai.summarize(sliceTranscript(tr, wins), a.repair ?? [], { ...ctx, title: `${ctx.title} (missing parts: ${wins.map(fmtWin).join(", ")})` }).catch((e) => { console.warn("gap fill failed:", (e as Error).message); return null; });
            if (extra) a.summary = mergeGapSections(a.summary, extra);
          }
          a.summary = fixBackwardRanges(a.summary);
          a.coverage = computeCoverage(tr, a.summary);
        } else a.summary = fixBackwardRanges(a.summary);
        a.summary.memory_pairs=memoryPairs(a.summary);
        // Server-side truth wins over the model's flag.
        a.summary.transcript_thin = a.slidesOnly ? false : isTranscriptThin(tr, ctx.slidesText) || !!a.summary.transcript_thin;
        break;
      }
      case "pdf": {
        const figures = figuresEnabled() ? await withTimeout(slideDecks(lecture).then((d) => pickFigures(d, a.summary!)), Number(process.env.FIGURES_TIMEOUT_MS || 90_000), "figures")
          .catch((e) => { console.warn("figures skipped:", (e as Error).message); return []; }) : [];
        a.figures = figures.map(({ src: _src, ...f }) => f); a.figuresNote = figuresEnabled() ? lastFigureNote : "FIGURES=off";
        // Lecture number only when the source says so (title like "הרצאה 5" / "Lecture 5"); never guessed from list position.
        const html = renderStudyHtml(a.summary!, figures, { course: course?.name, lecture: verifiedLectureLabel(lecture.title), date: lecture.recordedAt ?? new Date(lecture.createdAt).toISOString().slice(0, 10), level: DENSITY_LABEL[jobDensity(a)] ?? DENSITY_LABEL.standard });
        a.html = await saveArtifact(`${lecture.id}-${jobId}-study.html`, html, "text/html; charset=utf-8");
        const pdf = await withTimeout(htmlToPdf(html, { footerTemplate: studyFooterTemplate(a.slidesOnly ? null : a.coverage?.ratio) }), Number(process.env.PDF_TIMEOUT_MS || 120_000), "pdf render").catch((e) => { console.warn("pdf render failed, HTML only:", e); return null; });
        a.pdf = pdf ? await saveArtifact(`${lecture.id}-${jobId}-study.pdf`, pdf, "application/pdf") : a.html;
        if (process.env.DELETE_RAW_AUDIO !== "false") { await cleanupAudio(lecture.id); a.audioDeleted = true; }
        break;
      }
    }
    // A final POST /process may clear options.live while this (long) ASR call runs; don't overwrite it with our stale copy.
    const fresh = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
    if (fresh) { const fo = (JSON.parse(fresh.artifacts) as { options?: object }).options; if (fo) (a as { options?: object }).options = fo; }
    delete a.overloadHolds; delete a.run;
    const ns = next ?? "done";
    if (ns !== "asr" || current !== "asr") a.progressDetail = { stage: ns, label: stageLabel(ns) + (a.asrIncomplete ? " · ASR incomplete — reprocess needed" : "") };
    // Multi-density request: once the first summary is done, spawn one sibling job per extra level (reuses ASR+repair).
    if (ns === "done" && a.options?.densities?.length) {
      const extra = a.options.densities.filter((x) => x !== jobDensity(a));
      const tr = a.repaired ?? a.asr;
      // Detailed quotas used to force hallucination on ~14s / incomplete ASR — skip that sibling.
      const thinInput = !!a.asrIncomplete || !tr?.segments?.length
        || transcriptSpanSec(tr) < 180 || transcriptChars(tr) < 800 || isTranscriptThin(tr, lecture.slidesText);
      const spawn = thinInput ? extra.filter((d) => d !== "detailed") : extra;
      if (thinInput && extra.includes("detailed")) {
        console.warn(`skipping detailed density sibling — thin/incomplete ASR (${transcriptSpanSec(tr ?? { language: "he", segments: [] })}s)`);
      }
      a.options = { ...a.options, densities: undefined };
      for (const d of spawn) await cloneForDensity(job.lectureId, a, d);
    }
    const [row] = await db.update(schema.jobs)
      .set({ stage: next ?? "done", artifacts: JSON.stringify(a), error: null, updatedAt: Date.now() })
      .where(eq(schema.jobs.id, jobId)).returning();
    return row;
  } catch (e) {
    delete a.run;
    // Busy Gemini is never a hard failure: hold & auto-retry (hold capped at 15 min). GEMINI_OVERLOAD_MAX_HOLDS>0 re-enables a cap.
    const maxHolds = Number(process.env.GEMINI_OVERLOAD_MAX_HOLDS || 0);
    if (e instanceof GeminiOverloadedError && (!maxHolds || (a.overloadHolds ?? 0) < maxHolds)) {
      // Soft hold instead of `failed`: keep the stage, back off, and let the next poll resume after holdUntil.
      // Prevents the client's fail→retry loop from hammering an overloaded model every 15-30 s.
      const holds = (a.overloadHolds ?? 0) + 1, wait = overloadHoldMs(holds - 1);
      a.overloadHolds = holds; a.holdUntil = Date.now() + wait;
      a.progressDetail = { stage: current, label: `Gemini busy (high demand) — auto-retry in ${Math.round(wait / 60_000) || 1} min` };
      console.warn(`job ${jobId} ${current}: Gemini overloaded, holding ${Math.round(wait / 1000)}s (hold ${holds})`);
      const [row] = await db.update(schema.jobs)
        .set({ stage: current, error: null, artifacts: JSON.stringify(a), updatedAt: Date.now() })
        .where(eq(schema.jobs.id, jobId)).returning();
      return row;
    }
    // Hobby Blob suspend/quota: keep the job at pdf/summary instead of Failed — cron nudge resumes when writable.
    if (isBlobCapacityError(e)) {
      const wait = Number(process.env.BLOB_HOLD_MS || 30 * 60_000);
      a.holdUntil = Date.now() + wait;
      a.blobHold = true;
      a.progressDetail = {
        stage: current,
        label: `Blob storage suspended/full — auto-retry in ${Math.max(1, Math.round(wait / 60_000))} min`,
      };
      console.warn(`job ${jobId} ${current}: blob capacity, holding ${Math.round(wait / 1000)}s`);
      const [row] = await db.update(schema.jobs)
        .set({ stage: current, error: null, artifacts: JSON.stringify(a), updatedAt: Date.now() })
        .where(eq(schema.jobs.id, jobId)).returning();
      return row;
    }
    const [row] = await db.update(schema.jobs)
      .set({ stage: "failed", error: `${current}: ${shortErr(e)}`, artifacts: JSON.stringify(a), updatedAt: Date.now() })
      .where(eq(schema.jobs.id, jobId)).returning();
    return row;
  }
}

/** "הרצאה N" only if the lecture's own (source) title carries a lecture number; the title chip already shows it otherwise. */
export function verifiedLectureLabel(title?: string | null): string | null {
  const m = /(?:הרצאה|שיעור|lecture|lec\.?)\s*(?:מס'?|no\.?|#)?\s*(\d{1,2})(?!\d|\s*[\/.]\s*\d)/i.exec(title ?? "");
  return m ? `הרצאה ${Number(m[1])}` : null;
}

/** Keep job errors short and readable (Google errors embed huge JSON). */
function shortErr(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/daily quota \(RPD\)/.test(m)) return m;
  if (/\b429\b|RESOURCE_EXHAUSTED/i.test(m)) return "Gemini rate limit / quota hit; retry later";
  return m.length > 400 ? m.slice(0, 400) + "…" : m;
}

export function isBlobCapacityError(e: unknown): boolean {
  const m = (e as Error)?.message ?? String(e);
  return /Vercel Blob:.*(quota exceeded|store has been suspended|Storage quota)/i.test(m)
    || /blob.*suspended|storage quota exceeded/i.test(m);
}

/** Hierarchical summary for long lectures: SUMMARY_HIERARCHICAL=auto (default; ASR span ≥ SUMMARY_HIER_MIN_MINUTES, default 65) | on | off. */
export function useHierarchical(tr: Transcript): boolean {
  const mode = (process.env.SUMMARY_HIERARCHICAL || "auto").toLowerCase();
  if (/^(0|off|false|no)$/.test(mode)) return false;
  if (!tr.segments?.length) return false;
  if (/^(1|on|true|yes|always)$/.test(mode)) return true;
  return asrSpan(tr) >= Number(process.env.SUMMARY_HIER_MIN_MINUTES || 65) * 60;
}
const HIER_BUDGET_MS = Number(process.env.SUMMARY_HIER_BUDGET_MS || 270_000);
/** No big gap but low ratio: target every uncovered stretch > 3 min. */
function gapsAll(c: Coverage): [number, number][] { return c.gaps.length ? c.gaps : c.holes.length ? c.holes : [[c.asrStart, c.asrEnd]]; }
