/**
 * Pure-JS PPTX text extraction (no LibreOffice): unzip with fflate (only slide/notes XML entries, media skipped),
 * read <a:t> runs grouped by <a:p> paragraphs. Output matches pdfToText: one slide per "\f"-separated page,
 * speaker notes appended after a "[notes]" line. Unicode (Hebrew/English) preserved as-is.
 */
import { unzipSync, strFromU8 } from "fflate";

const decode = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");

function xmlText(xml: string): string {
  const paras: string[] = [];
  for (const p of xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) ?? []) {
    const runs = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b/g)].map((m) => (m[1] !== undefined ? decode(m[1]) : "\n"));
    const t = runs.join("").replace(/[ \t]+/g, " ").trim();
    if (t) paras.push(t);
  }
  return paras.join("\n");
}

export function isPptx(mime: string, url: string) {
  return mime.includes("presentationml") || /\.pptx(\?|$)/i.test(url);
}

export function pptxSlides(data: Uint8Array): { slide: number; text: string; notes: string }[] {
  const files = unzipSync(data, { filter: (f) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$|^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/_rels\/slide\d+\.xml\.rels)$/.test(f.name) });
  const s = (n: string) => (files[n] ? strFromU8(files[n]) : "");
  // Slide order from presentation.xml sldIdLst → rels targets; fallback numeric.
  const rels = Object.fromEntries([...s("ppt/_rels/presentation.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
    m[0].match(/Id="([^"]+)"/)?.[1], m[0].match(/Target="([^"]+)"/)?.[1]]));
  let order = [...s("ppt/presentation.xml").matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
    .map((m) => rels[m[1]]).filter(Boolean).map((t) => "ppt/" + String(t).replace(/^\/?(ppt\/)?/, ""));
  if (!order.length) order = Object.keys(files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => +a.match(/(\d+)\.xml/)![1] - +b.match(/(\d+)\.xml/)![1]);
  return order.map((path, i) => {
    const rel = s(path.replace("slides/", "slides/_rels/") + ".rels");
    const notesT = rel.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)?.[1];
    return { slide: i + 1, text: xmlText(s(path)), notes: notesT ? xmlText(s("ppt/notesSlides/" + notesT)).replace(/^\d+$/m, "").trim() : "" };
  });
}

export function pptxToText(data: Uint8Array): string {
  return pptxSlides(data).map((x) => x.text + (x.notes ? `\n[notes]\n${x.notes}` : "")).join("\f");
}
