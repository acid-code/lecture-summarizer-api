import type { Transcript } from "./types";

/**
 * Remove ASR passages that were transcribed twice.
 *
 * Root cause: when a window (or a density re-split half, e.g. "3:00-6:00") is transcribed, Gemini sometimes starts
 * listening earlier than asked and stamps already-transcribed speech with the requested (later) times. The merged
 * transcript then repeats a passage 1-2 more times ~1-2 minutes later, often with different sentence boundaries.
 *
 * Detection is high-precision: a segment is a duplicate when most of its word 3-grams already occurred in kept
 * segments from the preceding LOOKBACK seconds. Copies are re-split and re-worded, so segments are grouped into runs of
 * "weak" matches (>=50% 3-grams, or short with >=60% words); a run is dropped only when it holds >=2 strong (>=80%)
 * matches, or is one long (>=10 words) strong match. A speaker repeating one short sentence is kept. Earlier copies win.
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
  const n = segs.length;
  const cover: number[] = new Array(n).fill(0), wcover: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const prev: number[] = [];
    for (let k = 0; k < i; k++) if (segs[k].start >= segs[i].start - LOOKBACK_SEC) prev.push(k);
    // earlier text as one word stream, so 3-grams spanning old sentence boundaries also count
    const stream = prev.flatMap((k) => words[k]);
    const g3 = new Set(grams(stream, 3)), w1 = new Set(stream);
    const w = words[i];
    wcover[i] = w.length ? w.filter((x) => w1.has(x)).length / w.length : 0;
    cover[i] = w.length >= 4 ? (() => { const g = grams(w, 3); return g.filter((x) => g3.has(x)).length / g.length; })() : wcover[i];
  }
  const strong = (i: number) => cover[i] >= COVER;
  const weak = (i: number) => cover[i] >= EDGE_COVER ||
    (words[i].length >= 3 && words[i].length <= 8 && wcover[i] >= 0.6 && (cover[i] > 0 || words[i].length <= 5));
  const dup: boolean[] = new Array(n).fill(false);
  for (let i = 0; i < n;) {
    if (!weak(i)) { i++; continue; }
    let j = i; while (j + 1 < n && weak(j + 1)) j++;
    const idx = Array.from({ length: j - i + 1 }, (_, x) => i + x);
    const nStrong = idx.filter(strong).length;
    if (nStrong >= 2 || idx.some((x) => strong(x) && words[x].length >= 10)) idx.forEach((x) => (dup[x] = true));
    i = j + 1;
  }
  if (process.env.DEDUPE_DEBUG) segs.forEach((s, i) => console.warn(i, s.start.toFixed(0), cover[i].toFixed(2), wcover[i].toFixed(2), dup[i] ? "DUP" : "", s.text.slice(0, 40)));
  const out = segs.filter((_, i) => !dup[i]);
  const removed = n - out.length;
  return removed ? { ...t, segments: out, dedupedCount: removed } : t;
}
