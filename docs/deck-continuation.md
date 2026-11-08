# Range-aware multi-deck context (local only)

Base `be7a4a8`; branch `feature/deck-continuation`. No push, deployment or live DB migration. Companion Android branch is based on `c3a8282`.

## Already supported

Multiple decks per lecture (`lecture_files`) and reuse of the same deck content by separate lectures already exist. Uploads replace by filename within the lecture; different lectures do not have exclusive deck ownership. `lectures.slides_text` aggregates source text; pipeline/PDF figures read all attached decks. This is logical content reuse, not a new shared-blob reference-counting implementation. Prompt/figure budgets mean not every page must appear in output.

## Changes

- Nullable `lecture_files.slide_range` JSON; `ensureDb` uses a guarded additive ALTER for existing installations. No data rewrite. Drizzle schema updated.
- POST `/v1/lectures/{id}/slides?slide_start=3&slide_end=10&approximate=true` accepts optional original 1-based range (end >= start, <=10000 and within extracted page count). Absent range means whole deck. Same filename remains the idempotency identity. Validate before deleting prior attachments.
- GET same owner-scoped slides route returns `{range_support:true,files:[...]}`; `/files` includes `slide_range`. Android preflights any range snapshot before uploading any replacement; an old server refuses range use rather than silently ignoring it. Whole-deck requests remain backward-compatible.
- Store full extracted source text; focus named aggregate text to approved ranges with original page labels and an explicit approximate warning. PDF/PPTX figure candidates honor the same range, retaining original page numbers. No re-ASR required for existing transcript rebuilds.
- Give each named source prompt head/tail budget, including middle sources, in summary, repair/spelling and hierarchical paths. Filename-aware citation instruction avoids treating all decks' slide 3 as one source.
- Preserve original deck order when replacing by filename; suppress legacy one-slot migration when replacing an existing row (fix duplicate-on-retry).

## Tests

`npm run typecheck && npm test`: **66 passed, 0 failed/skipped**. Isolated local SQLite, synthetic OOXML, dummy test authentication, no Gemini/Blob keys. New endpoint integration test covers same deck in two lectures, two ranged decks, owner scope, capability/files metadata, invalid-range non-destruction, same-name retry idempotency, replacement order, and detaching from one lecture without clearing the other. Pure tests cover fair prompt budgets and PDF/PPTX range predicates. Not a real model/PDF E2E run.

Raw real lecture material is not in this repository. Read-only Genetics/Biochemistry diagnostic and limitations are documented in the Android `docs/DECK_CONTINUATION.md`. Focused ranges need deployment of this companion change later; nothing was deployed as part of this task.
