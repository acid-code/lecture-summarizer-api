import type { Transcript } from "./types";

/**
 * Remove ASR passages that were transcribed twice.
 *
 * Root cause: when a window (or a density re-split half, e.g. "3:00-6:00") is transcribed, Gemini sometimes starts
 * listening earlier than asked and stamps already-transcribed speech with the requested (later) times. The merged
 * transcript then repeats a passage 1-2 more times ~1-2 minutes later, often with different sentence boundaries.
 *
 * Detection is high-precision: a segment is a duplicate when most of its word 3-grams already occurred in kept
 * segments from the preceding LOOKBACK seconds, AND it is either long or part of a run of such segments (a speaker
 * repeating one sentence verbatim is kept; a repeated multi-sentence block is not). Earlier copies are kept.
 */
const LOOKBACK_SEC = Number(process.env.DEDUPE_LOOKBACK_SEC || 420);
const COVER = 0.8;
const EDGE_COVER = 0.5;

const norm = (s: string) => (s ?? "").replace(/[\u0591-\u05C7]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").toLowerCase().split(/\s+/).filter(Boolean);
const grams = (w: string[], n: number) => { const out: string[] = []; for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(" ")); return out; };

export function dedupeTranscript<T extends Transcript>(t: T): T & { dedupedCount?: number } {
  const segs = t.segments ?? [];
  if (segs.length < 3) return t;
  const words = segs.map((s) => norm(s.text));
  // coverage[i]: share of segment i's 3-grams (or words for short segments) already seen in the lookback.
  const kept: number[] = [];
  const cover: number[] = new Array(segs.length).fill(0);
  const dup: boolean[] = new Array(segs.length).fill(false);
  const seen = (i: number) => {
    const prev = kept.filter((k) => segs[k].start >= segs[i].start - LOOKBACK_SEC && segs[k].start <= segs[i].start + 1);
    const g3 = new Set(prev.flatMap((k) => grams(words[k], 3)).concat(
      // also n-grams spanning a sentence boundary of consecutive kept segments
      prev.slice(1).flatMap((k, x) => grams([...words[prev[x]].slice(-2), ...words[k].slice(0, 2)], 3))));
    const w1 = new Set(prev.flatMap((k) => words[k]));
    const w = words[i];
    if (w.length >= 4) { const g = grams(w, 3); return g.filter((x) => g3.has(x)).length / g.length; }
    return w.length ? w.filter((x) => w1.has(x)).length / w.length : 0;
  };
  // Pass 1: candidates (cumulatively, so a third copy is checked against kept text only).
  for (let i = 0; i < segs.length; i++) {
    cover[i] = seen(i);
    const cand = cover[i] >= COVER;
    // Provisional: long candidates are dups on their own; short ones are decided once neighbours are known.
    if (cand && words[i].length >= 10) dup[i] = true;
    else if (cand) dup[i] = true; // revisited below
    if (!dup[i]) kept.push(i);
  }
  // Pass 2: a short candidate (< 10 words) is only a dup inside a run with at least one other candidate neighbour.
  const nb = (j: number) => j >= 0 && j < segs.length && dup[j];
  for (let i = 0; i < segs.length; i++) {
    if (!dup[i] || words[i].length >= 10) continue;
    if (!nb(i - 1) && !nb(i + 1)) dup[i] = false;
  }
  // Pass 3: grow confirmed runs (>= 2 segments) by neighbours that are mostly covered (copies re-split differently).
  const inRun = (i: number) => dup[i] && (nb(i - 1) || nb(i + 1));
  for (let grew = true; grew;) {
    grew = false;
    for (let i = 0; i < segs.length; i++) {
      if (dup[i] || cover[i] < EDGE_COVER) continue;
      if ((i > 0 && inRun(i - 1)) || (i + 1 < segs.length && inRun(i + 1))) { dup[i] = true; grew = true; }
    }
  }
  const out = segs.filter((_, i) => !dup[i]);
  const n = segs.length - out.length;
  return n ? { ...t, segments: out, dedupedCount: n } : t;
}
