import type { LectureContext, Repair, Transcript } from "./types";

/** Hebrew combining marks: cantillation (U+0591–05AF), niqqud points (U+05B0–05BD, 05BF, 05C1–05C2, 05C4–05C5, 05C7).
 *  Punctuation in the block (maqaf U+05BE, paseq, sof pasuq, nun hafukha) is kept. */
const HEBREW_MARKS = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
export const stripNiqqud = (s: string) => (s ? s.replace(HEBREW_MARKS, "") : s);
export const hasNiqqud = (s: string) => /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/.test(s ?? "");
/** Deterministically remove Hebrew niqqud/cantillation from every segment text. */
export function stripTranscript<T extends Transcript>(t: T): T {
  return { ...t, segments: (t.segments ?? []).map((s) => ({ ...s, text: stripNiqqud(s.text) })) };
}
/* ---------- Deterministic Hebrew cleanup (high precision, runs after niqqud strip) ---------- */
const HE = "\u05D0-\u05EA";
/** Function words a stray prefix letter must not be glued onto ("ה של ה RNA" is a hesitation, not "השל"). */
const NO_JOIN = new Set(["של", "את", "זה", "זו", "זאת", "על", "עם", "אם", "גם", "לא", "כן", "אז", "או", "כי", "אה", "אהה", "ה", "ו", "ב", "ל", "מ", "ש", "כ", "יש", "אין", "הוא", "היא", "הם", "הן", "אני", "אתה", "את", "אנחנו", "מה", "מי", "איך", "פה", "כאן", "שם", "עוד", "רק", "כל", "אבל", "אחד", "אחת", "כמו"]);
/** Curated ASR confusions seen in real lectures. Whole words only (an optional prefix ו/ה/ב/כ/ל/מ/ש is kept). */
const HE_FIXES: [string, string][] = [
  ["הודם", "הקודם"],
  ["שרבה", "שהרבה"],
  ["יכלים", "יכולים"],
  ["סגנל", "סיגנל"],
  ["ראקציה", "ריאקציה"],
  ["ביאולוגיה", "ביולוגיה"],
  // Hebrew bench (Oct 2026): spellings the ASR emits in "pointed" mode; standard full spelling is unambiguous.
  ["דפקא", "דווקא"],
  ["דוקא", "דווקא"],
  ["מאד", "מאוד"],
];
const FIX_RES = HE_FIXES.map(([bad, good]) => [new RegExp(`(?<![${HE}])([ובכלמשה]{0,2})${bad}(?![${HE}])`, "g"), good] as const);
/** 1) glue a lone prefix letter (ב/כ/ל/מ/ו/ש/ה) to the following Hebrew word ("ב ריכוזים"→"בריכוזים");
 *  a lone ה before a word that already starts with ה is dropped ("ה הקפסיד"→"הקפסיד"); 2) curated word fixes. */
export function cleanHebrew(s: string): string {
  if (!s) return s;
  let out = s.replace(new RegExp(`(?<![${HE}'"׳״\\-])([בכלמושה]) ([${HE}]{2,})(?![${HE}'׳])`, "g"), (m, p: string, w: string) => {
    if (NO_JOIN.has(w)) return m;
    if (p === "ה" && w.startsWith("ה")) return w;
    if (p === w[0] && p !== "ו") return m; // ambiguous doubling — leave it
    return p + w;
  });
  for (const [re, good] of FIX_RES) out = out.replace(re, (_m, pre: string) => pre + good);
  return out;
}
/** True for real gibberish only. Lectures are mixed Hebrew+English (code-switching inside one sentence is normal, short
 *  English-only phrases are valid), so Hebrew and Latin letters (incl. accented Latin) are both "ok". Drops: segments whose
 *  letters are mostly another script (seen: Armenian gibberish over a silent tail) and huge repetition loops. */
export function isForeignScript(s: string): boolean {
  const letters = (s ?? "").match(/\p{L}/gu) ?? [];
  if (letters.length < 4) return false;
  const ok = letters.filter((c) => /[\p{Script=Hebrew}\p{Script=Latin}]/u.test(c)).length;
  return ok / letters.length < 0.5;
}
/** A degenerate loop: >=40 words where one short n-gram (1-4 words) repeats back-to-back covering >=70% of the text. */
export function isRepetitionLoop(s: string): boolean {
  const w = (s ?? "").trim().split(/\s+/).filter(Boolean);
  if (w.length < 40) return false;
  for (let n = 1; n <= 4; n++) {
    let best = 0, run = 0;
    for (let i = n; i + n <= w.length; i += n) {
      if (w.slice(i, i + n).join(" ") === w.slice(i - n, i).join(" ")) { run += n; best = Math.max(best, run + n); } else run = 0;
    }
    if (best / w.length >= 0.7) return true;
  }
  return false;
}
/** niqqud strip + deterministic Hebrew cleanup on every segment; keeps Hebrew, English and mixed He+En segments and drops
 *  only gibberish (other scripts, repetition loops). */
