import { before, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";

const file = `/tmp/slides-clear-${process.pid}.db`;
rmSync(file, { force: true });
process.env.DATABASE_URL = `file:${file}`;
process.env.API_TOKEN = "slides-test-token";
delete process.env.GEMINI_API_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
let route: typeof import("../src/app/v1/[...path]/route").GET;
before(async () => { route = (await import("../src/app/v1/[...path]/route")).GET; });
async function call(method: string, path: string, body?: unknown, device = "slides-owner") {
  const result = await route(new Request(`http://test/v1/${path}`, {
    method, headers: { authorization: "Bearer slides-test-token", "x-device-id": device, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { params: Promise.resolve({ path: path.split("/") }) });
  return { status: result.status, data: await result.json() as any };
}
test("clear slides is owner-scoped, idempotent, and retains transcript and jobs", async () => {
  const course = await call("POST", "courses", { name: "Biotech" });
  const lecture = await call("POST", "lectures", { course_id: course.data.course_id, title: "Lecture 3" });
  const id = lecture.data.lecture_id;
  const imported = await call("POST", `lectures/${id}/transcript/import`, {
    source: "panopto", external_id: "fixture", language: "he", segments: [{ t0: 0, t1: 10, text: "fixture transcript" }],
  });
  assert.equal(imported.status, 202);
  const { db, schema } = await import("../src/db");
  await db.insert(schema.lectureFiles).values({ id: "deck", lectureId: id, name: "PPT03.pdf", mime: "application/pdf", url: "fixture://deck", text: "deck terms", createdAt: Date.now() });
  await db.update(schema.lectures).set({ slidesUrl: "fixture://deck", slidesText: "deck terms" }).where(eq(schema.lectures.id, id));
  assert.equal((await call("DELETE", `lectures/${id}/slides`, undefined, "other-device")).status, 404);
  assert.equal((await db.select().from(schema.lectureFiles)).length, 1);
  assert.equal((await call("DELETE", `lectures/${id}/slides`)).status, 200);
  assert.equal((await call("DELETE", `lectures/${id}/slides`)).status, 200);
  assert.equal((await db.select().from(schema.lectureFiles)).length, 0);
  const [stored] = await db.select().from(schema.lectures).where(eq(schema.lectures.id, id));
  assert.equal(stored.slidesUrl, null); assert.equal(stored.slidesText, null);
  assert.equal((await db.select().from(schema.jobs)).length, 1);
  const transcript = await call("GET", `lectures/${id}/transcript`);
  assert.equal(transcript.status, 200);
  assert.equal(transcript.data.segments[0].text, "fixture transcript");
});
