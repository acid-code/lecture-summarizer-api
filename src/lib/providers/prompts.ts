import type { LectureContext, Repair, Transcript } from "./types";

const fmt = (t: Transcript) => t.segments.map((s, i) => `#${i} [${s.start}-${s.end}s] ${s.text}`).join("\n");

const ORTHO = `HEBREW ORTHOGRAPHY — the ASR often writes Hebrew words by sound, so fix misspelled Hebrew words to their correct
dictionary/scientific spelling. Common confusions: כ/ח/ק (ריקוזים→ריכוזים, קימיה→כימיה), ב/ו, ט/ת, ס/ש/צ (שׂ), א/ע/ה,
כ/כּ vs ק at word start, missing/extra matres lectionis (י/ו), final letters (ך ם ן ף ץ), split/merged words and prefixes (ה,ו,ב,כ,ל,מ,ש).
Domain terms (biology, chemistry, biochemistry, physics, math, engineering, CS) must use the standard academic Hebrew
spelling or the English term exactly as on the slides/course pack (enzyme names, units, reagents, acronyms like ELISA, pH, mM).`;

const RULES = `RULES: Prefer terms that appear in the slides first, then the course pack, then standard academic usage.
Correct only spelling/term errors of words that were clearly SAID — never rephrase, translate, summarize, reorder or add content,
never fix grammar or spoken style, never touch timestamps or segment boundaries. "span" must be an EXACT substring of that
segment's text (copy it character-for-character, keep it short: the misspelled word with minimal context), "replacement" is
the same span with only the fix applied. If unsure, skip it or give low confidence.`;

const ctxBlock = (t: Transcript, ctx: LectureContext, slides = 8000, pack = 5000) => {
  const text = t.segments.map((s) => s.text).join(" ");
  return `Primary evidence — lecture slides (glossary of correct spellings):
${(ctx.slidesText ?? "(none)").slice(0, slides)}
Secondary evidence — course pack excerpts:
${ctx.courseExcerpts?.(text, pack) || "(none)"}`;
};

/** Pass 1: terms + code-switching + Hebrew spelling. Segment indices are absolute (offset = first index in this chunk). */
export function repairPrompt(t: Transcript, ctx: LectureContext, offset = 0) {
  return `You fix ASR errors in a transcript of a Hebrew university lecture ("${ctx.title}"), Hebrew with English code-switching.
Fix: (a) English technical terms transliterated into Hebrew letters ("דיפ לרנינג" → "deep learning") when the slides use English;
(b) phonetically mangled terms, wrong acronyms, broken formula/compound names; (c) misspelled Hebrew words.
${ORTHO}
${RULES}
${ctxBlock(t, ctx)}
Transcript (segment index, times, text):
${t.segments.map((s, i) => `#${i + offset} [${s.start}-${s.end}s] ${s.text}`).join("\n")}
Return JSON array: [{"segment":index,"span":"exact substring in that segment","replacement":"fixed text","evidence":"slide N / course-pack / spelling / domain","confidence":0..1}].
Return [] if nothing to fix.`;
}

/** Pass 2 (light): Hebrew spelling only, run on the already-repaired text. */
export function spellingPrompt(t: Transcript, ctx: LectureContext, offset = 0) {
  return `Proofread ONLY the Hebrew spelling in this ASR transcript of a Hebrew lecture ("${ctx.title}").
Find Hebrew words written phonetically/incorrectly and give the correct spelling. Ignore style, grammar and punctuation.
${ORTHO}
${RULES}
${ctxBlock(t, ctx, 5000, 2500)}
Transcript (segment index, text):
${t.segments.map((s, i) => `#${i + offset} ${s.text}`).join("\n")}
Return JSON array: [{"segment":index,"span":"exact misspelled substring","replacement":"corrected","evidence":"spelling / slide N","confidence":0..1}].
Return [] if everything is spelled correctly.`;
}

const mmss = (sec: number) => { const t = Math.max(0, Math.floor(sec)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const fmtTimed = (t: Transcript) => t.segments.map((s) => `[t=${mmss(s.start)}-${mmss(s.end)}] ${s.text}`).join("\n");

/** Transcript is "thin" when it is empty/very short, or tiny compared to the slide text. */
export function isTranscriptThin(t: Transcript | undefined, slidesText?: string | null): boolean {
  const chars = (t?.segments ?? []).reduce((n, s) => n + s.text.trim().length, 0);
  const slides = slidesText?.length ?? 0;
  return chars < 800 || (slides > 0 && chars < slides * 0.25);
}

export function summaryPrompt(t: Transcript, repairs: Repair[], ctx: LectureContext) {
  const text = t.segments.map((s) => s.text).join(" ");
  const thin = isTranscriptThin(t, ctx.slidesText);
  return `Write a structured study summary in Hebrew (keep English technical terms in English) for the lecture "${ctx.title}".
SOURCE PRIORITY (strict):
1. PRIMARY = the repaired lecture transcript below (what the lecturer actually SAID). Build the summary around it:
   its order, explanations, examples, emphasis, remarks and anything said that is not on the slides.
2. SUPPORTING = slides. Use them only to fix terminology/formulas and to add slide-only material briefly.
3. BACKGROUND = course-pack excerpts — terminology/definitions only; never add topics not covered in this lecture.
CITATIONS (mixed, required):
- Spoken content MUST be cited with lecture time from the transcript, e.g. [t=4:35] (or a range [t=4:35-6:10]).
- Use [slide N] ONLY for material that appears on slides but was not discussed in the transcript.
- When both apply, cite both: [t=4:35, slide 3]. Never cite only slides for content that was spoken.
- Never invent times: only use times that appear in the transcript lines below.
${thin ? `WARNING: the transcript is empty or very short relative to the slides. Say so explicitly at the start of the
overview (in Hebrew: the recording/transcript covers only a small part of the lecture), summarize what the transcript does
contain with [t=…] cites, mark the rest as slide-only with [slide N], and set "transcript_thin": true.` : `Set "transcript_thin": false.`}
Slides: ${(ctx.slidesText ?? "(none)").slice(0, 12000)}
Course-pack excerpts: ${ctx.courseExcerpts?.(text, 6000) || "(none)"}
Term repairs already applied: ${JSON.stringify(repairs)}
Transcript (lecture time M:SS):
${fmtTimed(t) || "(empty)"}
Return JSON {"title","overview","transcript_thin":boolean,"sections":[{"heading","bullets":[],"citation"}],"glossary":[{"term","explanation"}]}.
Put cites inline at the end of bullets and in each section's "citation".
MATH: write every formula/equation/symbolic expression as LaTeX — inline \\( ... \\), display $$ ... $$ (it is rendered with KaTeX).
Escape backslashes correctly for JSON. Never put Hebrew inside math; keep math LTR and self-contained.`;
}

/** Apply high-confidence repairs to the transcript (edits stay stored for review). */
export function applyRepairs(t: Transcript, repairs: Repair[], min = 0.6): Transcript {
  const segs = t.segments.map((s) => ({ ...s }));
  for (const r of repairs) {
    if (r.confidence < min || !r.span) continue;
    const targets = r.segment != null && segs[r.segment] ? [segs[r.segment]] : segs;
    for (const s of targets) s.text = s.text.split(r.span).join(r.replacement);
  }
  return { ...t, segments: segs };
}
