import { test } from "node:test";
import assert from "node:assert/strict";
import { repairJsonEscapes } from "../src/lib/providers/gemini";

test("repairJsonEscapes fixes unescaped LaTeX commands and bad unicode escapes inside strings", () => {
  const broken = '{"title":"SVM","bullets":["Minimize \\sum_{i=1}^n \\alpha_i + \\underline{x} for \\(w \\in \\mathbb{R}^d\\)"]}';
  assert.throws(() => JSON.parse(broken));
  const parsed = JSON.parse(repairJsonEscapes(broken)) as { title: string; bullets: string[] };
  assert.equal(parsed.title, "SVM");
  assert.equal(parsed.bullets[0], "Minimize \\sum_{i=1}^n \\alpha_i + \\underline{x} for \\(w \\in \\mathbb{R}^d\\)");
});

test("repairJsonEscapes preserves valid JSON escapes and unicode sequences", () => {
  const valid = '{"text":"line1\\nline2\\t\\"quoted\\" \\u05d0 \\\\already"}';
  assert.deepEqual(JSON.parse(repairJsonEscapes(valid)), JSON.parse(valid));
});
