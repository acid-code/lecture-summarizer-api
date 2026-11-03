import { geminiProvider } from "./gemini";
import { geminiConfigured } from "./keys";
import { mockProvider } from "./mock";
import type { AiProvider } from "./types";

export function getProvider(): AiProvider {
  return geminiConfigured() ? geminiProvider : mockProvider;
}
export * from "./types";
