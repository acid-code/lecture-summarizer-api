import { GoogleGenAI, createPartFromUri } from "@google/genai";
import type { AiProvider, LectureContext, Repair, Transcript, LectureSummary } from "./types";

const model = () => process.env.GEMINI_MODEL || "gemini-2.5-flash"; // verify current Flash model name

function client() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
}

/** Upload a remote file (Blob URL) to the Gemini Files API and wait until it is ACTIVE. */
async function uploadToGemini(ai: GoogleGenAI, url: string, fallbackMime: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const mimeType = res.headers.get("content-type") || fallbackMime;
  const file = await ai.files.upload({ file: await res.blob(), config: { mimeType } });
  let f = file;
  for (let i = 0; i < 60 && f.state === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    f = await ai.files.get({ name: file.name! });
  }
  if (f.state === "FAILED") throw new Error("Gemini file processing failed");
  return createPartFromUri(f.uri!, f.mimeType || mimeType);
}

async function json<T>(contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"]): Promise<T> {
  const r = await client().models.generateContent({
    model: model(),
    contents,
    config: { responseMimeType: "application/json" },
  });
  return JSON.parse(r.text ?? "null") as T;
}

export const geminiProvider: AiProvider = {
  name: "gemini",
  async transcribe(audioUrl: string, ctx: LectureContext): Promise<Transcript> {
    const ai = client();
    const parts = [await uploadToGemini(ai, audioUrl, "audio/mp4")];
    // Slides bias the ASR toward correct English terms. PPTX may need conversion first (TODO, verify support).
    if (ctx.slidesUrl) parts.push(await uploadToGemini(ai, ctx.slidesUrl, "application/pdf"));
    return json<Transcript>([
      ...parts,
      `Transcribe this Hebrew university lecture ("${ctx.title}"). Speech mixes Hebrew with English technical terms: ` +
        `write English terms in Latin script, using the attached slides (if any) for spelling. ` +
        `Return JSON {"language":"he","segments":[{"start":seconds,"end":seconds,"text":string}]} with ~30-60s segments.`,
    ]);
  },
  async repairTerms(): Promise<Repair[]> {
    // TODO(core): Hebrew/English code-switch term repair. Use slide text + course glossary + course
    // context PDF to propose EDITS WITH EVIDENCE (not a rewritten transcript); store for user review.
    return [];
  },
  async summarize(t: Transcript, repairs: Repair[], ctx: LectureContext): Promise<LectureSummary> {
    return json<LectureSummary>([
      `Write a structured study summary in Hebrew (keep English technical terms in English) for the lecture "${ctx.title}". ` +
        `Cite as [slide N, mm:ss] where possible. Return JSON {"title","overview","sections":[{"heading","bullets":[],"citation"}],"glossary":[{"term","explanation"}]}.\n` +
        `Accepted term repairs: ${JSON.stringify(repairs)}\nTranscript: ${JSON.stringify(t.segments)}`,
    ]);
  },
};