export function cleanTranscript<T extends Transcript>(t: T): T {
  return { ...t, segments: (t.segments ?? []).map((s) => ({ ...s, text: cleanHebrew(stripNiqqud(s.text)) }))
    .filter((s) => !isForeignScript(s.text) && !isRepetitionLoop(s.text)) };
}
export const NO_NIQQUD = `NEVER emit niqqud, Hebrew vowel points or cantillation marks (Unicode U+0591–U+05C7). Write Hebrew as plain, unpointed Hebrew (כתיב מלא); English words stay in Latin script.`;

const fmt = (t: Transcript) => t.segments.map((s, i) => `#${i} [${s.start}-${s.end}s] ${s.text}`).join("\n");

const ORTHO = `HEBREW ORTHOGRAPHY — the ASR often writes Hebrew words by sound, so fix misspelled Hebrew words to their correct
dictionary/scientific spelling. Common confusions: כ/ח/ק (ריקוזים→ריכוזים, קימיה→כימיה), ב/ו, ט/ת, ס/ש/צ (שׂ), א/ע/ה,
כ/כּ vs ק at word start, missing/extra matres lectionis (י/ו), final letters (ך ם ן ף ץ), split/merged words and prefixes (ה,ו,ב,כ,ל,מ,ש).
PREFIXES: the one-letter prefixes ב כ ל מ ו ש ה are ALWAYS written attached to the next word — a lone prefix letter followed by a
space is an ASR split: join it ("ב ריכוזים"→"בריכוזים", "ה נדבק"→"הנדבק"). Short common words are often mis-heard too — fix them
even without slide evidence when the intended word is clear from context: dropped/garbled ק,ה,ו,י inside function words
(הודם→הקודם, שרבה→שהרבה, יכלים→יכולים, אתו→אותו, מאד→מאוד). These are spelling fixes, NOT rephrasing: keep every word that was said.
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
  return `You fix ASR errors in a transcript of a university lecture ("${ctx.title}") in mixed Hebrew+English:
speakers code-switch inside sentences, and English words/phrases (even whole short English sentences) are NORMAL and must stay English.
Fix: (a) English technical terms transliterated into Hebrew letters ("דיפ לרנינג" → "deep learning") when the slides use English;
(b) phonetically mangled terms, wrong acronyms, broken formula/compound names; (c) misspelled Hebrew words; (d) misspelled English words.
Never translate English into Hebrew or Hebrew into English, and never "fix" a correctly spoken English word into Hebrew.
${ORTHO}
${NO_NIQQUD}
${RULES}
${ctxBlock(t, ctx)}
Transcript (segment index, times, text):
${t.segments.map((s, i) => `#${i + offset} [${s.start}-${s.end}s] ${s.text}`).join("\n")}
Return JSON array: [{"segment":index,"span":"exact substring in that segment","replacement":"fixed text","evidence":"slide N / course-pack / spelling / domain","confidence":0..1}].
Return [] if nothing to fix.`;
}

/** Pass 2 (light): Hebrew spelling only, run on the already-repaired text. */
export function spellingPrompt(t: Transcript, ctx: LectureContext, offset = 0) {
  return `Proofread ONLY the Hebrew spelling in this ASR transcript of a mixed Hebrew+English lecture ("${ctx.title}").
Find Hebrew words written phonetically/incorrectly and give the correct spelling. Ignore style, grammar and punctuation.
Be thorough: check EVERY Hebrew word, including short function words and prefixes (not only technical terms). Do not be shy —
a clear misspelling of a common word should be fixed with confidence ≥0.7. Still never rephrase, reorder, drop or add words.
Leave English (Latin-script) words and code-switched phrases as they are; do not translate or transliterate them.
${ORTHO}
${NO_NIQQUD}
${RULES}
${ctxBlock(t, ctx, 5000, 2500)}
Transcript (segment index, text):
${t.segments.map((s, i) => `#${i + offset} ${s.text}`).join("\n")}
Return JSON array: [{"segment":index,"span":"exact misspelled substring","replacement":"corrected","evidence":"spelling / slide N","confidence":0..1}].
Return [] if everything is spelled correctly.`;
}

const mmss = (sec: number) => { const t = Math.max(0, Math.floor(sec)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const fmtTimed = (t: Transcript) => t.segments.map((s) => `[t=${mmss(s.start)}-${mmss(s.end)}] ${s.text}`).join("\n");

/** Optional end-of-PDF overview ("big picture"), appended AFTER the main summary; same language as the summary (Hebrew + English terms by default). */
export const BIG_PICTURE = `BIG PICTURE (optional "big_picture" field, written in the SAME language as the summary — Hebrew prose with English technical terms (He+En code-switch) for Hebrew lectures; it is printed at the very END of the PDF,
after the summary and glossary — it supplements the summary and never replaces or reorders it):
- "intent": 2-4 sentences on what this lecture was trying to TEACH — the underlying idea the examples were meant to illustrate,
  and how this lecture fits the course (use course-pack excerpts only for that framing).
