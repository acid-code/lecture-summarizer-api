# lecture-summarizer-api

Backend for a TAU lecture summarizer: Hebrew lecture audio (+ optional slides PDF/PPTX) → transcript → Hebrew/English term repair → study summary → RTL study PDF.

Next.js (App Router) + TypeScript, built for **Vercel Hobby (free)** as a *control plane*: API, auth stub, job status, Blob client uploads, and orchestration. Heavy work (ASR, LLM) runs on the **Gemini API**, not inside functions.

> Thin MVP. Anything marked **(verify)** is a planning figure that must be checked against current docs.

## Architecture

```
phone/web ──(Vercel Blob client upload, multipart)──► Blob  (audio, slides, course PDF)
     │
     └─► Next.js API on Vercel ── job: queued → asr → repair → summary → pdf → done
                                     │        │        │
                                     └── Gemini API (Files API + Flash model) ──┘
```

- **Never** run Whisper, WeasyPrint, or the native Typst CLI in Vercel functions (no GPU, native deps, 300 s Hobby limit).
- Function request body limit is **4.5 MB** → audio/slides go straight to Blob via `/api/upload` (client uploads). A ~50 min m4a is ~20–80 MB (verify).
- Each `POST /api/jobs/{id}/advance` runs **one stage** (`maxDuration = 300`, the Hobby max). Call it until `stage === "done"` (client polling now; Vercel Cron/Queues/Workflows later).
- Stages are idempotent; artifacts are saved per stage on the job, so a `failed` job resumes from the first missing stage.
- AI is behind `AiProvider` (`src/lib/providers`): **Gemini** when `GEMINI_API_KEY` or `GEMINI_API_KEYS` is set, otherwise a **mock** (lets you run everything without a key). Swap in ivrit-ai Whisper etc. later via a new provider.
- Course-level **context PDF** (old course summary, ~150–200 pages) is optional background context; each **lecture** = audio + optional slides.

## Free path setup

| Piece | Free tier | Notes |
|---|---|---|
| Vercel Hobby | $0 | 300 s max function duration, 4.5 MB body |
| Vercel Blob | 1 GB storage, 10 GB transfer / mo (verify) | Exceeding blocks Blob ~30 days on Hobby — delete audio after processing |
| Gemini API | free tier, rate-limited (verify RPM for your model) | Key from AI Studio |
| DB | local SQLite file / Turso free (verify) | via Drizzle + libsql |

Expected: ~$0/mo for 1 user, ~1 lecture/week; ~$0–5/mo if free limits bite (verify).

### 1. Gemini API key
1. Go to https://aistudio.google.com/apikey and create a key.
2. Put it in `.env.local` as `GEMINI_API_KEY` (and in Vercel → Project → Settings → Environment Variables). For more daily quota, add `GEMINI_API_KEYS=key1,key2` (keys from different Google projects): when a key's model ladder hits RPD, calls fail over to the next key; that key is skipped until 00:00 UTC. Keys are never logged (only an 8-char hash id).
3. `GEMINI_MODEL` defaults to the first rung of the model ladder (`gemini-3.5-flash-lite`), see below.

**Google AI Pro** (the Gemini app subscription) is separate from Gemini **API** billing; Pro may add AI Studio quota / Cloud credits (verify). The free API tier is enough to start. Free-tier API data may be used to improve Google products (verify) — keep audio private-ish accordingly.

### 2. Database
Drizzle ORM over **libsql**:
- Local: `DATABASE_URL=file:./data/local.db` (default, no setup).
- Vercel: a serverless filesystem is not persistent, so create a free **Turso** DB (`turso db create lectures`) and set `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN`. (Neon Postgres also works but needs the pg dialect — not wired.)
- Tables are auto-created on first request (`ensureDb`). `npm run db:push` syncs via drizzle-kit if you change the schema.

### 3. Vercel Blob

