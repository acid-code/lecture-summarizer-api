import { parseDensity } from "@/lib/providers/types";
import { authenticate } from "@/lib/auth";
import { notFound } from "@/lib/http";
import { getProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Hobby max; GET /v1/jobs/{id} may run one stage.
type Ctx = { params: Promise<{ path: string[] }> };

async function route(req: Request, { params }: Ctx) {
  const p = (await params).path;
  const m = req.method;
  if (m === "GET" && p.join("/") === "health")
    return Response.json({ ok: true, provider: getProvider().name, blob: !!process.env.BLOB_READ_WRITE_TOKEN, commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, figures: process.env.FIGURES ?? "on" });

  // Admin ops before device auth. Cron: Bearer CRON_SECRET (or x-vercel-cron when unset). Manual: POST + API_TOKEN.
  if (p[0] === "admin" && (p[1] === "blob-gc" || p[1] === "job-nudge") && !p[2] && (m === "POST" || m === "GET")) {
    const authz = req.headers.get("authorization") ?? "";
    const cronSecret = process.env.CRON_SECRET;
    const cronOk = (cronSecret && authz === `Bearer ${cronSecret}`)
      || (!cronSecret && req.headers.get("x-vercel-cron") === "1");
    const tokenOk = !process.env.API_TOKEN || authz === `Bearer ${process.env.API_TOKEN}`;
    if (m === "GET" ? !cronOk : !tokenOk) return Response.json({ error: "unauthorized" }, { status: 401 });
    const h0 = await import("@/lib/v1/handlers");
    try { await h0.ensureDb(); } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 503 });
    }
    const dry = new URL(req.url).searchParams.get("dry_run") === "1";
    if (p[1] === "blob-gc") {
      const { runBlobGc } = await import("@/lib/blob-gc");
      const gc = await runBlobGc({ dryRun: dry, orphans: true });
      // After reclaiming quota, immediately unstick soft-held jobs (Hobby allows only daily crons).
      const { runJobNudge } = await import("@/lib/job-nudge");
      const nudge = await runJobNudge({ dryRun: dry });
      return Response.json({ ...gc, nudge });
    }
    const { runJobNudge } = await import("@/lib/job-nudge");
    return Response.json(await runJobNudge({ dryRun: dry }));
  }

  const auth = authenticate(req); if (auth instanceof Response) return auth;
  const dev = auth.deviceId;
  // Load handlers/db only after health so /v1/health never initializes the DB.
  const h = await import("@/lib/v1/handlers");
  try { await h.ensureDb(); } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
  const [a, b, c, d] = p;
  if (a === "quota" && !b && m === "GET") {
    const { cooldowns } = await import("@/lib/providers/quota");
    return Response.json({ exhausted: await cooldowns() });
  }
  try {
    if (a === "devices" && b === "claim" && !c && m === "POST") return h.claimCourses(req, dev);
    if (a === "devices" && b === "me" && !c && m === "GET") return Response.json({ device_id: dev });
    if(a==="lectures"&&b&&(c==="tutor"||c==="move")&&m==="POST"&&!dev)return Response.json({error:"device_required"},{status:401});
    // Ownership gate: anything addressed by id must belong to this device (else 404, never 403).
    // Covers every GET/POST/DELETE under /courses/{id}, /lectures/{id}, /jobs/{id} (files, segments, markers, process, retry, ...).
    if (a === "courses" && b && !(await h.ownsCourse(dev, b))) return notFound();
    if (a === "lectures" && b && !(await h.ownsLecture(dev, b))) return notFound();
    if (a === "jobs" && b && !(await h.ownsJob(dev, b))) return notFound();
    if (a === "courses" && !b) return m === "POST" ? h.createCourse(req, dev) : h.listCourses(dev);
    if (a === "courses" && b && !c && m === "DELETE") return h.deleteCourse(b);
    if (a === "courses" && b && c === "context" && m === "POST") return h.uploadContext(req, b);
    if (a === "courses" && b && c === "files") {
      if (m === "GET" && !d) return h.listCourseFiles(b);
      if (m === "GET" && d) return h.getCourseFile(b, d);
      if (m === "DELETE") return h.deleteCourseFile(b, d);
    }
    if (a === "uploads" && !b && m === "POST") return h.createUpload(req);
    if (a === "lectures" && !b && m === "POST") return h.createLecture(req, dev);
    if (a === "lectures" && b) {
      if (!c && m === "GET") return h.getLecture(b);
      if (c === "move" && !d && m === "POST") return h.moveLecture(req,b,dev);
      if(c==="tutor"&&!d&&m==="POST"){const {tutorHandler}=await import("@/lib/study/handler");return tutorHandler(req,b,dev);}
      if (!c && m === "DELETE") return h.deleteLecture(b);
      if (c === "slides" && !d && m === "GET") return h.slideCapabilities(b);
      if (c === "slides" && !d && m === "DELETE") return h.clearLectureSlides(b);
      if (c === "slides" && m === "POST") return h.uploadSlides(req, b);
      if (c === "context" && m === "POST") {
        const courseId = await h.lectureCourseId(b);
        return courseId ? h.uploadContext(req, courseId) : notFound();
      }
      if (c === "context" && m === "DELETE") {
        const courseId = await h.lectureCourseId(b);
        return courseId ? h.deleteCourseFile(courseId, undefined) : notFound();
      }
      if (c === "audio" && d === "segments" && m === "POST") return h.uploadSegment(req, b);
      if (c === "markers" && m === "POST") return h.uploadMarkers(req, b);
      if (c === "transcript" && d === "import" && m === "POST") return h.importTranscript(req, b);
      if (c === "process" && m === "POST") return h.startProcess(req, b);
      if (m === "GET" && c === "files" && !d) return h.listFiles(b);
      if (m === "GET" && c === "files" && d) return h.getFile(b, d);
      if (m === "GET" && c === "transcript" && !d) return h.getTranscript(b);
      if (m === "GET" && c === "summaries") return h.listSummaries(b);
      if (m === "GET" && c === "summary.pdf") return h.summaryFile(b, "pdf", parseDensity(new URL(req.url).searchParams.get("density")));
      if (m === "GET" && c === "summary.html") return h.summaryFile(b, "html", parseDensity(new URL(req.url).searchParams.get("density")));
      if (m === "GET" && c === "summary.json") return h.summaryFile(b, "json", parseDensity(new URL(req.url).searchParams.get("density")));
    }
    if (a === "jobs" && !b && m === "GET") return h.listJobs(dev);
    if (a === "jobs" && b) {
      if (!c && m === "DELETE") return h.deleteJob(b);
      if (!c && m === "GET") return h.getJob(b, process.env.AUTO_ADVANCE_ON_POLL !== "false" && new URL(req.url).searchParams.get("advance") !== "0");
      if (c === "advance" && m === "POST") return h.postAdvance(b);
      if (c === "retry" && m === "POST") return h.postRetry(req, b);
      if (c === "cancel" && m === "POST") return h.postCancel(b);
      if (c === "reprocess" && m === "POST") return h.postReprocess(req, b);
      if (c === "rerepair" && m === "POST") return h.postRerepair(req, b);
      if (c === "resummarize" && m === "POST") return h.postResummarize(req, b);
    }
  } catch (e) {
    if(a==="lectures"&&c==="tutor")return Response.json({error:"tutor_unavailable"},{status:503});
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  return notFound();
}
export { route as GET, route as POST, route as DELETE };
