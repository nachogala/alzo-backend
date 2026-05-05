// backend/voice_telemetry.js
// Server-side voice-pipeline telemetry. Mirror of the RN helper.
// Locked by vault policy: vault-studio2/policies/voice-quality-assurance.md

const Sentry = require('@sentry/node');
const crypto = require('crypto');

const VOICE_STEPS = Object.freeze({
  UPLOAD_RECEIVED: 'upload_received',
  CAPA1_PASS: 'capa1_pass',
  CAPA1_FAIL: 'capa1_fail',
  CAPA2_PASS: 'capa2_pass',
  CAPA2_FAIL: 'capa2_fail',
  CLONE_REQUEST: 'clone_request',
  CLONE_RESPONSE: 'clone_response',
  CLONE_ERROR: 'clone_error',
  SLOT_USED: 'slot_used',
  SLOT_FULL: 'slot_full',
  GENERATE_REQUEST: 'generate_request',
  GENERATE_RESPONSE: 'generate_response',
  GENERATE_ERROR: 'generate_error',
  HEALTH_CHECK: 'health_check',
});

function hashUserId(userId) {
  if (!userId) return null;
  return 'u_' + crypto.createHash('sha1').update(String(userId)).digest('hex').slice(0, 12);
}

/**
 * trackVoiceStep — server-side
 * @param {string} step — one of VOICE_STEPS
 * @param {object} opts { journeyId, userId, success, errorCode, elapsedMs, extra }
 */
function trackVoiceStep(step, opts = {}) {
  const journeyId = opts.journeyId || 'no_journey';
  const payload = {
    step,
    journey_id: journeyId,
    user_id_hash: hashUserId(opts.userId),
    timestamp: Date.now(),
    elapsed_ms: opts.elapsedMs ?? null,
    success: opts.success,
    error_code: opts.errorCode || null,
    ...(opts.extra || {}),
  };

  console.log(`[voice_pipeline] ${JSON.stringify(payload)}`);

  Sentry.withScope((scope) => {
    scope.setTag('voice_pipeline_step', step);
    scope.setTag('journey_id', journeyId);
    if (opts.errorCode) scope.setTag('error_code', opts.errorCode);

    Sentry.addBreadcrumb({
      category: 'voice_pipeline',
      level: opts.success === false ? 'error' : 'info',
      message: step,
      data: payload,
    });

    if (opts.success === false || step.endsWith('_fail') || step.endsWith('_error') || step === VOICE_STEPS.SLOT_FULL) {
      Sentry.captureMessage(`voice_pipeline.${step}`, {
        level: 'error',
        tags: { voice_pipeline_step: step, journey_id: journeyId },
        extra: payload,
      });
    }
  });
}

module.exports = { trackVoiceStep, VOICE_STEPS, hashUserId };
