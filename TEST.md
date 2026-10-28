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
