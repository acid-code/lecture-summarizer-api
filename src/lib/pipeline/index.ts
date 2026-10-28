import { eq } from "drizzle-orm";
import { db, ensureDb, schema } from "@/db";
import { STAGES, type Stage } from "@/db/schema";
import { getProvider, type LectureContext, type Repair, type Transcript, type LectureSummary } from "../providers";
import { saveArtifact } from "../storage";
import { renderStudyHtml } from "./render";

/**
 * Runs exactly ONE stage per call so each invocation fits the Vercel Hobby 300s limit.
 * Call repeatedly (client polling, cron, or Vercel Workflows later) until stage === "done".
 * Stages are idempotent: artifacts are stored per stage, so a failed job can be re-advanced.
 */
export async function advanceJob(jobId: string) {
  await ensureDb();
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  if (!job) throw new Error("job not found");
  if (job.stage === "done") return job;
  const lecture = (await db.query.lectures.findFirst({ where: eq(schema.lectures.id, job.lectureId) }))!;
  const course = await db.query.courses.findFirst({ where: eq(schema.courses.id, lecture.courseId) });
  const ctx: LectureContext = { title: lecture.title, slidesUrl: lecture.slidesUrl, courseContextUrl: course?.contextPdfUrl };
  const a = JSON.parse(job.artifacts) as { asr?: Transcript; repair?: Repair[]; summary?: LectureSummary; pdf?: string };
  const ai = getProvider();

  // A failed job retries from the first stage without an artifact.
  const current: Stage = job.stage === "failed" ? (["asr", "repair", "summary", "pdf"] as const).find((s) => !a[s]) ?? "done" : job.stage;
  const next = STAGES[STAGES.indexOf(current) + 1] as Stage | undefined;
  try {
    switch (current) {
      case "queued":
        break;
      case "asr":
        if (!lecture.audioUrl && ai.name !== "mock") throw new Error("lecture has no audio");
        a.asr = await ai.transcribe(lecture.audioUrl ?? "", ctx);
        break;
      case "repair":
        a.repair = await ai.repairTerms(a.asr!, ctx); // TODO: He/En term repair (core of the project)
        break;
      case "summary":
        a.summary = await ai.summarize(a.asr!, a.repair ?? [], ctx);
        break;
      case "pdf":
        a.pdf = await saveArtifact(`${lecture.id}-study.html`, renderStudyHtml(a.summary!), "text/html; charset=utf-8");
        break;
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
