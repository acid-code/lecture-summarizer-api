import katex from "katex";
import type { LectureSummary } from "../providers/types";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Wrap Latin runs in LTR isolates so English terms render correctly inside RTL Hebrew. */
const bidiPlain = (s: string) => esc(s).replace(/([A-Za-z][A-Za-z0-9\-_. ]*[A-Za-z0-9])/g, '<bdi dir="ltr">$1</bdi>');

/**
 * Math: LaTeX in summary text is rendered server-side with KaTeX (pure JS → HTML+CSS, no browser JS needed),
 * then Chromium prints it into the PDF with the KaTeX fonts inlined (fonts/katex-inline.css).
 * Delimiters: $$…$$ and \[…\] (display), \(…\) and $…$ (inline; $ only when not followed by a space/digit-currency).
 * Malformed TeX falls back to the raw source in red (throwOnError:false), so a bad formula never fails the job.
 */
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;
export function renderMath(tex: string, display: boolean): string {
  const html = katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, output: "html", strict: "ignore" });
  return display ? `<div class="math" dir="ltr">${html}</div>` : `<bdi class="math" dir="ltr">${html}</bdi>`;
}
export function bidi(s: string): string {
  let out = "", last = 0;
  for (const m of s.matchAll(MATH)) {
    out += bidiPlain(s.slice(last, m.index));
    const display = m[1] != null || m[2] != null;
    out += renderMath(m[1] ?? m[2] ?? m[3] ?? m[4], display);
    last = m.index! + m[0].length;
  }
  return out + bidiPlain(s.slice(last));
}

/**
 * Print-ready RTL HTML for the study PDF (rendered to PDF by src/lib/pdf.ts when Chrome is available).
 * PDF: src/lib/pdf.ts inlines the IBM Plex Sans Hebrew + KaTeX fonts and renders with Chromium (system or @sparticuz).
 */
export function renderStudyHtml(s: LectureSummary): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(s.title)}</title>
<style>
@page{size:A4;margin:18mm}body{font-family:"IBM Plex Sans Hebrew","Noto Sans Hebrew","Heebo",Arial,sans-serif;line-height:1.6}
bdi{unicode-bidi:isolate;font-family:"Noto Sans","Inter",Arial,sans-serif}.cite{color:#666;font-size:.85em}
dt{font-weight:bold}h1,h2{line-height:1.3}ul{padding-inline-start:1.2em}.cite{direction:ltr;unicode-bidi:isolate}
.math{unicode-bidi:isolate;direction:ltr}div.math{text-align:center;margin:.4em 0}.katex{font-size:1.05em}
</style></head><body>
<h1>${bidi(s.title)}</h1>${s.transcript_thin ? `<p class="cite" style="direction:rtl">⚠ התמלול של ההקלטה קצר/חסר ביחס לשקפים — חלק מהסיכום מבוסס על השקפים בלבד.</p>` : ""}<p>${bidi(s.overview)}</p>
${s.sections.map((x) => `<h2>${bidi(x.heading)}</h2><ul>${x.bullets.map((b) => `<li>${bidi(b)}</li>`).join("")}</ul>${x.citation ? `<p class="cite">${esc(x.citation)}</p>` : ""}`).join("\n")}
<h2>מילון מונחים</h2><dl>${s.glossary.map((g) => `<dt><bdi dir="ltr">${esc(g.term)}</bdi></dt><dd>${bidi(g.explanation)}</dd>`).join("")}</dl>
</body></html>`;
}
