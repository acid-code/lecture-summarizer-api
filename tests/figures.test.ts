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
import { finalizePicks, citedSections } from "../src/lib/figures";
const g = { title: "t", overview: "o", glossary: [], sections: [
  { heading: "intro", bullets: ["x [slide 3]"] }, { heading: "linkage", bullets: ["y [slide 6]"], citation: "slide 5-7" }, { heading: "RF", bullets: ["z"], citation: "slides 18, 21" }] };
const pk = (page: number, section: number, relevance: number, sha = `h${page}`, dh: bigint | null = null) => ({ c: { page, sha, dhash: dh }, section, relevance, caption: "" });
test("cited slide ranges", () => { assert.deepEqual(citedSections(g, 6), [1]); assert.deepEqual(citedSections(g, 21), [2]); });
test("no duplicate image, one per section, cited section wins, weak dropped", () => {
  const out = finalizePicks(g, [pk(16, 0, 7, "A", 0n), pk(21, 0, 9, "B", 1n), pk(6, 0, 8), pk(40, 2, 3), pk(30, 0, 6.5)], 6, 1, 6);
  assert.deepEqual(out.map((p) => [p.c.page, p.section]), [[21, 2], [6, 1], [30, 0]]); // 16 ≈ 21 (dhash dist 1) dropped
});
test("empty picks ok", () => { assert.deepEqual(finalizePicks(g, [], 6), []); });

import { pptxAbsolutePics } from "../src/lib/figures";
test("grouped pictures map out of child-space (no corner pile-up)", () => {
  // Real PPT pattern: group uses tiny chExt coords; pics would overlap near (0,0) without mapping.
  const xml = `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:grpSp>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="5919788"/><a:chOff x="0" y="0"/><a:chExt cx="5760" cy="3729"/></a:xfrm></p:grpSpPr>
      <p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2881" cy="1940"/></a:xfrm></p:spPr></p:pic>
      <p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill><p:spPr><a:xfrm><a:off x="2850" y="0"/><a:ext cx="2910" cy="1932"/></a:xfrm></p:spPr></p:pic>
    </p:grpSp>
  </p:spTree></p:cSld></p:sld>`;
  const pics = pptxAbsolutePics(xml);
  assert.equal(pics.length, 2);
  const xs = pics.map((p) => p.box.x).sort((a, b) => a - b);
  assert.ok(xs[1] > 4_000_000, `second pic should sit on the right half, got x=${xs[1]}`);
  assert.ok(pics.every((p) => p.box.cx > 1_000_000 && p.box.cy > 1_000_000));
});
