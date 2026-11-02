import { test } from "node:test";
import assert from "node:assert/strict";
import { capChashuv, genericTitle, hierarchicalStep, asrSpan } from "../src/lib/providers/hierarchical";
import { useHierarchical } from "../src/lib/pipeline";
import { renderStudyHtml } from "../src/lib/pipeline/render";
import { mistralKey } from "../src/lib/figures";

const tr = (min: number) => ({ language: "he", segments: Array.from({ length: min }, (_, i) => ({ start: i * 60, end: i * 60 + 50, text: `משפט ${i}` })) });

test("genericTitle", () => {
  assert.equal(genericTitle("Lecture - 1.11.2026"), true);
  assert.equal(genericTitle("הרצאה 3"), true);
  assert.equal(genericTitle("VC dimension ומימד"), false);
});
test("capChashuv keeps earliest within budget", () => {
  const ps = [["חשוב: א", "ב"], ["חשוב: ג", "חשוב: ד"]];
  assert.equal(capChashuv(ps, 2), 2);
  assert.deepEqual(ps, [["חשוב: א", "ב"], ["חשוב: ג", "ד"]]);
});
test("useHierarchical by ASR span", () => {
  delete process.env.SUMMARY_HIERARCHICAL;
  assert.equal(useHierarchical(tr(50)), false);
  assert.equal(useHierarchical(tr(80)), true);
  process.env.SUMMARY_HIERARCHICAL = "off"; assert.equal(useHierarchical(tr(80)), false);
  process.env.SUMMARY_HIERARCHICAL = "on"; assert.equal(useHierarchical(tr(10)), true);
  delete process.env.SUMMARY_HIERARCHICAL;
  assert.equal(asrSpan(tr(2)), 110);
});
test("prose sections render as paragraphs", () => {
  const h = renderStudyHtml({ title: "t", overview: "o", sections: [{ heading: "h", bullets: ["פסקה"], style: "prose" }], glossary: [] });
  assert.match(h, /<h2>[^]*?<\/h2><p>/); assert.doesNotMatch(h, /<li>/);
});
test("mistral key alias", () => {
  const k = process.env.MISTRAL_API_KEY; delete process.env.MISTRAL_API_KEY; process.env.MISTRAL_API_KRY = "x";
  assert.equal(mistralKey(), "x"); delete process.env.MISTRAL_API_KRY; if (k) process.env.MISTRAL_API_KEY = k;
});
test("hierarchicalStep resumes across deadlines and caps חשוב", async () => {
  const t = tr(30); const st: any = {};
  const J: any = async (p: string) => {
    if (p.startsWith("You are extracting")) return { topics: [], professor_emphasis: [{ quote_or_paraphrase: "חשוב: x", t: "1:00" }] };
    if (p.startsWith("Build a study-guide")) return { title: "Lecture - 1.1.2026", overview: "English overview text", sections: [{ heading: "א", t_start: "0:00", t_end: "15:00", parts: [] }, { heading: "ב", t_start: "15:00", t_end: "29:00", parts: [] }] };
    if (p.startsWith("Write ONE")) return { heading: "ס", paragraphs: Array.from({ length: 20 }, () => "חשוב: " + "מילה ".repeat(30) + "[t=1:00]") };
    return { title: "כותרת אמיתית על נושא", overview: "סקירה בעברית מלאה" };
  };
  assert.equal(await hierarchicalStep(t, { title: "Lecture - 1.1.2026" }, J, st, Date.now() + 50_000), null); // no time → no work
  const s = (await hierarchicalStep(t, { title: "Lecture - 1.1.2026" }, J, st))!;
  assert.equal(s.title, "כותרת אמיתית על נושא"); assert.equal(s.overview, "סקירה בעברית מלאה");
  assert.ok((JSON.stringify(s).match(/חשוב/g) ?? []).length <= 12);
  assert.equal(s.sections[0].style, "prose");
});
test("ampersand not broken by LTR isolation", () => {
  const h = renderStudyHtml({ title: "t", overview: "o", sections: [{ heading: "דיכוטומיה (Dichotomy & Shattering)", bullets: ["x"] }], glossary: [] });
  assert.match(h, /Dichotomy <\/bdi>&amp; <bdi dir="ltr">Shattering|Dichotomy<\/bdi> &amp; <bdi dir="ltr">Shattering/);
});
