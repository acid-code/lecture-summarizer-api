import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiKeys, geminiConfigured, KeyPool, keyId, maskKey } from "../src/lib/providers/keys";

test("merges legacy GEMINI_API_KEY first, then GEMINI_API_KEYS; trims, skips empty, dedupes", () => {
  assert.deepEqual(geminiKeys({ GEMINI_API_KEY: " a ", GEMINI_API_KEYS: "b, ,a,c,,b " }), ["a", "b", "c"]);
  assert.deepEqual(geminiKeys({ GEMINI_API_KEYS: "x" }), ["x"]);
  assert.deepEqual(geminiKeys({}), []);
  assert.equal(geminiConfigured({ GEMINI_API_KEYS: "x" }), true);
  assert.equal(geminiConfigured({ GEMINI_API_KEY: "" , GEMINI_API_KEYS: " , " }), false);
});

test("exhausted key is skipped until next 00:00 UTC, then returns", () => {
  let now = Date.UTC(2026, 10, 3, 15, 0);
  const pool = new KeyPool(() => now);
  const until = pool.markExhausted("k1");
  assert.equal(until, Date.UTC(2026, 10, 4));
  assert.deepEqual(pool.available(["k1", "k2"]), ["k2"]);
  pool.markExhausted("k2");
  assert.deepEqual(pool.available(["k1", "k2"]), []);
  now = Date.UTC(2026, 10, 4, 0, 0, 1);
  assert.deepEqual(pool.available(["k1", "k2"]), ["k1", "k2"]);
});

test("mask never contains the full key", () => {
  const k = "AIzaSyTESTFAKEKEY1234567890";
  assert.ok(!maskKey(k).includes(k.slice(4, -2)));
  assert.match(keyId(k), /^[0-9a-f]{8}$/);
});