The Blob store must be **private** — the API uploads and reads with `access: "private"` so lecture audio is never world-readable.
Vercel dashboard → Storage → Create Blob store → connect to project. `BLOB_READ_WRITE_TOKEN` is injected automatically; pull it locally with `vercel env pull .env.local`. Without it, generated artifacts are written to `./data/artifacts` and client uploads are unavailable.

## Local run

```bash
npm install
cp .env.example .env.local   # fill what you have; everything is optional locally
npm run dev                  # http://localhost:3000
```

Smoke test (mock provider, no keys):
```bash
# Preferred: scripts/mock-job.sh http://localhost:3000   (v1 API). Legacy /api flow:
B=http://localhost:3000/api
curl $B/health
C=$(curl -s -XPOST $B/courses -H 'content-type: application/json' -d '{"name":"Intro ML"}' | jq -r .id)
L=$(curl -s -XPOST $B/courses/$C/lectures -H 'content-type: application/json' -d '{"title":"Lecture 1"}' | jq -r .id)
J=$(curl -s -XPOST $B/lectures/$L/process | jq -r .id)
for i in 1 2 3 4 5; do curl -s -XPOST $B/jobs/$J/advance; echo; done   # queued→asr→repair→summary→pdf→done
curl $B/jobs/$J | jq .artifacts.pdf   # path to the RTL study HTML
```

`npm run build` and `npm run typecheck` must pass.

