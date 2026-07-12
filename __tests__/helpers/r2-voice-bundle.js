'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

const CAPTURE_ORDER = ['goal', 'purpose', 'reconnectionAnchor', 'commitment'];
let cachedAudio;

function validR2AudioBuffer() {
  if (cachedAudio) return Buffer.from(cachedAudio);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alzo-r2-audio-'));
  const file = path.join(dir, 'capture.m4a');
  execFileSync(ffmpegStatic, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10.1',
    '-c:a', 'aac', '-b:a', '64k', file,
  ]);
  cachedAudio = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return Buffer.from(cachedAudio);
}

function provenanceFor(bundleId) {
  return {
    schemaVersion: 'alzo.voice_provenance.r2.v1',
    bundleId,
    requiredCaptureKeys: CAPTURE_ORDER,
    captures: CAPTURE_ORDER.map((stage, index) => ({
      stage,
      captureId: `${bundleId}_capture_${index + 1}`,
      voiceAttemptId: `${bundleId}_attempt_${index + 1}`,
      signalClass: 'human_voice_detected',
      validAudioDurationMs: 10100,
      sha256: 'a'.repeat(64),
    })),
  };
}

async function uploadR2VoiceBundle({ request, baseUrl, token, audioBuffer = validR2AudioBuffer() }) {
  const bundleId = `r2_bundle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const productProvenance = provenanceFor(bundleId);
  const voiceAttemptIds = productProvenance.captures.map((item) => item.voiceAttemptId);
  const voiceProcessingPayload = {
    schemaVersion: 'alzo.voice_processing_payload.r2.v1',
    productProvenance,
    files: CAPTURE_ORDER.map((stage, index) => ({
      stage,
      partName: `voice_${index + 1}_${stage}`,
      filename: `${stage}.m4a`,
      mediaType: 'audio/mp4',
    })),
  };

  const response = await request(baseUrl)
    .post('/api/onboarding/voice-bundle')
    .set('Authorization', `Bearer ${token}`)
    .set('x-correlation-id', bundleId)
    .field('schemaVersion', 'alzo.pre_account_voice_bundle.r2.v1')
    .field('language', 'en-US')
    .field('bundleId', bundleId)
    .field('preAccountVoiceBundle', JSON.stringify({ schemaVersion: 'alzo.pre_account_voice_bundle.r2.v1', bundleId }))
    .field('voiceProcessingPayload', JSON.stringify(voiceProcessingPayload))
    .field('productProvenance', JSON.stringify(productProvenance))
    .field('semanticCaptureOrder', JSON.stringify(CAPTURE_ORDER))
    .field('voiceAttemptIds', JSON.stringify(voiceAttemptIds))
    .attach('voice_1_goal', audioBuffer, { filename: 'goal.m4a', contentType: 'audio/mp4' })
    .attach('voice_2_purpose', audioBuffer, { filename: 'purpose.m4a', contentType: 'audio/mp4' })
    .attach('voice_3_reconnectionAnchor', audioBuffer, { filename: 'reconnectionAnchor.m4a', contentType: 'audio/mp4' })
    .attach('voice_4_commitment', audioBuffer, { filename: 'commitment.m4a', contentType: 'audio/mp4' });
  if (response.status !== 200) console.log('R2 bundle helper failure', response.status, response.body);
  return response;
}

function r2SemanticContext(overrides = {}) {
  return {
    goal: 'I will finish and launch the prototype.',
    purpose: 'This matters because it supports my family and the work I chose.',
    reconnectionAnchor: 'When it gets difficult, I remember why I chose to begin.',
    currentState: { mood: 'steady', energy: 7, alignment: 'I feel connected and willing to continue.' },
    firstMessageReference: { id: 'first_message_test', treatedSeparately: true },
    recentDailyMessages: [],
    ...overrides,
  };
}

module.exports = {
  CAPTURE_ORDER,
  r2SemanticContext,
  uploadR2VoiceBundle,
  validR2AudioBuffer,
};
