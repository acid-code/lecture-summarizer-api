// Usage: npx tsx scripts/check-srt.ts <file.srt> — parse an SRT and print span / segment stats.
import { readFileSync } from "node:fs";
import { parseSrt } from "../src/lib/transcript-import";
const t = parseSrt(readFileSync(process.argv[2], "utf8"));
const s = t.segments;
console.log(JSON.stringify({ segments: s.length, start: s[0]?.start, end: s.at(-1)?.end,
  hebrew: s.filter((x) => /[\u0590-\u05FF]/.test(x.text)).length, withColonPrefix: s.filter((x) => /^[^:]{1,40}:\s/.test(x.text)).length,
  disclaimer: s.some((x) => /auto-generated/i.test(x.text)), first: s[0]?.text, last: s.at(-1)?.text }, null, 1));
