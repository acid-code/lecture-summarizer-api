import { GoogleGenAI, createPartFromUri, type Part } from "@google/genai";
import { readFileUrl } from "../storage";
import { clipper } from "./clip";
import { applyRepairs, repairPrompt, spellingPrompt, summaryPrompt, NO_NIQQUD } from "./prompts";
import type { AiProvider, Repair, LectureSummary, Transcript, WindowTranscript } from "./types";

/**
 * Model ladder, highest free-tier daily quota first (AI Studio free project, Oct 2026):
 *   gemini-3.5-flash-lite, gemini-3.1-flash-lite ~15 RPM / 500 RPD
 *   gemini-3.8-flash, gemini-flash-latest, gemini-3.5-flash ~5 RPM / 20 RPD
 * On 429/quota errors the next model is tried. GEMINI_MODEL / GEMINI_FALLBACK_MODELS override.
 */
export const DEFAULT_LADDER = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-flash-latest", "gemini-3.5-flash"];
export const models = () => {
  const primary = process.env.GEMINI_MODEL || DEFAULT_LADDER[0];
  const fb = process.env.GEMINI_FALLBACK_MODELS !== undefined
    ? process.env.GEMINI_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean)
    : DEFAULT_LADDER;
  return [...new Set([primary, ...fb])];
};
export const QUOTA_MSG = "Gemini free daily quota exhausted; retry after reset";
export class QuotaError extends Error { constructor() { super(QUOTA_MSG); } }
/** Models whose daily quota is exhausted in this process (until ~midnight Pacific; we just keep 1h). */
const exhausted = new Map<string, number>();
const isQuota = (m: string) => /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(m);
const isDaily = (m: string) => /PerDay|per day|daily|RPD|retry in \d+h|"retryDelay":\s*"\d{4,}s"/i.test(m);
const INLINE_MAX = 15 * 1024 * 1024; // inline small files (request limit ~20 MB); larger go through the Files API
const client = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

/** Upload a stored file (Blob URL or local:) to the Gemini Files API and wait until ACTIVE. */
async function uploadToGemini(ai: GoogleGenAI, url: string, fallbackMime: string): Promise<Part> {
  const { data, mime } = await readFileUrl(url);
  const mimeType = mime && mime !== "application/octet-stream" ? mime : fallbackMime;
  if (data.length <= INLINE_MAX) return { inlineData: { mimeType, data: data.toString("base64") } };
  const file = await ai.files.upload({ file: new Blob([new Uint8Array(data)], { type: mimeType }), config: { mimeType } });
  let f = file;
  for (let i = 0; i < 60 && f.state === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    f = await ai.files.get({ name: file.name! });
  }
  if (f.state === "FAILED") throw new Error("Gemini file processing failed");
  return createPartFromUri(f.uri!, f.mimeType || mimeType);
}

/**
 * Walk the model ladder. 429/quota → next model immediately (daily limits are marked exhausted for 1h so later
 * calls skip them). 500/503/overloaded → bounded jittered backoff (GEMINI_RETRIES, GEMINI_RETRY_BUDGET_MS).
 * If every model is out of quota, throw a short QuotaError instead of dumping Google's JSON.
 */
