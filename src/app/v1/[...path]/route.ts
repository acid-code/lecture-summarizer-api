import { checkAuth } from "@/lib/auth";
import { notFound } from "@/lib/http";
import { getProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Hobby max; GET /v1/jobs/{id} may run one stage.
type Ctx = { params: Promise<{ path: string[] }> };

async function route(req: Request, { params }: Ctx) {
  const p = (await params).path;
  const m = req.method;
  if (m === "GET" && p.join("/") === "health")
    return Response.json({ ok: true, provider: getProvider().name, blob: !!process.env.BLOB_READ_WRITE_TOKEN });
  const denied = checkAuth(req); if (denied) return denied;
  // Load handlers/db only after health so /v1/health never initializes the DB.
  const h = await import("@/lib/v1/handlers");
  try { await h.ensureDb(); } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
  const [a, b, c, d] = p;
  try {
    if (a === "courses" && !b) return m === "POST" ? h.createCourse(req) : h.listCourses();
    if (a === "courses" && b && c === "context" && m === "POST") return h.uploadContext(req, b);
    if (a === "uploads" && !b && m === "POST") return h.createUpload(req);
    if (a === "lectures" && !b && m === "POST") return h.createLecture(req);
    if (a === "lectures" && b) {
      if (!c && m === "GET") return h.getLecture(b);
      if (c === "slides" && m === "POST") return h.uploadSlides(req, b);
      if (c === "context" && m === "POST") {
        const courseId = await h.lectureCourseId(b);
        return courseId ? h.uploadContext(req, courseId) : notFound();
      }
      if (c === "audio" && d === "segments" && m === "POST") return h.uploadSegment(req, b);
      if (c === "markers" && m === "POST") return h.uploadMarkers(req, b);
      if (c === "process" && m === "POST") return h.startProcess(req, b);
      if (m === "GET" && c === "transcript") return h.getTranscript(b);
      if (m === "GET" && c === "summary.pdf") return h.summaryFile(b, "pdf");
      if (m === "GET" && c === "summary.html") return h.summaryFile(b, "html");
      if (m === "GET" && c === "summary.json") return h.summaryFile(b, "json");
    }
    if (a === "jobs" && !b && m === "GET") return h.listJobs();
    if (a === "jobs" && b) {
      if (!c && m === "GET") return h.getJob(b, process.env.AUTO_ADVANCE_ON_POLL !== "false" && new URL(req.url).searchParams.get("advance") !== "0");
      if (c === "advance" && m === "POST") return h.postAdvance(b);
      if (c === "retry" && m === "POST") return h.postRetry(req, b);
      if (c === "resummarize" && m === "POST") return h.postResummarize(req, b);
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  return notFound();
}
export { route as GET, route as POST };
