/**
 * Local Hebrew ASR bench: windowed Gemini ASR + same merge/clean/dedupe as the pipeline + repair.
 * Usage: npx tsx scripts/hebrew-bench.ts <out-dir> <file.m4a>... (files are copied to data/bench/; BENCH_WINDOW_SEC, default 120)
 * Writes <name>.raw.json (model output, untouched), .asr.json (clean+dedupe), .repairs.json, .repaired.json and .txt views.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { geminiProvider } from "../src/lib/providers/gemini";
import { applyRepairs, cleanTranscript } from "../src/lib/providers/prompts";
import { dedupeTranscript } from "../src/lib/providers/dedupe";
import type { Segment, Transcript } from "../src/lib/providers/types";

const [out, ...files] = process.argv.slice(2);
const WIN = Number(process.env.BENCH_WINDOW_SEC || 120);
const txt = (t: Transcript) => t.segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n");
fs.mkdirSync(out, { recursive: true });
(async () => {
  for (const f of files) {
    const name = path.basename(f, path.extname(f));
    const rel = path.join("data", "bench", path.basename(f));
    if (path.resolve(f) !== path.resolve(rel)) fs.copyFileSync(f, rel);
    const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", rel]).toString());
    const ctx = { title: name, slidesText: null };
    const raw: Segment[] = []; let asr: Transcript = { language: "he", segments: [] };
    const windowed = dur > WIN * 1.25;
    for (let ws = 0; ws < dur; ws += WIN) {
      const audio = { url: "local:" + rel, mime: "audio/mp4", offsetSec: 0, durationSec: dur, ...(windowed ? { windowStart: ws, windowEnd: Math.min(dur, ws + WIN), prevText: process.env.BENCH_NO_PREV ? undefined : asr.segments.slice(-2).map((s) => s.text).join(" ").slice(-300) || undefined } : {}) };
      const t = await geminiProvider.transcribe(audio, ctx);
      raw.push(...t.segments);
      asr = dedupeTranscript({ language: "he", segments: [...asr.segments, ...cleanTranscript(t).segments] });
      if (!windowed) break;
    }
    const rawT = { language: "he", segments: raw };
    const repairs = await geminiProvider.repairTerms(asr, ctx);
    const repaired = cleanTranscript(applyRepairs(asr, repairs));
    const w = (k: string, v: unknown) => fs.writeFileSync(path.join(out, `${name}.${k}`), typeof v === "string" ? v : JSON.stringify(v, null, 1));
    w("raw.json", rawT); w("asr.json", asr); w("repairs.json", repairs); w("repaired.json", repaired);
    w("raw.txt", txt(rawT)); w("repaired.txt", txt(repaired));
    console.log(`${name}: ${dur.toFixed(0)}s raw ${raw.length} segs → asr ${asr.segments.length} → ${repairs.length} repairs`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
