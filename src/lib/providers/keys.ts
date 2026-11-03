import { createHash } from "node:crypto";
import { nextUtcMidnight } from "./quota-time";

/** Gemini API keys: legacy GEMINI_API_KEY first, then GEMINI_API_KEYS (comma-separated), trimmed, deduped. */
export function geminiKeys(env: Record<string, string | undefined> = process.env): string[] {
  const list = [env.GEMINI_API_KEY ?? "", ...(env.GEMINI_API_KEYS ?? "").split(",")].map((k) => k.trim()).filter(Boolean);
  return [...new Set(list)];
}
export const geminiConfigured = (env: Record<string, string | undefined> = process.env) => geminiKeys(env).length > 0;
/** Stable non-secret id for a key (used in logs and cooldown rows). Never log raw keys. */
export const keyId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 8);
export const maskKey = (key: string) => (key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-2)}` : "****") + `#${keyId(key)}`;

/** In-process skip list: a key whose whole model ladder hit daily quota is skipped until next 00:00 UTC. */
export class KeyPool {
  private until = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  available(keys: string[]): string[] { const t = this.now(); return keys.filter((k) => (this.until.get(keyId(k)) ?? 0) <= t); }
  markExhausted(key: string, until = nextUtcMidnight(this.now())) { this.until.set(keyId(key), Math.max(this.until.get(keyId(key)) ?? 0, until)); return until; }
  reset() { this.until.clear(); }
}
export const keyPool = new KeyPool();
