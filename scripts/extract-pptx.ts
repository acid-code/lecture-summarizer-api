// Usage: npx tsx scripts/extract-pptx.ts <file.pptx>
import { readFileSync } from "node:fs";
import { pptxSlides, pptxToText } from "../src/lib/pptx";
const buf = readFileSync(process.argv[2]); const t0 = Date.now();
const slides = pptxSlides(buf); const text = pptxToText(buf);
const nonEmpty = slides.filter((s) => s.text || s.notes);
console.log({ slides: slides.length, nonEmpty: nonEmpty.length, chars: text.length, hebrew: /[\u0590-\u05FF]/.test(text), ms: Date.now() - t0 });
for (const s of nonEmpty.slice(0, 4)) console.log(`#${s.slide}:`, s.text.slice(0, 160).replace(/\n/g, " | "));
