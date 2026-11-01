// Run: npx tsx --test tests/figures.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStudyHtml } from "../src/lib/pipeline/render";
import { matchSection } from "../src/lib/figures";

const s = { title: "t", overview: "o", glossary: [], sections: [{ heading: "רקע", bullets: ["מבוא"] }, { heading: "תדירות אללים", bullets: ["גרף"] }] };
const fig = (section: number) => ({ page: 3, caption: "גרף תדירות", section, src: "data:image/jpeg;base64,AA==" });

test("figure is placed under its section, not at the end", () => {
  const h = renderStudyHtml(s, [fig(0)]);
  assert.ok(h.indexOf("<figure") > h.indexOf("רקע") && h.indexOf("<figure") < h.indexOf("תדירות אללים"), h);
  assert.ok(h.includes('figcaption dir="rtl"') && h.includes("שקף 3"));
});
test("unmatched figure goes after last section; no figures = unchanged", () => {
  const h = renderStudyHtml(s, [fig(-1)]);
  assert.ok(h.indexOf("<figure") > h.indexOf("תדירות אללים") && h.indexOf("<figure") < h.indexOf("מילון מונחים"));
  assert.ok(!renderStudyHtml(s).includes("<figure"));
});
test("lexical section match", () => { assert.equal(matchSection(s, "תדירות אללים באוכלוסייה"), 1); });
