import type { LectureContext, Repair, Transcript } from "./types";

const fmt = (t: Transcript) => t.segments.map((s, i) => `#${i} [${s.start}-${s.end}s] ${s.text}`).join("\n");

export function repairPrompt(t: Transcript, ctx: LectureContext) {
  const text = t.segments.map((s) => s.text).join(" ");
  return `You fix Hebrew/English code-switching errors in an ASR transcript of a Hebrew university lecture ("${ctx.title}").
Typical errors: English technical terms transliterated into Hebrew letters ("דיפ לרנינג" → "deep learning"),
phonetically mangled terms, wrong acronyms, broken formula names. Do NOT rephrase, translate or fix grammar.
Only propose edits supported by evidence from the slides, the course pack, or very strong domain knowledge.
Primary evidence — lecture slides:
${(ctx.slidesText ?? "(none)").slice(0, 8000)}
Secondary evidence — course pack excerpts:
${ctx.courseExcerpts?.(text, 5000) || "(none)"}
Transcript (segment index, times, text):
${fmt(t)}
Return JSON array: [{"segment":index,"span":"exact substring in that segment","replacement":"fixed text","evidence":"slide N / course-pack p.N / domain","confidence":0..1}].
Return [] if nothing to fix.`;
  // TODO: phonetic matching (Hebrew-transliteration ↔ English term list) as a cheap pre-pass before the LLM.
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
Put cites inline at the end of bullets and in each section's "citation".`;
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
