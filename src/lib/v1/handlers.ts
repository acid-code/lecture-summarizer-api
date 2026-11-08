import { memoryPairsHeader } from "../study/memory";
import { parseSlideRange, storedSlideRange, focusedDeckText, combineDeckText } from "../slide-ranges";
import { parseDensity, DENSITIES, type Density } from "../providers/types";
/**
 * /v1 API — the contract the Android app (HttpLectureApi.kt) calls. snake_case JSON.
 * Uploads are multipart through the function (local/self-hosted). On Vercel the 4.5 MB body limit applies:
 * use POST /api/upload (Blob client upload) + POST /v1/lectures/{id}/audio/segments with JSON {seq,...,url}.
 */
import { and, desc, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, ensureDb, schema } from "@/db";
import { pdfToText } from "../context";
import { isPptx, pptxToText } from "../pptx";
import { bad, id, notFound } from "../http";
import { dedupeTranscript } from "../providers/dedupe";
import { getProvider } from "../providers";
import { deleteFileUrl } from "../storage";
import { materialsText, advanceJob, progressOf, stageLabel, reprocessJob, rerepairJob, resummarizeJob, resumeStage, jobDensity, retryJob, type Artifacts } from "../pipeline";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { blobAccess, isAcceptableUploadUrl, readFileUrl, saveFile } from "../storage";
import { captionsUsable, normalizeSegments, parseSrt, type ImportSegment } from "../transcript-import";
import { cleanHebrew, stripNiqqud } from "../providers/prompts";

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

/** Ownership predicate on courses for a device (null = legacy client → unclaimed courses only). */
export const ownedBy = (dev: string | null): SQL => (dev === null ? isNull(schema.courses.deviceId) : eq(schema.courses.deviceId, dev)) as SQL;

export async function ownsCourse(dev: string | null, cid: string) {
  return !!(await db.query.courses.findFirst({ columns: { id: true }, where: and(eq(schema.courses.id, cid), ownedBy(dev)) }));
}
export async function ownsLecture(dev: string | null, lid: string) {
  const r = await db.select({ id: schema.lectures.id }).from(schema.lectures).innerJoin(schema.courses, eq(schema.courses.id, schema.lectures.courseId))
    .where(and(eq(schema.lectures.id, lid), ownedBy(dev))).limit(1);
  return r.length > 0;
}
export async function ownsJob(dev: string | null, jid: string) {
  const r = await db.select({ id: schema.jobs.id }).from(schema.jobs).innerJoin(schema.lectures, eq(schema.lectures.id, schema.jobs.lectureId))
    .innerJoin(schema.courses, eq(schema.courses.id, schema.lectures.courseId)).where(and(eq(schema.jobs.id, jid), ownedBy(dev))).limit(1);
  return r.length > 0;
}

/**
 * POST /v1/devices/claim {claim_course_ids:[...]} — attach UNCLAIMED legacy courses whose ids the client already knows
 * to this device. Never steals a course owned by another device; never bulk-claims unknown ids.
 */
export async function claimCourses(req: Request, dev: string | null) {
  if (dev === null) return bad("X-Device-Id required");
  const p = z.object({ claim_course_ids: z.array(z.string().min(1)).max(500).default([]) }).safeParse(await req.json().catch(() => ({})));
  if (!p.success) return bad(p.error.message);
  const ids = [...new Set(p.data.claim_course_ids)];
  const claimed: string[] = [], skipped: { course_id: string; reason: string }[] = [];
  for (const cid of ids) {
    const c = await db.query.courses.findFirst({ columns: { id: true, deviceId: true }, where: eq(schema.courses.id, cid) });
    if (!c) { skipped.push({ course_id: cid, reason: "not_found" }); continue; }
    if (c.deviceId === dev) { claimed.push(cid); continue; } // idempotent
    if (c.deviceId) { skipped.push({ course_id: cid, reason: "not_found" }); continue; } // don't leak other devices' ids
    await db.update(schema.courses).set({ deviceId: dev }).where(and(eq(schema.courses.id, cid), isNull(schema.courses.deviceId)));
    const after = await db.query.courses.findFirst({ columns: { deviceId: true }, where: eq(schema.courses.id, cid) });
    if (after?.deviceId === dev) claimed.push(cid); else skipped.push({ course_id: cid, reason: "not_found" });
  }
  return j({ device_id: dev, claimed, skipped });
}