- "themes": 2-5 main themes/concepts, ordered from the most basic/"easier" idea to the hardest. Each "explanation" (3-6
  sentences) explains the concept itself in plain language, says WHY it matters, and ties it to the lecture's concrete examples
  (cite [t=…] / [slide N] when possible). Make implicit steps explicit — do not jump straight to the final result.
- "missed_terms": technical terms that were USED in the transcript or slides (e.g. "literal", or any term the lecturer
  mentioned in passing) but are not explained in the sections/glossary above — give a short precise definition with a cite.
- Stay grounded: standard textbook background needed to understand THIS lecture's material is fine, but do not introduce
  topics the lecture did not touch. If the lecture is too short/thin to say anything useful, set "big_picture": null.
- Same MATH rules apply (KaTeX delimiters).`;

/** Transcript is "thin" when it is empty/very short, or tiny compared to the slide text. */
export function isTranscriptThin(t: Transcript | undefined, slidesText?: string | null): boolean {
  const chars = (t?.segments ?? []).reduce((n, s) => n + s.text.trim().length, 0);
  const slides = slidesText?.length ?? 0;
  return chars < 800 || (slides > 0 && chars < slides * 0.25);
}

/** Materials-only (no recording): turn slide decks / PDFs into a lecture-style study summary. */
export function slidesOnlyPrompt(ctx: LectureContext) {
  const slides = ctx.slidesText ?? "";
  return `Write a structured study summary in Hebrew (keep English technical terms in English) for the lecture "${ctx.title}".
There is NO recording of this lecture. The source is the lecture's presentation slides / PDF materials below (text extracted
per slide/page, slides separated by form-feeds or "=== file ===" headers). Slides are terse bullet points, NOT a summary:
- Turn them into a real study summary a student can learn from: explain each concept in full sentences, connect ideas,
  spell out the reasoning/intuition behind formulas and definitions, and add short clarifying examples where they help.
- Follow the slides' order and topics; group related slides into coherent sections. Do not just copy slide text verbatim.
- Do not invent topics that are not in the materials; course-pack excerpts are background for terminology/definitions only.
- Cite slides as [slide N] (or [slide N-M]) at the end of bullets and in each section's "citation". Never use [t=…] times.
- Set "transcript_thin": false (there is intentionally no transcript).
Slides / materials:
${slides.slice(0, 60000) || "(none)"}
Course-pack excerpts: ${ctx.courseExcerpts?.(slides.slice(0, 4000), 6000) || "(none)"}
Return JSON {"title","overview","transcript_thin":boolean,"sections":[{"heading","bullets":[],"citation"}],"glossary":[{"term","explanation"}],"big_picture":{"intent","themes":[{"title","explanation"}],"missed_terms":[{"term","explanation"}]}}.
${BIG_PICTURE}
MATH (rendered with KaTeX — undelimited TeX prints as garbage in the RTL PDF):
- EVERY formula, equation, symbol or expression MUST be wrapped: inline \\( ... \\), display $$ ... $$. This includes single symbols (\\(\\varepsilon\\), \\(\\delta\\), \\(|H|\\)).
- NEVER write a bare \\command (\\frac, \\varepsilon, \\ln, \\le ...) in prose outside delimiters. Never write HTML entities (&gt;, &lt;) — use > < or \\le \\ge inside math.
- Never put Hebrew inside math; keep each formula LTR and self-contained (Hebrew words go outside the delimiters).
- Prefer standard ASCII/TeX notation for PAC/ML symbols: \\varepsilon, \\delta, e_P(h), |H|, \\mathbb{P}, m(\\varepsilon,\\delta).
- Escape backslashes correctly for JSON (\\\\frac in the JSON string).`;
}

/** Slide text for the summary prompt: head of the deck plus the closing slides in full (end-of-deck summaries matter). */
export function slidesForSummary(slides?: string | null, head = 10000, tail = 5000): string {
  if (!slides) return "(none)";
  if (slides.length <= head + tail) return slides + `\n(FINAL SLIDES = the last slides above.)`;
  return slides.slice(0, head) + `\n…(middle slides omitted)…\nFINAL SLIDES (end of deck, closing summary):\n` + slides.slice(-tail);
}

export function summaryPrompt(t: Transcript, repairs: Repair[], ctx: LectureContext) {
  if (ctx.slidesOnly) return slidesOnlyPrompt(ctx);
  const text = t.segments.map((s) => s.text).join(" ");
  const thin = isTranscriptThin(t, ctx.slidesText);
  return `Write a structured study summary in Hebrew (keep English technical terms in English) for the lecture "${ctx.title}".
