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

export function summaryPrompt(t: Transcript, repairs: Repair[], ctx: LectureContext) {
  const text = t.segments.map((s) => s.text).join(" ");
  return `Write a structured study summary in Hebrew (keep English technical terms in English) for the lecture "${ctx.title}".
The lecture transcript and slides are the PRIMARY source. Course-pack excerpts are background only — use them for
terminology/definitions, never add topics not covered in this lecture.
Cite as [slide N, mm:ss] where possible.
Slides: ${(ctx.slidesText ?? "(none)").slice(0, 12000)}
Course-pack excerpts: ${ctx.courseExcerpts?.(text, 6000) || "(none)"}
Term repairs already applied: ${JSON.stringify(repairs)}
Transcript:
${fmt(t)}
Return JSON {"title","overview","sections":[{"heading","bullets":[],"citation"}],"glossary":[{"term","explanation"}]}.`;
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