export async function createCourse(req: Request, dev: string | null = null) {
  const p = z.object({ name: z.string().min(1), lang_primary: z.string().default("he") }).safeParse(await req.json().catch(() => null));
  if (!p.success) return bad(p.error.message);
  const course_id = id();
  await db.insert(schema.courses).values({ id: course_id, name: p.data.name, langPrimary: p.data.lang_primary, createdAt: Date.now(), deviceId: dev });
  return j({ course_id, name: p.data.name }, 201);
}

export async function listCourses(dev: string | null = null) {
  const rows = await db.select({ course_id: schema.courses.id, name: schema.courses.name, has_context: schema.courses.contextPdfUrl }).from(schema.courses).where(ownedBy(dev));
  return j(rows.map((r) => ({ ...r, has_context: !!r.has_context })));
}

export async function createLecture(req: Request, dev: string | null = null) {
  const p = z.object({ course_id: z.string(), title: z.string().min(1), recorded_at: z.string().optional() }).safeParse(await req.json().catch(() => null));
  if (!p.success) return bad(p.error.message);
  if (!(await ownsCourse(dev, p.data.course_id))) return notFound();
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
    slide_range:storedSlideRange(f.slideRange),url: `/v1/lectures/${l.id}/files/${f.id}` }));
  if (!rows.length && l.slidesUrl) docs.push({ file_id: "legacy-slides", kind: "slides", name: l.slidesUrl.split("/").pop()!.replace(/^[\w]+-/, ""),
    mime: l.slidesUrl.endsWith(".pdf") ? "application/pdf" : "application/octet-stream", size: null, stored: true, slide_range:null,url: `/v1/lectures/${l.id}/files/legacy-slides` });
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

/** DELETE /v1/lectures/{id}/slides — detach all decks, keeping audio/transcript/jobs.
 * Ownership is checked by the router before this handler. Detached blobs are retained
 * rather than eagerly deleted while a job may read them; retention cleanup is separate.
 */
export async function clearLectureSlides(lid: string) {
  const [lecture] = await db.select().from(schema.lectures).where(eq(schema.lectures.id, lid));
  if (!lecture) return notFound();
  await db.batch([
    db.delete(schema.lectureFiles).where(and(eq(schema.lectureFiles.lectureId, lid), eq(schema.lectureFiles.kind, "slides"))),
    db.update(schema.lectures).set({ slidesUrl: null, slidesText: null }).where(eq(schema.lectures.id, lid)),
  ]);
  return j({ ok: true, files: 0 });
}

/** Range-capability preflight avoids silently ignoring focus against an older API. Owner scoped by router. */
export async function slideCapabilities(lid:string){
  const l=await lectureOr404(lid);if(!l)return notFound();
  return j({range_support:true,files:await filesOf(l,[])});
}

/**
 * POST /v1/lectures/{id}/slides — ADDS a deck (PDF/PPTX). Several decks per lecture are supported; re-uploading the
 * same file name replaces that deck (idempotent retries). ?replace=all clears previous decks first (old one-slot behaviour).
 */
