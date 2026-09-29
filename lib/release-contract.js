'use strict';

const WIRE_CONTRACT_VERSION = 'alzo.mobile-backend.v3';

const VOICE_MULTIPART_FIELDS = Object.freeze({
  goal: 'voice_1_goal',
  purpose: 'voice_2_purpose',
  reconnectionAnchor: 'voice_3_reconnectionAnchor',
  commitment: 'voice_4_commitment',
});

// v2 sync (2026-09-25): per-capture floor raised 7s -> 10s so the four
// per-step minimums sum to the 40s ElevenLabs aggregate. The backend only
// enforces the aggregate; the per-step floor is enforced by the mobile UI.
const VOICE_DURATION_RULE = Object.freeze({
  version: 'alzo.voice-duration.aggregate-40s.v2',
  captureCount: 4,
  minimumPerCaptureSeconds: 10,
  minimumAggregateSeconds: 40,
  maximumPerCaptureSeconds: 90,
  authority: 'UI_MOBILE_BACKEND_QA_PHYSICAL',
});

module.exports = {
  WIRE_CONTRACT_VERSION,
  VOICE_MULTIPART_FIELDS,
  VOICE_DURATION_RULE,
};
