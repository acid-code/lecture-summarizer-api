# Lecture study tools — local implementation

## Deployment and configuration

The memory game needs **no new deployed endpoint**: Android caches the existing per-lecture `/summary.json` glossary. The tutor **does need an approved API deployment** containing this change. Nothing was pushed, deployed, merged, or written to the production database during development.

The tutor reuses the existing `GEMINI_API_KEY` / `GEMINI_API_KEYS`, model ladder, key-auth failover, quota and overload handling. The API must have its existing `API_TOKEN` configured. No new OAuth client, Gmail access, Android Gemini key, or model credentials are required. Optional `TUTOR_PER_MINUTE` and `TUTOR_PER_DAY` override defaults of 6 and 60 (bounded to 1–60 and 1–1000 respectively).

`ensureDb()` creates the additive `tutor_buckets` table and expiry index idempotently. Counters use atomic SQLite/Turso UPSERT, work across server instances, are keyed by SHA-256 of the device identifier and window, and contain no conversation content. Fixed minute/day windows return `Retry-After`; expired counters are cleaned opportunistically. Limits are shared across a device's lectures. Valid-format owned requests consume limits even when the content is subsequently refused or unavailable.

## Contract

`POST /v1/lectures/{lectureId}/tutor` uses the existing bearer API authentication and requires `X-Device-Id`. Cross-device and unknown lectures return the same 404. Unlike legacy unclaimed lecture reads, this paid route requires a device identifier, including for unclaimed records.

```json
{"question":"Explain the enzyme example","language":"en","previous_questions":["What is an active site?"]}
```

`question` is required, trimmed and capped at 1200 characters. Language must be `he` or `en`. Optional previous questions are at most 3 strings of 400 characters, solely for pronoun/follow-up disambiguation. No assistant roles, client-provided source material, arbitrary system instructions or extra request fields are accepted. The streamed request body is capped at 8192 bytes.

Response: `kind` is `answer`, `refused` or `not_covered`, with `answer` and a `citations` array. Answer citations contain `source_id`, `kind`, `label`, and a verbatim `quote` from the supplied lecture material. Refusals contain no citations. Errors: 400 invalid request, 401 missing auth/device, 404 unavailable lecture, 409 no ready source material, 413 oversized body, 429 rate limit, 503 unavailable provider/configuration/storage. Provider internals are never returned to the client.

## Grounding and defenses

1. Load only this lecture's transcript, latest completed summary and attached slide text; focus slide text to saved ranges when present. Include all supported attached decks, not neighboring lectures or course materials. Legacy attached-slide text remains supported.
2. Source processing is deliberately bounded: inspect up to 12 recent jobs, 20 attached decks, and 1800 snippets. Each source text is capped at 240,000 characters; chunks are 1100 characters with 850-character stride. Retrieve up to 24 snippets, preserving material-type coverage alongside lexical relevance. This can conservatively miss information, particularly in long or image-only materials.
3. Treat material, questions and history as untrusted data. System rules prohibit general knowledge, role-play overrides, mixed off-topic requests and instructions inside source text. A deterministic common-jailbreak check runs before model use.
4. A separate Gemini topic/coverage check selects valid source IDs or refuses. The answer receives only selected evidence, not an unrestricted conversation or search tool.
5. Validate structured output and source IDs. Each cited quote must be a contiguous verbatim substring of an allowed source. A separate semantic support/topic verifier must approve the answer. Malformed, ungrounded or verifier-rejected results fail closed; no unverified streaming.
6. Refused/not-covered messages are fixed and localized. Gemini calls use the existing model/key retry wrapper, a 20-second SDK timeout and a 25-second abort signal per stage; exhausted/unavailable providers produce a generic service error.

These are defense-in-depth measures, **not a proof against every jailbreak or hallucination**. No live Gemini adversarial evaluation or live-provider end-to-end run was performed. After deployment approval, evaluate real HE/EN lecture questions, unrelated/mixed requests, malicious source instructions, follow-ups, quota errors and model availability before widening rollout.

`X-Device-Id` isolation inherits the existing shared-token architecture. It is not cryptographic user authentication, hardware attestation or Sybil-proof rate limiting: a caller able to spoof identifiers has the same architectural limitations as existing routes. New code does not log questions, answers or full API keys. Material/question transmission uses the existing Gemini provider; do not assume zero provider retention.

## Local verification

- TypeScript typecheck and Next production build.
- Full Node suite: **86 passing tests, zero failures/skips**, including strict payload/stream size/auth/ownership, two-deck ranged grounding, topic/coverage/verbatim evidence/verifier failures, bounded retrieval and follow-ups.
- Real SDK transport test with a closed fetch stub: first dummy key fails authentication, the next dummy key succeeds; verify systemInstruction/JSON mode and no tools. No external request can escape the stub.
- Temporary local SQLite tests for concurrent fixed-window minute limits, daily exhaustion/reset and device separation. No live DB writes or live Gemini calls.

Android implementation and UI details: see `docs/STUDY_TOOLS.md` in the Android checkout.
