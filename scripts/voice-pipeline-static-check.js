#!/usr/bin/env node
const fs = require('fs');

const files = {
  server: fs.readFileSync('server.js', 'utf8'),
  liveHarness: fs.readFileSync('scripts/voice-live-artifact-test.sh', 'utf8'),
};

const checks = [
  [files.server, 'persistedVoiceFiles = allVoiceFiles.map', 'onboarding persists every uploaded voice sample'],
  [files.server, 'JSON.stringify(persistedVoiceFiles)', 'voice manifest points to retained files'],
  [files.server, 'voice_user_${voiceOwnerId}_${sessionId}.m4a', 'onboarding writes user-scoped retained sample'],
  [files.server, 'f.startsWith(`voice_user_${safeUserId}_`)', 'daily fallback prefers authenticated user sample'],
  [files.server, 'voiceCandidate = userVoiceCandidates[0] || legacyVoiceCandidates[0]', 'daily fallback keeps legacy compatibility only after user sample'],
  [files.server, 'app.get("/api/health/voice", async (req, res) => {', 'voice health endpoint exists'],
  [files.server, '`${ELEVENLABS_BASE}/voices/${cachedVoiceId}`', 'voice health probes provider voice id'],
  [files.server, 'status: "stale"', 'voice health exposes stale cached voice state'],
  [files.server, "tags: { area: 'voice_upload', endpoint: 'onboarding' }", 'onboarding failures captured to Sentry'],
  [files.server, "tags: { area: 'voice_clone', endpoint: 'generate_affirmation' }", 'first output voice failures captured to Sentry'],
  [files.server, "tags: { area: 'voice_daily', endpoint: 'affirmation_today' }", 'daily voice failures captured to Sentry'],
  [files.server, 'version: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unknown"', 'health endpoint exposes deploy version'],
  [files.server, 'startedAt: goal.startedAt || goal.startDate || goal.createdAt || null', 'goals API aliases canonical startDate to startedAt'],
  [files.liveHarness, 'ALZO_API_BASE_URL', 'live artifact harness supports configurable API base'],
  [files.liveHarness, 'type=audio/m4a', 'live artifact harness sends app-like audio MIME'],
  [files.liveHarness, 'cloneMode=cloned', 'live artifact harness asserts cloned mode'],
  [files.liveHarness, 'expected sampleCount=${expected}', 'live artifact harness asserts expected sample count'],
  [files.liveHarness, 'generated-clone.ffprobe.txt', 'live artifact harness writes ffprobe artifact'],
];

let failed = 0;
for (const [body, needle, label] of checks) {
  if (body.includes(needle)) console.log(`✓ ${label}`);
  else { console.error(`✗ ${label} — missing ${needle}`); failed++; }
}
process.exit(failed ? 1 : 0);
