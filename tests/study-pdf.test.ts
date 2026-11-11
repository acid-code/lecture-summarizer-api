import { test } from "node:test";
import assert from "node:assert/strict";
import { isTitleSlide } from "../src/lib/figures";
import { depthTargets, summaryTooShort, summaryOvergrown } from "../src/lib/providers/prompts";
import { renderStudyHtml, cleanGlyphs } from "../src/lib/pipeline/render";

const tr = (min: number) => ({ language: "he", segments: [
  { start: 0, end: 10, text: "opening topic discussion ".repeat(40) },
  { start: min * 60 - 10, end: min * 60, text: "closing topic discussion ".repeat(40) },
] }) as any;
const shortClip = {
  language: "he",
  segments: [
    { start: 0, end: 3, text: "אז בשיעור היום אנחנו נדבר על ה-data pipeline." },
    { start: 3, end: 7, text: "אנחנו נתמקד ב-pattern הכי נפוץ בתעשייה, שזה ה-ETL process." },
    { start: 7, end: 13.5, text: "שזה אומר Extract, Transform ו-Load." },
  ],
} as any;

test("title / cover slides are skipped", () => {
  assert.ok(isTitleSlide({ page: 1, text: "Lecture 3 Infinite Hypothesis Classes, VC Dimension November 1, 2026 Jonathan Berant Introduction", imageOps: 2 }));
  assert.ok(isTitleSlide({ page: 2, text: "Agenda", imageOps: 0 }));
  assert.ok(!isTitleSlide({ page: 14, text: "Shattering: a set of 3 points in R^2 can be shattered by linear classifiers, diagram below shows all 8 labelings and separating lines", imageOps: 3 }));
});
test("depthTargets scales for a 120 min lecture", () => {
  const d = depthTargets(tr(120), "detailed");
  const std = depthTargets(tr(120));
  const compact = depthTargets(tr(120), "compact");
  assert.ok(std.sections < d.sections && compact.sections < std.sections);
  assert.ok(compact.sections * compact.bulletsHi < std.sections * std.bulletsLo, "compact capacity must stay under standard");
  assert.equal(d.minutes, 120);
  assert.ok(d.sections >= 30 && d.sections <= 36, String(d.sections));
  assert.ok(d.bulletsLo >= 5 && d.bulletsHi <= 10); // leaner bullets (Nov 2026 retune)
  assert.equal(depthTargets(tr(10)).sections, 2); // proportional: ~10/6, no fake 4-section floor
  assert.ok(compact.bulletsHi <= 2 && compact.sections <= 5);
});
test("compact stays lean vs standard for a typical hour", () => {
  const c = depthTargets(tr(60), "compact");
  const s = depthTargets(tr(60), "standard");
  assert.ok(c.sections <= 3, `compact hour should be ~2-3 sections, got ${c.sections}`);
  assert.ok(c.sections < s.sections, `compact sections ${c.sections} vs standard ${s.sections}`);
  assert.ok(c.bulletsHi < s.bulletsLo);
  assert.ok(c.sections * c.bulletsHi < s.sections * s.bulletsLo, "compact capacity well under standard");
});
test("compact overgrown triggers when model ignores hard cap", () => {
  const packed = {
    sections: Array.from({ length: 8 }, (_, i) => ({ heading: `נושא ${i}`, bullets: ["a", "b", "c"] })),
    glossary: Array(12).fill({ term: "t", explanation: "e" }),
  };
  assert.ok(summaryOvergrown(packed, tr(60), "compact"));
  assert.ok(!summaryOvergrown({ sections: [{ heading: "א", bullets: ["נקודה"] }, { heading: "ב", bullets: ["נקודה"] }] }, tr(60), "compact"));
});
test("14s clip must not demand a multi-section detailed pack", () => {
  const d = depthTargets(shortClip, "detailed");
  assert.equal(d.thin, true);
  assert.ok(d.sections <= 2, String(d.sections));
  assert.ok(d.minutes < 1);
  assert.ok(summaryOvergrown({ sections: [{ heading: "a", bullets: ["1", "2", "3", "4"] }, { heading: "b", bullets: ["1", "2", "3", "4"] }, { heading: "c", bullets: ["1", "2"] }], glossary: Array(8).fill({ term: "t", explanation: "e" }), big_picture: { intent: "x" } }, shortClip, "detailed"));
  assert.ok(!summaryOvergrown({ sections: [{ heading: "a", bullets: ["1", "2"] }], glossary: [{ term: "ETL", explanation: "Extract Transform Load" }] }, shortClip, "detailed"));
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
  assert.ok(!h.includes("⚠"));
  // Figure frame only (ignore slide-card page layout heights like 112mm).
  assert.ok(!/\.fig-frame\{[^}]*max-height:1[01]\dmm/.test(h));
});
test("summary figures use a framed box with object-fit contain", () => {
  const h = renderStudyHtml({ title: "t", overview: "o", glossary: [], sections: [{ heading: "h", bullets: ["b"] }] } as any,
    [{ page: 2, caption: "diagram", section: 0, src: "data:image/jpeg;base64,aaaa" }]);
  assert.match(h, /class="fig-frame"/);
  assert.match(h, /\.fig-frame\{[^}]*height:72mm/);
  assert.match(h, /\.fig-frame img\{[^}]*object-fit:contain/);
  assert.match(h, /\.fig-frame img\{[^}]*position:absolute/);
  assert.ok(!/\.fig-frame\{[^}]*max-height:1[01]\dmm/.test(h), "figure frame must stay <=80mm");
});
