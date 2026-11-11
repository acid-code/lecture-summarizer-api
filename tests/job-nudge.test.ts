import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBlobHoldArtifacts,
  pickNudgeBatch,
  rankNudgeCandidates,
  type NudgeCandidate,
} from "../src/lib/job-nudge";

function c(partial: Partial<NudgeCandidate> & Pick<NudgeCandidate, "id" | "lectureId">): NudgeCandidate {
  return {
    stage: "pdf",
    updatedAt: 1,
    density: "standard",
    blobHold: false,
    holdUntil: null,
    busy: false,
    stuck: true,
    superseded: false,
    ...partial,
  };
}

test("isBlobHoldArtifacts detects soft-hold label", () => {
  assert.equal(
    isBlobHoldArtifacts({ progressDetail: { stage: "pdf", label: "Blob storage suspended/full — auto-retry in 30 min" } }),
    true,
  );
  assert.equal(isBlobHoldArtifacts({ progressDetail: { stage: "pdf", label: "Building PDF" } }), false);
  assert.equal(isBlobHoldArtifacts({ holdUntil: Date.now() + 60_000 }), true);
  assert.equal(isBlobHoldArtifacts({ holdUntil: Date.now() + 60_000, overloadHolds: 2 }), false);
});

test("pickNudgeBatch supersedes orphans and limits pdf + batch size", () => {
  const now = 1_000_000;
  const rows = [
    c({ id: "orphan", lectureId: "L1", superseded: true, stuck: false }),
    c({ id: "pdf1", lectureId: "L2", stage: "pdf", blobHold: true, stuck: false }),
    c({ id: "pdf2", lectureId: "L3", stage: "pdf", blobHold: true, stuck: false }),
    c({ id: "sum", lectureId: "L4", stage: "summary", stuck: true }),
    c({ id: "busy", lectureId: "L5", stage: "summary", busy: true, stuck: true }),
    c({ id: "gemini", lectureId: "L6", stage: "summary", holdUntil: now + 10_000, stuck: false }),
  ];
  const { advance, supersede, skip } = pickNudgeBatch(rows, { maxAdvance: 2, now });
  assert.deepEqual(supersede.map((x) => x.id), ["orphan"]);
  assert.deepEqual(advance.map((x) => x.id), ["pdf1", "sum"]);
  assert.ok(skip.some((s) => s.c.id === "pdf2" && s.reason === "pdf_limit"));
  assert.ok(skip.some((s) => s.c.id === "busy" && s.reason === "busy"));
  assert.ok(skip.some((s) => s.c.id === "gemini" && s.reason === "gemini_hold"));
});

test("rankNudgeCandidates prefers blob holds and one job per lecture", () => {
  const ranked = rankNudgeCandidates([
    c({ id: "old-stuck", lectureId: "L1", updatedAt: 10, stuck: true }),
    c({ id: "blob", lectureId: "L2", updatedAt: 50, blobHold: true, stuck: false }),
    c({ id: "same-lec", lectureId: "L1", updatedAt: 5, stuck: true, stage: "summary" }),
    c({ id: "orphan", lectureId: "L9", superseded: true, stuck: false }),
  ]);
  assert.equal(ranked[0].id, "blob");
  assert.ok(ranked.some((x) => x.id === "orphan"));
  assert.equal(ranked.filter((x) => x.lectureId === "L1" && !x.superseded).length, 1);
});
