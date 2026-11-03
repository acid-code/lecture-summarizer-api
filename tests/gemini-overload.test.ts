import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGeminiError, backoffMs, overloadFallback, DEFAULT_OVERLOAD_FALLBACK, GeminiOverloadedError } from "../src/lib/providers/overload";

const HIGH_DEMAND = '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}';

test("classifies 503 high demand separately from quota and auth", () => {
  assert.equal(classifyGeminiError(HIGH_DEMAND), "overloaded");
  assert.equal(classifyGeminiError("The model is overloaded. Please try again later."), "overloaded");
  assert.equal(classifyGeminiError('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for metric generate_content_free_tier_requests, limit: 20 PerDay"}}'), "daily_quota");
  assert.equal(classifyGeminiError('429 RESOURCE_EXHAUSTED per minute "retryDelay": "12s"'), "rpm");
  assert.equal(classifyGeminiError('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'), "auth");
  assert.equal(classifyGeminiError('{"error":{"code":500,"status":"INTERNAL"}}'), "transient");
  assert.equal(classifyGeminiError("invalid JSON from Gemini"), "other");
});

test("backoff is exponential, jittered ±25%, capped", () => {
  assert.equal(backoffMs(1, 2000, 20_000, () => 0.5), 2000);
  assert.equal(backoffMs(2, 2000, 20_000, () => 0.5), 4000);
  assert.equal(backoffMs(3, 2000, 20_000, () => 0.5), 8000);
  assert.equal(backoffMs(10, 2000, 20_000, () => 0.5), 20_000);
  assert.equal(backoffMs(1, 2000, 20_000, () => 0), 1500);
  assert.equal(backoffMs(1, 2000, 20_000, () => 1), 2500);
});

test("overload fallback prefers GEMINI_FALLBACK_MODEL, then untried ladder rungs, then null", () => {
  const ladder = ["a", "b", "c"];
  assert.equal(overloadFallback("a", ladder, new Set(["a"]), {}), DEFAULT_OVERLOAD_FALLBACK);
  assert.equal(overloadFallback("a", ladder, new Set(["a"]), { GEMINI_FALLBACK_MODEL: "c" }), "c");
  assert.equal(overloadFallback("c", ladder, new Set(["a", "c"]), { GEMINI_FALLBACK_MODEL: "c" }), "b");
  assert.equal(overloadFallback("b", ladder, new Set(["a", "b", "c"]), { GEMINI_FALLBACK_MODEL: "c" }), null);
  assert.equal(overloadFallback("a", ladder, new Set(["a"]), { GEMINI_FALLBACK_MODEL: "" }), "b");
});

test("overloaded error lists tried models without secrets", () => {
  const e = new GeminiOverloadedError(["m1", "m2"]);
  assert.match(e.message, /overloaded.*m1, m2/);
});