export async function uploadSlides(req: Request, lid: string) {
  const l = await lectureOr404(lid); if (!l) return notFound();
  let range:ReturnType<typeof parseSlideRange>;
  try{range=parseSlideRange(new URL(req.url).searchParams);}catch{return bad("invalid_slide_range");}
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
  const [replaced]=await db.select().from(schema.lectureFiles).where(and(eq(schema.lectureFiles.lectureId,lid),eq(schema.lectureFiles.name,name)));
  if(range){if(!slidesText)return bad("slide_range_requires_extractable_pages");try{focusedDeckText(name,slidesText,range);}catch{return bad("slide_range_exceeds_pages");}}
  if (new URL(req.url).searchParams.get("replace") === "all") await db.delete(schema.lectureFiles).where(eq(schema.lectureFiles.lectureId, lid));
  else await db.delete(schema.lectureFiles).where(and(eq(schema.lectureFiles.lectureId, lid), eq(schema.lectureFiles.name, name)));
  // Migrate a legacy one-slot deck into the table the first time a lecture gets a second file.
  const existing = await db.select().from(schema.lectureFiles).where(eq(schema.lectureFiles.lectureId, lid));
  if (!replaced && !existing.length && l.slidesUrl && l.slidesUrl !== url && new URL(req.url).searchParams.get("replace") !== "all")
    await db.insert(schema.lectureFiles).values({ id: id(), lectureId: lid, kind: "slides", name: l.slidesUrl.split("/").pop()!, mime: "application/octet-stream",
      url: l.slidesUrl, text: l.slidesText, createdAt: l.createdAt });
  await db.insert(schema.lectureFiles).values({ id: id(), lectureId: lid, kind: "slides", name, mime: mime || "application/octet-stream", url, text: slidesText,slideRange:range?JSON.stringify(range):null,
    size: data?.length ?? null, createdAt: new URL(req.url).searchParams.get("replace")==="all"?Date.now():(replaced?.createdAt ?? Date.now()) });
  const all = await db.select().from(schema.lectureFiles).where(eq(schema.lectureFiles.lectureId, lid)).orderBy(schema.lectureFiles.createdAt);
  const combined = combineDeckText(all);
  await db.update(schema.lectures).set({ slidesUrl: all[0]?.url ?? url, slidesText: combined }).where(eq(schema.lectures.id, lid));
  return j({ ok: true, slides_text_chars: slidesText?.length ?? 0, files: all.length,slide_range:range });
}

export const MAX_COURSE_FILES = 3;

/** Rebuild courses.context_url/context_text from course_files (all files joined; each file's first page tagged). */
async function syncCourseContext(courseId: string) {
  const all = await db.select().from(schema.courseFiles).where(eq(schema.courseFiles.courseId, courseId)).orderBy(schema.courseFiles.createdAt);
  const text = all.filter((f) => f.text).map((f) => (all.length > 1 ? `=== ${f.name} ===\n` : "") + f.text).join("\f") || null;
  await db.update(schema.courses).set({ contextPdfUrl: all[0]?.url ?? null, contextText: text }).where(eq(schema.courses.id, courseId));
  return all;
}

/** Move a legacy single context PDF into course_files (once). */
async function migrateLegacyContext(c: typeof schema.courses.$inferSelect) {
  const n = await db.select({ id: schema.courseFiles.id }).from(schema.courseFiles).where(eq(schema.courseFiles.courseId, c.id));
  if (n.length || !c.contextPdfUrl) return;
  await db.insert(schema.courseFiles).values({ id: id(), courseId: c.id, name: decodeURIComponent(c.contextPdfUrl.split("/").pop()!.split("?")[0]),
    mime: "application/pdf", url: c.contextPdfUrl, text: c.contextText, createdAt: c.createdAt });
}

/**
 * POST course context (course- or lecture-addressed). Course context = up to 3 PDFs/PPTX, all sent with every lecture.
 * Default (old clients): REPLACES all context files with this one. ?mode=add adds (same name → replaced); 409 when 3 already.
 */
