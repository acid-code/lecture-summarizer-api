// Run: npx tsx --test tests/devices.test.ts — per-device isolation + legacy claim.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const DBF = `/tmp/ls-devices-test-${process.pid}.db`;
rmSync(DBF, { force: true });
process.env.DATABASE_URL = `file:${DBF}`;
process.env.API_TOKEN = "tok";
delete process.env.GEMINI_API_KEY;

type R = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let route: R;
const A = "device-aaaaaaaa", B = "device-bbbbbbbb";
async function call(method: string, path: string, dev: string | null, body?: unknown, token = "tok") {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (dev) headers["x-device-id"] = dev;
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`http://x/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await route(req, { params: Promise.resolve({ path: path.split("/") }) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

before(async () => { route = (await import("../src/app/v1/[...path]/route")).GET as unknown as R; });

test("token still required", async () => {
  assert.equal((await call("GET", "courses", A, undefined, "bad")).status, 401);
});

test("device B cannot see or touch device A's data", async () => {
  const c = await call("POST", "courses", A, { name: "A course" }); assert.equal(c.status, 201);
  const cid = c.body.course_id;
  const l = await call("POST", "lectures", A, { course_id: cid, title: "L1" }); assert.equal(l.status, 201);
  const lid = l.body.lecture_id;
  assert.deepEqual((await call("GET", "courses", A)).body.map((x: any) => x.course_id), [cid]);
  assert.deepEqual((await call("GET", "courses", B)).body, []);
  assert.equal((await call("GET", `lectures/${lid}`, B)).status, 404);
  assert.equal((await call("GET", `courses/${cid}/files`, B)).status, 404);
  assert.equal((await call("POST", "lectures", B, { course_id: cid, title: "x" })).status, 404);
  assert.equal((await call("POST", `lectures/${lid}/process`, B, {})).status, 404);
  assert.equal((await call("DELETE", `lectures/${lid}`, B)).status, 404);
  assert.equal((await call("DELETE", `courses/${cid}`, B)).status, 404);
  assert.equal((await call("DELETE", `courses/${cid}/files`, B)).status, 404);
  assert.equal((await call("POST", `lectures/${lid}/markers`, B, [])).status, 404);
  assert.equal((await call("POST", `lectures/${lid}/audio/segments`, B, { seq: 0 })).status, 404);
  assert.equal((await call("GET", `lectures/${lid}/files`, B)).status, 404);
  assert.equal((await call("GET", `lectures/${lid}`, A)).status, 200);
  // legacy (no header) client can't see device-owned courses either
  assert.deepEqual((await call("GET", "courses", null)).body, []);
  // B cannot claim A's course
  const cl = await call("POST", "devices/claim", B, { claim_course_ids: [cid] });
  assert.deepEqual(cl.body.claimed, []);
  assert.equal((await call("GET", `lectures/${lid}`, A)).status, 200);
});

test("legacy course: usable by old client, claimed only by a device that names it", async () => {
  const c = await call("POST", "courses", null, { name: "legacy" }); assert.equal(c.status, 201);
  const cid = c.body.course_id;
  const l = await call("POST", "lectures", null, { course_id: cid, title: "live" }); const lid = l.body.lecture_id;
  assert.equal((await call("GET", `lectures/${lid}`, null)).status, 200); // old APK keeps working
  assert.deepEqual((await call("GET", "courses", B)).body, []);
  assert.deepEqual((await call("POST", "devices/claim", B, { claim_course_ids: [] })).body.claimed, []);
  assert.equal((await call("GET", `lectures/${lid}`, B)).status, 404);
  const r = await call("POST", "devices/claim", A, { claim_course_ids: [cid, "nope"] });
  assert.deepEqual(r.body.claimed, [cid]);
  assert.deepEqual(r.body.skipped.map((s: any) => s.course_id), ["nope"]);
  assert.equal((await call("GET", `lectures/${lid}`, A)).status, 200);
  assert.equal((await call("GET", `lectures/${lid}`, B)).status, 404);
  assert.deepEqual((await call("POST", "devices/claim", B, { claim_course_ids: [cid] })).body.claimed, []);
  assert.deepEqual((await call("POST", "devices/claim", A, { claim_course_ids: [cid] })).body.claimed, [cid]); // idempotent
});

test("jobs scoped: B cannot get/retry/delete A's job, list empty", async () => {
  const c = await call("POST", "courses", A, { name: "J" });
  const l = await call("POST", "lectures", A, { course_id: c.body.course_id, title: "x" });
  const p = await call("POST", `lectures/${l.body.lecture_id}/process`, A, {});
  const jid = p.body?.job_id;
  assert.ok(jid, JSON.stringify(p.body));
  for (const [m, path] of [["GET", `jobs/${jid}?advance=0`], ["DELETE", `jobs/${jid}`], ["POST", `jobs/${jid}/retry`], ["POST", `jobs/${jid}/resummarize`]] as const)
    assert.equal((await call(m, path.split("?")[0], B)).status, 404, path);
  assert.ok(!(await call("GET", "jobs", B)).body.some((x: any) => x.job_id === jid));
});
