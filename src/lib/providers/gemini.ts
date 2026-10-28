import { GoogleGenAI, createPartFromUri, type Part } from "@google/genai";
import { readFileUrl } from "../storage";
import { repairPrompt, summaryPrompt } from "./prompts";
import type { AiProvider, Repair, LectureSummary, WindowTranscript } from "./types";

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

async function rawJson(contents: (Part | string)[], schema?: object): Promise<string> {
  const r = await withRetry((model) => client().models.generateContent({
    model, contents, config: { responseMimeType: "application/json", maxOutputTokens: 65536, ...(schema ? { responseSchema: schema } : {}) },
  }));
  return r.text ?? "";
}

function parse<T>(raw: string): T {
  try { return JSON.parse(extractJson(raw)) as T; } catch (e) {
    throw new BadJsonError(`invalid JSON from Gemini (${raw.length} chars): ${(e as Error).message}`, raw);
  }
}

/** Generate + parse JSON; on invalid/truncated JSON re-ask (GEMINI_JSON_RETRIES, default 2) then try a repair prompt. */
async function json<T>(contents: (Part | string)[], schema?: object, opts: { repair?: boolean } = {}): Promise<T> {
  const tries = Number(process.env.GEMINI_JSON_RETRIES || 2);
  let last: BadJsonError | undefined;
  for (let i = 0; i < tries; i++) {
    const raw = await rawJson(contents, schema);
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

export const geminiProvider: AiProvider = {
  name: "gemini",
  async transcribe(audio, ctx): Promise<WindowTranscript> {
    const ai = client();
    const part = await uploadToGemini(ai, audio.url, audio.mime);
    const hints = (ctx.slidesText ?? "(none)").slice(0, 6000);
    const ask = (ws?: number, we?: number) => json<WindowTranscript>([part,
      `Transcribe this Hebrew university lecture audio ("${ctx.title}"). Speech mixes Hebrew with English technical terms: ` +
        `write English terms in Latin script. Slide text for spelling hints:\n${hints}\n` +
        (ws !== undefined && we !== undefined
          ? `ONLY transcribe the part of the audio from ${fmt(ws)} to ${fmt(we)} (${ws}s-${we}s). Timestamps must be absolute ` +
            `seconds from the start of the file. If the audio ends before ${fmt(ws)}, return {"language":"he","segments":[],"audioEnded":true}. `
          : "") +
        `Return JSON {"language":"he","segments":[{"start":seconds,"end":seconds,"text":string}]} with ~30-60s segments. ` +
        `If there is no speech, return {"language":"he","segments":[]}.`,
    ], transcriptSchema, { repair: false });

    // On persistent bad JSON: split the window in half and merge; at the minimum size try the repair path.
    const run = async (ws?: number, we?: number): Promise<WindowTranscript> => {
      try { return await ask(ws, we); } catch (e) {
        if (!(e instanceof BadJsonError)) throw e;
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
    const t = await run(audio.windowStart, audio.windowEnd);
    let segs = (t.segments ?? []).filter((s) => typeof s.start === "number" && typeof s.end === "number" && s.text);
    if (audio.windowStart !== undefined && audio.windowEnd !== undefined) {
      const ws = audio.windowStart, we = audio.windowEnd;
      // Model sometimes returns window-relative times; detect and shift. Then keep only segments starting inside the window.
      if (segs.length && ws > 0 && segs[0].start < ws - 5 && segs.every((s) => s.start <= we - ws + 5)) segs = segs.map((s) => ({ ...s, start: s.start + ws, end: s.end + ws }));
      segs = segs.filter((s) => s.start >= ws - 2 && s.start < we);
    }
    // Shift into lecture time (multi-segment uploads).
    return { language: t.language || "he", audioEnded: t.audioEnded, segments: segs.map((s) => ({ ...s, start: s.start + audio.offsetSec, end: s.end + audio.offsetSec })) };
  },
  async repairTerms(t, ctx): Promise<Repair[]> {
    if (!t.segments.length) return [];
    const r = await json<Repair[]>([repairPrompt(t, ctx)]);
    return Array.isArray(r) ? r : [];
  },
  async summarize(t, repairs, ctx): Promise<LectureSummary> {
    return json<LectureSummary>([summaryPrompt(t, repairs, ctx)]);
  },
};
