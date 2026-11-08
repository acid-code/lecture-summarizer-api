/**
 * Hierarchical (map → outline → per-section write) summary for long lectures.
 * 1) per-10-min structured notes, 2) outline covering the full timeline, 3) one call per section (prose paragraphs).
 * Post-processing: Hebrew overview check, real title, global cap on "חשוב" markers, min-words retry per section.
 * Pure w.r.t. the model: callers pass `J` (prompt → parsed JSON, with their own retry / quota handling).
 */
import type { LectureContext, LectureSummary, Transcript } from "./types";
import { MATH_RULES, NO_NIQQUD, STRUCTURE_MODE, slidesForSummary } from "./prompts";

export type JsonFn = <T = any>(prompt: string, opts?: { strong?: boolean }) => Promise<T>;
export const HIER_PART_SEC = 600;
export const HIER_MIN_WORDS = 350;
export const HIER_MAX_CHASHUV = 12;

const mmss = (s: number) => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const toSec = (v: unknown): number | null => typeof v === "number" ? v : v ? String(v).split(":").reduce((n, p) => n * 60 + Number(p), 0) : null;
export const words = (xs: string[]) => xs.join(" ").split(/\s+/).filter(Boolean).length;
const heRatio = (s: string) => { const he = (s.match(/[\u0590-\u05FF]/g) ?? []).length, en = (s.match(/[A-Za-z]/g) ?? []).length; return he / Math.max(1, he + en); };
/** "Lecture - 1.11.2026", "הרצאה 3", "Recording 12" … → not a real title. */
export const genericTitle = (t: string) => !t.trim() || /^(lecture|recording|הרצאה|הקלטה|שיעור)?[\s\-–:#]*[\d./\-\s]*$/i.test(t.trim()) || /^(lecture|recording)\s*[-–:]\s*[\d./]+$/i.test(t.trim());

/** ASR span (first speech → last speech), seconds. */
export const asrSpan = (t: Transcript) => t.segments.length ? Math.max(...t.segments.map((s) => s.end)) - Math.min(...t.segments.map((s) => s.start)) : 0;

/** Remove "חשוב:" prefixes beyond the global budget (keeps the earliest ones). */
export function capChashuv(paragraphSets: string[][], budget: number): number {
  let used = 0;
  for (const ps of paragraphSets) for (let i = 0; i < ps.length; i++) {
    const n = (ps[i].match(/חשוב/g) ?? []).length; if (!n) continue;
    if (used + n <= budget) { used += n; continue; }
    ps[i] = ps[i].replace(/^\s*\**חשוב(\s*\([^)]*\))?\s*\**\s*[:：]\s*/, "").replace(/\s*\(?חשוב(?: למבחן)?\)?[:：]?\s*/g, " ").trim();
    used += (ps[i].match(/חשוב/g) ?? []).length;
  }
  return used;
}

/** Resumable state (stored in job artifacts between 300 s invocations). */
export interface HierState { parts?: any[]; outline?: any; sections?: (LectureSummary["sections"][number] | null)[]; calls?: number }
const CONC = () => Math.max(1, Number(process.env.SUMMARY_HIER_CONCURRENCY || 3));

