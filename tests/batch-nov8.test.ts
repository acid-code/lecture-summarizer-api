import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeScripts, bidi, flipArrows, mergedGlossary, renderStudyHtml } from "../src/lib/pipeline/render";
import { stageRunDecision, verifiedLectureLabel, RUN_LEASE_MS, MAX_STAGE_RUNS } from "../src/lib/pipeline";

test("powers/subscripts keep the whole exponent raised", () => {
  assert.equal(normalizeScripts("2^10"), "2^{10}");
  assert.equal(normalizeScripts("a^(n+1)"), "a^{n+1}");
  assert.equal(normalizeScripts("x^-1"), "x^{-1}");
  assert.equal(normalizeScripts("n_10"), "n_{10}");
  for (const ok of ["x^2", "2^{10}", "e^{-x}", "2^n", "x^\\alpha"]) assert.equal(normalizeScripts(ok), ok);
  // KaTeX output: "10" inside one superscript group
  const h = bidi("סיבוכיות 2^10 פעולות");
  assert.match(h, /msupsub[\s\S]*1[\s\S]*0/);
  assert.equal(bidi("$2^10$"), bidi("$2^{10}$"));
});

test("arrows flip in RTL prose, not in LTR big-picture or math", () => {
  assert.equal(flipArrows("A → B ⇒ C -> D"), "A ← B ⇐ C ← D");
  assert.match(bidi("קלט → פלט"), /←/);
  const html = renderStudyHtml({ title: "t", overview: [], sections: [], glossary: [], big_picture: { intent: "input → output", themes: [], missed_terms: [] } } as any);
  assert.match(html, /input <\/bdi>→|input → output|→/);
});

test("one glossary: big-picture missed terms merged + deduped, no second terms list", () => {
  const s: any = { title: "t", overview: [], sections: [], glossary: [{ term: "BFS", explanation: "a" }],
    big_picture: { intent: "כוונה", themes: [], missed_terms: [{ term: "bfs", explanation: "dup" }, { term: "DFS", explanation: "b" }] } };
  assert.deepEqual(mergedGlossary(s).map((g) => g.term), ["BFS", "DFS"]);
  const html = renderStudyHtml(s);
  assert.equal((html.match(/מילון מונחים|מונחים שהופיעו בהרצאה/g) ?? []).length, 1);
});

test("lecture number only when the source title has it", () => {
  assert.equal(verifiedLectureLabel("Algorithms שיעור 20/10"), null);
  assert.equal(verifiedLectureLabel("Neurobiology Tutorial 1"), null);
  assert.equal(verifiedLectureLabel("הרצאה 5 - גרפים"), "הרצאה 5");
  assert.equal(verifiedLectureLabel("Lecture 3"), "הרצאה 3");
  assert.equal(verifiedLectureLabel(undefined), null);
  const html = renderStudyHtml({ title: "t", overview: [], sections: [], glossary: [] } as any, [], { course: "c", lecture: null });
  assert.doesNotMatch(html, /הרצאה 1/);
});

test("stall guard: busy within lease, re-run after, fail after max, reset on retry", () => {
  const now = 1_000_000_000;
  assert.deepEqual(stageRunDecision(undefined, "pdf", now, now), { action: "run", n: 1 });
  const run = { stage: "pdf", n: 1, at: now };
  assert.deepEqual(stageRunDecision(run, "pdf", now, now + 1000), { action: "busy" });
  assert.deepEqual(stageRunDecision(run, "pdf", now, now + RUN_LEASE_MS + 1), { action: "run", n: 2 });
  assert.deepEqual(stageRunDecision({ ...run, n: MAX_STAGE_RUNS }, "pdf", now, now + RUN_LEASE_MS + 1), { action: "fail", runs: MAX_STAGE_RUNS });
  assert.deepEqual(stageRunDecision({ ...run, n: MAX_STAGE_RUNS }, "pdf", now + 5, now + RUN_LEASE_MS + 1), { action: "run", n: 1 }); // retried
  assert.deepEqual(stageRunDecision(run, "summary", now, now + 1), { action: "run", n: 1 });
});
