import { geminiProvider } from "./gemini";
import { mockProvider } from "./mock";
import type { AiProvider } from "./types";

export function getProvider(): AiProvider {
  return process.env.GEMINI_API_KEY ? geminiProvider : mockProvider;
}
export * from "./types";
