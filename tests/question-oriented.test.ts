import { test } from "node:test";
import assert from "node:assert/strict";
import { isQuestionSection, MATH_RULES, STRUCTURE_MODE, spokenSectionCount } from "../src/lib/providers/prompts";
import { renderStudyHtml, bidi } from "../src/lib/pipeline/render";
import type { LectureSummary } from "../src/lib/providers/types";

test("isQuestionSection detects kind and headings", () => {
  assert.ok(isQuestionSection({ kind: "question", heading: "Anything" }));
  assert.ok(isQuestionSection({ heading: "שאלה 3: VC dimension" }));
  assert.ok(isQuestionSection({ heading: "Exercise 2 — shattering" }));
  assert.ok(!isQuestionSection({ heading: "הגדרת VC dimension" }));
  assert.ok(!isQuestionSection({ kind: "topic", heading: "מבוא" }));
});

test("spokenSectionCount includes question sections", () => {
  const n = spokenSectionCount({
    sections: [
      { heading: "שאלה 1: A" },
      { heading: "דגשים חשובים של המרצה" },
      { heading: "סיכום מהמצגת" },
    ],
  });
  assert.equal(n, 1);
});

test("prompts still require KaTeX delimiters for notes", () => {
  assert.match(MATH_RULES, /important_notes/);
  // Template literal stores one backslash: "\(" — same delimiters KaTeX expects in model output.
  assert.match(MATH_RULES, /\\\(/);
  assert.match(STRUCTURE_MODE, /structure_mode/);
  assert.match(STRUCTURE_MODE, /important_notes/);
});

test("question PDF HTML renders notes with KaTeX and cites", () => {
  const summary: LectureSummary = {
    title: "תרגול VC",
    overview: "תרגול על שאלות VC",
    structure_mode: "questions",
    glossary: [{ term: "VC", explanation: "Vapnik–Chervonenkis" }],
    sections: [
      {
        kind: "question",
        heading: "שאלה 1: shattering",
        citation: "[t=4:20, slide 7]",
        bullets: [
          "הגדרה: קבוצה נשברת אם כל תיוג אפשרי. נוסחה: \\(2^{|C|}\\).",
          "דוגמה עם נקודות במישור.",
        ],
        important_notes: [
          "חשוב: אל תבלבלו בין \\(\\mathrm{VCdim}\\) לבין shattering.",
          "במבחן: התחילו מ־$$H=\\{h:x\\mapsto \\mathrm{sign}(w\\cdot x)\\}$$.",
        ],
      },
      {
        kind: "question",
        heading: "שאלה 2: bound",
        citation: "[slide 9]",
        bullets: ["חסם הגידול."],
        important_notes: ["שימו לב ל־\\(\\varepsilon\\) ו־\\(\\delta\\)."],
      },
    ],
  };
  const html = renderStudyHtml(summary, [], { course: "ML", level: "standard" });
  assert.match(html, /מבנה:.*שאלות/s);
  assert.match(html, /class="card question"/);
  assert.match(html, /הערות לפתרון/);
  assert.match(html, /badge-q/);
  // Math from bullets AND important_notes must go through KaTeX (not raw backslash garbage).
  assert.match(html, /class="math"/);
  assert.ok(html.includes("katex"), "KaTeX CSS classes present");
  assert.ok(!html.includes("\\mathrm{VCdim}"), "raw TeX from notes should be rendered");
  assert.ok(!/\\\\varepsilon(?![^<]*katex)/.test(html.replace(/<[^>]+>/g, "")));
  // Citations stay LTR isolates
  assert.match(html, /cite-inline/);
  assert.match(html, /slide 7/);
});

test("topic summary without questions stays unchanged visually", () => {
  const html = renderStudyHtml({
    title: "הרצאה",
    overview: "תיאוריה",
    structure_mode: "topics",
    glossary: [],
    sections: [{ heading: "נושא א", bullets: ["עובדה \\(\\alpha\\)"] }],
  });
  assert.ok(!html.includes("הערות לפתרון"));
  assert.ok(!html.includes("card question"));
  assert.ok(html.includes("katex"));
});

test("bidi renders display math in note-like strings", () => {
  const out = bidi("נוסחה חשובה: $$\\frac{1}{2}$$ בסוף");
  assert.match(out, /katex-display|class="math"/);
  assert.ok(!out.includes("\\frac{1}{2}"));
});
