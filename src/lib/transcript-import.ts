/** External (Panopto / TAU video server) transcript import: SRT → Transcript, plus JSON segment normalization. */
import type { Segment, Transcript } from "./providers/types";

const TS = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
/** "HH:MM:SS,mmm" → seconds. */
export function srtTime(s: string): number {
  const m = TS.exec(s); if (!m) throw new Error(`bad SRT timestamp: ${s}`);
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1000;
}

/** Panopto's auto-caption disclaimer cue line. */
const DISCLAIMER = /^\s*\[(auto-generated transcript|תמלול אוטומטי)[^\]]*\]\s*$/i;
/** Candidate "Speaker Name: " prefix (≤ 5 words, no digits/sentence punctuation). */
const SPEAKER = /^\s*([^\s:\d.?!,][^:\d.?!,\n]{0,40}?):\s+/u;

function rawCue(text: string): string {
  return text.split(/\r?\n/).filter((l) => !DISCLAIMER.test(l)).map((l) => l.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Strip speaker prefixes. A prefix counts as a speaker label only when it recurs (≥ 3 cues and ≥ 5% of cues),
 * so a Hebrew sentence that happens to contain a colon is kept intact.
 */
export function stripSpeakers(segs: Segment[]): Segment[] {
  const n = new Map<string, number>();
  for (const s of segs) { const m = SPEAKER.exec(s.text); if (m && m[1].trim().split(/\s+/).length <= 5) n.set(m[1].trim(), (n.get(m[1].trim()) ?? 0) + 1); }
  const min = Math.max(Math.min(3, segs.length), Math.ceil(segs.length * 0.05));
  const speakers = new Set([...n].filter(([, c]) => c >= min).map(([k]) => k));
  return segs.map((s) => { const m = SPEAKER.exec(s.text); return m && speakers.has(m[1].trim()) ? { ...s, text: s.text.slice(m[0].length).trim() } : s; })
    .filter((s) => s.text);
}

export function parseSrt(srt: string, language = "he"): Transcript {
  const segments: Segment[] = [];
  for (const block of srt.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split("-->");
    const text = rawCue(lines.slice(ti + 1).join("\n"));
    if (!text) continue;
    segments.push({ start: srtTime(a), end: srtTime(b), text });
  }
  segments.sort((x, y) => x.start - y.start);
  return { language, segments: stripSpeakers(segments) };
}

export interface ImportSegment { t0?: number; t1?: number; start?: number; end?: number; text?: string }
/** Normalize JSON segments ({t0,t1}|{start,end}); drops empty/invalid ones and strips speaker prefixes. */
export function normalizeSegments(segs: ImportSegment[], language = "he"): Transcript {
  const out: Segment[] = [];
  for (const s of segs ?? []) {
    const start = Number(s.t0 ?? s.start), end = Number(s.t1 ?? s.end ?? start);
    const text = rawCue(String(s.text ?? ""));
    if (!Number.isFinite(start) || !text) continue;
    out.push({ start, end: Number.isFinite(end) && end >= start ? end : start, text });
  }
  out.sort((x, y) => x.start - y.start);
  return { language, segments: stripSpeakers(out) };
}

/** Match Android CaptionQuality: thin captions on a long video must not start a study job. */
export const LONG_VIDEO_SEC = 15 * 60;
export const MIN_CAPTION_COVERAGE = 0.25;
export const MIN_CAPTION_CHARS = 800;
/** Full-session SRT paired with a short clip (e.g. 14s podcast) must not become the study transcript. */
export const MAX_CAPTION_OVERSHOOT_RATIO = 1.35;
export const MAX_CAPTION_OVERSHOOT_SLACK_SEC = 90;

export function captionsOvershootVideo(captionEndSec: number, videoDurationSec: number): boolean {
  const limit = Math.max(videoDurationSec * MAX_CAPTION_OVERSHOOT_RATIO, videoDurationSec + MAX_CAPTION_OVERSHOOT_SLACK_SEC);
  return captionEndSec > limit;
}

export function captionsUsable(t: Transcript, videoDurationSec?: number | null): boolean {
  const segs = t.segments ?? [];
  if (!segs.length) return false;
  const chars = segs.reduce((n, s) => n + s.text.trim().length, 0);
  const end = Math.max(...segs.map((s) => s.end));
  const video = Number(videoDurationSec);
  const hasVideo = Number.isFinite(video) && video > 0;
  if (!hasVideo) return chars >= 200;
  if (captionsOvershootVideo(end, video!)) return false;
  if (video! < LONG_VIDEO_SEC) return chars > 0;
  if (chars < MIN_CAPTION_CHARS) return false;
  if (end < video! * MIN_CAPTION_COVERAGE) return false;
  return true;
}
