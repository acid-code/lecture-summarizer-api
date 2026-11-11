/**
 * Call production /v1/admin/job-nudge using API_TOKEN from .env.local.
 * Usage: node scripts/run-job-nudge-remote.mjs [--apply]
 */
import fs from "node:fs";

for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] ??= v;
}

const apply = process.argv.includes("--apply");
const token = process.env.API_TOKEN;
if (!token) {
  console.error("missing API_TOKEN in .env.local");
  process.exit(2);
}
const base = process.env.API_BASE || "https://lecture-summarizer-api.vercel.app";
const url = `${base}/v1/admin/job-nudge${apply ? "" : "?dry_run=1"}`;
const res = await fetch(url, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
const text = await res.text();
console.log("status", res.status);
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
catch { console.log(text.slice(0, 2000)); }
process.exit(res.ok ? 0 : 1);
