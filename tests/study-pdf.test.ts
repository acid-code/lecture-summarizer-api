import { test } from "node:test";
import assert from "node:assert/strict";
import { isTitleSlide } from "../src/lib/figures";
import { depthTargets, summaryTooShort } from "../src/lib/providers/prompts";
import { renderStudyHtml, cleanGlyphs } from "../src/lib/pipeline/render";

const tr = (min: number) => ({ language: "he", segments: [{ start: 0, end: 10, text: "a" }, { start: min * 60 - 10, end: min * 60, text: "b" }] }) as any;

test("title / cover slides are skipped", () => {
  assert.ok(isTitleSlide({ page: 1, text: "Lecture 3 Infinite Hypothesis Classes, VC Dimension November 1, 2026 Jonathan Berant Introduction", imageOps: 2 }));
  assert.ok(isTitleSlide({ page: 2, text: "Agenda", imageOps: 0 }));
  assert.ok(!isTitleSlide({ page: 14, text: "Shattering: a set of 3 points in R^2 can be shattered by linear classifiers, diagram below shows all 8 labelings and separating lines", imageOps: 3 }));
});
test("depthTargets scales for a 120 min lecture", () => {
  const d = depthTargets(tr(120));
  assert.equal(d.minutes, 120);
  assert.ok(d.sections >= 30 && d.sections <= 36, String(d.sections));
  assert.ok(d.bulletsLo >= 5 && d.bulletsHi <= 10); // leaner bullets (Nov 2026 retune)
  assert.equal(depthTargets(tr(10)).sections, 4);
});
test("4-section summary of 120 min lecture is too short", () => {
  const sec = { heading: "x", bullets: ["a", "b", "c"] };
  assert.ok(summaryTooShort({ sections: [sec, sec, sec, sec] }, tr(120)));
  assert.ok(!summaryTooShort({ sections: Array(32).fill({ heading: "x", bullets: Array(7).fill("b") }) }, tr(120)));
});
test("no tofu glyphs / broken figures / huge figure boxes", () => {
  assert.equal(cleanGlyphs("כמו ك מסווגי ⭐ שרירותي"), "כמו מסווגי שרירות");
  const h = renderStudyHtml({ title: "t", overview: "o", glossary: [], sections: [{ heading: "h", bullets: ["b"] }] } as any,
    [{ page: 2, caption: "c", section: 0, src: "data:image/jpeg;base64," }]);
  assert.ok(!h.includes("<figure"));
  assert.ok(!h.includes("⚠") && !/max-height:1[01]\dmm/.test(h));
});
