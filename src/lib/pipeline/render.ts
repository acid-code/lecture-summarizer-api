import katex from "katex";
import type { LectureSummary } from "../providers/types";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Models sometimes emit HTML entities themselves (`&gt;`); decode first so we never double-escape. */
const unent = (s: string) => s.replace(/&(gt|lt|amp|quot|#39);/g, (_, e) => ({ gt: ">", lt: "<", amp: "&", quot: '"', "#39": "'" })[e as string]!);
/**
 * Wrap Latin runs (and any stray `\command…` TeX run) in LTR isolates so English terms / leftover TeX
 * render correctly inside RTL Hebrew instead of being reordered into garbage like `frac\ - 1)left\`.
 */
const bidiPlain = (s: string) =>
  esc(s).replace(/(\\[A-Za-z]+[^\s\u0590-\u05FF]*(?:\s+[^\s\u0590-\u05FF]+)*|[A-Za-z][A-Za-z0-9\-_. ]*[A-Za-z0-9])/g, '<bdi dir="ltr">$1</bdi>');

/**
 * Math: LaTeX in summary text is rendered server-side with KaTeX (pure JS → HTML+CSS, no browser JS needed),
 * then Chromium prints it into the PDF with the KaTeX fonts inlined (fonts/katex-inline.css).
 * Delimiters: $$…$$ and \[…\] (display), \(…\) and $…$ (inline; $ only when not followed by a space/digit-currency).
 * Undelimited ("bare") TeX outside delimiters is detected conservatively (see bareMath) and rendered inline.
 * Malformed TeX falls back to the raw source in red (throwOnError:false), so a bad formula never fails the job.
 */
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;
export function renderMath(tex: string, display: boolean): string {
  const html = katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, output: "html", strict: "ignore" });
  return display ? `<div class="math" dir="ltr">${html}</div>` : `<bdi class="math" dir="ltr">${html}</bdi>`;
}

/* ---------- bare-TeX detection (no Hebrew is ever pulled into math) ---------- */
const CMD = /\\[A-Za-z]+/;
/** A token that is unmistakably math: a TeX command, sub/superscript, |H|-style bars, or braces. */
const STRONG = (t: string) => CMD.test(t) || /[_^{}]/.test(t) || /\|[^|\s]+\|/.test(t);
/** A token that may sit inside a formula: strong, operators/numbers/brackets, or a single Latin letter (optionally with (..)). */
const WEAK = (t: string) =>
  STRONG(t) || /^[\d.,+\-*/=<>≤≥()[\]|!:;]+$/.test(t) || /^[(\[]*[A-Za-z][\d']?(?:\([^\s]*\))?[)\],;:]*$/.test(t) || /^[A-Za-z]?[=<>≤≥]+$/.test(t);
/** Balanced-ish check so we don't hand KaTeX `\frac{4` halves. */
const balanced = (t: string) => {
  let d = 0;
  for (const c of t) { if (c === "{") d++; else if (c === "}" && --d < 0) return false; }
  return d === 0;
};
function renderBare(tex: string): string | null {
  const t = tex.replace(/≤/g, "\\le ").replace(/≥/g, "\\ge ");
  if (!balanced(t)) return null;
  try {
    katex.renderToString(t, { throwOnError: true, strict: "ignore" });
  } catch { return null; }
  return renderMath(t, false);
}
/** Non-delimited text → HTML: bare formulas rendered with KaTeX, everything else escaped + LTR-isolated. */
function plainWithBareMath(s: string): string {
  if (!CMD.test(s) && !/[_^]|\|[^|\s]+\|/.test(s)) return bidiPlain(s);
  let out = "", last = 0;
  // Only non-Hebrew spans can be math.
  for (const span of s.matchAll(/[^\u0590-\u05FF]+/g)) {
    const text = span[0], base = span.index!;
    const toks = [...text.matchAll(/\S+/g)];
    let i = 0;
    while (i < toks.length) {
      if (!WEAK(toks[i][0])) { i++; continue; }
      let j = i, strong = false;
      while (j < toks.length && WEAK(toks[j][0])) { strong ||= STRONG(toks[j][0]); j++; }
      if (strong) {
        const start = base + toks[i].index!;
        let end = base + toks[j - 1].index! + toks[j - 1][0].length;
        // trailing sentence punctuation stays prose
        while (end > start && /[.,;:]/.test(s[end - 1])) end--;
        // strip unbalanced leading "(" / trailing ")" that belong to prose
        let a = start, b = end;
        while (a < b && /[.,;:!\s]/.test(s[a])) a++; // leading prose punctuation ("חסם: ...")
        // Hebrew prefix hyphen ("ב-\\delta") is prose, not a minus sign
        if (s[a] === "-" && a > 0 && /[\u0590-\u05FF]/.test(s[a - 1])) a++;
        const frag = () => s.slice(a, b);
        if (frag().startsWith("(") && (frag().match(/\(/g)!.length > (frag().match(/\)/g) ?? []).length)) a++;
        if (frag().endsWith(")") && ((frag().match(/\)/g) ?? []).length > (frag().match(/\(/g) ?? []).length)) b--;
        const html = renderBare(frag());
        if (html) { out += bidiPlain(s.slice(last, a)) + html; last = b; }
      }
      i = j;
    }
  }
  return out + bidiPlain(s.slice(last));
}

export function bidi(raw: string): string {
  const s = unent(raw ?? "");
  let out = "", last = 0;
  for (const m of s.matchAll(MATH)) {
    out += plainWithBareMath(s.slice(last, m.index));
    const display = m[1] != null || m[2] != null;
    out += renderMath(m[1] ?? m[2] ?? m[3] ?? m[4], display);
    last = m.index! + m[0].length;
  }
  return out + plainWithBareMath(s.slice(last));
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
