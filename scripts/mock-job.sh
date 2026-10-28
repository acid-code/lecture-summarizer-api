#!/usr/bin/env bash
# Full job against the /v1 (Android) contract. Usage: scripts/mock-job.sh [base_url] [audio_file] [context_pdf] [slides_pdf]
# Works with the mock provider (no GEMINI_API_KEY) or Gemini. Needs curl + jq.
set -euo pipefail
B=${1:-http://localhost:3000}/v1; AUDIO=${2:-}; CTX=${3:-}; SLIDES=${4:-}
H=(); [ -n "${API_TOKEN:-}" ] && H=(-H "Authorization: Bearer $API_TOKEN")
curl -sf "$B/health"; echo
C=$(curl -sf "${H[@]}" -XPOST "$B/courses" -H 'content-type: application/json' -d '{"name":"Intro ML","lang_primary":"he"}' | jq -r .course_id)
L=$(curl -sf "${H[@]}" -XPOST "$B/lectures" -H 'content-type: application/json' -d "{\"course_id\":\"$C\",\"title\":\"Lecture 1\",\"recorded_at\":\"2026-10-28T10:00:00Z\"}" | jq -r .lecture_id)
echo "course=$C lecture=$L"
[ -n "$CTX" ] && curl -sf "${H[@]}" -XPOST "$B/lectures/$L/context" -F "file=@$CTX;type=application/pdf" && echo
[ -n "$SLIDES" ] && curl -sf "${H[@]}" -XPOST "$B/lectures/$L/slides" -F "file=@$SLIDES;type=application/pdf" && echo
if [ -n "$AUDIO" ]; then
  curl -sf "${H[@]}" -XPOST "$B/lectures/$L/audio/segments" -F seq=0 -F started_at=2026-10-28T10:00:00Z -F duration=5 -F "file=@$AUDIO;type=audio/wav"; echo
fi
curl -sf "${H[@]}" -XPOST "$B/lectures/$L/markers" -H 'content-type: application/json' -d '[{"t_sec":12,"page":2,"label":"important"}]'; echo
J=$(curl -sf "${H[@]}" -XPOST "$B/lectures/$L/process" -H 'content-type: application/json' -d '{"options":{"asr":"cloud"}}' | jq -r .job_id)
for i in $(seq 1 20); do   # each poll runs one stage (AUTO_ADVANCE_ON_POLL)
  S=$(curl -sf "${H[@]}" "$B/jobs/$J"); echo "$S" | jq -c '{state,stage,progress,error}'
  st=$(echo "$S" | jq -r .state); [ "$st" = done ] || [ "$st" = failed ] && break
done
curl -sf "${H[@]}" "$B/lectures/$L/summary.json" | jq '{repairs, summary: .summary.title}'
curl -s "${H[@]}" -o /tmp/summary.pdf -w 'summary.pdf HTTP %{http_code} %{content_type}\n' "$B/lectures/$L/summary.pdf"
