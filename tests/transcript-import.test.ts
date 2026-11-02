// Panopto / external transcript import: SRT parsing + /v1/lectures/{id}/transcript/import happy path (mock provider).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { parseSrt, srtTime, normalizeSegments } from "../src/lib/transcript-import";

const SRT = readFileSync(new URL("./fixtures/panopto-lecture3-captions.srt", import.meta.url), "utf8");
const DBF = `/tmp/ls-import-test-${process.pid}.db`;
rmSync(DBF, { force: true });
process.env.DATABASE_URL = `file:${DBF}`;
process.env.API_TOKEN = "tok";
process.env.DELETE_RAW_AUDIO = "false";
process.env.FIGURES = "off";
delete process.env.GEMINI_API_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;

test("srtTime", () => {
  assert.equal(srtTime("00:00:03,584"), 3.584);
  assert.equal(srtTime("02:36:03,424"), 9363.424);
});

test("parses the Panopto Lecture 3 SRT: span, Hebrew, no disclaimer/speaker prefixes", () => {
  const t = parseSrt(SRT);
  assert.equal(t.language, "he");
  assert.ok(t.segments.length > 800, `${t.segments.length}`);
  assert.ok(t.segments[0].start < 5);
  const end = t.segments.at(-1)!.end;
  assert.ok(end > 9300 && end < 9400, `${end}`);
  assert.equal(t.segments[0].text, "לאוד כזה, לא?");
  assert.ok(t.segments.every((s) => !s.text.includes("Jonathan Berant") && !/Auto-generated/i.test(s.text)));
  assert.ok(t.segments.filter((s) => /[\u0590-\u05FF]/.test(s.text)).length / t.segments.length > 0.9);
  assert.ok(t.segments.every((s, i) => s.end >= s.start && (!i || s.start >= t.segments[i - 1].start)));
});

test("a non-recurring colon in Hebrew text is kept", () => {
  const t = normalizeSegments([{ t0: 0, t1: 1, text: "A B: x" }, { t0: 1, t1: 2, text: "A B: y" }, { t0: 2, t1: 3, text: "A B: z" }, { t0: 3, t1: 4, text: "ההגדרה היא: משהו" }]);
  assert.deepEqual(t.segments.map((s) => s.text), ["x", "y", "z", "ההגדרה היא: משהו"]);
  assert.equal(normalizeSegments([{ start: 5, end: 7, text: "שלום" }]).segments[0].end, 7);
});

type R = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let route: R;
const D = "device-import-1";
async function call(method: string, path: string, body?: unknown, ct = "application/json") {
  const headers: Record<string, string> = { authorization: "Bearer tok", "x-device-id": D };
  if (body !== undefined) headers["content-type"] = ct;
  const req = new Request(`http://x/v1/${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const res = await route(req, { params: Promise.resolve({ path: path.split("?")[0].split("/") }) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
before(async () => { route = (await import("../src/app/v1/[...path]/route")).GET as unknown as R; });

async function lecture() {
  const c = await call("POST", "courses", { name: "ML" });
  return (await call("POST", "lectures", { course_id: c.body.course_id, title: "Lecture 3" })).body.lecture_id as string;
}

test("import raw SRT (no audio) → job at repair with ASR artifact (pipeline not run)", async () => {
  const lid = await lecture();
  const r = await call("POST", `lectures/${lid}/transcript/import`, SRT, "application/x-subrip");
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.ok(r.body.end_sec > 9300 && r.body.start_sec < 5);
  let job = (await call("GET", `jobs/${r.body.job_id}?advance=0`)).body;
  assert.equal(job.stage, "repair"); assert.equal(job.asr_source, "panopto"); assert.equal(job.transcript_ready, true);
  assert.equal(job.pdf_ready, false);
});

test("import JSON segments {t0,t1}; bad bodies rejected", async () => {
  const lid = await lecture();
  const r = await call("POST", `lectures/${lid}/transcript/import`, { source: "panopto", external_id: "7d763e9c", language: "he", segments: [{ t0: 0, t1: 2.4, text: "שלום" }, { start: 3, end: 5, text: "עולם" }] });
  assert.equal(r.status, 202); assert.equal(r.body.segments, 2);
  assert.equal((await call("POST", `lectures/${lid}/transcript/import`, {})).status, 400);
  assert.equal((await call("POST", `lectures/${lid}/transcript/import`, { segments: [{ text: "" }] })).status, 422);
  assert.equal((await call("POST", `lectures/nope/transcript/import`, { segments: [] })).status, 404);
});
