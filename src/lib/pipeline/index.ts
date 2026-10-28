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
  asr?: Transcript; asrParts?: number; asrComplete?: boolean; repair?: Repair[]; repaired?: Transcript;
  summary?: LectureSummary; html?: string; pdf?: string; audioDeleted?: boolean;
}

async function audioInputs(lectureId: string, legacyUrl: string | null): Promise<AudioInput[]> {
  const segs = await db.select().from(schema.segments).where(eq(schema.segments.lectureId, lectureId)).orderBy(asc(schema.segments.seq));
  let off = 0;
  const out: AudioInput[] = [];
  for (const s of segs) { if (s.url) out.push({ url: s.url, mime: s.mime, offsetSec: off }); off += s.duration ?? 0; }
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

  const current: Stage = job.stage === "failed"
    ? (!a.asrComplete ? "asr" : (["repair", "summary", "pdf"] as const).find((s) => !a[s]) ?? "done")
    : job.stage;
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
        const t = await ai.transcribe(list[done], ctx);
        a.asr = { language: t.language, segments: [...(a.asr?.segments ?? []), ...t.segments] };
        a.asrParts = done + 1;
        if (a.asrParts < list.length) next = "asr"; else a.asrComplete = true;
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
      .set({ stage: "failed", error: `${current}: ${(e as Error).message}`, artifacts: JSON.stringify(a), updatedAt: Date.now() })
      .where(eq(schema.jobs.id, jobId)).returning();
    return row;
  }
}
