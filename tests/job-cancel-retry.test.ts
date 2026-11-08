import { test } from "node:test";
import assert from "node:assert/strict";
import { stageRunDecision, RUN_LEASE_MS } from "../src/lib/pipeline";

test("fresh stage always runs", () => {
  assert.deepEqual(stageRunDecision(undefined, "summary", Date.now()), { action: "run", n: 1 });
});

test("active lease is busy", () => {
  const at = Date.now() - 1_000;
  assert.deepEqual(stageRunDecision({ stage: "summary", n: 1, at }, "summary", at), { action: "busy" });
});

test("expired lease re-runs", () => {
  const at = Date.now() - RUN_LEASE_MS - 1_000;
  assert.deepEqual(stageRunDecision({ stage: "summary", n: 1, at }, "summary", at), { action: "run", n: 2 });
});

test("retry bump (updatedAt past lease) starts fresh", () => {
  const at = Date.now() - 1_000;
  assert.deepEqual(stageRunDecision({ stage: "summary", n: 2, at }, "summary", at + 5_000), { action: "run", n: 1 });
});
