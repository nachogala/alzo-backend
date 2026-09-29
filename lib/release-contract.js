'use strict';

const WIRE_CONTRACT_VERSION = 'alzo.mobile-backend.v3';

const VOICE_MULTIPART_FIELDS = Object.freeze({
  goal: 'voice_1_goal',
  purpose: 'voice_2_purpose',
  reconnectionAnchor: 'voice_3_reconnectionAnchor',
  commitment: 'voice_4_commitment',
});

// v3 sync (2026-09-29): per-capture floor is a silent 4s sanity gate on the
// mobile side (v2's 10s floor rejected natural answers -- the Build 47
// product error). The backend only enforces the aggregate (40s, unchanged).
const VOICE_DURATION_RULE = Object.freeze({
  version: 'alzo.voice-duration.aggregate-40s.v3',
  captureCount: 4,
  minimumPerCaptureSeconds: 4,
  minimumAggregateSeconds: 40,
  maximumPerCaptureSeconds: 90,
  authority: 'UI_MOBILE_BACKEND_QA_PHYSICAL',
});

module.exports = {
  WIRE_CONTRACT_VERSION,
  VOICE_MULTIPART_FIELDS,
  VOICE_DURATION_RULE,
};
