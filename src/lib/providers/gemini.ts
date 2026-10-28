import { GoogleGenAI, createPartFromUri, type Part } from "@google/genai";
import { readFileUrl } from "../storage";
import { repairPrompt, summaryPrompt } from "./prompts";
import type { AiProvider, Repair, Transcript, LectureSummary } from "./types";

/** Primary model + fallbacks tried on 503 "high demand". gemini-2.5-flash is closed to new keys (Oct 2026). */
const models = () => [process.env.GEMINI_MODEL || "gemini-3.5-flash",
  ...(process.env.GEMINI_FALLBACK_MODELS ?? "gemini-flash-latest,gemini-3.8-flash").split(",").map((m) => m.trim()).filter(Boolean)];
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

/** Retry transient 429/503 ("high demand") with backoff; stays well under the 300s function limit. */
async function withRetry<T>(f: (model: string) => Promise<T>, tries = 4): Promise<T> {
  const ms = models();
  for (let i = 0; ; i++) {
    try { return await f(ms[i % ms.length]); } catch (e) {
      const msg = (e as Error).message ?? "";
      if (i >= tries - 1 || !/\b(429|500|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
}

async function json<T>(contents: (Part | string)[]): Promise<T> {
  const r = await withRetry((model) => client().models.generateContent({ model, contents, config: { responseMimeType: "application/json" } }));
  return JSON.parse(r.text ?? "null") as T;
}

export const geminiProvider: AiProvider = {
  name: "gemini",
  async transcribe(audio, ctx): Promise<Transcript> {
    const ai = client();
    const t = await json<Transcript>([
      await uploadToGemini(ai, audio.url, audio.mime),
      `Transcribe this Hebrew university lecture audio ("${ctx.title}"). Speech mixes Hebrew with English technical terms: ` +
        `write English terms in Latin script. Slide text for spelling hints:\n${(ctx.slidesText ?? "(none)").slice(0, 6000)}\n` +
        `Return JSON {"language":"he","segments":[{"start":seconds,"end":seconds,"text":string}]} with ~30-60s segments. ` +
        `If the audio has no speech, return {"language":"he","segments":[]}.`,
    ]);
    // Shift into lecture time (multi-segment uploads).
    return { ...t, segments: (t.segments ?? []).map((s) => ({ ...s, start: s.start + audio.offsetSec, end: s.end + audio.offsetSec })) };
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
