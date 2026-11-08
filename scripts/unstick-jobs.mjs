/**
 * Force-retry non-done jobs via the production API using each course's X-Device-Id from Turso.
 * Usage: node scripts/unstick-jobs.mjs [--dry] [jobId...]
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  process.env[m[1].trim()] ??= v;
}

const dry = process.argv.includes("--dry");
const only = process.argv.slice(2).filter((a) => !a.startsWith("-") && /^[0-9a-f-]{36}$/i.test(a));
const base = process.env.API_BASE || "https://lecture-summarizer-api.vercel.app";
const token = process.env.API_TOKEN;
if (!token || token === "[SENSITIVE]") {
  console.error("API_TOKEN missing in .env.local");
  process.exit(1);
}

const db = createClient({ url: process.env.DATABASE_URL, authToken: process.env.DATABASE_AUTH_TOKEN });
const q = only.length
  ? `SELECT j.id, j.stage, j.error, l.title, c.device_id AS deviceId
     FROM jobs j JOIN lectures l ON l.id=j.lecture_id JOIN courses c ON c.id=l.course_id
     WHERE j.id IN (${only.map(() => "?").join(",")})`
  : `SELECT j.id, j.stage, j.error, l.title, c.device_id AS deviceId
     FROM jobs j JOIN lectures l ON l.id=j.lecture_id JOIN courses c ON c.id=l.course_id
     WHERE j.stage NOT IN ('done') ORDER BY j.updated_at DESC LIMIT 40`;
const { rows } = await db.execute(only.length ? { sql: q, args: only } : q);

console.log(`found ${rows.length} jobs (dry=${dry})`);
for (const r of rows) {
  const id = r.id;
  const device = r.deviceId;
  console.log(`\n→ ${id.slice(0, 8)}… stage=${r.stage} title=${r.title} device=${device ? device.slice(0, 8) + "…" : "NULL"}`);
  if (!device) {
    console.log("  skip: no device_id on course");
    continue;
  }
  if (dry) continue;
  const headers = { Authorization: `Bearer ${token}`, "X-Device-Id": String(device), "content-type": "application/json" };
  // force retry so mid-flight summary/pdf leases reset
  const res = await fetch(`${base}/v1/jobs/${id}/retry?force=1`, { method: "POST", headers, body: "{}" });
  const body = await res.text();
  console.log(`  retry HTTP ${res.status}: ${body.slice(0, 240)}`);
  // kick one advance via poll
  const g = await fetch(`${base}/v1/jobs/${id}`, { headers });
  const gj = await g.text();
  console.log(`  poll HTTP ${g.status}: ${gj.slice(0, 240)}`);
}