## Deploy (Vercel Hobby)
1. Import this repo in Vercel (framework: Next.js).
2. Add a Blob store; set `GEMINI_API_KEY`, `GEMINI_MODEL`, `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `API_TOKEN`.
3. **Turso is required on Vercel**: set `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN` (no file DB on Vercel; DB routes return a JSON 503 explaining this until set). `/v1/health` and `/api/health` work even before Turso is configured (no DB access).
4. Deploy. Check `/api/health` → `{"provider":"gemini","blob":true}`.
5. PDF needs nothing extra: `@sparticuz/chromium` is auto-selected on Vercel. Function memory: keep the default (2 GB on Hobby); the PDF stage takes ~3–8 s incl. cold unpack. Check by running a job and `GET /v1/lectures/{id}/summary.pdf` → 200 `application/pdf`. If the bundle exceeds the 250 MB limit, set `PDF_RENDERER=html` as a fallback.
6. Large uploads: just connect the Blob store (step 2). Verify with `curl -XPOST $B/v1/uploads -H 'content-type: application/json' -d '{"filename":"a.m4a","content_type":"audio/mp4"}'` → `mode:"blob"`.

## API — `/v1` (Android contract, canonical)

Implemented in `src/app/v1/[...path]/route.ts` → `src/lib/v1/handlers.ts`. Matches `HttpLectureApi.kt` in
[lecture-summarizer-android](https://github.com/acid-code/lecture-summarizer-android). Auth: `Authorization: Bearer $API_TOKEN` (disabled when unset).

| Method | Path | Body | Response | Android |
|---|---|---|---|---|
| GET | `/v1/health` | – | `{ok,provider,blob}` | – |
| POST | `/v1/courses` | `{name, lang_primary}` | `{course_id}` | createCourse ✓ |
| GET | `/v1/courses` | – | `[{course_id,name,has_context}]` | – |
| POST | `/v1/courses/{id}/context` | multipart `file` (PDF) or JSON `{url}` | `{pages,chars}` | – |
| POST | `/v1/uploads` | JSON `{filename, content_type, size?}` | `{mode:"multipart"}` (no Blob) or `{mode:"blob", method:"PUT", put_url, headers, expires_at}` | large-file uploads |
| POST | `/v1/lectures` | `{course_id,title,recorded_at}` | `{lecture_id}` | createLecture ✓ |
| GET | `/v1/lectures/{id}` | – | lecture + segments + jobs | – |
| POST | `/v1/lectures/{id}/slides` | multipart `file` (PDF/PPTX) or JSON `{url}` | `{slides_text_chars}` | uploadSlides ✓ |
| POST | `/v1/lectures/{id}/context` | multipart `file` (PDF) or JSON `{url}` — stored on the lecture's **course** | `{pages,chars}` | uploadCourseContext ✓ |
| POST | `/v1/lectures/{id}/audio/segments` | multipart `seq, started_at, duration, file` or JSON `{seq,duration,url,mime}`; idempotent per seq | `{seq}` | uploadSegment ✓ |
| POST | `/v1/lectures/{id}/markers` | `[{t_sec,page,label}]` | `{count}` | uploadMarkers ✓ |
| POST | `/v1/lectures/{id}/process` | `{options}` (`options.live=true`: ASR-while-recording job, reused; a later call without `live` finalizes it) | `{job_id, live}` (202) | startProcessing ✓ |
| GET | `/v1/jobs/{id}` | – | `{state: queued\|running\|done\|failed, stage, progress 0-100, error, pdf_ready, repairs}` — **runs one stage per poll** (`AUTO_ADVANCE_ON_POLL`, `?advance=0` to just read) | jobStatus ✓ |
| POST | `/v1/jobs/{id}/advance` | – | same as above; also resumes `failed` jobs | – |
| POST | `/v1/jobs/{id}/retry` | – (`?force=1` for a running job) | job view (202); resets a `failed` or stuck (no update for `JOB_STUCK_MS`, default 10 min) job to its first incomplete stage, clears `error`, keeps finished stage outputs (no ASR redo). 409 if done/running, 404 unknown | retryJob ✓ |
| GET | `/v1/lectures/{id}/summary.pdf` | – | `application/pdf` (501 only if `PDF_RENDERER=html` or Chromium fails to launch) | downloadSummaryPdf ✓ |
| GET | `/v1/lectures/{id}/summary.html` / `summary.json` | – | RTL HTML / `{summary,repairs,transcript}` | – |

Legacy `/api/*` routes (web scaffold: `/api/courses`, `/api/jobs/{id}/advance`, `/api/upload` Blob token) are kept.

### Pipeline details
- **ASR**: one audio segment per advance call (offsets = cumulative `duration`), so long lectures never exceed 300 s per call. Files ≤15 MB are sent inline; bigger ones via the Gemini Files API.
- **Repair**: Gemini returns an **edit list** `[{segment,span,replacement,evidence,confidence}]` grounded in slide text + course-pack excerpts; edits with confidence ≥0.6 are applied to a `repaired` transcript, originals kept. TODO: phonetic pre-pass.
- **Slide text** (`lectures.slides_text`, `\f` between slides, feeds ASR term bias + repair + summary): PDF via `unpdf`; PPTX via pure-JS `fflate` unzip of `ppt/slides/*.xml` (+ speaker notes as `[notes]`), slide order from `presentation.xml`, media never decompressed — works on Vercel, no LibreOffice (`src/lib/pptx.ts`). Check a deck locally: `npx tsx scripts/extract-pptx.ts deck.pptx`.
- **Course-context pack**: PDF text extracted once (`unpdf`) into `courses.context_text`; each prompt gets top lexical-match ~1.2k-char chunks (≤5–6k chars total, `src/lib/context.ts`), never the whole PDF. Slides stay the primary source. TODO: embeddings.
- **PDF**: RTL HTML → PDF with headless Chromium via `puppeteer-core` (`src/lib/pdf.ts`). **Local/box**: system Chrome (`CHROME_PATH` or `/usr/bin/{google-chrome,chromium,chromium-browser}`). **Vercel** (`VERCEL`/Lambda env, or force with `PDF_RENDERER=sparticuz`): `@sparticuz/chromium` (brotli pack in `node_modules/@sparticuz/chromium/bin`, unpacked to `/tmp` on cold start, ~+2–4 s; traced into functions via `outputFileTracingIncludes` in `next.config.ts`). The Hebrew font (IBM Plex Sans Hebrew, OFL, `fonts/`) is inlined as `@font-face` so it embeds even with no system fonts. `PDF_RENDERER=html` disables PDF (→ 501, use `summary.html`). typst-wasm (`templates/study.typ`) not used.
- **Uploads**: two paths, same `/v1` endpoints.
  - *Local/box (no `BLOB_READ_WRITE_TOKEN`)*: multipart through the function → `data/uploads/`. `POST /v1/uploads` returns `{mode:"multipart"}`.
  - *Vercel (Blob store connected)*: function bodies are capped at **4.5 MB**, so the client calls `POST /v1/uploads` → gets a 1-hour, single-pathname, content-type-restricted Blob client token as `{put_url, headers}`, PUTs raw bytes to `put_url` with those headers (response JSON has `url`), then sends JSON `{url, ...}` to `/v1/lectures/{id}/audio/segments` (`{seq, started_at, duration, mime, url}`), `/slides` or `/context`. Small multipart still works on Vercel under 4.5 MB.
  - JSON `{url}` is only accepted for `https://*.blob.vercel-storage.com` or `local:data/uploads/...` (no SSRF / path traversal).
  - The Android app uses Blob when `/v1/uploads` says `blob` and the file is > 4 MB, else multipart.
- **Raw audio deletion**: after the PDF stage, segment files are deleted and URLs nulled (`DELETE_RAW_AUDIO=true` default).
- Gemini **model ladder** (free tier, AI Studio free project, Oct 2026 — verify yours in AI Studio → Rate limits; quota is per project and resets at midnight Pacific):

  | Rung | Model | Free RPM / RPD |
  | --- | --- | --- |
  | 1 | `gemini-3.5-flash-lite` | 15 / 500 |
  | 2 | `gemini-3.1-flash-lite` | 15 / 500 |
  | 3 | `gemini-3.8-flash` | 5 / 20 |
  | 4 | `gemini-flash-latest` | 5 / 20 |
  | 5 | `gemini-3.5-flash` | 5 / 20 |

  Note: `gemini-2.5-flash-lite` is only ~20 RPD now, so it is not in the ladder.

  On 429 / `RESOURCE_EXHAUSTED` the next rung is tried immediately (no backoff); a model that hits a daily limit is skipped for 1 h in that process. 500/503 get jittered backoff (`GEMINI_RETRIES`, default 5; total wait capped by `GEMINI_RETRY_BUDGET_MS`, default 90 s). If every rung is out of quota the job goes `failed` with `error: "<stage>: Gemini free daily quota exhausted; retry after reset"` (no raw JSON). Override with `GEMINI_MODEL` (first rung) and `GEMINI_FALLBACK_MODELS` (comma list replacing the rest). Call `POST /v1/jobs/{id}/retry` after reset (the Android Retry button does this).

  **503 / overloaded ("high demand")** is handled separately from quota: exponential backoff + jitter on the same model (`GEMINI_OVERLOAD_RETRIES`, default 3; base `GEMINI_OVERLOAD_BASE_MS`, default 2000), then fallback to `GEMINI_FALLBACK_MODEL` (default `gemini-3.1-flash-lite`; set empty to just use the next ladder rung), then the other rungs. Keys are not rotated for overload. If everything stays overloaded the job is **held, not failed**: it keeps its stage (state `running`, `error: null`, `progress_detail.label` "Gemini busy (high demand) — auto-retry in N min") and polls are no-ops until the hold expires (jittered backoff from `GEMINI_OVERLOAD_HOLD_MS`, default 60 s, capped 15 min). After `GEMINI_OVERLOAD_MAX_HOLDS` (default 8) consecutive holds it goes `failed` as before. Logs show model, key index/hash (never the key), attempt and fallback.

Full job script: `scripts/mock-job.sh [base] [audio] [context.pdf] [slides.pdf]` — see TEST.md.

## Lecture materials (several files per lecture) — 2026-10
- New table `lecture_files` (auto-created by `ensureDb`, no manual migration). `POST /v1/lectures/{id}/slides` now **adds** a deck
  (PDF/PPTX); the same file name replaces that deck (idempotent retries); `?replace=all` restores the old one-slot behaviour.
  JSON uploads accept `{url, name?, mime?}`.
- Backward compatible: `lectures.slides_url` = first deck, `lectures.slides_text` = all decks' text joined (`=== name ===` headers),
  so the pipeline/prompts are unchanged. A legacy single deck is listed as `file_id: "legacy-slides"` and is moved into the table
  when a second deck is added.
- `GET /v1/lectures/{id}` adds `files[]`; `GET /v1/lectures/{id}/files` lists decks + audio segments (`seg-N`);
  `GET /v1/lectures/{id}/files/{file_id}` streams one (410 for audio removed by raw-audio cleanup).

## Math in the study PDF
Summary text may contain LaTeX: `\( … \)` / `$…$` inline, `$$ … $$` / `\[ … \]` display. `render.ts` converts it with
**KaTeX** (pure JS) to HTML; `pdf.ts` inlines `fonts/katex-inline.css` (KaTeX CSS + woff2 fonts as data URLs) so Chromium
prints it into the PDF on Vercel too. Bad TeX shows as red source, never fails the job. Single `$` follows pandoc rules
(`$5 and $10` stays text). The summary prompt asks Gemini to emit formulas as LaTeX. Regenerate the CSS after a KaTeX upgrade
(see commit message one-liner in git log). Typst is not used in the Vercel path (native binary).

### Re-repair (no ASR quota)
`POST /v1/jobs/{id}/rerepair[?force=1]` keeps the ASR and re-runs repair (term fixes + a second Hebrew-spelling pass) → summary → PDF.
`reprocess?fallback=1` without server audio now does the same. Env: `REPAIR_SPELLING_PASS=0` disables pass 2, `REPAIR_CHUNK_SEGMENTS` (default 120).

## Figures in the study PDF

The `pdf` stage (`src/lib/figures/`) embeds important graphs/diagrams from the lecture's slide decks **inline under the matching summary section**:

1. Each PDF deck (PPTX via LibreOffice → PDF when `soffice` exists) is analyzed with unpdf: text length + image/vector paint ops per page. Pages with images/drawings are pre-filtered and capped (`FIGURES_MAX_PAGES`).
2. Candidates are rendered as whole-slide JPEG thumbnails (~1000 px, q75) with `pdftoppm`, or in-process with unpdf + `@napi-rs/canvas` (serverless).
3. **Mistral vision** (`MISTRAL_VISION_MODEL`, default `ministral-14b-2512`) picks up to `FIGURES_MAX` figures `{page, section, caption}` in one call. Gemini still writes the text summary.
4. Fallback without `MISTRAL_API_KEY` / on error: image-heavy, low-text slides, section matched by slide citation or lexical overlap.
5. `render.ts` places each figure (caption RTL when Hebrew, `[שקף N]`) after its section. Figure metadata is kept in `artifacts.figures`. Failures never fail the job (text-only PDF). `FIGURES=off` disables.

Limits: PPTX figures need LibreOffice (not on Vercel → PPTX decks stay text-only there; PDFs work). ~6 JPEGs add ≈1 MB to the PDF.

## External transcript import (Panopto)

`POST /v1/lectures/{id}/transcript/import` uses an existing timed transcript (e.g. TAU Panopto captions from
`GenerateSRT.ashx?id={deliveryId}&language=0`) instead of our audio ASR. No audio segments are needed.

- JSON: `{ "source": "panopto", "external_id": "<deliveryId>", "title": "…", "language": "he", "segments": [{ "t0": 0.0, "t1": 2.4, "text": "…" }] }`
  (`start`/`end` also accepted; or put the raw SRT in `"srt"`).
- Raw SRT body: `Content-Type: application/x-subrip` (or `text/plain`); `?source=&external_id=&language=` optional.

The parser drops Panopto's `[Auto-generated transcript…]` disclaimer and recurring `Speaker Name: ` prefixes.
A new job gets `artifacts.asr` = the transcript, `asrComplete=true`, `asrSource` (default `panopto`) and starts at
`repair` → `summary` → `pdf` (poll `GET /v1/jobs/{id}`; `asr_source` is reported). Returns `202 { job_id, source, segments, start_sec, end_sec }`.
Check an SRT locally: `npx tsx scripts/check-srt.ts file.srt`.
