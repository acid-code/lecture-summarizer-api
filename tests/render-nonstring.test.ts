import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStudyHtml } from "../src/lib/pipeline/render";

test("renderStudyHtml tolerates non-string summary fields (array overview, numbers, objects, nulls)", () => {
  const s: any = {
    title: 42,
    overview: ["פסקה ראשונה [t=0:10, slide 76].", "פסקה שנייה"],
    sections: [{ heading: { text: "כותרת" }, citation: 7, bullets: ["רגיל", 3, null, ["a", "b"], { text: "אובייקט" }] }],
    glossary: [{ term: "Keratin", explanation: undefined }],
    big_picture: { intent: ["כוונה"], themes: [{ title: 1, explanation: null }], missed_terms: [{ term: "X", explanation: 2 }] },
  };
  const html = renderStudyHtml(s, [{ page: 1, section: 0, caption: undefined as any, src: "data:image/png;base64,AAAA" }]);
  assert.match(html, /פסקה ראשונה/);
  assert.match(html, /פסקה שנייה/);
  assert.match(html, /אובייקט/);
});
