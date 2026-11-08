import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("tutor answer prompt requires KaTeX delimiters and numbered cite markers", () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/study/tutor.ts"), "utf8");
  assert.match(src, /Place matching markers \[1\]/);
  assert.match(src, /MATH: wrap every formula/);
  assert.match(src, /\\\\\(/);
  assert.match(src, /\$\$/);
  assert.match(src, /blank line/);
});
