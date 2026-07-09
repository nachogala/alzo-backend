/**
 * Contract coverage for Build 21 backend gap:
 *   POST /api/onboarding/voice-bundle
 *
 * The mobile contract sends four semantic captures:
 *   goal, purpose, resistance, commitmentReading
 * with voiceAttemptId/session correlation and product provenance. This test
 * proves the backend route accepts that contract, persists all 4 samples under
 * one session manifest, and returns a receipt compatible with the first-message
 * generation handoff.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const { execFileSync } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

const {
  MockAgent,
  setGlobalDispatcher,
  fetch: undiciFetch,
  Headers: UndiciHeaders,
  Request: UndiciRequest,
  Response: UndiciResponse,
  FormData: UndiciFormData,
} = require('undici');
const request = require('supertest');

// Force undici fetch so MockAgent intercepts server.js transcription calls.
globalThis.fetch = undiciFetch;
globalThis.Headers = UndiciHeaders;
globalThis.Request = UndiciRequest;
globalThis.Response = UndiciResponse;
globalThis.FormData = UndiciFormData;

const sentryStub = require('./__mocks__/sentry-stub');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'alzo-voice-bundle-'));
const TEST_DB = path.join(TEST_ROOT, 'alzo.db');
const TEST_UPLOADS = path.join(TEST_ROOT, 'uploads');
const TEST_AUDIO = path.join(TEST_ROOT, 'audio');

function pickFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let serverHarness;
let mockAgent;
let elevenState;

function mockAgentSetup() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect((host) => /^(127\.0\.0\.1|localhost)/.test(host));
  setGlobalDispatcher(agent);
  return agent;
}

function installOpenAIMock(agent) {
  const pool = agent.get('https://api.openai.com');
  pool
    .intercept({ path: '/v1/audio/transcriptions', method: 'POST' })
    .reply(200, { text: 'I choose the work, remember the purpose, face resistance, and commit out loud.' })
    .persist();
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, {
      choices: [{ message: { content: 'unknown' } }],
    })
    .persist();
}

function audioResponseBuffer() {
  return Buffer.from('/+MYxAAAAANIAAAAAExBTUUzLjk5cgQAAAAAAAAAABRAJAaUQAAQAAAAEi4i', 'base64');
}

function installElevenLabsMock(agent) {
  const pool = agent.get('https://api.elevenlabs.io');
  const state = { cloneCalls: 0, ttsCalls: 0, lastCloneVoiceId: null };
  pool
    .intercept({ path: '/v1/voices/add', method: 'POST' })
    .reply(200, () => {
      state.cloneCalls += 1;
      state.lastCloneVoiceId = `voice_bundle_clone_${state.cloneCalls}`;
      return { voice_id: state.lastCloneVoiceId };
    })
    .persist();
  pool
    .intercept({ path: /^\/v1\/text-to-speech\/[^/]+/, method: 'POST' })
    .reply(() => {
      state.ttsCalls += 1;
      return {
        statusCode: 200,
        data: audioResponseBuffer(),
        responseOptions: { headers: { 'content-type': 'audio/mpeg' } },
      };
    })
    .persist();
  pool
    .intercept({ path: /^\/v1\/voices\/[^/]+$/, method: 'DELETE' })
    .reply(200, { ok: true })
    .persist();
  return state;
}

async function bootServer() {
  if (serverHarness) {
    await serverHarness.close();
    serverHarness = null;
  }
  fs.rmSync(TEST_UPLOADS, { recursive: true, force: true });
  fs.rmSync(TEST_AUDIO, { recursive: true, force: true });
  fs.mkdirSync(TEST_UPLOADS, { recursive: true });
  fs.mkdirSync(TEST_AUDIO, { recursive: true });
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

  const backendRoot = path.resolve(__dirname, '..');
  const port = await pickFreePort();

  process.env.DB_PATH = TEST_DB;
  process.env.UPLOAD_STORAGE_DIR = TEST_UPLOADS;
  process.env.AUDIO_STORAGE_DIR = TEST_AUDIO;
  process.env.PORT = String(port);
  process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.SENTRY_DSN = '';
  process.env.NODE_ENV = 'test';

  sentryStub._reset();
  jest.resetModules();
  jest.doMock('../backend/voice_validator', () => ({
    validateInputSample: jest.fn(async () => ({ ok: true, soft: false, duration: 4.2, peak: 0.3 })),
    validateTtsRender: jest.fn(async () => ({ ok: true, soft: false, duration: 5.1, peak: 0.25 })),
    analyzeFile: jest.fn(async () => ({ ok: true, reason: null, duration: 4.2, peak: 0.3 })),
    decoderAvailable: jest.fn(() => true),
    THRESHOLDS: { MIN_INPUT_DURATION_S: 3, MIN_TTS_DURATION_S: 4, MIN_PEAK_AMPLITUDE: 0.05 },
  }));

  const before = new Set(
    process._getActiveHandles().filter((h) => h && h.constructor && h.constructor.name === 'Server')
  );
  require(path.join(backendRoot, 'server.js'));

  const deadline = Date.now() + 8000;
  let bound = false;
  while (Date.now() < deadline) {
    bound = await new Promise((r) => {
      const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.end(); r(true); });
      s.on('error', () => r(false));
    });
    if (bound) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!bound) throw new Error(`server failed to bind on 127.0.0.1:${port}`);

  const after = process._getActiveHandles().filter((h) => h && h.constructor && h.constructor.name === 'Server');
  const newServer = after.find((h) => !before.has(h));
  serverHarness = {
    port,
    close: () => new Promise((resolve) => {
      if (newServer && typeof newServer.close === 'function') {
        try { newServer.close(() => resolve()); } catch { resolve(); }
        setTimeout(resolve, 1000);
      } else {
        resolve();
      }
    }),
  };
  return serverHarness;
}

function url() {
  return `http://127.0.0.1:${serverHarness.port}`;
}


let fixtureAudioBuffer;
function audioBuffer() {
  if (fixtureAudioBuffer) return Buffer.from(fixtureAudioBuffer);
  const fixturePath = path.join(TEST_AUDIO, 'fixture-voice-sample.m4a');
  fs.mkdirSync(TEST_AUDIO, { recursive: true });
  execFileSync(ffmpegStatic, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1.25',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    fixturePath,
  ]);
  fixtureAudioBuffer = fs.readFileSync(fixturePath);
  return Buffer.from(fixtureAudioBuffer);
}

async function registerUser() {
  const email = `voice-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@thenetmencorp.com`;
  const res = await request(url())
    .post('/api/auth/signup')
    .send({ email, password: 'test-pass-1234', name: 'Voice Bundle QA' })
    .set('Content-Type', 'application/json');
  return { email, token: res.body?.token, status: res.status };
}

beforeEach(async () => {
  mockAgent = mockAgentSetup();
  installOpenAIMock(mockAgent);
  elevenState = installElevenLabsMock(mockAgent);
  await bootServer();
});

afterEach(async () => {
  if (serverHarness) await serverHarness.close();
  serverHarness = null;
  await mockAgent?.close();
  jest.dontMock('../backend/voice_validator');
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('POST /api/onboarding/voice-bundle', () => {
  it('accepts the Build 21 four-capture contract and preserves provenance/session correlation', async () => {
    const { token, status } = await registerUser();
    expect(status).toBe(200);
    expect(token).toBeTruthy();

    const bundleId = 'bundle_test_123';
    const voiceAttemptIds = [
      'attempt_goal_1',
      'attempt_purpose_2',
      'attempt_resistance_3',
      'attempt_commitment_4',
    ];
    const semanticCaptureOrder = ['goal', 'purpose', 'resistance', 'commitmentReading'];
    const productProvenance = {
      build: 21,
      source: 'alzo3-pre-account-voice-bundle',
      requiredCaptureKeys: semanticCaptureOrder,
    };
    const voiceProcessingPayload = {
      schemaVersion: 'pre_account_voice_bundle.v1',
      productProvenance,
      files: semanticCaptureOrder.map((stage, index) => ({
        stage,
        partName: `voice_${index + 1}_${stage}`,
        filename: `${stage}.m4a`,
        mediaType: 'audio/mp4',
      })),
      account: { authSessionId: 'auth_session_123' },
    };

    const res = await request(url())
      .post('/api/onboarding/voice-bundle')
      .set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'req_voice_bundle_test')
      .set('x-correlation-id', bundleId)
      .field('schemaVersion', 'pre_account_voice_bundle.v1')
      .field('language', 'en-US')
      .field('bundleId', bundleId)
      .field('preAccountVoiceBundle', JSON.stringify({ bundleId, captures: {} }))
      .field('voiceProcessingPayload', JSON.stringify(voiceProcessingPayload))
      .field('productProvenance', JSON.stringify(productProvenance))
      .field('semanticCaptureOrder', JSON.stringify(semanticCaptureOrder))
      .field('voiceAttemptIds', JSON.stringify(voiceAttemptIds))
      .attach('voice_1_goal', audioBuffer(), { filename: 'goal.m4a', contentType: 'audio/mp4' })
      .attach('voice_2_purpose', audioBuffer(), { filename: 'purpose.m4a', contentType: 'audio/mp4' })
      .attach('voice_3_resistance', audioBuffer(), { filename: 'resistance.m4a', contentType: 'audio/mp4' })
      .attach('voice_4_commitmentReading', audioBuffer(), { filename: 'commitmentReading.m4a', contentType: 'audio/mp4' });


    if (res.status !== 200) console.log('voice-bundle failure response', res.status, res.body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('submitted');
    expect(res.body.bundleId).toBe(bundleId);
    expect(res.body.fileCount).toBe(4);
    expect(res.body.semanticCaptureOrder).toEqual(semanticCaptureOrder);
    expect(res.body.voiceAttemptIds).toEqual(voiceAttemptIds);
    expect(res.body.productProvenance).toMatchObject(productProvenance);
    expect(res.body.captureReceipt.map((r) => r.stage)).toEqual(semanticCaptureOrder);
    expect(res.body.captureReceipt.map((r) => r.partName)).toEqual([
      'voice_1_goal',
      'voice_2_purpose',
      'voice_3_resistance',
      'voice_4_commitmentReading',
    ]);
    expect(res.body.captureReceipt.map((r) => r.voiceAttemptId)).toEqual(voiceAttemptIds);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.providerJobId).toBe(res.body.sessionId);

    expect(res.body.providerFileCount).toBe(1);
    expect(res.body.mergedVoiceArtifact).toMatchObject({
      sourceCaptures: 4,
      voiceAttemptIds,
      providerFileCount: 1,
      providerJobId: res.body.sessionId,
    });
    expect(res.body.mergedVoiceArtifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.voiceDebug.sampleCount).toBe(1);
    expect(res.body.voiceDebug.sourceSampleCount).toBe(4);
    expect(res.body.voiceDebug.mergedVoiceArtifact.sha256).toBe(res.body.mergedVoiceArtifact.sha256);
    expect(res.body.voiceDebug.answerMeta.bundleId).toBe(bundleId);
    expect(res.body.voiceDebug.answerMeta.voiceAttemptIds).toEqual(voiceAttemptIds);
    expect(res.body.context.goal).toMatch(/choose the work/i);
    expect(res.body.context.vision).toMatch(/remember the purpose/i);
    expect(res.body.context.blocker).toMatch(/face resistance/i);
    expect(res.body.context.commitmentReading).toMatch(/commit out loud/i);

    const manifestPath = path.join(TEST_UPLOADS, `voice_manifest_${res.body.sessionId}.json`);
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.schemaVersion).toBe('alzo.voice_manifest.v2');
    expect(manifest.sourceCaptureFiles).toHaveLength(4);
    expect(manifest.providerFiles).toHaveLength(1);
    expect(manifest.mergedVoiceArtifact.sha256).toBe(res.body.mergedVoiceArtifact.sha256);
    for (const persisted of [...manifest.sourceCaptureFiles, ...manifest.providerFiles]) {
      expect(fs.existsSync(persisted)).toBe(true);
    }

    const firstMessage = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${token}`)
      .send({
        context: res.body.context,
        sessionId: res.body.sessionId,
        language: 'en-US',
        detectedGender: res.body.detectedGender,
        voiceAttemptIds,
        bundleId,
      });

    expect(firstMessage.status).toBe(200);
    expect(elevenState.cloneCalls).toBeGreaterThanOrEqual(1);
    expect(elevenState.ttsCalls).toBeGreaterThanOrEqual(1);
    expect(firstMessage.body.audioUrl).toBeTruthy();

    expect(firstMessage.body.voiceDebug?.sampleCount).toBe(1);
    expect(firstMessage.body.voiceDebug?.sampleFiles).toHaveLength(1);
    expect(firstMessage.body.voiceDebug?.sampleFiles?.[0]).toMatch(/merged\.m4a$/);
    expect(firstMessage.body.voiceDebug?.cloneMode).toBe('cloned');
  }, 30000);
});