/** Run as much of the hierarchical summary as fits before `deadline` (ms epoch). Returns the summary when finished, else null (state updated). */
export async function hierarchicalStep(tr: Transcript, ctx: LectureContext, J: JsonFn, st: HierState, deadline = Infinity, log: (m: string) => void = console.warn): Promise<LectureSummary | null> {
  const segs = tr.segments; const end = Math.max(...segs.map((x) => x.end));
  const title = ctx.title; const slides = slidesForSummary(ctx.slidesText,2200,800);
  const timeLeft = () => deadline - Date.now() > 100_000;
  const Jc: JsonFn = (p, o) => { st.calls = (st.calls ?? 0) + 1; return J(p, o); };
  // 1) per-part notes
  const windows: { a: number; label: string; text: string }[] = [];
  for (let a = 0; a < end; a += HIER_PART_SEC) {
    const ss = segs.filter((x) => x.start >= a && x.start < a + HIER_PART_SEC); if (!ss.length) continue;
    windows.push({ a, label: `${mmss(a)}-${mmss(Math.min(end, a + HIER_PART_SEC))}`, text: ss.map((x) => `[t=${mmss(x.start)}] ${x.text}`).join("\n") });
  }
  st.parts ??= [];
  while (st.parts.length < windows.length) {
    if (!timeLeft()) return null;
    const batch = windows.slice(st.parts.length, st.parts.length + CONC());
    const got = await Promise.all(batch.map(async (w) => ({ ...(await Jc(`You are extracting study notes from part of a Hebrew university lecture ("${title}"), lecture time ${w.label}.
Return JSON {"part":"${w.label}","topics":[{"name","t_start","t_end","summary"}],"definitions":[{"term_en","term_he","definition","t"}],"theorems_or_rules":[{"statement","t"}],"examples":[{"description","details","t"}],"professor_emphasis":[{"quote_or_paraphrase","t"}],"exam_hints":[{"hint","t"}],"numbers_and_specifics":[{"fact","t"}]}.
Use only times (M:SS) that appear in the transcript. Hebrew text, keep English technical terms in English. ${NO_NIQQUD} Capture every distinct topic, definition, rule, procedure, worked example (setup+method+result) and number that matters in this part — as concise notes, not a retelling; skip admin chatter, jokes and repetitions. professor_emphasis / exam_hints: only what the lecturer EXPLICITLY stresses ("this is important", "will be on the exam") — usually 0-2 per part.
Slide hints (spelling only): ${slides}
TRANSCRIPT:
${w.text}`)), part: w.label })));
    st.parts.push(...got); log(`hier parts ${st.parts.length}/${windows.length}`);
  }
  const parts = st.parts;
  // 2) outline
  if (!st.outline) {
    if (!timeLeft()) return null;
    const dn = ctx.density ?? "standard";
    const nSec = Math.max(dn === "compact" ? 3 : 5, Math.round(end / 60 / (dn === "compact" ? 15 : dn === "detailed" ? 9 : 11)));
    st.outline = await Jc(`Build a study-guide outline for the lecture "${title}" (${mmss(0)}-${mmss(end)}) from these per-part notes. Sections must follow lecture order and together cover the FULL timeline (every part with real content belongs to some section; no gap >8 minutes except parts with no lecture content). ~${nSec} sections.
${STRUCTURE_MODE}
Return JSON {"title","overview","structure_mode":"topics"|"questions","sections":[{"heading","kind":"question"?,"t_start","t_end","parts":["M:SS-M:SS"],"must_include":["..."]}]}.
- "title": a real, specific HEBREW lecture title describing the main topics (English technical terms allowed inline)${genericTitle(title) ? "" : `; the course/lecture is "${title}" — keep that course name as prefix`}. Never a date or "Lecture - …".
- "overview": 3-5 sentences in HEBREW (Hebrew script, English technical terms inline only). Not English.
- Headings in Hebrew with English terms. If structure_mode is "questions", headings are "שאלה N: …" and kind is "question".
NOTES: ${JSON.stringify(parts)}`);
    if (!st.outline?.sections?.length) throw new Error("hierarchical outline empty");
  }
  const outline = st.outline;
  // 3) sections
  st.sections ??= [];
  const dn = ctx.density ?? "standard";
  const band = dn === "compact" ? { lo: 120, hi: 250, paras: "2-3", min: 80 } : dn === "detailed" ? { lo: 450, hi: 750, paras: "3-7", min: HIER_MIN_WORDS } : { lo: 220, hi: 420, paras: "2-5", min: 150 };
  const writeSection = async (sec: any): Promise<LectureSummary["sections"][number] | null> => {
    const rel = parts.filter((p) => (sec.parts ?? []).includes(p.part));
    const a = Math.max(0, (toSec(sec.t_start) ?? 0) - 30), b = (toSec(sec.t_end) ?? end) + 30;
    const raw = segs.filter((x) => x.start >= a && x.start <= b).map((x) => `[t=${mmss(x.start)}] ${x.text}`).join("\n");
    if (!raw.trim()) return null;
    const asQuestion = sec.kind === "question" || outline.structure_mode === "questions" || /^(שאלה|תרגיל|Question|Exercise)\s*\d/i.test(String(sec.heading ?? ""));
    const prompt = `Write ONE section of a Hebrew study guide for "${title}". Heading: "${sec.heading}" (lecture ${sec.t_start}-${sec.t_end}).
Write ${band.lo}-${band.hi} words of Hebrew study notes as short explanatory paragraphs with English technical terms inline (code-switch), split into ${band.paras} paragraphs. Each paragraph ends with a [t=M:SS] or [t=M:SS-M:SS] citation using only times from the transcript. Cover must_include: ${JSON.stringify(sec.must_include ?? [])}.
This is a STUDY SUMMARY, not a retelling: never paraphrase the speech sentence by sentence. Distill definitions, rules, procedures, the key example (setup+method+result) and the numbers that matter; drop admin, anecdotes, repetitions.${dn === "detailed" ? " Explain reasoning and intuition where the lecturer did." : ""} At most ONE paragraph may start with "חשוב: " and only if the lecturer explicitly stressed it; otherwise do not use the word "חשוב". ${NO_NIQQUD} No filler.
${asQuestion ? `This section is ONE drill question. Also return "important_notes": short lines (1-6) with solving tips/traps/exam hints the TA said for THIS question only — required when spoken, including for standard density. Citation should include [slide N] when identifiable.` : ""}
${MATH_RULES}
Return JSON {"heading","paragraphs":[string],"citation":"[t=..]","kind":${asQuestion ? `"question"` : `"topic"`},"important_notes":[string]}.
STRUCTURED NOTES: ${JSON.stringify(rel)}
TRANSCRIPT EXCERPT:
${raw}`;
    let r: any = await Jc(prompt);
    let w = words(r.paragraphs ?? []);
    if (w < band.min) {
      log(`hier section "${sec.heading}" only ${w} words; retrying`);
      const r2: any = await Jc(prompt + `\n\nYour previous answer was only ${w} words — too short. Write at least ${band.lo} words covering the topics in must_include — concise notes, not a retelling.`, { strong: true }).catch(() => null);
      if (r2 && words(r2.paragraphs ?? []) > w) { r = r2; w = words(r2.paragraphs ?? []); }
    }
    log(`hier section "${sec.heading}" ${w}w`);
    const notes = Array.isArray(r.important_notes) ? r.important_notes.map(String).filter((x: string) => x.trim()) : [];
    return {
      heading: r.heading || sec.heading,
      bullets: (r.paragraphs ?? []).map(String),
      citation: r.citation,
      style: "prose",
      kind: asQuestion ? "question" : undefined,
      important_notes: notes.length ? notes : undefined,
    };
  };
  while (st.sections.length < outline.sections.length) {
    if (!timeLeft()) return null;
    const batch = outline.sections.slice(st.sections.length, st.sections.length + CONC());
    st.sections.push(...await Promise.all(batch.map(writeSection)));
  }
  const sections = st.sections.filter(Boolean).map((x) => ({ ...x!, bullets: [...x!.bullets] }));
  // Emphasis section: exam hints first, deduped; total "חשוב" in the document capped.
  const seenE = new Set<string>();
  const emph = parts.flatMap((p) => [...(p.exam_hints ?? []).map((x: any) => `למבחן: ${x.hint} [t=${x.t}]`), ...(p.professor_emphasis ?? []).map((x: any) => `${x.quote_or_paraphrase} [t=${x.t}]`)])
    .filter((x) => { const k = x.slice(0, 40); if (seenE.has(k)) return false; seenE.add(k); return true; }).slice(0, 8);
  capChashuv(sections.map((s) => s.bullets), HIER_MAX_CHASHUV - 1); // heading of emphasis section uses one
  if (emph.length) sections.push({ heading: "דגשים חשובים של המרצה", bullets: emph.map((e) => e.replace(/חשוב[:：]?\s*/g, "")) });
  const seen = new Set<string>();
  const glossary = parts.flatMap((p) => p.definitions ?? []).filter((d: any) => { const k = (d.term_en || d.term_he || "").toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .map((d: any) => ({ term: [d.term_en, d.term_he].filter(Boolean).join(" / "), explanation: `${d.definition} [t=${d.t}]` }));
  let overview = String(outline.overview ?? ""); let outTitle = String(outline.title ?? "");
  if (heRatio(overview) < 0.6 || genericTitle(outTitle) || heRatio(outTitle) < 0.3) {
    const fix: any = await Jc(`Rewrite in Hebrew (Hebrew script; keep English technical terms inline, ${NO_NIQQUD}). Return JSON {"title","overview"}. title: specific Hebrew lecture title naming the main topics (not a date). overview: 3-5 Hebrew sentences.
Current title: ${outTitle || title}
Current overview: ${overview}
Section headings: ${sections.map((s) => s.heading).join(" | ")}`).catch(() => null);
    if (fix?.overview && heRatio(fix.overview) >= heRatio(overview)) overview = fix.overview;
    if (fix?.title && !genericTitle(fix.title)) outTitle = fix.title;
  }
  if (genericTitle(outTitle)) outTitle = title;
  const structure_mode = outline.structure_mode === "questions" || sections.some((s) => s.kind === "question") ? "questions" as const : "topics" as const;
  return { title: outTitle, overview, transcript_thin: false, structure_mode, sections, glossary };
}

/** Convenience: run to completion (offline / tests). */
export const hierarchicalSummary = async (tr: Transcript, ctx: LectureContext, J: JsonFn, log?: (m: string) => void) =>
  (await hierarchicalStep(tr, ctx, J, {}, Infinity, log))!;
