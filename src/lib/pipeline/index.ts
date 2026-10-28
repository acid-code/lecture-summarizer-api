import { asc, eq } from "drizzle-orm";
import { db, ensureDb, schema } from "@/db";
import { STAGES, type Stage } from "@/db/schema";
import { retrieveExcerpts } from "../context";
import { htmlToPdf } from "../pdf";
import { getProvider, type AudioInput, type LectureContext, type Repair, type Transcript, type LectureSummary } from "../providers";
import { applyRepairs } from "../providers/prompts";
import { deleteFileUrl, saveArtifact } from "../storage";
import { renderStudyHtml } from "./render";

export interface Artifacts {
  asr?: Transcript; asrParts?: number; /** next ASR window start (s) inside the current part */ asrWindowStart?: number; asrComplete?: boolean; repair?: Repair[]; repaired?: Transcript;
  summary?: LectureSummary; html?: string; pdf?: string; audioDeleted?: boolean;
}

/** ASR window length (s): long audio is transcribed in windows so Gemini's JSON output is not truncated. */
const ASR_WINDOW_SEC = Number(process.env.ASR_WINDOW_SEC || 360);
const ASR_MAX_WINDOWS = 60;

async function audioInputs(lectureId: string, legacyUrl: string | null): Promise<AudioInput[]> {
  const segs = await db.select().from(schema.segments).where(eq(schema.segments.lectureId, lectureId)).orderBy(asc(schema.segments.seq));
  let off = 0;
  const out: AudioInput[] = [];
  for (const s of segs) { if (s.url) out.push({ url: s.url, mime: s.mime, offsetSec: off, durationSec: s.duration ?? undefined }); off += s.duration ?? 0; }
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
 * ASR runs one audio segment per call (stays in "asr" until all segments are transcribed).
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

  const current: Stage = job.stage === "failed" ? resumeStage(a) : job.stage;
  let next = STAGES[STAGES.indexOf(current) + 1] as Stage | undefined;
  try {
    switch (current) {
      case "queued":
        break;
      case "asr": {
        const inputs = await audioInputs(lecture.id, lecture.audioUrl);
        if (!inputs.length && ai.name !== "mock") throw new Error("lecture has no audio");
        const list = inputs.length ? inputs : [{ url: "", mime: "audio/mp4", offsetSec: 0 }];
        const done = a.asrParts ?? 0;
        const cur = list[done];
        const ws = a.asrWindowStart ?? 0;
        const known = cur.durationSec && cur.durationSec > 0;
        // Window when duration is unknown or longer than one window; short known parts go in one call.
        const windowed = ai.name !== "mock" && (!known || cur.durationSec! > ASR_WINDOW_SEC * 1.25);
        const we = windowed ? (known ? Math.min(cur.durationSec!, ws + ASR_WINDOW_SEC) : ws + ASR_WINDOW_SEC) : undefined;
        const t = await ai.transcribe(windowed ? { ...cur, windowStart: ws, windowEnd: we } : cur, ctx);
        a.asr = { language: t.language, segments: [...(a.asr?.segments ?? []), ...t.segments] };
        const partDone = !windowed || (known ? we! >= cur.durationSec! : (t.audioEnded || !t.segments.length || ws / ASR_WINDOW_SEC >= ASR_MAX_WINDOWS - 1));
        if (partDone) { a.asrParts = done + 1; a.asrWindowStart = 0; } else a.asrWindowStart = we;
        if ((a.asrParts ?? 0) < list.length) next = "asr"; else a.asrComplete = true;
        break;
      }
      case "repair":
        a.repair = await ai.repairTerms(a.asr!, ctx);
        a.repaired = applyRepairs(a.asr!, a.repair);
        break;
      case "summary":
        a.summary = await ai.summarize(a.repaired ?? a.asr!, a.repair ?? [], ctx);
        break;
      case "pdf": {
        const html = renderStudyHtml(a.summary!);
        a.html = await saveArtifact(`${lecture.id}-study.html`, html, "text/html; charset=utf-8");
        const pdf = await htmlToPdf(html).catch((e) => { console.warn("pdf render failed, HTML only:", e); return null; });
        a.pdf = pdf ? await saveArtifact(`${lecture.id}-study.pdf`, pdf, "application/pdf") : a.html;
        if (process.env.DELETE_RAW_AUDIO !== "false") { await cleanupAudio(lecture.id); a.audioDeleted = true; }
        break;
      }
    }
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
  if (/\b429\b|RESOURCE_EXHAUSTED/i.test(m)) return "Gemini free daily quota exhausted; retry after reset";
  return m.length > 400 ? m.slice(0, 400) + "…" : m;
}
