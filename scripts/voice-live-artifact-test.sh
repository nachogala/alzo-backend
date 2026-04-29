#!/usr/bin/env bash
set -euo pipefail

API="${ALZO_API_BASE_URL:-https://alzo-backend-production.up.railway.app}"
SOURCE_AUDIO="${1:-${ALZO_VOICE_SOURCE_AUDIO:-}}"
EXPECT_SAMPLES="${ALZO_EXPECT_SAMPLE_COUNT:-4}"
OUT_ROOT="${ALZO_VOICE_QA_OUT:-/tmp/alzo-voice-live-artifacts}"
RUN_ID="voice-live-$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_ROOT/$RUN_ID"

if [ -z "$SOURCE_AUDIO" ]; then
  echo "usage: $0 /path/to/source-voice-audio" >&2
  echo "or set ALZO_VOICE_SOURCE_AUDIO=/path/to/source-voice-audio" >&2
  exit 2
fi
if [ ! -f "$SOURCE_AUDIO" ]; then
  echo "source audio not found: $SOURCE_AUDIO" >&2
  exit 2
fi
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 2; }
command -v ffprobe >/dev/null || { echo "ffprobe is required" >&2; exit 2; }
command -v node >/dev/null || { echo "node is required" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

mkdir -p "$OUT/samples"

for i in 1 2 3 4; do
  start=$(( (i - 1) * 12 ))
  ffmpeg -hide_banner -loglevel error -y -i "$SOURCE_AUDIO" -ss "$start" -t 8 -c:a aac -b:a 96k "$OUT/samples/q$i.m4a"
done

EMAIL="voice-live-$(date +%s)-$RANDOM@example.com"
PASS="VoiceLive2026!"

curl -sS -D "$OUT/signup.headers" -o "$OUT/signup.raw.json" \
  -X POST "$API/api/auth/signup" \
  -H 'Content-Type: application/json' \
  --data "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"name\":\"Voice Live QA\"}"

TOKEN=$(node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(!j.token) throw new Error('signup failed '+JSON.stringify(j)); process.stdout.write(j.token)" "$OUT/signup.raw.json")
node - <<'NODE' "$OUT/signup.raw.json" "$OUT/signup-redacted.json"
const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.writeFileSync(process.argv[3], JSON.stringify({ signupStatus: j.token ? 'ok' : 'failed', trialEndsAt: Boolean(j.trialEndsAt) }, null, 2));
NODE

curl -sS -D "$OUT/onboarding.headers" -o "$OUT/onboarding.raw.json" \
  -X POST "$API/api/onboarding" \
  -H "Authorization: Bearer $TOKEN" \
  -F language=en-US \
  -F 'answerMeta={"qa":"live-voice-artifact-test"}' \
  -F q1=@"$OUT/samples/q1.m4a"';type=audio/m4a' \
  -F q2=@"$OUT/samples/q2.m4a"';type=audio/m4a' \
  -F q3=@"$OUT/samples/q3.m4a"';type=audio/m4a' \
  -F q4=@"$OUT/samples/q4.m4a"';type=audio/m4a'

SESSION=$(node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(!j.sessionId) throw new Error('onboarding failed '+JSON.stringify(j)); if(!j.voiceReady) throw new Error('voiceReady false '+JSON.stringify(j.voiceDebug)); process.stdout.write(j.sessionId)" "$OUT/onboarding.raw.json")
node - <<'NODE' "$OUT/onboarding.raw.json" "$OUT/onboarding-redacted.json"
const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
delete j.sessionId;
if (j.voiceDebug) j.voiceDebug.sampleFiles = (j.voiceDebug.sampleFiles || []).map(() => '[sample-file]');
fs.writeFileSync(process.argv[3], JSON.stringify(j, null, 2));
NODE

curl -sS -D "$OUT/generate.headers" -o "$OUT/generate.raw.json" \
  -X POST "$API/api/generate-affirmation" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  --data "{\"context\":{\"intro\":\"Voice live QA focused on ALZO\",\"bigGoal\":\"make ALZO voice cloning sound personal and premium\",\"weekFocus\":\"prove the deployed clone path uses all samples\",\"whyItMatters\":\"users trust their own voice\"},\"sessionId\":\"$SESSION\",\"language\":\"en-US\",\"detectedGender\":\"male\"}"

node - <<'NODE' "$OUT/generate.raw.json" "$EXPECT_SAMPLES" "$OUT/generate-redacted.json"
const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = Number(process.argv[3]);
const summary = { affirmationText: j.affirmationText, audioUrl: j.audioUrl, voiceDebug: j.voiceDebug };
fs.writeFileSync(process.argv[4], JSON.stringify(summary, null, 2));
if (j.voiceDebug?.cloneMode !== 'cloned') throw new Error(`expected cloneMode=cloned, got ${j.voiceDebug?.cloneMode}`);
if (Number(j.voiceDebug?.sampleCount) !== expected) throw new Error(`expected sampleCount=${expected}, got ${j.voiceDebug?.sampleCount}`);
if (!j.audioUrl) throw new Error('missing audioUrl');
NODE

AUDIO_URL=$(node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(j.audioUrl.startsWith('http') ? j.audioUrl : '$API' + j.audioUrl)" "$OUT/generate.raw.json")
curl -sS -D "$OUT/generated-audio.headers" -L "$AUDIO_URL" -o "$OUT/generated-clone.mp3"
ffprobe -hide_banner -v error -show_format -show_streams "$OUT/generated-clone.mp3" > "$OUT/generated-clone.ffprobe.txt"

{
  echo "OUT=$OUT"
  echo "API=$API"
  echo "cloneMode=cloned"
  echo "sampleCount=$EXPECT_SAMPLES"
  echo "generatedAudio=$OUT/generated-clone.mp3"
  ffprobe -hide_banner -v error -show_entries format=duration,size,bit_rate -of default=nw=1 "$OUT/generated-clone.mp3"
} | tee "$OUT/summary.txt"
