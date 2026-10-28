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
- AI is behind `AiProvider` (`src/lib/providers`): **Gemini** when `GEMINI_API_KEY` is set, otherwise a **mock** (lets you run everything without a key). Swap in ivrit-ai Whisper etc. later via a new provider.
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
2. Put it in `.env.local` as `GEMINI_API_KEY` (and in Vercel → Project → Settings → Environment Variables).
3. `GEMINI_MODEL` defaults to `gemini-2.5-flash` — model names change fast (verify). The plan mentions `gemini-3.5-transcribe` for ASR (verify).

**Google AI Pro** (the Gemini app subscription) is separate from Gemini **API** billing; Pro may add AI Studio quota / Cloud credits (verify). The free API tier is enough to start. Free-tier API data may be used to improve Google products (verify) — keep audio private-ish accordingly.

### 2. Database
Drizzle ORM over **libsql**:
- Local: `DATABASE_URL=file:./data/local.db` (default, no setup).
- Vercel: a serverless filesystem is not persistent, so create a free **Turso** DB (`turso db create lectures`) and set `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN`. (Neon Postgres also works but needs the pg dialect — not wired.)
- Tables are auto-created on first request (`ensureDb`). `npm run db:push` syncs via drizzle-kit if you change the schema.

### 3. Vercel Blob
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
3. Deploy. Check `/api/health` → `{"provider":"gemini","blob":true}`.

## API — `/v1` (Android contract, canonical)

Implemented in `src/app/v1/[...path]/route.ts` → `src/lib/v1/handlers.ts`. Matches `HttpLectureApi.kt` in
[lecture-summarizer-android](https://github.com/acid-code/lecture-summarizer-android). Auth: `Authorization: Bearer $API_TOKEN` (disabled when unset).

| Method | Path | Body | Response | Android |
|---|---|---|---|---|
| GET | `/v1/health` | – | `{ok,provider,blob}` | – |
| POST | `/v1/courses` | `{name, lang_primary}` | `{course_id}` | createCourse ✓ |
| GET | `/v1/courses` | – | `[{course_id,name,has_context}]` | – |
| POST | `/v1/courses/{id}/context` | multipart `file` (PDF) or JSON `{url}` | `{pages,chars}` | – |
| POST | `/v1/lectures` | `{course_id,title,recorded_at}` | `{lecture_id}` | createLecture ✓ |
| GET | `/v1/lectures/{id}` | – | lecture + segments + jobs | – |
| POST | `/v1/lectures/{id}/slides` | multipart `file` (PDF/PPTX) or JSON `{url}` | `{slides_text_chars}` | uploadSlides ✓ |
| POST | `/v1/lectures/{id}/context` | multipart `file` (PDF) or JSON `{url}` — stored on the lecture's **course** | `{pages,chars}` | uploadCourseContext ✓ |
| POST | `/v1/lectures/{id}/audio/segments` | multipart `seq, started_at, duration, file` or JSON `{seq,duration,url,mime}`; idempotent per seq | `{seq}` | uploadSegment ✓ |
| POST | `/v1/lectures/{id}/markers` | `[{t_sec,page,label}]` | `{count}` | uploadMarkers ✓ |
| POST | `/v1/lectures/{id}/process` | `{options}` | `{job_id}` (202) | startProcessing ✓ |
| GET | `/v1/jobs/{id}` | – | `{state: queued\|running\|done\|failed, stage, progress 0-100, error, pdf_ready, repairs}` — **runs one stage per poll** (`AUTO_ADVANCE_ON_POLL`, `?advance=0` to just read) | jobStatus ✓ |
| POST | `/v1/jobs/{id}/advance` | – | same as above; also resumes `failed` jobs | – |
| GET | `/v1/lectures/{id}/summary.pdf` | – | `application/pdf` (501 if no PDF renderer) | downloadSummaryPdf ✓ |
| GET | `/v1/lectures/{id}/summary.html` / `summary.json` | – | RTL HTML / `{summary,repairs,transcript}` | – |

Legacy `/api/*` routes (web scaffold: `/api/courses`, `/api/jobs/{id}/advance`, `/api/upload` Blob token) are kept.

### Pipeline details
- **ASR**: one audio segment per advance call (offsets = cumulative `duration`), so long lectures never exceed 300 s per call. Files ≤15 MB are sent inline; bigger ones via the Gemini Files API.
- **Repair**: Gemini returns an **edit list** `[{segment,span,replacement,evidence,confidence}]` grounded in slide text + course-pack excerpts; edits with confidence ≥0.6 are applied to a `repaired` transcript, originals kept. TODO: phonetic pre-pass.
- **Course-context pack**: PDF text extracted once (`unpdf`) into `courses.context_text`; each prompt gets top lexical-match ~1.2k-char chunks (≤5–6k chars total, `src/lib/context.ts`), never the whole PDF. Slides stay the primary source. TODO: embeddings.
- **PDF**: RTL HTML → PDF with headless Chrome (`puppeteer-core`, system Chrome). Works on the box/self-host. On Vercel there is no Chrome → falls back to HTML and `summary.pdf` returns 501. TODO: `@sparticuz/chromium` or typst-wasm.
- **Uploads**: multipart goes through the function and is saved to Vercel Blob if `BLOB_READ_WRITE_TOKEN`, else `data/uploads/` (local playtesting). **On Vercel the 4.5 MB body limit** means Android segments must go via Blob client upload (`/api/upload`) + JSON `{url}` to the same endpoints — Android client change still TODO.
- **Raw audio deletion**: after the PDF stage, segment files are deleted and URLs nulled (`DELETE_RAW_AUDIO=true` default).
- Gemini: default `gemini-3.5-flash` (2.5-flash is closed to new keys), fallbacks on 503 via `GEMINI_FALLBACK_MODELS`, retry with backoff.

Full job script: `scripts/mock-job.sh [base] [audio] [context.pdf] [slides.pdf]` — see TEST.md.
