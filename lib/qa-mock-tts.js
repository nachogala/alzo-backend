// QA mock TTS kill switch
//
// Detects QA / Maestro / internal test requests and short-circuits the
// ElevenLabs voice path with a static silent MP3. Saves quota and keeps
// CI/QA runs from burning paid characters.
//
// Detection (ANY match → mock):
//   1. user.email matches QA_EMAIL_PATTERNS
//   2. request header  X-Internal-Build: 1
//   3. env QA_USE_MOCK_TTS=true  (force-on for staging)
//
// Real responses keep the same shape:
//   { audioUrl, durationMs, cloneMode: "mock" }
//
// Public URL is served by express.static("public") in server.js.

const MOCK_AUDIO_URL = process.env.MOCK_AUDIO_URL || "/qa-mock.mp3";
const MOCK_DURATION_MS = 1000; // 1s silence

// Email patterns are AUTHORITATIVE — grepped from
// ~/Projects/alzo-app-v2/.maestro/flows/ on 2026-05-17:
//   qa-day1-, qa-day2-, qa-day3-, qa-weekly-, qa-item3-  → ...@thenetmencorp.com
//   e2e+test@alzo.app
// Plus prefixes (Joaquín spec) constrained to avoid false-positives against
// internal voice-flow regression fixtures that use plain `qa-<timestamp>@...`:
//   qa-day<N>, qa-weekly, qa-item<N>, qa-throwaway, maestro, throwaway, e2e+
// NOTE: bare `qa-` / `qa_` / `test` / `test-` are NOT matched — the legacy
// regression suite (__tests__/voice-flow.test.js) seeds users with those
// prefixes and expects the real voice path. New Maestro flows MUST use one
// of the namespaced prefixes above OR send the X-Internal-Build:1 header.
const QA_EMAIL_RX = /^(qa-day\d+|qa-weekly|qa-item\d+|qa-throwaway|maestro|throwaway|e2e)[-_+.]/i;
const QA_DOMAIN_RX = /@(maestro\.local|qa\.alzo\.app)$/i;

function isQaEmail(email) {
  if (!email || typeof email !== "string") return false;
  const e = email.trim().toLowerCase();
  if (QA_DOMAIN_RX.test(e)) return true;
  // Local-part check — match prefix patterns.
  const local = e.split("@")[0] || "";
  return QA_EMAIL_RX.test(local);
}

function isInternalBuildHeader(req) {
  if (!req || !req.headers) return false;
  const h = req.headers["x-internal-build"];
  return h === "1" || h === 1 || h === true || h === "true";
}

function isMockForced() {
  const v = (process.env.QA_USE_MOCK_TTS || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Decide whether to serve a mock for this request.
 * @param {object} req - express req
 * @param {object|null} user - row from getUserByToken or null
 * @returns {{mock: boolean, reason: string|null}}
 */
function shouldServeMock(req, user) {
  if (isMockForced()) return { mock: true, reason: "env_QA_USE_MOCK_TTS" };
  if (isInternalBuildHeader(req)) return { mock: true, reason: "header_X-Internal-Build" };
  const email = user && user.email ? user.email : null;
  if (email && isQaEmail(email)) return { mock: true, reason: "qa_email_pattern" };
  return { mock: false, reason: null };
}

/**
 * Build the mock response payload. Logs to stdout once per request.
 */
function buildMockResponse({ user, reason, affirmationText }) {
  const tag = user && user.email ? user.email : "no-user";
  // eslint-disable-next-line no-console
  console.log(`[TTS-MOCK] served mock for qa user ${tag} reason=${reason}`);
  const base = {
    audioUrl: MOCK_AUDIO_URL,
    durationMs: MOCK_DURATION_MS,
    cloneMode: "mock",
  };
  if (typeof affirmationText === "string") base.affirmationText = affirmationText;
  return base;
}

module.exports = {
  shouldServeMock,
  buildMockResponse,
  isQaEmail,
  MOCK_AUDIO_URL,
  MOCK_DURATION_MS,
};
