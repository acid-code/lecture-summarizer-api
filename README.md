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

## API

All routes accept `Authorization: Bearer $API_TOKEN` (auth stub; disabled if `API_TOKEN` is empty).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | provider + blob status |
| GET/POST | `/api/courses` | list / create `{name, contextPdfUrl?}` |
| GET/POST | `/api/courses/{courseId}/lectures` | list / create `{title, audioUrl?, slidesUrl?}` |
| GET/PATCH | `/api/lectures/{lectureId}` | read (with jobs) / attach `{audioUrl?, slidesUrl?}` after upload |
| POST | `/api/lectures/{lectureId}/process` | create a queued job |
| GET | `/api/jobs/{jobId}` | status + artifacts |
| POST | `/api/jobs/{jobId}/advance` | run the next stage |
| POST | `/api/upload` | Vercel Blob client-upload token route |

Client upload example:
```ts
import { upload } from "@vercel/blob/client";
const blob = await upload(file.name, file, {
  access: "public", handleUploadUrl: "/api/upload", multipart: true,
  clientPayload: JSON.stringify({ token: API_TOKEN }),
});
await fetch(`/api/lectures/${id}`, { method: "PATCH", body: JSON.stringify({ audioUrl: blob.url }) });
```

## What's real vs stubbed
- **Real:** CRUD for courses/lectures/jobs, stage machine, Blob client-upload route, Gemini ASR (Files API upload of audio + slides as context) and summary with JSON output, RTL HTML study document with LTR-isolated English terms.
- **Stubbed / TODO:**
  - `repair` stage — the core He/En code-switch term repair (edits with evidence from slides + course glossary/context PDF) returns `[]` for Gemini.
  - PDF: the `pdf` stage emits print-ready RTL **HTML**; real PDF via **typst-wasm** from `templates/study.typ` is TODO (fonts must be bundled).
  - Course context PDF is stored but not yet used in prompts. PPTX → PDF conversion not handled (Gemini may not accept PPTX — verify).
  - Gemini Files API upload buffers the whole file in function memory (fine for ≤~100 MB on 2 GB; verify) and must finish within 300 s; long lectures may need splitting or Workflows.
  - Auth is a shared token; audio auto-delete after processing is not implemented yet; Blob objects are public-with-random-suffix.

## Privacy
Public repo: never commit keys, `.env*`, or lecture audio (gitignored). Get the lecturer's OK before recording.
