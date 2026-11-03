/**
 * Gemini error classification + overload (503) backoff/fallback policy. Pure functions so they are unit-testable.
 *  - overloaded: 503 / UNAVAILABLE / "high demand" / overloaded → backoff on the same model, then fall back to another model.
 *    Never rotates keys (an overloaded model is overloaded for every key).
 *  - daily_quota / rpm: 429 RESOURCE_EXHAUSTED → existing ladder + multi-key failover (quota.ts / keys.ts).
 *  - auth: invalid / revoked key → try the next key.
 *  - transient: 500 INTERNAL → short backoff on the same model.
 */
import { isDailyQuota, isQuotaError } from "./quota";

export type GeminiErrorKind = "overloaded" | "daily_quota" | "rpm" | "auth" | "transient" | "other";

export function classifyGeminiError(msg: string): GeminiErrorKind {
  if (/\b503\b|UNAVAILABLE|high demand|overloaded/i.test(msg)) return "overloaded";
  if (isQuotaError(msg)) return isDailyQuota(msg) ? "daily_quota" : "rpm";
  if (/API_KEY_INVALID|API key not valid|API key expired|PERMISSION_DENIED|UNAUTHENTICATED|\b401\b/i.test(msg)) return "auth";
  if (/\b500\b|INTERNAL|\b504\b|DEADLINE_EXCEEDED/i.test(msg)) return "transient";
  return "other";
}

/** Exponential backoff with ±25% jitter: base·2^(attempt-1), capped. attempt is 1-based. */
export function backoffMs(attempt: number, base = 2000, cap = 20_000, rand: () => number = Math.random): number {
  return Math.round(Math.min(cap, base * 2 ** Math.max(0, attempt - 1)) * (0.75 + rand() * 0.5));
}

export const DEFAULT_OVERLOAD_FALLBACK = "gemini-3.1-flash-lite";

/**
 * Model to try after `current` stays overloaded: GEMINI_FALLBACK_MODEL (default gemini-3.1-flash-lite) if not tried yet,
 * else the next untried ladder rung. null = nothing left (caller gives up with GeminiOverloadedError).
 */
export function overloadFallback(current: string, ladder: string[], tried: Set<string>,
  env: Record<string, string | undefined> = process.env): string | null {
  const pref = (env.GEMINI_FALLBACK_MODEL ?? DEFAULT_OVERLOAD_FALLBACK).trim();
  if (pref && pref !== current && !tried.has(pref)) return pref;
  const i = ladder.indexOf(current);
  const order = [...ladder.slice(i + 1), ...ladder.slice(0, Math.max(0, i))];
  return order.find((m) => m !== current && !tried.has(m)) ?? null;
}

export const OVERLOAD_MSG = "Gemini is overloaded (503 high demand) on all tried models; auto-retrying later";
export class GeminiOverloadedError extends Error {
  constructor(public models: string[]) { super(`${OVERLOAD_MSG} (tried ${models.join(", ")})`); }
}
/** How long a job is held (not failed) after an overload before the next attempt. Jittered. */
export const overloadHoldMs = (holds: number, rand: () => number = Math.random) =>
  backoffMs(holds + 1, Number(process.env.GEMINI_OVERLOAD_HOLD_MS || 60_000), 15 * 60_000, rand);
