// Run: npx tsx --test tests/render-math.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { bidi } from "../src/lib/pipeline/render";

const noGarbage = (h: string) => {
  assert.ok(!/frac\\|right\\|left\\|\\ varepsilon/.test(h), "reversed TeX fragment leaked: " + h);
  assert.ok(!h.includes("&amp;gt;"), "double-escaped entity");
};

test("bare PAC sample complexity in Hebrew bullet renders via KaTeX", () => {
  const h = bidi("גודל המדגם הנדרש הוא N(\\varepsilon,\\delta) = \\frac{4}{\\varepsilon}\\ln\\left(\\frac{4}{\\delta}\\right) עבור מלבנים.");
  assert.ok(h.includes('class="katex"'), h);
  assert.ok(!/\\frac|\\ln|\\left/.test(h.replace(/<annotation[\s\S]*?<\/annotation>/g, "")), h);
  assert.ok(h.includes("עבור מלבנים"));
  noGarbage(h);
});

test("union bound with model-emitted &gt; entity", () => {
  const h = bidi("לפי חסם האיחוד P[e_P(A(S)) &gt; \\varepsilon] \\le |H|(1-\\varepsilon)^m \\le |H| e^{-\\varepsilon m}");
  assert.ok(h.includes('class="katex"'), h);
  noGarbage(h);
});

test("finite class sample complexity m >= (1/eps) ln(|H|/delta)", () => {
  const h = bidi("לכן מספיק m \\ge \\frac{1}{\\varepsilon}\\ln\\frac{|H|}{\\delta} דוגמאות.");
  assert.ok(h.includes('class="katex"'), h);
  assert.ok(h.trim().endsWith("דוגמאות."), h);
  noGarbage(h);
});

test("delimited math still works and is not double-rendered", () => {
  const h = bidi("עבור \\(|H|=3^m+1\\) ועבור $$m \\ge \\frac{1}{\\varepsilon}\\ln\\frac{|H|}{\\delta}$$");
  assert.equal((h.match(/class="math"/g) ?? []).length, 2, "exactly one inline + one display render");
  assert.ok(h.includes("katex-display"));
  noGarbage(h);
});

test("single bare symbols", () => {
  const h = bidi("נסמן ב-\\varepsilon את השגיאה וב-\\delta את הביטחון");
  assert.equal((h.match(/class="math"/g) ?? []).length, 2, h);
  assert.ok(!/<span class="mord">−<\/span>/.test(h), "Hebrew prefix hyphen must not become a minus");
  noGarbage(h);
});

test("plain Hebrew + English prose untouched", () => {
  const h = bidi("ההגדרה של PAC learning במקרה realizable.");
  assert.ok(!h.includes("katex"));
  assert.ok(h.includes('<bdi dir="ltr">PAC learning</bdi>'));
});

test("unparseable leftover TeX is LTR-isolated, not reversed", () => {
  const h = bidi("ראו \\badcmd{ בהרצאה");
  assert.ok(h.includes('<bdi dir="ltr">\\badcmd{</bdi>'), h);
});

import { bidi as bidi2, renderStudyHtml as rsh } from "../src/lib/pipeline/render";
test("hebrew bullet with trailing citation isolates whole bracket group", () => {
  const h = bidi2("ומטרתם להבטיח תכונות על שגיאת המבחן [slide 7, t=6:00-6:18].");
  assert.ok(h.includes('<bdi class="cite-inline" dir="ltr">[slide 7, t=6:00-6:18]</bdi>.'));
});
test("mixed math + cite", () => {
  const h = bidi2("מבטיחה $P[e_P(A(S)) > \\epsilon] \\le \\delta$ [t=6:35-7:45, slide 8] ו- \\frac{1}{\\epsilon} &amp;gt; 0");
  assert.ok(h.includes("katex"));
  assert.ok(h.includes('<bdi class="cite-inline" dir="ltr">[t=6:35-7:45, slide 8]</bdi>'));
  assert.doesNotMatch(h, /frac\\|left\\|&amp;gt;/);
  assert.equal(h.match(/cite-inline/g)!.length, 1);
});
test("glossary term goes through math", () => {
  const h = rsh({ title: "t", overview: "", sections: [], glossary: [{ term: "$H_{OR}$", explanation: "מחלקה" }] } as any);
  assert.match(h, /<dt><bdi class="math"/);
});

test("big picture appendix renders LTR after glossary with math", async () => {
  const { renderStudyHtml } = await import("../src/lib/pipeline/render");
  const h = renderStudyHtml({ title: "t", overview: "o", sections: [], glossary: [{ term: "a", explanation: "b" }],
    big_picture: { intent: "Teach SAT encodings.", themes: [{ title: "Literals", explanation: "A literal is \\(x\\) or \\(\\neg x\\)." }],
      missed_terms: [{ term: "literal", explanation: "a variable or its negation" }] } });
  assert.ok(h.indexOf("Big picture") > h.indexOf("מילון מונחים"));
  assert.ok(h.includes('dir="ltr"') && h.includes('class="katex"') && h.includes("Terms used in the lecture"));
  const he = renderStudyHtml({ title: "t", overview: "o", sections: [], glossary: [], big_picture: { intent: "ההרצאה מלמדת קידוד \\(x\\) ל-SAT.", themes: [], missed_terms: [{ term: "literal", explanation: "משתנה או שלילתו" }] } });
  assert.ok(he.includes('<section class="big-picture" dir="rtl" lang="he">') && he.includes("התמונה הגדולה") && he.includes('class="katex"'), he);
  assert.ok(!renderStudyHtml({ title: "t", overview: "o", sections: [], glossary: [], big_picture: null }).includes("Big picture"));
});
