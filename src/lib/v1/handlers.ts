/**
 * /v1 API — the contract the Android app (HttpLectureApi.kt) calls. snake_case JSON.
 * Uploads are multipart through the function (local/self-hosted). On Vercel the 4.5 MB body limit applies:
 * use POST /api/upload (Blob client upload) + POST /v1/lectures/{id}/audio/segments with JSON {seq,...,url}.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensureDb, schema } from "@/db";
import { pdfToText } from "../context";
import { isPptx, pptxToText } from "../pptx";
import { bad, id, notFound } from "../http";
import { advanceJob, progressOf, resummarizeJob, retryJob, type Artifacts } from "../pipeline";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { blobAccess, isAcceptableUploadUrl, readFileUrl, saveFile } from "../storage";

const j = (b: unknown, status = 200) => Response.json(b, { status });

async function form(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const json = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (json && typeof json.url === "string" && !isAcceptableUploadUrl(json.url)) throw new Error("url must be a Vercel Blob URL from POST /v1/uploads");
    return { json, fd: null };
  }
  return { json: null, fd: await req.formData() };
}

async function fileFrom(fd: FormData, dir: "uploads", prefix: string) {
  const f = fd.get("file");
  if (!(f instanceof File)) return null;
  const data = Buffer.from(await f.arrayBuffer());
  const mime = f.type || "application/octet-stream";
  return { data, mime, url: await saveFile(dir, `${prefix}-${f.name || "file"}`, data, mime), name: f.name };
}

const lectureOr404 = (lid: string) => db.query.lectures.findFirst({ where: eq(schema.lectures.id, lid) });

export async function createCourse(req: Request) {
  const p = z.object({ name: z.string().min(1), lang_primary: z.string().default("he") }).safeParse(await req.json().catch(() => null));
  if (!p.success) return bad(p.error.message);
  const course_id = id();
  await db.insert(schema.courses).values({ id: course_id, name: p.data.name, langPrimary: p.data.lang_primary, createdAt: Date.now() });
  return j({ course_id, name: p.data.name }, 201);
}

export async function listCourses() {
  const rows = await db.select({ course_id: schema.courses.id, name: schema.courses.name, has_context: schema.courses.contextPdfUrl }).from(schema.courses);
  return j(rows.map((r) => ({ ...r, has_context: !!r.has_context })));
}

export async function createLecture(req: Request) {
  const p = z.object({ course_id: z.string(), title: z.string().min(1), recorded_at: z.string().optional() }).safeParse(await req.json().catch(() => null));
  if (!p.success) return bad(p.error.message);
  if (!(await db.query.courses.findFirst({ where: eq(schema.courses.id, p.data.course_id) }))) return notFound();
  const lecture_id = id();
  await db.insert(schema.lectures).values({ id: lecture_id, courseId: p.data.course_id, title: p.data.title, recordedAt: p.data.recorded_at, createdAt: Date.now() });
  return j({ lecture_id }, 201);
}

export async function getLecture(lid: string) {
  const l = await lectureOr404(lid); if (!l) return notFound();
  const segs = await db.select().from(schema.segments).where(eq(schema.segments.lectureId, lid));
  const jobs = await db.select({ job_id: schema.jobs.id, stage: schema.jobs.stage }).from(schema.jobs).where(eq(schema.jobs.lectureId, lid));
  return j({ lecture_id: l.id, course_id: l.courseId, title: l.title, recorded_at: l.recordedAt, slides: !!l.slidesUrl,
    markers: JSON.parse(l.markers), segments: segs.map((s) => ({ seq: s.seq, duration: s.duration, stored: !!s.url })), jobs,
    files: await filesOf(l, segs) });
}

/** All materials of a lecture: slide decks (new table, or the legacy single slides_url) + audio segments. */
async function filesOf(l: typeof schema.lectures.$inferSelect, segs: (typeof schema.segments.$inferSelect)[]) {
  const rows = await db.select().from(schema.lectureFiles).where(eq(schema.lectureFiles.lectureId, l.id)).orderBy(schema.lectureFiles.createdAt);
  const docs = rows.map((f) => ({ file_id: f.id, kind: f.kind, name: f.name, mime: f.mime, size: f.size, stored: true,
    url: `/v1/lectures/${l.id}/files/${f.id}` }));
  if (!rows.length && l.slidesUrl) docs.push({ file_id: "legacy-slides", kind: "slides", name: l.slidesUrl.split("/").pop()!.replace(/^[\w]+-/, ""),
    mime: l.slidesUrl.endsWith(".pdf") ? "application/pdf" : "application/octet-stream", size: null, stored: true, url: `/v1/lectures/${l.id}/files/legacy-slides` });
  const audio = segs.sort((a, b) => a.seq - b.seq).map((s) => ({ file_id: `seg-${s.seq}`, kind: "audio", name: `Audio part ${s.seq + 1}`, mime: s.mime,
    size: null, stored: !!s.url, duration: s.duration, url: `/v1/lectures/${l.id}/files/seg-${s.seq}` }));
  return [...docs, ...audio];
}

