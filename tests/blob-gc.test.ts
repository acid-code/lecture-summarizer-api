import { test } from "node:test";
import assert from "node:assert/strict";
import { supersededJobIds } from "../src/lib/blob-gc";

test("supersededJobIds keeps newest per lecture+density", () => {
  const jobs = [
    { id: "old-std", lectureId: "L1", updatedAt: 100, artifacts: JSON.stringify({ options: { density: "standard" }, pdf: "a" }) },
    { id: "new-std", lectureId: "L1", updatedAt: 300, artifacts: JSON.stringify({ options: { density: "standard" }, pdf: "b" }) },
    { id: "only-det", lectureId: "L1", updatedAt: 200, artifacts: JSON.stringify({ options: { density: "detailed" }, pdf: "c" }) },
    { id: "other-lec", lectureId: "L2", updatedAt: 50, artifacts: JSON.stringify({ options: { density: "standard" }, pdf: "d" }) },
  ];
  assert.deepEqual(supersededJobIds(jobs).sort(), ["old-std"]);
});

test("supersededJobIds empty when one job per key", () => {
  const jobs = [
    { id: "a", lectureId: "L1", updatedAt: 1, artifacts: JSON.stringify({ options: { density: "compact" } }) },
    { id: "b", lectureId: "L1", updatedAt: 2, artifacts: JSON.stringify({ options: { density: "slides" } }) },
  ];
  assert.deepEqual(supersededJobIds(jobs), []);
});