async function withRetry<T>(f: (model: string) => Promise<T>, tries = Number(process.env.GEMINI_RETRIES || 5)): Promise<T> {
  const budget = Number(process.env.GEMINI_RETRY_BUDGET_MS || 90_000);
  const start = Date.now();
  let transient = 0;
  const now = Date.now();
  const ladder = models().filter((m) => (exhausted.get(m) ?? 0) < now);
  if (!ladder.length) throw new QuotaError();
  let quotaHits = 0;
  for (let i = 0; ; i++) {
    const model = ladder[i % ladder.length];
    try { return await f(model); } catch (e) {
      const msg = (e as Error).message ?? "";
      if (isQuota(msg)) {
        quotaHits++;
        if (isDaily(msg) || quotaHits >= ladder.length) exhausted.set(model, Date.now() + 3600_000);
        console.warn(`gemini ${model} quota hit, trying next model`);
        if (quotaHits >= ladder.length) throw new QuotaError();
        continue;
      }
      if (++transient >= tries || !/\b(500|503)\b|UNAVAILABLE|overloaded|INTERNAL/i.test(msg)) throw e;
      const wait = Math.min(30_000, 3000 * 2 ** (transient - 1)) * (0.75 + Math.random() * 0.5);
      if (Date.now() - start + wait > budget) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Strip markdown fences and extract the first balanced JSON object/array from model text. */
export function extractJson(text: string): string {
  const t = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = t.search(/[[{]/);
  if (start < 0) return t;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return t.slice(start, i + 1);
  }
  return t.slice(start); // unbalanced (truncated) — let JSON.parse report it
}

export class BadJsonError extends Error {
  constructor(message: string, public raw: string) { super(message); }
}

async function rawJson(contents: (Part | string)[], schema?: object, maxOutputTokens = 65536): Promise<string> {
  const r = await withRetry((model) => client().models.generateContent({
    model, contents, config: { responseMimeType: "application/json", maxOutputTokens, ...(schema ? { responseSchema: schema } : {}) },
  }));
  return r.text ?? "";
}

function parse<T>(raw: string): T {
  try { return JSON.parse(extractJson(raw)) as T; } catch (e) {
    throw new BadJsonError(`invalid JSON from Gemini (${raw.length} chars): ${(e as Error).message}`, raw);
  }
}

/** Generate + parse JSON; on invalid/truncated JSON re-ask (GEMINI_JSON_RETRIES, default 2) then try a repair prompt. */
async function json<T>(contents: (Part | string)[], schema?: object, opts: { repair?: boolean; maxOutputTokens?: number } = {}): Promise<T> {
  const tries = Number(process.env.GEMINI_JSON_RETRIES || 2);
  let last: BadJsonError | undefined;
  for (let i = 0; i < tries; i++) {
    const raw = await rawJson(contents, schema, opts.maxOutputTokens);
    try { return parse<T>(raw); } catch (e) { if (!(e instanceof BadJsonError)) throw e; last = e; console.warn(e.message); }
  }
  if (opts.repair !== false && last && last.raw.length < 200_000) {
    const fixed = await rawJson([`The following JSON is invalid or truncated. Return ONLY the corrected, complete, valid JSON with the same ` +
      `structure (close any truncated arrays/objects; drop an incomplete last item). Do not add commentary.\n\n${last.raw}`], schema);
    try { return parse<T>(fixed); } catch (e) { if (!(e instanceof BadJsonError)) throw e; last = e; }
  }
  throw last!;
}

const transcriptSchema = {
  type: "OBJECT",
  properties: {
    language: { type: "STRING" },
    audioEnded: { type: "BOOLEAN" },
    segments: { type: "ARRAY", items: { type: "OBJECT", properties: {
      start: { type: "NUMBER" }, end: { type: "NUMBER" }, text: { type: "STRING" } }, required: ["start", "end", "text"] } },
  },
  required: ["language", "segments"],
};
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const MIN_SPLIT_SEC = 60;
/** Output cap for one ASR call: generous for real speech (~10 tokens/s incl. JSON) but stops degenerate repetition
 *  loops (seen: 70k+ chars of a repeated phrase over a silent tail) from running for minutes and burning quota. */
const asrTokenCap = (ws?: number, we?: number) => ws !== undefined && we !== undefined ? Math.min(65536, Math.max(4096, Math.round((we - ws) * 30))) : 65536;
/** Pull every complete {start,end,text} object out of truncated/invalid transcript JSON. */
export function salvageSegments(raw: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const re = /\{\s*"start"\s*:\s*([\d.]+)\s*,\s*"end"\s*:\s*([\d.]+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  for (const m of raw.matchAll(re)) { try { out.push({ start: +m[1], end: +m[2], text: JSON.parse(`"${m[3]}"`) }); } catch { /* skip */ } }
  // Drop a degenerate loop: stop at the 3rd consecutive repeat of the same text.
  return out.filter((s, i) => !(i >= 2 && s.text === out[i - 1].text && s.text === out[i - 2].text));
}

export const geminiProvider: AiProvider = {
  name: "gemini",
  async transcribe(audio, ctx): Promise<WindowTranscript> {
    const ai = client();
    const hints = (ctx.slidesText ?? "(none)").slice(0, 6000);
    const LANG = `Transcribe this university lecture audio ("${ctx.title}"). The speaker mixes Hebrew and English, often inside ` +
      `the same sentence (Hebrew with English technical terms/phrases, sometimes whole English sentences): write Hebrew words in ` +
      `Hebrew script and English words in Latin script exactly as spoken; never translate or transliterate either way. ` +
      `${NO_NIQQUD} Slide text for spelling hints:\n${hints}\n`;
    const TAIL = `Return JSON {"language":"he","segments":[{"start":seconds,"end":seconds,"text":string}]} with one segment per ` +
      `sentence (~5-15s each). Transcribe every word verbatim (no summarizing, no skipping). start/end must be the real ` +
      `moments the words are spoken, measured from the audio itself; do not space timestamps evenly. ` +
      `If there is no speech, return {"language":"he","segments":[]}.`;
    // Preferred path: cut each window with ffmpeg and send only that clip (timestamps clip-relative, offset by ws here).
    // Fallback (no ffmpeg / ffmpeg error): whole file + "transcribe only MM:SS-MM:SS" prompt as before.
    const windowed = audio.windowStart !== undefined && audio.windowEnd !== undefined;
    let src: { data: Buffer; mime?: string } | undefined;
    let clip: Awaited<ReturnType<typeof clipper>> | null = null;
    if (windowed) {
      try { src = await readFileUrl(audio.url); clip = await clipper(src.data); }
      catch (e) { clip = null; console.warn(`ASR clip: ffmpeg unavailable, falling back to whole-file time-range prompt: ${(e as Error).message}`); }
    }
    let wholePart: Part | undefined;
    const whole = async () => (wholePart ??= await uploadToGemini(ai, audio.url, audio.mime));
    const askClip = async (ws: number, we: number): Promise<WindowTranscript | null> => {
      if (!clip) return null;
      let bytes: Buffer | null;
      try { bytes = await clip.cut(ws, we); }
      catch (e) { console.warn(`ASR clip ${fmt(ws)}-${fmt(we)}: cut failed, falling back to whole-file prompt: ${(e as Error).message}`); return null; }
      if (!bytes) return { language: "he", segments: [], audioEnded: true };
      const part: Part = { inlineData: { mimeType: "audio/mp4", data: bytes.toString("base64") } };
      const call = () => json<WindowTranscript>([part, LANG +
        `This clip is ${Math.round(we - ws)}s long. Transcribe ALL speech in this clip from its very beginning to its end; ` +
        `timestamps are seconds from the start of THIS clip (0 = clip start). ` +
        (audio.prevText ? `The clip may begin mid-sentence; the previous part ended with: «${audio.prevText}». Do not repeat those words. ` : "") +
        TAIL], transcriptSchema, { repair: false, maxOutputTokens: asrTokenCap(ws, we) });
      let t: WindowTranscript;
      try { t = await call(); } catch (e) {
        // Salvage/repair here so clip-relative times get offset; otherwise let run() split the window.
        if (!(e instanceof BadJsonError)) throw e;
        const salvaged = salvageSegments(e.raw);
        if (salvaged.length >= 2) { console.warn(`ASR clip: salvaged ${salvaged.length} segments from invalid JSON`); t = { language: "he", segments: salvaged }; }
        else if (we - ws > MIN_SPLIT_SEC * 2) throw e;
        else t = parse<WindowTranscript>(await rawJson([`The following JSON is invalid or truncated. Return ONLY corrected, complete, ` +
          `valid JSON with the same structure (drop an incomplete last item).\n\n${e.raw}`], transcriptSchema));
      }
      const segs = (t.segments ?? []).map((s) => typeof s.start === "number" && typeof s.end === "number"
        ? { ...s, start: Math.min(we, s.start + ws), end: Math.min(we, s.end + ws) } : s);
      return { ...t, segments: segs, audioEnded: t.audioEnded };
    };
    const ask = async (ws?: number, we?: number) => (ws !== undefined && we !== undefined ? await askClip(ws, we) : null) ??
      json<WindowTranscript>([await whole(), LANG +
        (ws !== undefined && we !== undefined
          ? `ONLY transcribe the part of the audio from ${fmt(ws)} to ${fmt(we)} (${ws}s-${we}s). Timestamps must be absolute ` +
            `seconds from the start of the file. If the audio ends before ${fmt(ws)}, return {"language":"he","segments":[],"audioEnded":true}. `+
            (audio.prevText ? `Everything before ${fmt(ws)} is ALREADY transcribed; it ended with: «${audio.prevText}». Do NOT transcribe ` +
              `those words again: start with the speech that follows them, at or after ${fmt(ws)}. ` : "")
          : "") + TAIL,
    ], transcriptSchema, { repair: false, maxOutputTokens: asrTokenCap(ws, we) });

    // On persistent bad JSON: split the window in half and merge; at the minimum size try the repair path.
    const run = async (ws?: number, we?: number): Promise<WindowTranscript> => {
      try { return await ask(ws, we); } catch (e) {
        if (!(e instanceof BadJsonError)) throw e;
        // Truncated output (often a repetition loop hitting the token cap): keep the complete segments, no extra calls.
        const salvaged = salvageSegments(e.raw);
        if (salvaged.length >= 2) { console.warn(`ASR: salvaged ${salvaged.length} segments from invalid JSON`); return { language: "he", segments: salvaged }; }
        if (ws !== undefined && we !== undefined && we - ws > MIN_SPLIT_SEC * 2) {
          const mid = Math.round((ws + we) / 2);
          const [x, y] = [await run(ws, mid), await run(mid, we)];
          return { language: x.language || y.language, segments: [...(x.segments ?? []), ...(y.segments ?? [])], audioEnded: x.audioEnded };
        }
        try {
          const fixed = await rawJson([`The following JSON is invalid or truncated. Return ONLY corrected, complete, valid JSON with the same ` +
            `structure (drop an incomplete last item).\n\n${e.raw}`], transcriptSchema);
          return parse<WindowTranscript>(fixed);
        } catch (e2) {
          if (!(e2 instanceof BadJsonError)) throw e2;
          throw new Error(`Gemini returned invalid transcript JSON` + (ws !== undefined ? ` for ${fmt(ws)}-${fmt(we!)}` : "") +
            ` after retries, splitting and repair (${e2.message}). Retry the job later.`);
        }
      }
    };
    const clean = (t: WindowTranscript, ws?: number, we?: number) => {
      if (process.env.ASR_DEBUG) console.warn("raw window", ws, we, JSON.stringify(t.segments?.map((s) => [s.start, s.end, s.text.slice(0, 30)])));
      let segs = (t.segments ?? []).filter((s) => typeof s.start === "number" && typeof s.end === "number" && s.text);
      if (ws !== undefined && we !== undefined) {
        // Model sometimes returns window-relative times; detect and shift. Then keep only segments starting inside the window.
        if (segs.length && ws > 0 && segs[0].start < ws - 5 && segs.every((s) => s.start <= we - ws + 5)) segs = segs.map((s) => ({ ...s, start: s.start + ws, end: s.end + ws }));
        const inside = (x: typeof segs) => x.filter((s) => s.start >= ws - 2 && s.start < we);
        // Seen on short clips: the model returns the right window's speech with times shifted past the window
        // (e.g. 202-302s for 120-192s), so the filter would silently drop the whole window. If most segments fall
        // outside but the returned span fits the window, rebase the block to the window start instead of losing it.
        const kept = inside(segs);
        const span = segs.length ? segs[segs.length - 1].start - segs[0].start : 0;
        if (segs.length >= 2 && kept.length < segs.length / 2 && span <= we - ws + 10) {
          const shift = ws - segs[0].start;
          segs = segs.map((s) => ({ ...s, start: Math.max(ws, s.start + shift), end: Math.min(we, Math.max(ws, s.end + shift)) }));
          console.warn(`ASR window ${fmt(ws)}-${fmt(we)}: rebased ${segs.length} off-window segments by ${shift.toFixed(0)}s`);
        }
        segs = inside(segs);
      }
      return segs;
    };
    // Fabricated timing check: flash-lite sometimes transcribes only part of a window and spreads it evenly over the whole
    // range (≈half the normal text density, long uniform segments) which stretches time ~2x vs the audio. Re-ask in halves.
    const suspicious = (segs: { start: number; end: number; text: string }[], ws: number, we: number) => {
      if (segs.length < 3 || we - ws < MIN_SPLIT_SEC * 2) return false;
      const span = Math.max(1, segs[segs.length - 1].end - segs[0].start);
      const chars = segs.reduce((n, s) => n + s.text.length, 0);
      const avgLen = span / segs.length;
      return chars / span < 6 && avgLen > 25;
    };
    const runChecked = async (ws?: number, we?: number, depth = 0): Promise<{ t: WindowTranscript; segs: ReturnType<typeof clean> }> => {
      const t = await run(ws, we);
      const segs = clean(t, ws, we);
      if (ws !== undefined && we !== undefined && depth < 2 && suspicious(segs, ws, we)) {
        const mid = Math.round((ws + we) / 2);
        const a = await runChecked(ws, mid, depth + 1), b = await runChecked(mid, we, depth + 1);
        return { t: { language: a.t.language || b.t.language, segments: [], audioEnded: a.t.audioEnded && b.t.audioEnded }, segs: [...a.segs, ...b.segs] };
      }
      return { t, segs };
    };
    let res: Awaited<ReturnType<typeof runChecked>>;
    try { res = await runChecked(audio.windowStart, audio.windowEnd); } finally { await clip?.dispose(); }
    const { t, segs: raw } = res;
    const segs = raw.sort((a, b) => a.start - b.start);
    // Shift into lecture time (multi-segment uploads).
    return { language: t.language || "he", audioEnded: t.audioEnded, segments: segs.map((s) => ({ ...s, start: s.start + audio.offsetSec, end: s.end + audio.offsetSec })) };
  },
  async repairTerms(t, ctx): Promise<Repair[]> {
    if (!t.segments.length) return [];
    // Chunk long transcripts so each call sees a manageable slice (indices stay absolute).
    const size = Number(process.env.REPAIR_CHUNK_SEGMENTS || 120);
    const run = async (mk: typeof repairPrompt, tr: Transcript) => {
      const out: Repair[] = [];
      for (let o = 0; o < tr.segments.length; o += size) {
        const part = { ...tr, segments: tr.segments.slice(o, o + size) };
        try { const r = await json<Repair[]>([mk(part, ctx, o)]); if (Array.isArray(r)) out.push(...r); }
        catch (e) { if (o === 0 && mk === repairPrompt) throw e; console.warn(`repair chunk ${o} skipped: ${(e as Error).message}`); }
      }
      return out;
    };
    const first = await run(repairPrompt, t);
    if (process.env.REPAIR_SPELLING_PASS === "0") return first;
    // Light second pass focused only on Hebrew spelling, over the text after pass-1 fixes.
    const second = await run(spellingPrompt, applyRepairs(t, first)).catch(() => [] as Repair[]);
    return [...first, ...second.map((r) => ({ ...r, evidence: r.evidence || "spelling" }))];
  },
  async summarize(t, repairs, ctx): Promise<LectureSummary> {
    return json<LectureSummary>([summaryPrompt(t, repairs, ctx)]);
  },
};
