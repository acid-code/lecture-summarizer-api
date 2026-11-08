import { test } from "node:test";
import assert from "node:assert/strict";
import { captionsUsable } from "../src/lib/transcript-import";
import type { Transcript } from "../src/lib/providers/types";

const t = (chars: number, end: number): Transcript => ({
  language: "he",
  segments: [{ start: 0, end, text: "א".repeat(chars) }],
});

test("empty rejected", () => {
  assert.equal(captionsUsable({ language: "he", segments: [] }, 3600), false);
});

test("short video allows sparse captions", () => {
  assert.equal(captionsUsable(t(5, 30), 120), true);
});

test("long video rejects tiny text", () => {
  assert.equal(captionsUsable(t(50, 3600), 3600), false);
});

test("long video rejects short span", () => {
  assert.equal(captionsUsable(t(900, 60), 3600), false);
});

test("long video accepts good coverage", () => {
  assert.equal(captionsUsable(t(900, 2000), 3600), true);
});

test("unknown duration near-empty rejected", () => {
  assert.equal(captionsUsable(t(10, 10), null), false);
  assert.equal(captionsUsable(t(200, 10), null), true);
});
