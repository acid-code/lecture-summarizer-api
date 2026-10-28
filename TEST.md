# Playtesting

```bash
npm install && npm run dev            # http://localhost:3000
```
Schema changed? There are no migrations yet — `rm data/local.db` (gitignored) and restart.

## Mock (no key)
Leave `GEMINI_API_KEY` empty (`GEMINI_API_KEY= npm run dev`), then:
```bash
scripts/mock-job.sh http://localhost:3000                                   # minimal
scripts/mock-job.sh http://localhost:3000 sample.wav course-pack.pdf slides.pdf  # all uploads
```
Prints each poll (`queued→asr→repair→summary→pdf→done`), the repair edit list, and saves `/tmp/summary.pdf`.

## Gemini
Put `GEMINI_API_KEY=...` in `.env` / `.env.local` (gitignored) and restart. Use a **tiny synthetic** clip, never a real lecture:
```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -ar 16000 tone.wav   # no-speech smoke test
# Spoken sample: Gemini TTS (gemini-3.8-flash-tts) reading a short He/En sentence → wav (see git history of this file).
scripts/mock-job.sh http://localhost:3000 sample.wav course-pack.pdf slides.pdf
```
Verified 2026-10-28 with a 9 s synthetic Hebrew TTS clip: ASR wrote English terms in Latin script, summary cited the
course-pack excerpt (chain rule), PDF rendered via Chrome, raw segment deleted. Direct repair test on a transliterated
transcript ("דיפ לרנינג", "בק פרופגיישן", …) returned 4 correct edits with slide evidence.

Gotchas seen: `gemini-2.5-flash` 404 for new keys; `gemini-flash-latest` / `gemini-3.8-flash` frequent 503 → fallbacks + retry.
Large Files API uploads hung once ("fetch failed") → small files now go inline.

## PDF renderer paths
- Box default: system Chrome. Simulate Vercel locally with `PDF_RENDERER=sparticuz npm start` (unpacks `@sparticuz/chromium` to `/tmp/chromium`).
- Check font embedding: `pdffonts /tmp/summary.pdf` → `IBMPlexSansHebrew-Regular/Bold … emb yes`.
- Tested 2026-10-28 (mock provider): both paths → `summary.pdf HTTP 200 application/pdf`, Hebrew font embedded.

## Large uploads on Vercel (Blob)
```bash
B=https://<deploy>.vercel.app/v1; H=(-H "authorization: Bearer $API_TOKEN")
R=$(curl -s "${H[@]}" -XPOST $B/uploads -H 'content-type: application/json' -d '{"filename":"seg0.m4a","content_type":"audio/mp4"}')
# mode=blob → PUT the bytes with the returned headers
args=(); for k in $(echo "$R" | jq -r '.headers|keys[]'); do args+=(-H "$k: $(echo "$R" | jq -r --arg k "$k" '.headers[$k]')"); done
URL=$(curl -s -XPUT "${args[@]}" --data-binary @seg0.m4a "$(echo "$R" | jq -r .put_url)" | jq -r .url)
curl -s "${H[@]}" -XPOST $B/lectures/$L/audio/segments -H 'content-type: application/json' -d "{\"seq\":0,\"duration\":300,\"mime\":\"audio/mp4\",\"url\":\"$URL\"}"
```
(`duration` is seconds.) Same JSON `{url}` for `/lectures/{id}/slides` and `/lectures/{id}/context`. Locally (no Blob token) `/v1/uploads` → `{"mode":"multipart"}`; keep using `-F file=@...`.
Not yet tested against a real Blob store (no token on the box).

## Retrying a failed job (e.g. Gemini 503)

```bash
B=http://localhost:3000/v1; J=<job_id>
curl -s $B/jobs/$J?advance=0 | jq '{state,stage,error}'   # state: failed, error: "summary: ... 503 ..."
curl -s -XPOST $B/jobs/$J/retry | jq '{state,stage,error}' # 202, stage: summary (first incomplete), error: null
curl -s $B/jobs/$J | jq .stage                              # polling continues; ASR/repair are NOT redone
curl -s -XPOST $B/jobs/$J/retry                             # on a done/running job → 409 (use ?force=1 for running)
```
Stuck jobs (no update for `JOB_STUCK_MS`, default 10 min) are retryable too. Gemini retry knobs: `GEMINI_RETRIES` (5), `GEMINI_RETRY_BUDGET_MS` (90000).
