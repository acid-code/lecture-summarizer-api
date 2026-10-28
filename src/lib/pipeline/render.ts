import type { LectureSummary } from "../providers/types";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Wrap Latin runs in LTR isolates so English terms render correctly inside RTL Hebrew. */
const bidi = (s: string) => esc(s).replace(/([A-Za-z][A-Za-z0-9\-_. ]*[A-Za-z0-9])/g, '<bdi dir="ltr">$1</bdi>');

/**
 * Print-ready RTL HTML for the study PDF (rendered to PDF by src/lib/pdf.ts when Chrome is available).
 * PDF: src/lib/pdf.ts inlines the IBM Plex Sans Hebrew font and renders with Chromium (system or @sparticuz).
 */
export function renderStudyHtml(s: LectureSummary): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(s.title)}</title>
<style>
@page{size:A4;margin:18mm}body{font-family:"IBM Plex Sans Hebrew","Noto Sans Hebrew","Heebo",Arial,sans-serif;line-height:1.6}
bdi{unicode-bidi:isolate;font-family:"Noto Sans","Inter",Arial,sans-serif}.cite{color:#666;font-size:.85em}
dt{font-weight:bold}h1,h2{line-height:1.3}ul{padding-inline-start:1.2em}.cite{direction:ltr;unicode-bidi:isolate}
</style></head><body>
<h1>${bidi(s.title)}</h1>${s.transcript_thin ? `<p class="cite" style="direction:rtl">⚠ התמלול של ההקלטה קצר/חסר ביחס לשקפים — חלק מהסיכום מבוסס על השקפים בלבד.</p>` : ""}<p>${bidi(s.overview)}</p>
${s.sections.map((x) => `<h2>${bidi(x.heading)}</h2><ul>${x.bullets.map((b) => `<li>${bidi(b)}</li>`).join("")}</ul>${x.citation ? `<p class="cite">${esc(x.citation)}</p>` : ""}`).join("\n")}
<h2>מילון מונחים</h2><dl>${s.glossary.map((g) => `<dt><bdi dir="ltr">${esc(g.term)}</bdi></dt><dd>${bidi(g.explanation)}</dd>`).join("")}</dl>
</body></html>`;
}
