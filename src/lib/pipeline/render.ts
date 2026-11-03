import katex from "katex";
import type { LectureSummary } from "../providers/types";
import type { Figure } from "../figures";

/** Coerce any model-emitted value (number/object/array/null) to text so `.replace` never crashes. */
export const str = (x: unknown): string => {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(str).filter(Boolean).join(" ");
  if (typeof x === "object") {
    const o = x as Record<string, unknown>;
    const t = o.text ?? o.content ?? o.body ?? o.bullet ?? o.point ?? o.title;
    return t != null ? str(t) : Object.values(o).map(str).filter(Boolean).join(" — ");
  }
  return String(x);
};
const arr = <T = unknown>(x: unknown): T[] => (Array.isArray(x) ? x : x == null ? [] : [x]) as T[];
const esc = (s: unknown) => str(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Models sometimes emit HTML entities themselves (`&gt;`); decode first so we never double-escape. */
const unent = (s: unknown) => str(s).replace(/&(gt|lt|amp|quot|#39);/g, (_, e) => ({ gt: ">", lt: "<", amp: "&", quot: '"', "#39": "'" })[e as string]!);
/**
 * Wrap Latin runs (and any stray `\command…` TeX run) in LTR isolates so English terms / leftover TeX
 * render correctly inside RTL Hebrew instead of being reordered into garbage like `frac\ - 1)left\`.
 */
const bidiPlain = (s: string) =>
  // HTML entities from esc() (&amp; …) are skipped so their letters are never wrapped (was rendering "&" as ";amp&").
  esc(s).replace(/(&(?:[a-z]+|#\d+);)|(\\[A-Za-z]+[^\s\u0590-\u05FF]*(?:\s+[^\s\u0590-\u05FF]+)*|[A-Za-z][A-Za-z0-9\-_. ]*[A-Za-z0-9])/g, (m, ent) => ent ? m : `<bdi dir="ltr">${m}</bdi>`);

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

/** Source citations like `[slide 7, t=6:00-6:18]` / `[t=9:20, slides 8-9]` — isolated whole so brackets never split. */
const CITE = /\[[^\[\]\n$]*?(?:\bslides?\b|\bt\s*=|\d{1,2}:\d{2})[^\[\]\n$]*\]/gi;
export function renderCite(c: string): string {
  return `<bdi class="cite-inline" dir="ltr">${esc(str(c).replace(/\s+/g, " "))}</bdi>`;
}

/** Strip glyphs the embedded fonts can't draw (tofu): stray Arabic letters the model mixes into Hebrew, U+FFFD, emoji/symbols. */
export function cleanGlyphs(s: unknown): string {
  return str(s).replace(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g, "")
    .replace(/[\uFFFD\u200B\uFEFF]/g, "")
    .replace(/[\u2600-\u27BF\u2B50\u2B55]|[\uD83C-\uDBFF][\uDC00-\uDFFF]|\uFE0F/g, "")
    .replace(/[ \t]{2,}/g, " ");
}
export function bidi(raw: unknown): string {
  const s = cleanGlyphs(unent(unent(raw ?? "")));
  let out = "", last = 0;
  for (const m of s.matchAll(CITE)) {
    out += bidiMath(s.slice(last, m.index));
    out += renderCite(m[0]); // trailing "." stays outside the isolate (prose)
    last = m.index! + m[0].length;
  }
  return out + bidiMath(s.slice(last));
}

function bidiMath(s: string): string {
  let out = "", last = 0;
  for (const m of s.matchAll(MATH)) {
    out += plainWithBareMath(s.slice(last, m.index));
    const display = m[1] != null || m[2] != null;
    out += renderMath(m[1] ?? m[2] ?? m[3] ?? m[4], display);
    last = m.index! + m[0].length;
  }
  return out + plainWithBareMath(s.slice(last));
}

/** "Big picture" appendix after the glossary (optional). RTL like the body when it contains Hebrew; LTR only if fully non-Hebrew. Math/cites/Latin stay LTR-isolated via bidi(). */
export function renderBigPicture(b: LectureSummary["big_picture"]): string {
  if (!b || (!str(b.intent).trim() && !b.themes?.length && !b.missed_terms?.length)) return "";
  const themes = arr<any>(b.themes).filter((t) => t?.title || t?.explanation);
  const terms = arr<any>(b.missed_terms).filter((t) => t?.term);
  const all = [b.intent, ...themes.flatMap((t) => [t.title, t.explanation]), ...terms.flatMap((t) => [t.term, t.explanation])].join(" ");
  const he = /[\u0590-\u05FF]/.test(all);
  const [dir, lang, h2, h3] = he
    ? ["rtl", "he", "התמונה הגדולה — מה ההרצאה ניסתה ללמד", "מונחים שהופיעו בהרצאה"]
    : ["ltr", "en", "Big picture — what this lecture was trying to teach", "Terms used in the lecture"];
  return `<section class="big-picture" dir="${dir}" lang="${lang}"><h2>${h2}</h2>
${str(b.intent).trim() ? `<p>${bidi(b.intent)}</p>` : ""}
${themes.map((t) => `<h3>${bidi(t.title ?? "")}</h3><p>${bidi(t.explanation ?? "")}</p>`).join("\n")}
${terms.length ? `<h3>${h3}</h3><dl>${terms.map((g) => `<dt>${bidi(g.term)}</dt><dd>${bidi(g.explanation ?? "")}</dd>`).join("")}</dl>` : ""}
</section>`;
}

/**
 * Print-ready RTL HTML for the study PDF (rendered to PDF by src/lib/pdf.ts when Chrome is available).
 * PDF: src/lib/pdf.ts inlines the IBM Plex Sans Hebrew + KaTeX fonts and renders with Chromium (system or @sparticuz).
 */
/** Whole-slide figure block; caption RTL when Hebrew. */
export function renderFigure(f: Figure): string {
  const he = /[\u0590-\u05FF]/.test(str(f.caption));
  const label = `${he ? "שקף" : "slide"} ${f.page}${f.deck ? ` · ${f.deck}` : ""}`;
  return `<figure class="fig"><img src="${f.src}" alt="${esc(label)}"><figcaption dir="${he ? "rtl" : "ltr"}">${f.caption ? bidi(f.caption) + " " : ""}<bdi class="cite-inline" dir="ltr">[${esc(label)}]</bdi></figcaption></figure>`;
}

/** Header metadata from the job record (LectureSummary has none). All optional; missing chips are omitted. */
export interface StudyMeta { course?: string | null; lecture?: string | null; date?: string | null; level?: string | null }
export const SIGN_OFF = "סוכם אוטומטית מההרצאה והשקפים · בדקו מול החומר הרשמי";
const fmtDate = (d?: string | null) => { if (!d) return ""; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); return m ? `${m[3]}.${m[2]}.${m[1]}` : d; };

/** Branded layout v2 (approved): slim navy/yellow bar, white header + pills, card sections with 01/02 badges, amber key box. */
const BRAND_CSS = `@page{size:A4;margin:14mm 0 16mm 0}@page:first{margin-top:0}*{box-sizing:border-box}
body{font-family:"Heebo","IBM Plex Sans Hebrew","Noto Sans Hebrew",Arial,sans-serif;margin:0;color:#1F2937;font-size:10.5pt;line-height:1.7;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{height:6px;background:#0F1F4D;position:relative}.bar:after{content:"";position:absolute;right:0;top:0;height:6px;width:88px;background:#F2B705}
header{padding:30px 44px 22px}h1{font-size:22pt;line-height:1.25;font-weight:800;color:#0F1F4D;margin:0 0 14px;letter-spacing:-.3px}
.meta{display:flex;flex-wrap:wrap;gap:8px}.chip{font-size:8.5pt;color:#475569;background:#F1F5F9;border-radius:999px;padding:3px 12px}
.chip.lvl{background:#0F1F4D;color:#fff;font-weight:600}.chip.lvl b{color:#F2B705}
main{padding:0 44px}.ov{font-size:11pt;color:#475569;margin:6px 0 24px;max-width:94%}.thin{color:#64748B;font-size:9pt}
.key{background:#FFFBEB;border:1px solid #FDE68A;border-radius:16px;padding:16px 22px 10px;margin:0 0 28px;break-inside:avoid}
.kh{font-size:9pt;font-weight:700;color:#0F1F4D;letter-spacing:.5px;display:flex;align-items:center;gap:8px;margin-bottom:4px}.kh:before{content:"";width:18px;height:4px;border-radius:2px;background:#F2B705}
ul{margin:0;padding:0 18px 0 0}li{margin-bottom:6px}li::marker{color:#94A3B8}p{margin:.35em 0}
.card{border:1px solid #E5E7EB;border-radius:14px;padding:18px 22px 12px;margin:0 0 16px;box-shadow:0 1px 2px rgba(15,31,77,.04),0 4px 14px rgba(15,31,77,.05)}
.sh{display:flex;align-items:baseline;gap:10px;margin-bottom:8px;flex-wrap:wrap;break-after:avoid}
.num{font-size:9pt;font-weight:700;color:#F2B705;background:#0F1F4D;border-radius:6px;padding:1px 7px;direction:ltr}
h2{font-size:13pt;font-weight:700;color:#0F1F4D;margin:0}h3{color:#1E3A8A;margin:.6em 0 .2em}
.cite-inline{display:inline-block;unicode-bidi:isolate;direction:ltr;white-space:nowrap;background:#EEF2FF;color:#1E3A8A;border-radius:999px;padding:0 8px;font-size:7.5pt;font-weight:500;margin:0 3px;vertical-align:1px;line-height:1.7}
.cite{direction:ltr;unicode-bidi:isolate;margin:.4em 0 0}
.gt{font-size:13pt;font-weight:700;color:#0F1F4D;margin:30px 0 12px}
dl.gl{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0}.term{background:#F8FAFC;border-radius:12px;padding:10px 14px;break-inside:avoid}
dt{font-weight:700;color:#1E3A8A;font-size:9.5pt}dd{margin:2px 0 0;font-size:9.5pt;color:#475569;line-height:1.6}
.sign{margin:30px 0 10px;padding:12px 0 0;border-top:1px solid #E2E8F0;color:#64748B;font-size:9pt;text-align:center}
bdi{unicode-bidi:isolate}.math,.katex,.katex-display{unicode-bidi:isolate;direction:ltr}bdi.math{display:inline-block}div.math{display:block;text-align:center;margin:.4em 0}.katex{font-size:1.05em}
.big-picture[dir=rtl]{direction:rtl;text-align:right}.big-picture[dir=ltr]{direction:ltr;text-align:left}.big-picture{border-top:1px solid #E2E8F0;margin-top:2em;padding-top:.5em}.big-picture h2{margin:.6em 0 .3em}.big-picture dl{margin:0}.big-picture dd{margin:0 0 .4em}
.fig{margin:.5em auto;text-align:center;break-inside:avoid;page-break-inside:avoid}.fig img{display:block;margin:0 auto;max-width:100%;max-height:80mm;object-fit:contain;border:1px solid #E5E7EB;border-radius:8px}.fig figcaption{font-size:.85em;color:#475569;margin-top:.3em}.fig figcaption[dir=rtl]{direction:rtl}`;

export function renderStudyHtml(s0: LectureSummary, figures: Figure[] = [], meta: StudyMeta = {}): string {
  // Defensive: a summary stored as `[{...}]` (Gemini array wrap) rendered as an empty glossary-only page.
  const s = (Array.isArray(s0) ? (s0 as unknown[]).find((o) => o && typeof o === "object") ?? {} : s0) as LectureSummary;
  const ok = figures.filter((f) => /^data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{4,}/.test(f.src ?? ""));
  const secs = arr<any>(s.sections);
  const figs = (i: number) => ok.filter((f) => f.section === i || (i === secs.length - 1 && (f.section < 0 || f.section >= secs.length))).map(renderFigure).join("");
  const chips = [meta.course, meta.lecture, fmtDate(meta.date)].filter((x) => str(x).trim()).map((x) => `<span class="chip">${bidi(x)}</span>`).join("")
    + (str(meta.level).trim() ? `<span class="chip lvl">רמה: <b>${bidi(meta.level)}</b></span>` : "");
  // Key points: first bullet of the first 4 sections (presentation only; summary content unchanged).
  const keys = secs.slice(0, 4).map((x) => arr(x?.bullets)[0]).filter((b) => str(b).trim());
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(s.title)}</title>
<style>
${BRAND_CSS}
</style></head><body>
<div class="bar"></div><header><h1>${bidi(s.title)}</h1>${chips ? `<div class="meta">${chips}</div>` : ""}</header>
<main>${s.transcript_thin ? `<p class="thin">שימו לב: התמלול של ההקלטה קצר/חסר ביחס לשקפים — חלק מהסיכום מבוסס על השקפים בלבד.</p>` : ""}${arr(s.overview).map((o) => `<p class="ov">${bidi(o)}</p>`).join("")}
${keys.length ? `<div class="key"><div class="kh">חשוב לזכור</div><ul>${keys.map((b) => `<li>${bidi(b)}</li>`).join("")}</ul></div>` : ""}
${secs.map((x, i) => `<section class="card"><div class="sh"><span class="num">${String(i + 1).padStart(2, "0")}</span><h2>${bidi(x?.heading)}</h2>${x?.citation ? renderCite(unent(x.citation)) : ""}</div>${x?.style === "prose" ? arr(x.bullets).map((b) => `<p>${bidi(b)}</p>`).join("") : `<ul>${arr(x?.bullets).map((b) => `<li>${bidi(b)}</li>`).join("")}</ul>`}${figs(i)}</section>`).join("\n")}
<div class="gt">מילון מונחים</div><dl class="gl">${arr<any>(s.glossary).map((g) => `<div class="term"><dt>${bidi(g?.term)}</dt><dd>${bidi(g?.explanation)}</dd></div>`).join("")}</dl>
${renderBigPicture(s.big_picture)}
<div class="sign">${SIGN_OFF}</div></main>
</body></html>`;
}

/** Chromium footer (displayHeaderFooter): "עמוד X מתוך Y · כיסוי הקלטה NN%". Coverage omitted when unknown (slides-only). */
export function studyFooterTemplate(coverageRatio?: number | null): string {
  const cov = typeof coverageRatio === "number" && isFinite(coverageRatio) ? ` · כיסוי הקלטה ${Math.round(Math.min(1, Math.max(0, coverageRatio)) * 100)}%` : "";
  return `<div dir="rtl" style="width:100%;font-family:'IBM Plex Sans Hebrew',Arial,sans-serif;font-size:7.5pt;color:#94A3B8;text-align:center;padding:0 44px">עמוד <span class="pageNumber"></span> מתוך <span class="totalPages"></span>${cov}</div>`;
}
