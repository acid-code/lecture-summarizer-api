import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverage, citeRanges, fixBackwardRanges, asrCompleteness, mergeGapSections } from "../src/lib/pipeline/coverage";

const asr = (end: number) => ({ language: "he", segments: Array.from({ length: Math.ceil(end / 60) }, (_, i) => ({ start: i * 60, end: Math.min(end, i * 60 + 60), text: "x" })) });
const sum = (cites: string[]): any => ({ title: "", overview: "", glossary: [], sections: cites.map((c, i) => ({ heading: `h${i}`, bullets: [`b [${c}]`] })) });

test("late-only summary (ML case) fails coverage with a big early gap", () => {
  const c = computeCoverage(asr(137 * 60), sum(["t=101:00-110:00", "t=120:00", "t=136:00"]))!;
  assert.equal(c.ok, false); assert.ok(c.ratio < 0.4); assert.equal(c.gaps[0][0], 0);
});
test("evenly cited 46-min lecture passes", () => {
  const cites = Array.from({ length: 12 }, (_, i) => `t=${i * 4}:00-${i * 4 + 3}:30`);
  const c = computeCoverage(asr(46 * 60), sum(cites))!;
  assert.equal(c.ok, true, JSON.stringify(c));
});
test("middle 15-min gap fails even with high ratio elsewhere", () => {
  const cites = Array.from({ length: 30 }, (_, i) => i * 4).filter((m) => m < 40 || m > 56).map((m) => `t=${m}:00`);
  const c = computeCoverage(asr(120 * 60), sum(cites))!;
  assert.equal(c.ok, false); assert.equal(c.gaps.length, 1);
});
test("backwards ranges are swapped", () => {
  assert.deepEqual(citeRanges(sum(["t=12:30-11:05"])), [[665, 750]]);
  assert.equal(fixBackwardRanges(sum(["t=12:30-11:05, slide 3"])).sections[0].bullets[0], "b [t=11:05-12:30, slide 3]");
  assert.equal(fixBackwardRanges("[t=1:00:05-1:02:00]"), "[t=1:00:05-1:02:00]");
});
test("ASR incomplete detection (genetics ~51 of ~81 min)", () => {
  assert.equal(asrCompleteness(asr(51 * 60), 81 * 60).incomplete, true);
  assert.equal(asrCompleteness(asr(46 * 60), 46 * 60 + 30).incomplete, false);
  assert.equal(asrCompleteness(asr(46 * 60), 0).incomplete, false);
});
test("gap sections merge in time order", () => {
  const m = mergeGapSections(sum(["t=50:00"]), { ...sum(["t=10:00"]), sections: [{ heading: "new", bullets: ["b [t=10:00]"] }] });
  assert.deepEqual(m.sections.map((s) => s.bullets[0]), ["b [t=10:00]", "b [t=50:00]"]);
});

test("mergeTranscripts fills earlier recording session from sibling job; completeness catches leading gap", async () => {
  const { mergeTranscripts, asrCompleteness } = await import("../src/lib/pipeline/coverage");
  const seg = (s: number) => ({ start: s, end: s + 20, text: "x" + s });
  const late = { language: "he", segments: Array.from({ length: 90 }, (_, i) => seg(6110 + i * 20)) };
  const early = { language: "he", segments: Array.from({ length: 300 }, (_, i) => seg(i * 20)) };
  assert.equal(asrCompleteness(late, 7984).incomplete, true);
  const m = mergeTranscripts(late, [early]);
  assert.equal(m.added, 300);
  assert.equal(m.t.segments[0].start, 0);
  assert.equal(mergeTranscripts(m.t, [early]).added, 0);
});

test("mergeSiblingArtifacts merges earlier session into asr, asrRaw and repaired (resummarize path)", async () => {
  const { mergeSiblingArtifacts } = await import("../src/lib/pipeline/index");
  const seg = (s: number) => ({ start: s, end: s + 20, text: "x" + s });
  const late = { language: "he", segments: Array.from({ length: 90 }, (_, i) => seg(6110 + i * 20)) };
  const early = { language: "he", segments: Array.from({ length: 300 }, (_, i) => seg(i * 20)) };
  const a: any = { asrComplete: true, asr: late, asrRaw: late, repaired: late };
  assert.equal(mergeSiblingArtifacts(a, [{ asrComplete: true, asr: early, repaired: early } as any, undefined]), 300);
  for (const k of ["asr", "asrRaw", "repaired"]) assert.equal(a[k].segments[0].start, 0);
});
test("ASR ~99% end with pauses is not incomplete", async () => {
  const { asrCompleteness } = await import("../src/lib/pipeline/coverage");
  const segs = Array.from({ length: 100 }, (_, i) => ({ start: i * 50, end: i * 50 + 20, text: "x" }));
  assert.equal(asrCompleteness({ language: "he", segments: segs } as any, 5000).incomplete, false);
});
