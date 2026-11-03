import type { LectureSummary, Transcript } from "../providers/types";

/** Seconds around a point cite [t=m:ss] that count as "covered". */
export const CITE_PAD_SEC = 120;
export const MIN_COVERAGE = 0.85;
export const MAX_GAP_SEC = 600;
export const ASR_MIN_RATIO = 0.95;

export interface Coverage { asrStart: number; asrEnd: number; asrSec: number; citedSec: number; ratio: number; cites: number; gaps: [number, number][]; /** all uncovered stretches > 3 min */ holes: [number, number][]; ok: boolean }

export const parseClock = (s: string) => s.split(":").reduce((n, p) => n * 60 + Number(p), 0);
const clock = (sec: number) => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60; return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`; };

const RANGE = /t=\s*(\d{1,3}(?::\d{2}){1,2})(?:\s*[-–]\s*(\d{1,3}(?::\d{2}){1,2}))?/g;

/** All [t=…] cites in a summary as [start,end] (backwards ranges swapped). */
export function citeRanges(s: LectureSummary): [number, number][] {
  const out: [number, number][] = [];
  for (const m of JSON.stringify(s ?? {}).matchAll(RANGE)) {
    const a = parseClock(m[1]), b = m[2] ? parseClock(m[2]) : a;
    out.push(a <= b ? [a, b] : [b, a]);
  }
  return out;
}

/** Fix backwards t= ranges (e.g. t=12:30-11:05) in every string of the summary, in place-safe copy. */
export function fixBackwardRanges<T>(v: T): T {
  if (typeof v === "string") return v.replace(RANGE, (all, a: string, b?: string) => b && parseClock(a) > parseClock(b) ? all.replace(a, "\0").replace(b, a).replace("\0", b) : all) as T;
  if (Array.isArray(v)) return v.map(fixBackwardRanges) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fixBackwardRanges(x)])) as T;
  return v;
}

export function asrSpan(t: Transcript | undefined): [number, number] | null {
  const s = t?.segments ?? [];
  if (!s.length) return null;
  return [Math.min(...s.map((x) => x.start)), Math.max(...s.map((x) => x.end))];
}

/** How much of the ASR time span the summary's [t=…] cites touch (each cite padded by CITE_PAD_SEC). */
export function computeCoverage(t: Transcript | undefined, s: LectureSummary): Coverage | null {
  const span = asrSpan(t);
  if (!span || span[1] - span[0] < 60) return null;
  const [lo, hi] = span;
  const iv = citeRanges(s).map(([a, b]) => [Math.max(lo, a - CITE_PAD_SEC), Math.min(hi, b + CITE_PAD_SEC)] as [number, number])
    .filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const r of iv) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push([...r]); }
  const citedSec = merged.reduce((n, [a, b]) => n + b - a, 0);
  const gaps: [number, number][] = [];
  let cur = lo;
  for (const [a, b] of merged) { if (a - cur > 0) gaps.push([cur, a]); cur = Math.max(cur, b); }
  if (hi - cur > 0) gaps.push([cur, hi]);
  const big = gaps.filter(([a, b]) => b - a > MAX_GAP_SEC).map(([a, b]) => [Math.round(a), Math.round(b)] as [number, number]);
  const asrSec = hi - lo, ratio = citedSec / asrSec;
  return { asrStart: Math.round(lo), asrEnd: Math.round(hi), asrSec: Math.round(asrSec), citedSec: Math.round(citedSec), ratio: Math.round(ratio * 1000) / 1000,
    cites: iv.length, gaps: big, holes: gaps.filter(([a, b]) => b - a > 180).map(([a, b]) => [Math.round(a), Math.round(b)] as [number, number]), ok: ratio >= MIN_COVERAGE && !big.length };
}

/** Transcript restricted to the given windows (for a focused "fill gaps" summary call). */
export function sliceTranscript(t: Transcript, wins: [number, number][]): Transcript {
  return { ...t, segments: t.segments.filter((x) => wins.some(([a, b]) => x.end > a && x.start < b)) };
}

/** Append gap-fill sections (deduped by heading), keeping order by first cite time. */
export function mergeGapSections(base: LectureSummary, extra: LectureSummary): LectureSummary {
  const have = new Set(base.sections.map((x) => String(x.heading).trim()));
  const add = (extra.sections ?? []).filter((x) => !have.has(String(x.heading).trim()) && citeRanges({ sections: [x] } as LectureSummary).length);
  const first = (x: LectureSummary["sections"][number]) => citeRanges({ sections: [x] } as LectureSummary)[0]?.[0] ?? Infinity;
  const timed = [...base.sections, ...add].map((x, i) => ({ x, i, t: first(x) }));
  // Keep untimed (slide-only) sections at their relative tail position; sort timed by time.
  const sorted = timed.filter((y) => y.t !== Infinity).sort((a, b) => a.t - b.t).concat(timed.filter((y) => y.t === Infinity));
  return { ...base, sections: sorted.map((y) => y.x), glossary: [...(base.glossary ?? []), ...(extra.glossary ?? []).filter((g) => !(base.glossary ?? []).some((h) => h.term === g.term))] };
}

/** Time intervals actually spoken-covered by a transcript (segments merged across pauses < tolSec). */
export function spokenIntervals(t: Transcript | undefined, tolSec = 90): [number, number][] {
  const iv = [...(t?.segments ?? [])].map((x) => [x.start, Math.max(x.start, x.end)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of iv) { const l = out[out.length - 1]; if (l && r[0] <= l[1] + tolSec) l[1] = Math.max(l[1], r[1]); else out.push([...r]); }
  return out;
}

/**
 * Merge segments from older transcripts of the same lecture (e.g. the job that ran before "Record another", whose raw
 * audio was already deleted) into `base`, only where `base` has no speech. `extras` newest first. Sorted by time.
 */
export function mergeTranscripts(base: Transcript, extras: (Transcript | undefined)[]): { t: Transcript; added: number } {
  const segs = [...base.segments];
  let added = 0;
  for (const e of extras) {
    if (!e?.segments?.length) continue;
    const have = spokenIntervals({ ...base, segments: segs }, 30);
    const inside = (m: number) => have.some(([a, b]) => m >= a && m <= b);
    const add = e.segments.filter((x) => !inside((x.start + x.end) / 2));
    segs.push(...add); added += add.length;
  }
  segs.sort((a, b) => a.start - b.start);
  return { t: { ...base, segments: segs }, added };
}

/** ASR speech coverage vs uploaded audio duration (catches missing start/middle too, not only a short end). */
export function asrCompleteness(t: Transcript | undefined, uploadedSec: number) {
  const end = asrSpan(t)?.[1] ?? 0;
  const spoken = spokenIntervals(t, 180).reduce((n, [a, b]) => n + b - a, 0);
  // Primary signal: transcript end vs uploaded duration (silences/pauses inside the lecture are normal).
  const ratio = uploadedSec > 0 ? end / uploadedSec : 1;
  // Secondary: gross missing start/middle (e.g. a lost recording session) — speech covers under half the audio.
  const spokenRatio = uploadedSec > 0 ? (spoken + 180) / uploadedSec : 1;
  return { asrEndSec: Math.round(end), spokenSec: Math.round(spoken), uploadedSec: Math.round(uploadedSec), ratio: Math.round(ratio * 1000) / 1000, incomplete: uploadedSec > 0 && (ratio < ASR_MIN_RATIO || spokenRatio < 0.5) };
}

export const fmtWin = ([a, b]: [number, number]) => `${clock(a)}-${clock(b)}`;
