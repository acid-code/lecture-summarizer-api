/**
 * Repeat a bounded production nudge until the backlog is stable or the duration expires.
 * Usage: node scripts/burst-job-nudge.mjs [--apply] [--max=12] [--minutes=600]
 */
import fs from "node:fs";

for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([^#=\s]+)\s*=(.*)$/);
  if (!m) continue;
  const raw = m[2].trim();
  const value = ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ? raw.slice(1, -1)
    : raw;
  process.env[m[1].trim()] ??= value;
}

const apply = process.argv.includes("--apply");
const max = process.argv.find((a) => a.startsWith("--max="))?.slice(6) || "12";
const minutes = Number(process.argv.find((a) => a.startsWith("--minutes="))?.slice(10) || "600");
const intervalSeconds = Number(process.env.NUDGE_BURST_INTERVAL_SECONDS || "60");
const base = process.env.API_BASE || "https://lecture-summarizer-api.vercel.app";
const token = process.env.API_TOKEN;
if (!token) throw new Error("missing API_TOKEN");

const until = Date.now() + Math.max(1, minutes) * 60_000;
let stable = 0;
let last = "";

while (Date.now() < until) {
  const url = `${base}/v1/admin/job-nudge?${apply ? "" : "dry_run=1&"}max=${encodeURIComponent(max)}`;
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let report;
  try { report = JSON.parse(text); } catch { throw new Error(`nudge HTTP ${res.status}: ${text.slice(0, 500)}`); }
  if (!res.ok) throw new Error(`nudge HTTP ${res.status}: ${text.slice(0, 500)}`);

  const signature = JSON.stringify({ advanced: report.advanced, retried: report.retried, superseded: report.superseded });
  stable = signature === last ? stable + 1 : 0;
  last = signature;
  console.log(new Date().toISOString(), JSON.stringify({
    scanned: report.scanned,
    advanced: report.advanced?.length || 0,
    retried: report.retried?.length || 0,
    superseded: report.superseded?.length || 0,
    errors: report.errors?.length || 0,
  }));
  if (apply && report.scanned === 0) break;
  if (apply && stable >= 3) {
    console.log("backlog stable for 3 iterations; stopping");
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
}
