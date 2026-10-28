import type { AiProvider } from "./types";

export const mockProvider: AiProvider = {
  name: "mock",
  async transcribe() {
    return {
      language: "he",
      segments: [
        { start: 0, end: 12, text: "היום נדבר על דיפ לרנינג ועל בק פרופגיישן." },
        { start: 12, end: 30, text: "ה-gradient descent מעדכן את המשקלים." },
      ],
    };
  },
  async repairTerms() {
    return [{ span: "דיפ לרנינג", replacement: "deep learning", evidence: "mock: slide 1 title", confidence: 0.9 }];
  },
  async summarize(_t, _r, ctx) {
    return {
      title: ctx.title,
      overview: "סיכום לדוגמה (mock): ההרצאה עוסקת ב-deep learning וב-backpropagation.",
      sections: [{ heading: "Gradient descent", bullets: ["עדכון משקלים בכיוון ההפוך ל-gradient"], citation: "[slide 2, 00:12]" }],
      glossary: [{ term: "backpropagation", explanation: "חישוב גרדיאנטים לאחור דרך הרשת" }],
    };
  },
};
