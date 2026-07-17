/**
 * Contract coverage for Build 21 backend gap:
 *   POST /api/onboarding/voice-bundle
 *
 * The mobile contract sends four captures in the R2 Final order:
 *   goal, purpose, reconnectionAnchor, commitment
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
const crypto = require('crypto');

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
const alzoR2 = require('../lib/alzo-r2-contracts');

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

function installOpenAIMock(agent, { transcriptionDelayMs = 0, transcriptionPlan = null } = {}) {
  const pool = agent.get('https://api.openai.com');
  if (Array.isArray(transcriptionPlan)) {
    for (const item of transcriptionPlan) {
      let scope = pool
        .intercept({ path: '/v1/audio/transcriptions', method: 'POST' })
        .reply(200, { text: item.text });
      if (item.delayMs > 0) scope = scope.delay(item.delayMs);
    }
  } else {
    let transcriptionScope = pool
      .intercept({ path: '/v1/audio/transcriptions', method: 'POST' })
      .reply(200, { text: 'I choose the work, remember the purpose, face resistance, and commit out loud.' });
    if (transcriptionDelayMs > 0) transcriptionScope = transcriptionScope.delay(transcriptionDelayMs);
    transcriptionScope.persist();
  }
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, {
      choices: [{ message: { content: 'I choose the work because my purpose matters to me. I return by remembering what I already named.' } }],
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

async function bootServer({ preserveStorage = false, semanticResolutionTimeoutMs = null } = {}) {
  if (serverHarness) {
    await serverHarness.close();
    serverHarness = null;
  }
  if (!preserveStorage) {
    fs.rmSync(TEST_UPLOADS, { recursive: true, force: true });
    fs.rmSync(TEST_AUDIO, { recursive: true, force: true });
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  }
  fs.mkdirSync(TEST_UPLOADS, { recursive: true });
  fs.mkdirSync(TEST_AUDIO, { recursive: true });

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
  if (semanticResolutionTimeoutMs == null) delete process.env.SEMANTIC_RESOLUTION_TIMEOUT_MS;
  else process.env.SEMANTIC_RESOLUTION_TIMEOUT_MS = String(semanticResolutionTimeoutMs);

  sentryStub._reset();
  jest.resetModules();
  jest.doMock('../backend/voice_validator', () => ({
    validateInputSample: jest.fn(async () => ({ ok: true, soft: false, duration: 40.2, peak: 0.3 })),
    validateTtsRender: jest.fn(async () => ({ ok: true, soft: false, duration: 5.1, peak: 0.25 })),
    analyzeFile: jest.fn(async () => ({ ok: true, reason: null, duration: 40.2, peak: 0.3 })),
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
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
        try {
          newServer.close(() => {
            clearTimeout(timer);
            resolve();
          });
        } catch {
          clearTimeout(timer);
          resolve();
        }
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
  const password = 'test-pass-1234';
  const res = await request(url())
    .post('/api/auth/signup')
    .send({ email, password, name: 'Voice Bundle QA' })
    .set('Content-Type', 'application/json');
  return { email, password, token: res.body?.token, userId: res.body?.userId, status: res.status };
}

function provenanceCapture(stage, index, suffix = '') {
  return {
    captureId: `capture_${suffix ? `${suffix}_` : ''}${index + 1}_${stage}`,
    stage,
    signalClass: 'human_voice_detected',
    ...(stage === 'commitment' ? {
      text: alzoR2.COMMITMENT_TEXT,
      copyVersion: alzoR2.COMMITMENT_VERSION,
      copySha256: alzoR2.COMMITMENT_SHA256,
    } : {}),
  };
}

async function uploadContractBundle(token, suffix = 'lifecycle', commitmentPatch = {}) {
  const bundleId = `bundle_${suffix}_${Date.now()}`;
  const ordered = ['goal', 'purpose', 'reconnectionAnchor', 'commitment'];
  const voiceAttemptIds = ordered.map((stage, index) => `attempt_${suffix}_${index + 1}_${stage}`);
  const productProvenance = {
    build: 24,
    source: 'alzo3-pre-account-voice-bundle',
    requiredCaptureKeys: ordered,
    captures: ordered.map((stage, index) => {
      const capture = provenanceCapture(stage, index, suffix);
      return stage === 'commitment' ? { ...capture, ...commitmentPatch } : capture;
    }),
  };
  const voiceProcessingPayload = {
    schemaVersion: 'pre_account_voice_bundle.v1',
    productProvenance,
    files: ordered.map((stage, index) => ({ stage, partName: `voice_${index + 1}_${stage}`, filename: `${stage}.m4a`, mediaType: 'audio/mp4' })),
    account: { authSessionId: `auth_${suffix}` },
  };
  return request(url())
    .post('/api/onboarding/voice-bundle')
    .set('Authorization', `Bearer ${token}`)
    .field('schemaVersion', 'alzo.pre_account_voice_bundle.r2.v1')
    .field('language', 'en-US')
    .field('bundleId', bundleId)
    .field('preAccountVoiceBundle', JSON.stringify({ bundleId, captures: {} }))
    .field('voiceProcessingPayload', JSON.stringify(voiceProcessingPayload))
    .field('productProvenance', JSON.stringify(productProvenance))
    .field('semanticCaptureOrder', JSON.stringify(ordered))
    .field('voiceAttemptIds', JSON.stringify(voiceAttemptIds))
    .attach('voice_1_goal', audioBuffer(), { filename: 'goal.m4a', contentType: 'audio/mp4' })
    .attach('voice_2_purpose', audioBuffer(), { filename: 'purpose.m4a', contentType: 'audio/mp4' })
    .attach('voice_3_reconnectionAnchor', audioBuffer(), { filename: 'reconnectionAnchor.m4a', contentType: 'audio/mp4' })
    .attach('voice_4_commitment', audioBuffer(), { filename: 'commitment.m4a', contentType: 'audio/mp4' });
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
  it('rejects a fourth Commitment capture whose canonical v2 text does not match', async () => {
    const { token, status } = await registerUser();
    expect(status).toBe(200);
    const res = await uploadContractBundle(token, 'commitment_mismatch', {
      text: alzoR2.COMMITMENT_TEXT.replace(/I'll/g, 'I’ll'),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'voice_bundle_commitment_contract_invalid' });
    expect(res.body.failureCodes).toContain('commitment_copy_text_mismatch');
    expect(elevenState.cloneCalls).toBe(0);
    expect(fs.readdirSync(TEST_UPLOADS)).toHaveLength(0);
  }, 30000);

  it('hard-aborts backend semantic resolution at the deadline and classifies provider_timeout', async () => {
    await mockAgent.close();
    mockAgent = mockAgentSetup();
    installOpenAIMock(mockAgent, { transcriptionDelayMs: 100 });
    elevenState = installElevenLabsMock(mockAgent);
    await bootServer({ semanticResolutionTimeoutMs: 25 });

    const { token, status } = await registerUser();
    expect(status).toBe(200);
    const res = await uploadContractBundle(token, 'semantic_timeout');

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      error: 'semantic_resolution_timeout',
      failureKind: 'provider_timeout',
      stage: 'semantic_resolution',
      retryAction: 'record_again',
    });
    expect(res.body.requestId).toBeTruthy();
    expect(res.body.correlationId).toBeTruthy();
    expect(elevenState.cloneCalls).toBe(0);
    expect(fs.readdirSync(TEST_UPLOADS)).toHaveLength(0);
  }, 30000);

  it('parallelizes four slow transcriptions within one shared budget and preserves deterministic receipt provenance order', async () => {
    await mockAgent.close();
    mockAgent = mockAgentSetup();
    installOpenAIMock(mockAgent, {
      transcriptionPlan: [
        { delayMs: 110, text: 'My concrete goal is to finish meaningful work with calm focus every morning.' },
        { delayMs: 20, text: 'My purpose is to keep my promises and be present for the people I love.' },
        { delayMs: 80, text: 'When resistance appears I return with one breath and one honest next step.' },
        { delayMs: 50, text: 'Today I commit to show up with patience and complete one meaningful action.' },
      ],
    });
    elevenState = installElevenLabsMock(mockAgent);
    await bootServer({ semanticResolutionTimeoutMs: 180 });

    const { token, status } = await registerUser();
    expect(status).toBe(200);
    const res = await uploadContractBundle(token, 'parallel_budget_order');

    if (res.status !== 200) console.log('parallel transcription failure response', res.status, res.body);
    expect(res.status).toBe(200);
    expect(res.body.captureReceipt.map((item) => item.stage)).toEqual([
      'goal',
      'purpose',
      'reconnectionAnchor',
      'commitment',
    ]);
    expect(res.body.captureReceipt.map((item) => item.partName)).toEqual([
      'voice_1_goal',
      'voice_2_purpose',
      'voice_3_reconnectionAnchor',
      'voice_4_commitment',
    ]);
    expect(res.body.captureReceipt.map((item) => item.voiceAttemptId)).toEqual([
      'attempt_parallel_budget_order_1_goal',
      'attempt_parallel_budget_order_2_purpose',
      'attempt_parallel_budget_order_3_reconnectionAnchor',
      'attempt_parallel_budget_order_4_commitment',
    ]);
    expect(res.body.captureReceipt.every((item) => item.transcribed === true)).toBe(true);
    expect(elevenState.cloneCalls).toBe(0);
  }, 30000);

  it('accepts the Build 21 four-capture contract and preserves provenance/session correlation', async () => {
    const { token, userId, status } = await registerUser();
    expect(status).toBe(200);
    expect(token).toBeTruthy();

    const bundleId = 'bundle_test_123';
    const voiceAttemptIds = [
      'attempt_goal_1',
      'attempt_purpose_2',
      'attempt_anchor_3',
      'attempt_commitment_4',
    ];
    const semanticCaptureOrder = ['goal', 'purpose', 'reconnectionAnchor', 'commitment'];
    const productProvenance = {
      build: 24,
      source: 'alzo3-pre-account-voice-bundle',
      requiredCaptureKeys: semanticCaptureOrder,
      captures: semanticCaptureOrder.map((stage, index) => provenanceCapture(stage, index)),
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
      .field('schemaVersion', 'alzo.pre_account_voice_bundle.r2.v1')
      .field('language', 'en-US')
      .field('bundleId', bundleId)
      .field('preAccountVoiceBundle', JSON.stringify({ bundleId, captures: {} }))
      .field('voiceProcessingPayload', JSON.stringify(voiceProcessingPayload))
      .field('productProvenance', JSON.stringify(productProvenance))
      .field('semanticCaptureOrder', JSON.stringify(semanticCaptureOrder))
      .field('voiceAttemptIds', JSON.stringify(voiceAttemptIds))
      .attach('voice_1_goal', audioBuffer(), { filename: 'goal.m4a', contentType: 'audio/mp4' })
      .attach('voice_2_purpose', audioBuffer(), { filename: 'purpose.m4a', contentType: 'audio/mp4' })
      .attach('voice_3_reconnectionAnchor', audioBuffer(), { filename: 'reconnectionAnchor.m4a', contentType: 'audio/mp4' })
      .attach('voice_4_commitment', audioBuffer(), { filename: 'commitment.m4a', contentType: 'audio/mp4' });


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
      'voice_3_reconnectionAnchor',
      'voice_4_commitment',
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
    expect(res.body.mergedVoiceArtifact.validAudioDurationMs).toBe(40200);
    expect(res.body.mergedVoiceArtifact.validationPassed).toBe(true);
    expect(res.body.voiceDebug.sampleCount).toBe(1);
    expect(res.body.voiceDebug.sourceSampleCount).toBe(4);
    expect(res.body.voiceDebug.mergedVoiceArtifact.sha256).toBe(res.body.mergedVoiceArtifact.sha256);
    expect(res.body.voiceDebug.answerMeta.bundleId).toBe(bundleId);
    expect(res.body.voiceDebug.answerMeta.voiceAttemptIds).toEqual(voiceAttemptIds);
    expect(res.body.context.goal.text).toMatch(/choose the work/i);
    expect(res.body.context.purpose.text).toMatch(/remember the purpose/i);
    expect(res.body.context.reconnectionAnchor.text).toMatch(/face resistance/i);
    expect(JSON.stringify(res.body.context)).not.toMatch(/commitment|journal/i);

    const manifestPath = path.join(TEST_UPLOADS, `voice_manifest_${res.body.sessionId}.json`);
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.schemaVersion).toBe('alzo.voice_manifest.r2.v1');
    expect(manifest.voiceOwnerId).toBe(userId);
    expect(manifest.sourceCaptureFiles).toHaveLength(4);
    expect(manifest.providerFiles).toHaveLength(1);
    expect(manifest.mergedVoiceArtifact.sha256).toBe(res.body.mergedVoiceArtifact.sha256);
    expect(manifest.semanticContext).toEqual(res.body.semanticContext);
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
    expect(firstMessage.body.audioProvenance).toMatchObject({
      schemaVersion: 'alzo.audio_provenance.v1',
      artifactKind: 'synthesized_first_message',
      audioUrl: firstMessage.body.audioUrl,
    });
    expect(firstMessage.body.audioProvenance.artifactId).toBeTruthy();
    expect(firstMessage.body.audioProvenance.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(firstMessage.body.audioProvenance.sourceCaptureSha256s).toHaveLength(4);
    const servedPath = path.join(TEST_AUDIO, path.basename(firstMessage.body.audioUrl));
    const servedSha256 = crypto.createHash('sha256').update(fs.readFileSync(servedPath)).digest('hex');
    expect(firstMessage.body.audioProvenance.sha256).toBe(servedSha256);
    const servedAudio = await request(url()).get(firstMessage.body.audioUrl);
    expect(servedAudio.status).toBe(200);
    expect(Buffer.isBuffer(servedAudio.body)).toBe(true);
    expect(crypto.createHash('sha256').update(servedAudio.body).digest('hex')).toBe(firstMessage.body.audioProvenance.sha256);
    expect(firstMessage.body.audioProvenance.sourceCaptureSha256s).not.toContain(servedSha256);
    expect(firstMessage.body.audioProvenance.sha256).not.toBe(manifest.mergedVoiceArtifact.sha256);

    expect(firstMessage.body.voiceDebug?.sampleCount).toBe(1);
    expect(firstMessage.body.voiceDebug?.sampleFiles).toHaveLength(1);
    expect(firstMessage.body.voiceDebug?.sampleFiles?.[0]).toMatch(/merged\.m4a$/);
    expect(firstMessage.body.voiceDebug?.cloneMode).toBe('cloned');
  }, 30000);

  it('enforces voiceOwnerId and recovers the validated merged artifact after process restart', async () => {
    const owner = await registerUser();
    const intruder = await registerUser();
    expect(owner.status).toBe(200);
    expect(intruder.status).toBe(200);

    const upload = await uploadContractBundle(owner.token, 'owner_restart');
    expect(upload.status).toBe(200);
    const { sessionId } = upload.body;
    const manifestPath = path.join(TEST_UPLOADS, `voice_manifest_${sessionId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const mergedPath = manifest.providerFiles[0];
    expect(manifest.voiceOwnerId).toBe(owner.userId);
    expect(manifest.providerFiles).toEqual([mergedPath]);
    expect(manifest.sourceCaptureFiles).toHaveLength(4);
    expect(fs.existsSync(mergedPath)).toBe(true);

    const unauthorized = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${intruder.token}`)
      .send({ context: upload.body.context, sessionId, language: 'en-US' });
    expect(unauthorized.status).toBe(403);
    expect(unauthorized.body.error).toBe('r2_voice_owner_mismatch');
    expect(elevenState.cloneCalls).toBe(0);

    await bootServer({ preserveStorage: true });
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(mergedPath)).toBe(true);

    const recovered = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        context: { goal: 'request injection', commitment: 'forbidden request value' },
        sessionId,
        language: 'en-US',
      });
    expect(recovered.status).toBe(200);
    expect(recovered.body.audioUrl).toBeTruthy();
    expect(recovered.body.voiceDebug?.sampleFiles).toEqual([path.basename(mergedPath)]);
    expect(fs.existsSync(mergedPath)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(manifest.sourceCaptureFiles.every((filePath) => fs.existsSync(filePath))).toBe(true);

    fs.unlinkSync(mergedPath);
    const missingArtifact = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ context: upload.body.context, sessionId, language: 'en-US' });
    expect(missingArtifact.status).toBe(422);
    expect(missingArtifact.body.error).toBe('r2_merged_artifact_missing');
  }, 60000);
});
