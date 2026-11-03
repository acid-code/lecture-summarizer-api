import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStudyHtml } from "../src/lib/pipeline/render";
import { unwrapSummary } from "../src/lib/providers/gemini";
const obj = { title: "BFS", overview: "o", transcript_thin: false, sections: [{ heading: "H1", bullets: ["b1"], citation: "[t=0:01]" }], glossary: [{ term: "T", explanation: "E" }] };
test("array-wrapped summary renders sections", () => {
  const h = renderStudyHtml([obj] as any);
  assert.ok(h.includes("H1") && h.includes("b1"));
});
test("unwrapSummary", () => { assert.equal(unwrapSummary([obj] as any), obj); assert.equal(unwrapSummary(obj), obj); });