SOURCE PRIORITY (strict) — the VOICE/transcript leads, slides only support it:
1. PRIMARY = the repaired lecture transcript below (what the lecturer actually SAID). Build the summary around it:
   follow the ORDER of the speech, its explanations, examples, emphasis, remarks, and anything said that is not on the slides.
   Section headings and structure come from how the lecture was spoken, NOT from the slide deck outline.
2. SUPPORTING = slides. Use them only to clarify terms/spelling, formulas, definitions, structure and diagrams for what was said.
   Do NOT reorganize the summary by slide order and do NOT give slide-only bullets equal weight: slide material that was not
   discussed goes in briefly (one short bullet, or the glossary), never as the backbone of a section.
2b. IMPORTANT SLIDE CONTENT must not be lost even though slides are secondary: harvest the slides' key definitions and key
   points into the matching spoken sections (cite [slide N], or [t=…, slide N] when also spoken), and ALWAYS add one final
   section titled "סיכום מהמצגת" (from the slides) built from the deck's CLOSING / summary / conclusion / take-home slides
   (usually the last few slides, shown in full below under "FINAL SLIDES") — include their points even if they were only
   lightly spoken or not spoken at all, each cited [slide N] (+ [t=…] when spoken). Keep it concise (about 3-8 bullets);
   do not turn the whole slide outline into sections.
3. BACKGROUND = course-pack excerpts — terminology/definitions only; never add topics not covered in this lecture.
CITATIONS (mixed, required):
- Spoken content MUST be cited with lecture time from the transcript, e.g. [t=4:35] (or a range [t=4:35-6:10]).
- Use [slide N] ONLY for material that appears on slides but was not discussed in the transcript.
- When both apply, cite both: [t=4:35, slide 3]. Never cite only slides for content that was spoken.
- Never invent times: only use times that appear in the transcript lines below.
${thin ? `WARNING: the transcript is empty or very short relative to the slides. Say so explicitly at the start of the
overview (in Hebrew: the recording/transcript covers only a small part of the lecture), summarize what the transcript does
contain with [t=…] cites, mark the rest as slide-only with [slide N], and set "transcript_thin": true.` : `Set "transcript_thin": false.`}
PRIMARY SOURCE — transcript (lecture time M:SS):
${fmtTimed(t) || "(empty)"}
Term repairs already applied: ${JSON.stringify(repairs)}
SUPPORTING CONTEXT — slides (glossary/structure/diagrams only; not the outline of the summary):
${slidesForSummary(ctx.slidesText)}
Course-pack excerpts: ${ctx.courseExcerpts?.(text, 6000) || "(none)"}
Return JSON {"title","overview","transcript_thin":boolean,"sections":[{"heading","bullets":[],"citation"}],"glossary":[{"term","explanation"}],"big_picture":{"intent","themes":[{"title","explanation"}],"missed_terms":[{"term","explanation"}]}}.
${BIG_PICTURE}
Put cites inline at the end of bullets and in each section's "citation".
MATH (rendered with KaTeX — undelimited TeX prints as garbage in the RTL PDF):
- EVERY formula, equation, symbol or expression MUST be wrapped: inline \\( ... \\), display $$ ... $$. This includes single symbols (\\(\\varepsilon\\), \\(\\delta\\), \\(|H|\\)).
- NEVER write a bare \\command (\\frac, \\varepsilon, \\ln, \\le ...) in prose outside delimiters. Never write HTML entities (&gt;, &lt;) — use > < or \\le \\ge inside math.
- Never put Hebrew inside math; keep each formula LTR and self-contained (Hebrew words go outside the delimiters).
- Prefer standard ASCII/TeX notation for PAC/ML symbols: \\varepsilon, \\delta, e_P(h), |H|, \\mathbb{P}, m(\\varepsilon,\\delta).
- Escape backslashes correctly for JSON (\\\\frac in the JSON string).`;
}

/** Apply high-confidence repairs to the transcript (edits stay stored for review). */
export function applyRepairs(t: Transcript, repairs: Repair[], min = 0.6): Transcript {
  const segs = t.segments.map((s) => ({ ...s, text: stripNiqqud(s.text) }));
  for (const raw of repairs) {
    if (raw.confidence < min || !raw.span) continue;
    const r = { ...raw, span: stripNiqqud(raw.span), replacement: stripNiqqud(raw.replacement ?? "") };
    if (!r.span) continue;
    const targets = r.segment != null && segs[r.segment] ? [segs[r.segment]] : segs;
    for (const s of targets) s.text = s.text.split(r.span).join(r.replacement);
  }
  return { ...t, segments: segs.map((s) => ({ ...s, text: cleanHebrew(s.text) })) };
}