/** GET /v1/lectures/{id}/files — materials list. */
export async function listFiles(lid: string) {
  const l = await lectureOr404(lid); if (!l) return notFound();
  const segs = await db.select().from(schema.segments).where(eq(schema.segments.lectureId, lid));
  return j(await filesOf(l, segs));
}

/** GET /v1/lectures/{id}/files/{fileId} — stream one stored material (private Blob → client). */
export async function getFile(lid: string, fid: string) {
  const l = await lectureOr404(lid); if (!l) return notFound();
  let url: string | null | undefined, mime = "application/octet-stream", name = fid;
  if (fid === "legacy-slides") { url = l.slidesUrl; name = url?.split("/").pop() ?? "slides"; }
  else if (fid.startsWith("seg-")) {
    const s = await db.query.segments.findFirst({ where: and(eq(schema.segments.lectureId, lid), eq(schema.segments.seq, Number(fid.slice(4)))) });
    url = s?.url; mime = s?.mime ?? mime; name = `${fid}.m4a`;
    if (s && !s.url) return j({ error: "audio was deleted after processing (raw-audio cleanup); the phone keeps its local copy" }, 410);
  } else {
    const f = await db.query.lectureFiles.findFirst({ where: and(eq(schema.lectureFiles.lectureId, lid), eq(schema.lectureFiles.id, fid)) });
    url = f?.url; mime = f?.mime ?? mime; name = f?.name ?? name;
  }
  if (!url) return notFound();
  const r = await readFileUrl(url);
  return new Response(new Uint8Array(r.data), { headers: { "content-type": r.mime || mime,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}` } });
}

/**
 * POST /v1/lectures/{id}/slides — ADDS a deck (PDF/PPTX). Several decks per lecture are supported; re-uploading the
 * same file name replaces that deck (idempotent retries). ?replace=all clears previous decks first (old one-slot behaviour).
 */
export async function uploadSlides(req: Request, lid: string) {
  const l = await lectureOr404(lid); if (!l) return notFound();
  const { fd, json } = await form(req);
  let url: string | undefined, data: Buffer | undefined, mime = "", name = "";
  if (fd) { const f = await fileFrom(fd, "uploads", `${lid}-slides`); if (!f) return bad("file required"); ({ url, data, mime } = f); name = f.name || "slides"; }
  else if (typeof json?.url === "string") {
    url = json.url; ({ data, mime = "" } = await readFileUrl(url));
    if (!mime && typeof json.mime === "string") mime = json.mime;
    name = typeof json.name === "string" && json.name ? json.name : decodeURIComponent(url.split("/").pop()!.split("?")[0]);
  }
  else return bad("multipart file or JSON {url, name?, mime?}");
  // Slide text for prompts (ASR bias, repair, summary): PDF via unpdf, PPTX via pure-JS unzip+XML. "\f" between slides.
  const slidesText = mime.includes("pdf") || url.endsWith(".pdf") || name.toLowerCase().endsWith(".pdf") ? await pdfToText(data!).catch(() => null)
    : isPptx(mime, url) || name.toLowerCase().endsWith(".pptx") ? (() => { try { return pptxToText(data!) || null; } catch (e) { console.error("pptx extract failed", e); return null; } })()
    : null;
  if (new URL(req.url).searchParams.get("replace") === "all") await db.delete(schema.lectureFiles).where(eq(schema.lectureFiles.lectureId, lid));
  else await db.delete(schema.lectureFiles).where(and(eq(schema.lectureFiles.lectureId, lid), eq(schema.lectureFiles.name, name)));
  // Migrate a legacy one-slot deck into the table the first time a lecture gets a second file.
  const existing = await db.select().from(schema.lectureFiles).where(eq(schema.lectureFiles.lectureId, lid));
  if (!existing.length && l.slidesUrl && l.slidesUrl !== url && new URL(req.url).searchParams.get("replace") !== "all")
    await db.insert(schema.lectureFiles).values({ id: id(), lectureId: lid, kind: "slides", name: l.slidesUrl.split("/").pop()!, mime: "application/octet-stream",
      url: l.slidesUrl, text: l.slidesText, createdAt: l.createdAt });
  await db.insert(schema.lectureFiles).values({ id: id(), lectureId: lid, kind: "slides", name, mime: mime || "application/octet-stream", url, text: slidesText,
    size: data?.length ?? null, createdAt: Date.now() });
  const all = await db.select().from(schema.lectureFiles).where(eq(schema.lectureFiles.lectureId, lid)).orderBy(schema.lectureFiles.createdAt);
  const combined = all.filter((f) => f.text).map((f) => (all.length > 1 ? `=== ${f.name} ===\n` : "") + f.text).join("\f") || null;
  await db.update(schema.lectures).set({ slidesUrl: all[0]?.url ?? url, slidesText: combined }).where(eq(schema.lectures.id, lid));
  return j({ ok: true, slides_text_chars: slidesText?.length ?? 0, files: all.length });
}

/** Course-context pack. Stored on the COURSE (shared by all its lectures). Both URL shapes accepted. */
export async function uploadContext(req: Request, courseId: string) {
  const c = await db.query.courses.findFirst({ where: eq(schema.courses.id, courseId) }); if (!c) return notFound();
  const { fd, json } = await form(req);
  let url: string, data: Buffer;
  if (fd) { const f = await fileFrom(fd, "uploads", `${courseId}-context`); if (!f) return bad("file required"); ({ url, data } = f); }
  else if (typeof json?.url === "string") { url = json.url; ({ data } = await readFileUrl(url)); }
  else return bad("multipart file or JSON {url}");
  const text = await pdfToText(data).catch((e) => { throw new Error(`context PDF unreadable: ${e.message}`); });
  await db.update(schema.courses).set({ contextPdfUrl: url, contextText: text }).where(eq(schema.courses.id, courseId));
  return j({ ok: true, course_id: courseId, pages: text.split("\f").length, chars: text.length });
}

export async function uploadSegment(req: Request, lid: string) {
  const l = await lectureOr404(lid); if (!l) return notFound();
  const { fd, json } = await form(req);
  const get = (k: string) => (fd ? fd.get(k) : json?.[k]) as string | number | null | undefined;
  const seq = Number(get("seq"));
  if (!Number.isInteger(seq)) return bad("seq required");
  let url: string, mime = "audio/mp4";
  if (fd) { const f = await fileFrom(fd, "uploads", `${lid}-seg${seq}`); if (!f) return bad("file required"); url = f.url; if (f.mime.startsWith("audio/")) mime = f.mime; }
  else if (typeof json?.url === "string") { url = json.url; mime = (json.mime as string) || mime; }
  else return bad("multipart file or JSON {url}");
  const duration = get("duration") != null ? Number(get("duration")) : null;
  // Idempotent per (lecture, seq): a retried upload replaces the previous row.
  await db.delete(schema.segments).where(and(eq(schema.segments.lectureId, lid), eq(schema.segments.seq, seq)));
  await db.insert(schema.segments).values({ id: id(), lectureId: lid, seq, startedAt: (get("started_at") as string) ?? null, duration, url, mime, createdAt: Date.now() });
  return j({ ok: true, seq }, 201);
}

export async function uploadMarkers(req: Request, lid: string) {
  const p = z.array(z.object({ t_sec: z.number(), page: z.number().int().optional(), label: z.string().optional() })).safeParse(await req.json().catch(() => null));
  if (!p.success) return bad(p.error.message);
  const [row] = await db.update(schema.lectures).set({ markers: JSON.stringify(p.data) }).where(eq(schema.lectures.id, lid)).returning();
  return row ? j({ ok: true, count: p.data.length }) : notFound();
}

export async function startProcess(req: Request, lid: string) {
  if (!(await lectureOr404(lid))) return notFound();
  const options = (await req.json().catch(() => ({})))?.options ?? {};
  const job_id = id();
  await db.insert(schema.jobs).values({ id: job_id, lectureId: lid, stage: "queued", artifacts: JSON.stringify({ options }), updatedAt: Date.now() });
  return j({ job_id }, 202);
}

function jobView(job: typeof schema.jobs.$inferSelect) {
  const a = JSON.parse(job.artifacts) as Artifacts;
  const state = job.stage === "done" ? "done" : job.stage === "failed" ? "failed" : job.stage === "queued" ? "queued" : "running";
  return { job_id: job.id, lecture_id: job.lectureId, state, stage: job.stage, progress: progressOf(job.stage), error: job.error,
    pdf_ready: !!a.pdf, transcript_ready: !!(a.repaired ?? a.asr)?.segments?.length, transcript_thin: a.summary?.transcript_thin ?? null,
    updated_at: new Date(job.updatedAt).toISOString(), repairs: a.repair ?? null };
}

/**
 * Android only polls GET /v1/jobs/{id}; it never calls /advance. So by default a poll also runs one unit of work
 * (AUTO_ADVANCE_ON_POLL=false to disable, e.g. when a cron/worker advances jobs).
 */
export async function getJob(jid: string, advance: boolean) {
  let job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jid) });
  if (!job) return notFound();
  if (advance && job.stage !== "done" && job.stage !== "failed") job = await advanceJob(jid);
  return j(jobView(job));
}

export async function postAdvance(jid: string) {
  try { return j(jobView(await advanceJob(jid))); } catch { return notFound(); }
}

/** POST /v1/jobs/{id}/retry[?force=1] — reset failed/stuck job to first incomplete stage, keep finished stage outputs. */
export async function postRetry(req: Request, jid: string) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const r = await retryJob(jid, force);
  if (!r.ok && r.reason === "not_found") return notFound();
  if (!r.ok) return j({ ...jobView(r.job!), error: `job is ${r.job!.stage}; only failed or stuck jobs can be retried (use ?force=1 for a running job)` }, 409);
  return j(jobView(r.job), 202);
}

/** GET /v1/jobs — 20 most recent jobs, for debugging without the phone's job id. */
export async function listJobs() {
  const rows = await db.select({ job_id: schema.jobs.id, lecture_id: schema.jobs.lectureId, stage: schema.jobs.stage, error: schema.jobs.error,
    updated_at: schema.jobs.updatedAt, title: schema.lectures.title })
    .from(schema.jobs).leftJoin(schema.lectures, eq(schema.lectures.id, schema.jobs.lectureId))
    .orderBy(desc(schema.jobs.updatedAt)).limit(20);
  return j(rows.map((r) => ({ ...r, state: r.stage === "done" || r.stage === "failed" || r.stage === "queued" ? r.stage : "running",
    updated_at: new Date(r.updated_at).toISOString() })));
}

/** GET /v1/lectures/{id}/transcript — repaired (else raw ASR) transcript from the newest job that has one. */
export async function getTranscript(lid: string) {
  const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.lectureId, lid)).orderBy(desc(schema.jobs.updatedAt));
  for (const job of jobs) {
    const a = JSON.parse(job.artifacts) as Artifacts;
    const t = a.repaired ?? a.asr;
    if (!t?.segments?.length) continue;
    return j({ lecture_id: lid, job_id: job.id, source: a.repaired ? "repaired" : "asr", complete: !!a.asrComplete, language: t.language,
      segments: t.segments.map((s) => ({ t0: s.start, t1: s.end, text: s.text })) });
  }
  return j({ error: "no transcript" }, 404);
}

/** POST /v1/jobs/{id}/resummarize[?force=1] — clear summary/pdf, keep ASR+repair, re-run from summary. */
export async function postResummarize(req: Request, jid: string) {
  const r = await resummarizeJob(jid, new URL(req.url).searchParams.get("force") === "1");
  if (!r.ok && r.reason === "not_found") return notFound();
  if (!r.ok) return j({ ...jobView(r.job!), error: "needs a done/failed job with complete ASR (use ?force=1 for a running job)" }, 409);
  return j(jobView(r.job), 202);
}

async function latestDone(lid: string) {
  const jobs = await db.select().from(schema.jobs).where(and(eq(schema.jobs.lectureId, lid), eq(schema.jobs.stage, "done")));
  return jobs.sort((x, y) => y.updatedAt - x.updatedAt)[0];
}

export async function summaryFile(lid: string, kind: "pdf" | "html" | "json") {
  const job = await latestDone(lid); if (!job) return j({ error: "no finished job" }, 404);
  const a = JSON.parse(job.artifacts) as Artifacts;
  if (kind === "json") return j({ summary: a.summary, repairs: a.repair, transcript: a.repaired ?? a.asr });
  const url = kind === "pdf" ? a.pdf : a.html;
  if (!url) return notFound();
  const isPdf = kind === "pdf" && !url.endsWith(".html");
  if (kind === "pdf" && !isPdf) return j({ error: "PDF renderer unavailable on this deployment; use summary.html" }, 501);
  const { data } = await readFileUrl(url);
  return new Response(new Uint8Array(data), { headers: { "content-type": isPdf ? "application/pdf" : "text/html; charset=utf-8" } });
}

export { ensureDb };

/**
 * POST /v1/uploads {filename, content_type, size?} → how the client should upload a large file.
 *  - Blob configured (Vercel): {mode:"blob", method:"PUT", put_url, headers} — client PUTs raw bytes there
 *    (bypasses the 4.5 MB function body limit); response JSON has `url`, which the client then sends as
 *    JSON {url} to the normal /v1 slides|context|segments endpoint.
 *  - No Blob (box/local): {mode:"multipart"} — keep using multipart to the /v1 endpoints.
 */
export async function createUpload(req: Request) {
  const p = z.object({ filename: z.string().min(1), content_type: z.string().min(1), size: z.number().optional() }).safeParse(await req.json().catch(() => null));
  if (!p.success) return bad(p.error.message);
  if (!process.env.BLOB_READ_WRITE_TOKEN) return j({ mode: "multipart" });
  const allowed = ["audio/", "application/pdf", "application/vnd.openxmlformats-officedocument.presentationml.presentation"];
  if (!allowed.some((a) => p.data.content_type.startsWith(a))) return bad("content_type not allowed");
  const pathname = `uploads/${id()}-${p.data.filename.replace(/[^\w.\-]/g, "_")}`;
  const token = await generateClientTokenFromReadWriteToken({
    pathname, maximumSizeInBytes: 200 * 1024 * 1024, allowedContentTypes: [p.data.content_type],
    validUntil: Date.now() + 60 * 60 * 1000, addRandomSuffix: true,
  });
  const apiBase = process.env.VERCEL_BLOB_API_URL || "https://vercel.com/api/blob";
  return j({
    mode: "blob", method: "PUT", pathname,
    put_url: `${apiBase}/?${new URLSearchParams({ pathname })}`,
    headers: {
      authorization: `Bearer ${token}`, "x-api-version": "13", "x-vercel-blob-access": blobAccess(),
      "x-content-type": p.data.content_type, "x-add-random-suffix": "1",
    },
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }, 201);
}

export async function lectureCourseId(lectureId: string): Promise<string | null> {
  const l = await db.query.lectures.findFirst({ where: eq(schema.lectures.id, lectureId) });
  return l?.courseId ?? null;
}
