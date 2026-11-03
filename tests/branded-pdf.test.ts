import test from "node:test";
import assert from "node:assert/strict";
import { renderStudyHtml, studyFooterTemplate, SIGN_OFF } from "../src/lib/pipeline/render";
const s: any = { title: "כותרת", overview: "סקירה", sections: [{ heading: "א", bullets: ["נקודה [slide 2]", "ב"] }, { heading: "ב", bullets: ["ג"] }], glossary: [{ term: "DNA", explanation: "חומצה" }] };
test("branded v2 layout: bar, numbered cards, key box, pills, sign-off, RTL", () => {
  const h = renderStudyHtml(s, [], { course: "מבוא", lecture: "הרצאה 3", date: "2026-10-27", level: "מלא" });
  assert.match(h, /<html lang="he" dir="rtl">/); assert.match(h, /class="bar"/);
  assert.match(h, /<span class="num">01<\/span>[^]*<span class="num">02<\/span>/);
  assert.match(h, /class="key"[^]*חשוב לזכור/); assert.match(h, /27\.10\.2026/); assert.match(h, /chip lvl">רמה: <b>מלא/);
  assert.ok(h.includes(`<div class="sign">${SIGN_OFF}</div>`)); assert.equal(SIGN_OFF, "סוכם אוטומטית מההרצאה והשקפים · בדקו מול החומר הרשמי");
  assert.doesNotMatch(h, /בהצלחה|⭐/); assert.match(h, /class="cite-inline"/);
  assert.doesNotMatch(renderStudyHtml(s), /class="meta"/);
});
test("footer template", () => {
  assert.match(studyFooterTemplate(0.873), /pageNumber[^]*totalPages[^]*כיסוי הקלטה 87%/);
  assert.doesNotMatch(studyFooterTemplate(null), /כיסוי/);
});