export async function uploadContext(req: Request, courseId: string) {
  const c = await db.query.courses.findFirst({ where: eq(schema.courses.id, courseId) }); if (!c) return notFound();
  const add = new URL(req.url).searchParams.get("mode") === "add";
  const { fd, json } = await form(req);
  let url: string, data: Buffer, mime = "", name = "";
  if (fd) { const f = await fileFrom(fd, "uploads", `${courseId}-context`); if (!f) return bad("file required"); ({ url, data, mime } = f); name = f.name || "context.pdf"; }
  else if (typeof json?.url === "string") {
    url = json.url; ({ data, mime = "" } = await readFileUrl(url));
    if (!mime && typeof json.mime === "string") mime = json.mime;
    name = typeof json.name === "string" && json.name ? json.name : decodeURIComponent(url.split("/").pop()!.split("?")[0]);
  }
  else return bad("multipart file or JSON {url, name?, mime?}");
  const pptx = isPptx(mime, url) || name.toLowerCase().endsWith(".pptx");
  const text = pptx ? pptxToText(data) : await pdfToText(data).catch((e) => { throw new Error(`context PDF unreadable: ${e.message}`); });
  if (add) {
    await migrateLegacyContext(c);
    await db.delete(schema.courseFiles).where(and(eq(schema.courseFiles.courseId, courseId), eq(schema.courseFiles.name, name)));
    const n = await db.select({ id: schema.courseFiles.id }).from(schema.courseFiles).where(eq(schema.courseFiles.courseId, courseId));
    if (n.length >= MAX_COURSE_FILES) return j({ error: `course already has ${MAX_COURSE_FILES} context files; remove one first` }, 409);
  } else await db.delete(schema.courseFiles).where(eq(schema.courseFiles.courseId, courseId));
  await db.insert(schema.courseFiles).values({ id: id(), courseId, name, mime: mime || (pptx ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/pdf"),
    url, text, size: data.length, createdAt: Date.now() });
  const all = await syncCourseContext(courseId);
  return j({ ok: true, course_id: courseId, pages: text.split("\f").length, chars: text.length, files: all.length, max_files: MAX_COURSE_FILES });
}

/** GET /v1/courses/{id}/files — course context files. */
export async function listCourseFiles(courseId: string) {
  const c = await db.query.courses.findFirst({ where: eq(schema.courses.id, courseId) }); if (!c) return notFound();
  await migrateLegacyContext(c);
  const rows = await db.select().from(schema.courseFiles).where(eq(schema.courseFiles.courseId, courseId)).orderBy(schema.courseFiles.createdAt);
  return j({ max_files: MAX_COURSE_FILES, files: rows.map((f) => ({ file_id: f.id, name: f.name, mime: f.mime, size: f.size,
    chars: f.text?.length ?? 0, url: `/v1/courses/${courseId}/files/${f.id}` })) });
}

export async function getCourseFile(courseId: string, fid: string) {
  const f = await db.query.courseFiles.findFirst({ where: and(eq(schema.courseFiles.courseId, courseId), eq(schema.courseFiles.id, fid)) });
  if (!f) return notFound();
  const r = await readFileUrl(f.url);
  return new Response(new Uint8Array(r.data), { headers: { "content-type": r.mime || f.mime,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(f.name)}` } });
}

/** DELETE /v1/courses/{id}/files/{fileId} (or /files?all=1 to clear). */
export async function deleteCourseFile(courseId: string, fid: string | undefined) {
  const c = await db.query.courses.findFirst({ where: eq(schema.courses.id, courseId) }); if (!c) return notFound();
  await migrateLegacyContext(c);
  if (fid) await db.delete(schema.courseFiles).where(and(eq(schema.courseFiles.courseId, courseId), eq(schema.courseFiles.id, fid)));
  else await db.delete(schema.courseFiles).where(eq(schema.courseFiles.courseId, courseId));
  const all = await syncCourseContext(courseId);
  return j({ ok: true, files: all.length });
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
  const l = await lectureOr404(lid); if (!l) return notFound();
  const options = (await req.json().catch(() => ({})))?.options ?? {};
  { // density: single level; densities: several levels (one summary job each, ASR shared)
    const ds = (Array.isArray(options.densities) ? options.densities : []).map(parseDensity).filter(Boolean) as Density[];
    const d0 = parseDensity(options.density) ?? ds[0] ?? "standard";
    options.density = d0; options.densities = ds.length > 1 ? [...new Set(ds)] : undefined;
  }
  // Need audio or materials (lecture decks, or course files) — slides-only summaries don't need a recording.
  const segs = await db.select().from(schema.segments).where(eq(schema.segments.lectureId, lid));
  const course = await db.query.courses.findFirst({ where: eq(schema.courses.id, l.courseId) });
  if (!segs.some((s) => s.url) && !l.audioUrl && !materialsText(l, course) && getProvider().name !== "mock")
    return j({ error: "lecture has no audio and no slides/PDF materials", audio_missing: true }, 409);
  // Reuse a live (ASR-while-recording) job: options.live keeps it in ASR waiting for more parts; a final call without
  // live clears the flag so the same job (with its finished ASR) continues to repair → summary → pdf.
  const prev = await db.query.jobs.findFirst({ where: and(eq(schema.jobs.lectureId, lid), ne(schema.jobs.stage, "done")), orderBy: desc(schema.jobs.updatedAt) });
  const pa = prev ? JSON.parse(prev.artifacts) as Artifacts & { options?: { live?: boolean } } : null;
  if (prev && pa?.options?.live) {
    if (!options.live || prev.stage === "failed") { // failed (e.g. 429) live jobs resume on the next upload
      pa.options = { ...pa.options, ...options, live: !!options.live };
      await db.update(schema.jobs).set({ artifacts: JSON.stringify(pa), updatedAt: Date.now(),
        ...(prev.stage === "failed" ? { stage: resumeStage(pa), error: null } : {}) }).where(eq(schema.jobs.id, prev.id));
    }
    return j({ job_id: prev.id, live: !!options.live }, 202);
  }
  const job_id = id();
  await db.insert(schema.jobs).values({ id: job_id, lectureId: lid, stage: "queued", artifacts: JSON.stringify({ options }), updatedAt: Date.now() });
  return j({ job_id, live: !!options.live }, 202);
}

/**
 * POST /v1/lectures/{id}/transcript/import — use an external timed transcript (e.g. TAU Panopto captions) as the job's ASR.
 * Body: JSON { source?, external_id?, title?, language?, segments?: [{t0|start, t1|end, text}], srt? }
 * or a raw SRT body (Content-Type: application/x-subrip / text/plain). No audio needed: the job starts at "repair".
 */
export async function importTranscript(req: Request, lid: string) {
  const l = await lectureOr404(lid); if (!l) return notFound();
  const ct = req.headers.get("content-type") ?? "";
  let body: { source?: string; external_id?: string; title?: string; language?: string; segments?: ImportSegment[]; srt?: string; video_duration_sec?: number };
  if (ct.includes("application/json")) body = (await req.json().catch(() => null)) ?? {};
  else body = { srt: await req.text() };
  const url = new URL(req.url).searchParams;
  const course = await db.query.courses.findFirst({ where: eq(schema.courses.id, l.courseId) });
  const language = body.language || url.get("language") || course?.langPrimary || "he";
  const asr = typeof body.srt === "string" && body.srt.trim() ? parseSrt(body.srt, language)
    : Array.isArray(body.segments) ? normalizeSegments(body.segments, language) : null;
  if (!asr) return j({ error: "provide segments[] or an SRT body" }, 400);
  if (!asr.segments.length) return j({ error: "transcript has no timed segments" }, 422);
  const videoDurationSec = Number(body.video_duration_sec ?? url.get("video_duration_sec"));
  if (!captionsUsable(asr, Number.isFinite(videoDurationSec) ? videoDurationSec : null)) {
    return j({ error: "captions too short relative to video length; use audio instead", code: "transcript_thin_vs_video",
      video_duration_sec: Number.isFinite(videoDurationSec) ? videoDurationSec : null,
      caption_end_sec: Math.max(...asr.segments.map((s) => s.end)),
      caption_chars: asr.segments.reduce((n, s) => n + s.text.trim().length, 0) }, 422);
  }
  const source = String(body.source || url.get("source") || "panopto").slice(0, 40);
  const externalId = body.external_id ?? url.get("external_id") ?? undefined;
  if (typeof body.title === "string" && body.title.trim()) await db.update(schema.lectures).set({ title: body.title.trim() }).where(eq(schema.lectures.id, lid));
  const a: Artifacts = { asr, asrComplete: true, asrSource: source, asrExternalId: externalId, progressDetail: { stage: "repair", label: stageLabel("repair") } };
  const job_id = id();
  await db.insert(schema.jobs).values({ id: job_id, lectureId: lid, stage: "repair", artifacts: JSON.stringify({ ...a, options: { source } }), updatedAt: Date.now() });
  const segs = asr.segments;
  return j({ job_id, source, segments: segs.length, start_sec: segs[0].start, end_sec: Math.max(...segs.map((s) => s.end)) }, 202);
}

function jobView(job: typeof schema.jobs.$inferSelect) {
  const a = JSON.parse(job.artifacts) as Artifacts;
  const state = job.stage === "done" ? "done" : job.stage === "failed" ? "failed" : job.stage === "queued" ? "queued" : "running";
  return { job_id: job.id, lecture_id: job.lectureId, density: jobDensity(a), state, stage: job.stage, progress: progressOf(job.stage), error: job.error,
    pdf_ready: !!a.pdf, asr_source: a.asrSource ?? "audio", slides_only: !!a.slidesOnly, transcript_ready: !!(a.repaired ?? a.asr)?.segments?.length, transcript_thin: a.summary?.transcript_thin ?? null,
    asr_incomplete: !!a.asrIncomplete, asr_check: a.asrCheck ?? null, coverage: a.coverage ?? null,
    warning: a.asrIncomplete ? `ASR incomplete — reprocess needed (transcript ends ${Math.round((a.asrCheck?.asrEndSec ?? 0) / 60)} of ${Math.round((a.asrCheck?.uploadedSec ?? 0) / 60)} min uploaded)` : a.coverage && !a.coverage.ok ? `Summary covers ${Math.round(a.coverage.ratio * 100)}% of the lecture` : null,
    updated_at: new Date(job.updatedAt).toISOString(), repairs: a.repair ?? null,
    progress_detail: job.stage === "failed" || job.stage === "done" || a.progressDetail?.stage !== job.stage
      ? { stage: job.stage, label: job.stage === "asr" ? `ASR part ${(a.asrParts ?? 0) + 1}` : stageLabel(job.stage) }
      : a.progressDetail };
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
export async function listJobs(dev: string | null = null) {
  const rows = await db.select({ job_id: schema.jobs.id, lecture_id: schema.jobs.lectureId, stage: schema.jobs.stage, error: schema.jobs.error,
    updated_at: schema.jobs.updatedAt, title: schema.lectures.title })
    .from(schema.jobs).innerJoin(schema.lectures, eq(schema.lectures.id, schema.jobs.lectureId))
    .innerJoin(schema.courses, eq(schema.courses.id, schema.lectures.courseId)).where(ownedBy(dev))
    .orderBy(desc(schema.jobs.updatedAt)).limit(20);
  return j(rows.map((r) => ({ ...r, state: r.stage === "done" || r.stage === "failed" || r.stage === "queued" ? r.stage : "running",
    updated_at: new Date(r.updated_at).toISOString() })));
}

/** GET /v1/lectures/{id}/transcript — repaired (else raw ASR) transcript from the newest job that has one. */
export async function getTranscript(lid: string) {
  const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.lectureId, lid)).orderBy(desc(schema.jobs.updatedAt));
  for (const job of jobs) {
    const a = JSON.parse(job.artifacts) as Artifacts;
    const raw = a.repaired ?? a.asr;
    if (!raw?.segments?.length) continue;
    const t = dedupeTranscript(raw);
    return j({ lecture_id: lid, job_id: job.id, source: a.repaired ? "repaired" : "asr", complete: !!a.asrComplete, language: t.language,
      segments: t.segments.map((s) => ({ t0: s.start, t1: s.end, text: cleanHebrew(stripNiqqud(s.text)) })) });
  }
  return j({ error: "no transcript" }, 404);
}

/** POST /v1/jobs/{id}/resummarize[?force=1] — clear summary/pdf, keep ASR+repair, re-run from summary. */
export async function postResummarize(req: Request, jid: string) {
  const q = new URL(req.url).searchParams;
  const body = await req.json().catch(() => ({}));
  const r = await resummarizeJob(jid, q.get("force") === "1", parseDensity(q.get("density") ?? body?.density));
  if (!r.ok && r.reason === "not_found") return notFound();
  if (!r.ok) return j({ ...jobView(r.job!), error: "needs a done/failed job with complete ASR (use ?force=1 for a running job)" }, 409);
  return j(jobView(r.job), 202);
}

/** POST /v1/jobs/{id}/rerepair[?force=1] — keep ASR, re-run repair (terms + Hebrew spelling) + summary + pdf. */
export async function postRerepair(req: Request, jid: string) {
  const r = await rerepairJob(jid, new URL(req.url).searchParams.get("force") === "1");
  if (!r.ok && r.reason === "not_found") return notFound();
  if (!r.ok) return j({ ...jobView(r.job!), error: "needs a done/failed job with complete ASR (use ?force=1 for a running job)" }, 409);
  return j(jobView(r.job), 202);
}

/** POST /v1/jobs/{id}/reprocess[?fallback=1&force=1] — full redo from ASR when server audio exists; else 409 audio_missing
 *  (or, with fallback=1, re-summarize from the existing transcript). Response adds mode + audio_missing. */
export async function postReprocess(req: Request, jid: string) {
  const q = new URL(req.url).searchParams;
  const r = await reprocessJob(jid, q.get("fallback") === "1", q.get("force") === "1");
  if (!r.ok && r.reason === "not_found") return notFound();
  if (!r.ok) return j({ ...(r.job ? jobView(r.job) : {}), audio_missing: !!r.audioMissing,
    error: r.audioMissing ? "raw audio is no longer on the server; re-upload audio or use fallback=1" : "only done, failed or stuck jobs can be reprocessed (use ?force=1)" }, 409);
  return j({ ...jobView(r.job), mode: r.mode, audio_missing: !!r.audioMissing }, 202);
}

async function latestDone(lid: string, density?: Density) {
  const jobs = await db.select().from(schema.jobs).where(and(eq(schema.jobs.lectureId, lid), eq(schema.jobs.stage, "done")));
  return jobs.filter((x) => !density || jobDensity(JSON.parse(x.artifacts)) === density).sort((x, y) => y.updatedAt - x.updatedAt)[0];
}

/** GET /v1/lectures/{id}/summaries — newest done job per density level (plus any in-flight). */
export async function listSummaries(lid: string) {
  const jobs = (await db.select().from(schema.jobs).where(eq(schema.jobs.lectureId, lid))).sort((x, y) => y.updatedAt - x.updatedAt);
  const out: Record<string, unknown> = {};
  for (const d of DENSITIES) {
    const done = jobs.find((x) => x.stage === "done" && jobDensity(JSON.parse(x.artifacts)) === d);
    const latest=jobs.find(x=>jobDensity(JSON.parse(x.artifacts))===d);
    const running=latest&&latest.stage!=="done"&&latest.stage!=="failed"&&(!done||latest.updatedAt>done.updatedAt)?latest:undefined;
    const failed=jobs.find(x=>x.stage==="failed"&&jobDensity(JSON.parse(x.artifacts))===d&&(!done||x.updatedAt>done.updatedAt));
    out[d] = { done_job_id: done?.id ?? null, updated_at: done ? new Date(done.updatedAt).toISOString() : null, running_job_id: running?.id ?? null, running_stage:running?.stage??null, failed_job_id:running?null:failed?.id??null };
  }
  return j({ lecture_id: lid, densities: out });
}

export async function summaryFile(lid: string, kind: "pdf" | "html" | "json", density?: Density) {
  const job = await latestDone(lid, density); if (!job) return j({ error: density ? `no finished ${density} summary` : "no finished job" }, 404);
  const a = JSON.parse(job.artifacts) as Artifacts;
  if (kind === "json") return j({ summary: a.summary, repairs: a.repair, transcript: a.repaired ?? a.asr, figures: a.figures ?? null, figures_note: a.figuresNote ?? null });
  const url = kind === "pdf" ? a.pdf : a.html;
  if (!url) return notFound();
  const isPdf = kind === "pdf" && !url.endsWith(".html");
  if (kind === "pdf" && !isPdf) return j({ error: "PDF renderer unavailable on this deployment; use summary.html" }, 501);
  const { data } = await readFileUrl(url);
  return new Response(new Uint8Array(data), { headers: { "content-type": isPdf ? "application/pdf" : "text/html; charset=utf-8", ...(isPdf?{"X-Study-Pairs":memoryPairsHeader(a.summary)}:{}) } });
}

/**
 * DELETE /v1/lectures/{id} — delete the lecture, its jobs, audio segments and material rows, and best-effort delete
 * every Blob it referenced (audio parts, slide decks, study HTML/PDF). Missing blobs are ignored. Idempotent: 404 → ok.
 */
export async function deleteLecture(lid: string) {
  const l = await lectureOr404(lid);
  if (!l) return j({ ok: true, deleted: false, lecture_id: lid });
  const segs = await db.select().from(schema.segments).where(eq(schema.segments.lectureId, lid));
  const files = await db.select().from(schema.lectureFiles).where(eq(schema.lectureFiles.lectureId, lid));
  const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.lectureId, lid));
  const urls = new Set<string>();
  for (const s of segs) if (s.url) urls.add(s.url);
  for (const f of files) urls.add(f.url);
  if (l.slidesUrl) urls.add(l.slidesUrl);
  if (l.audioUrl) urls.add(l.audioUrl);
  for (const job of jobs) { try { const a = JSON.parse(job.artifacts) as Artifacts; if (a.pdf) urls.add(a.pdf); if (a.html) urls.add(a.html); } catch { /* ignore */ } }
  let blobErrors = 0;
  await Promise.all([...urls].map((u) => deleteFileUrl(u).catch((e) => { blobErrors++; console.warn("blob delete failed", u, e?.message); })));
  await db.delete(schema.jobs).where(eq(schema.jobs.lectureId, lid));
  await db.delete(schema.segments).where(eq(schema.segments.lectureId, lid));
  await db.delete(schema.lectureFiles).where(eq(schema.lectureFiles.lectureId, lid));
  await db.delete(schema.lectures).where(eq(schema.lectures.id, lid));
  return j({ ok: true, deleted: true, lecture_id: lid, jobs: jobs.length, blobs: urls.size, blob_errors: blobErrors });
}

/** DELETE /v1/jobs/{id} — delete one job and its study HTML/PDF blobs (lecture + materials stay). */
export async function deleteJob(jid: string) {
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jid) });
  if (!job) return j({ ok: true, deleted: false, job_id: jid });
  try { const a = JSON.parse(job.artifacts) as Artifacts; for (const u of [a.pdf, a.html]) if (u) await deleteFileUrl(u).catch(() => {}); } catch { /* ignore */ }
  await db.delete(schema.jobs).where(eq(schema.jobs.id, jid));
  return j({ ok: true, deleted: true, job_id: jid });
}

/** DELETE /v1/courses/{id} — delete a course: all its lectures (jobs, segments, files, blobs), course files + context PDF blobs, then the course row. Idempotent. */
export async function deleteCourse(cid: string) {
  const c = await db.query.courses.findFirst({ where: eq(schema.courses.id, cid) });
  if (!c) return j({ ok: true, deleted: false, course_id: cid });
  const ls = await db.select({ id: schema.lectures.id }).from(schema.lectures).where(eq(schema.lectures.courseId, cid));
  for (const l of ls) await deleteLecture(l.id);
  const files = await db.select().from(schema.courseFiles).where(eq(schema.courseFiles.courseId, cid));
  const urls = new Set<string>(files.map((f) => f.url));
  if (c.contextPdfUrl) urls.add(c.contextPdfUrl);
  let blobErrors = 0;
  await Promise.all([...urls].map((u) => deleteFileUrl(u).catch((e) => { blobErrors++; console.warn("blob delete failed", u, e?.message); })));
  await db.delete(schema.courseFiles).where(eq(schema.courseFiles.courseId, cid));
  await db.delete(schema.courses).where(eq(schema.courses.id, cid));
  return j({ ok: true, deleted: true, course_id: cid, lectures: ls.length, blobs: urls.size, blob_errors: blobErrors });
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

/** Move the relationship only. Jobs, lecture files, transcript and all density PDFs keep the same lecture id. */
export async function moveLecture(req:Request,lid:string,dev:string|null){
  if(!dev)return j({error:"device_required"},401);
  const parsed=z.object({course_id:z.string().min(1)}).strict().safeParse(await req.json().catch(()=>null));
  if(!parsed.success)return j({error:"invalid_request"},400);
  if(!await ownsLecture(dev,lid)||!await ownsCourse(dev,parsed.data.course_id))return notFound();
  await db.update(schema.lectures).set({courseId:parsed.data.course_id}).where(eq(schema.lectures.id,lid));
  return j({lecture_id:lid,course_id:parsed.data.course_id,moved:true});
}
