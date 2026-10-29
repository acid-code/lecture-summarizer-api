// Usage: npx tsx scripts/render-bullets.ts bullets.json   (JSON array of strings, or {"bullets":[...]})
//    or: echo '["N = \\frac{4}{\\varepsilon}"]' | npx tsx scripts/render-bullets.ts
import { readFileSync } from "node:fs";
import { bidi } from "../src/lib/pipeline/render";
const raw = JSON.parse(readFileSync(process.argv[2] ?? 0, "utf8"));
const bullets: string[] = Array.isArray(raw) ? raw : raw.bullets ?? raw.sections?.flatMap((s: { bullets: string[] }) => s.bullets) ?? [];
console.log(`<ul dir="rtl">\n${bullets.map((b) => `  <li>${bidi(b)}</li>`).join("\n")}\n</ul>`);
