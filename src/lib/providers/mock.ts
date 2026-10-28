import type { AiProvider } from "./types";

export const mockProvider: AiProvider = {
  name: "mock",
  async transcribe(audio) {
    const o = audio.offsetSec;
    return {
      language: "he",
      segments: [
        { start: o, end: o + 12, text: "היום נדבר על דיפ לרנינג ועל בק פרופגיישן." },
        { start: o + 12, end: o + 30, text: "ה-gradient descent מעדכן את המשקלים." },
      ],
    };
  },
  async repairTerms() {
    return [{ span: "דיפ לרנינג", replacement: "deep learning", evidence: "mock: slide 1 title", confidence: 0.9 }];
  },
  async summarize(t, _r, ctx) {
    // Exercise the course-pack retrieval path so playtests show which excerpts would be sent.
    const excerpt = ctx.courseExcerpts?.(t.segments.map((s) => s.text).join(" "), 300) ?? "";
    return {
      title: ctx.title,
      overview: "סיכום לדוגמה (mock): ההרצאה עוסקת ב-deep learning וב-backpropagation.",
      sections: [
        { heading: "Gradient descent", bullets: ["עדכון משקלים בכיוון ההפוך ל-gradient"], citation: "[slide 2, 00:12]" },
        ...(excerpt ? [{ heading: "Course context (mock)", bullets: [excerpt.slice(0, 200)] }] : []),
      ],
      glossary: [{ term: "backpropagation", explanation: "חישוב גרדיאנטים לאחור דרך הרשת" }],
    };
  },
};
