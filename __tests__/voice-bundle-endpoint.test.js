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
const Database = require('better-sqlite3');

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
let transcriptionCalls;
let chatCalls;

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
      .reply(200, () => { transcriptionCalls += 1; return { text: 'I choose the work, remember the purpose, face resistance, and commit out loud.' }; });
    if (transcriptionDelayMs > 0) transcriptionScope = transcriptionScope.delay(transcriptionDelayMs);
    transcriptionScope.persist();
  }
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, () => { chatCalls += 1; return {
      choices: [{ message: { content: 'I choose the work because my purpose matters to me. I return by remembering what I already named.' } }],
    }; })
    .persist();
}

let syntheticTtsBuffer;
function audioResponseBuffer() {
  if (!syntheticTtsBuffer) {
    const file = path.join(TEST_ROOT, 'synthetic-tts.mp3');
    execFileSync(ffmpegStatic, ['-y', '-v', 'error', '-f', 'lavfi', '-i',
      'sine=frequency=440:duration=5', '-c:a', 'libmp3lame', file]);
    syntheticTtsBuffer = fs.readFileSync(file);
  }
  return Buffer.from(syntheticTtsBuffer);
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

async function bootServer({ preserveStorage = false, semanticResolutionTimeoutMs = null, realAnalyzer = false } = {}) {
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
  if (realAnalyzer) jest.dontMock('../backend/voice_validator');
  else jest.doMock('../backend/voice_validator', () => ({
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

async function uploadContractBundle(token, suffix = 'lifecycle', commitmentPatch = {}, productProvenanceOverride = null, audioByStage = {}) {
  const bundleId = `bundle_${suffix}_${Date.now()}`;
  const ordered = ['goal', 'purpose', 'reconnectionAnchor', 'commitment'];
  const voiceAttemptIds = ordered.map((stage, index) => `attempt_${suffix}_${index + 1}_${stage}`);
  const productProvenance = productProvenanceOverride || {
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
    .attach('voice_1_goal', audioByStage.goal || audioBuffer(), { filename: 'goal.m4a', contentType: 'audio/mp4' })
    .attach('voice_2_purpose', audioByStage.purpose || audioBuffer(), { filename: 'purpose.m4a', contentType: 'audio/mp4' })
    .attach('voice_3_reconnectionAnchor', audioByStage.reconnectionAnchor || audioBuffer(), { filename: 'reconnectionAnchor.m4a', contentType: 'audio/mp4' })
    .attach('voice_4_commitment', audioByStage.commitment || audioBuffer(), { filename: 'commitment.m4a', contentType: 'audio/mp4' });
}

function actualAac(seconds) {
  // A host encoder with sample-accurate M4A edit lists is needed for the
  // 6.999 boundary: some bundled ffmpeg versions round it to exactly 7.000.
  if (seconds === 6.999 && process.env.ALZO_QA_M4A_SHORT_FILE) {
    return fs.readFileSync(process.env.ALZO_QA_M4A_SHORT_FILE);
  }
  const filename = path.join(TEST_ROOT, `actual-${seconds}-${crypto.randomBytes(4).toString('hex')}.m4a`);
  execFileSync(ffmpegStatic, [
    '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
    '-c:a', 'aac', '-movflags', '+faststart', filename,
  ]);
  return fs.readFileSync(filename);
}

beforeEach(async () => {
  transcriptionCalls = 0;
  chatCalls = 0;
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
  (process.env.ALZO_QA_APPLE_AAC_DIR && process.env.ALZO_MOBILE_CONTRACT_MODULE ? it : it.skip)('real mobile adapter and state recover from HTTP422 through generation, readable playback and Home reopen', async () => {
    await bootServer({ realAnalyzer: true });
    const mobile = path.dirname(process.env.ALZO_MOBILE_CONTRACT_MODULE);
    const {createMockApi} = require(path.join(mobile, 'mockApi'));
    const {createAlzo2BackendAdapter} = require(path.join(mobile, 'alzo2BackendAdapter'));
    const {COMMITMENT_TEXT} = require(path.join(mobile, 'onboardingCopy'));
    const {currentUploadFailure} = require(path.join(mobile, 'voiceUploadRecovery'));
    const {createMemoryPersistenceAdapter} = require(path.join(mobile, 'persistenceRuntime'));
    const {createV2Envelope} = require(path.join(mobile, 'persistedStateSchema'));
    const {selectCanonicalFirstMessage} = require(path.join(mobile, 'firstMessageAuthority'));
    const {resolveInitialRouteId} = require(path.join(mobile, 'routeResolution'));
    mockAgent.get('https://api.elevenlabs.io').intercept({path:'/v1/voices',method:'GET'}).reply(200,{voices:[]}).persist();
    const adapter=createAlzo2BackendAdapter({baseUrl:url(),fetch:async(target,options={})=>{
      // MockAgent's localhost passthrough cannot stream FormData reliably.
      // Serialize the adapter's actual multipart body without changing fields.
      if(options.body instanceof UndiciFormData){
        const encoded=new UndiciRequest(target,options);
        options={...options,headers:Object.fromEntries(encoded.headers),body:Buffer.from(await encoded.arrayBuffer())};
      }
      try{return await undiciFetch(target,options);}catch(error){throw new Error(String(error.cause?.message||error.message));}
    }});
    const api=createMockApi({backendAuthAdapter:adapter});
    api.postOnboardingDraft({category:'health'});
    for(const stage of ['goal','purpose','resistance','commitmentReading']) {
      const seconds=stage==='commitmentReading'?20:11;
      const file=path.join(process.env.ALZO_QA_APPLE_AAC_DIR,seconds+'.m4a');
      const capture=api.postSemanticVoiceCapture({stage,uri:'file://'+file,durationSeconds:seconds,durationMs:seconds*1000,
        semanticValue:stage==='commitmentReading'?COMMITMENT_TEXT:'',transcript:null,
        semanticStatus:'backend_transcription_pending',requiresBackendValidation:true,microphoneWorking:true,
        signalClass:'artifact_requires_backend_transcription',voiceAttemptId:'http_oct7_'+stage,
        artifactProbe:{uriPresent:true,fileExists:true,fileSizeBytes:fs.statSync(file).size,probeError:null},fileSizeBytes:fs.statSync(file).size});
      expect(capture.ok).toBe(true);
    }
    expect((await api.postEmailSignIn({email:'http-integration@example.test',password:'test-pass-1234'})).ok).toBe(true);
    const bundle=api.getPreAccountVoiceBundleStatus().bundle;
    const ids=Object.values(api.getState().onboarding.semanticCaptures).map(item=>item.captureId);
    const journey=api.postPreAccountVoiceBundleJourney({bundle});
    expect(journey.ok).toBe(true);
    expect((await api.postDailyDeliveryTime({time:'08:00',timezone:'America/New_York'})).ok).toBe(true);
    expect(api.postPlantSelection(journey.journey.id,{plantChoiceId:'vds_sprout_quiet',name:'Synthetic integration'}).ok).toBe(true);
    const fileBlob=(name)=>({blob:new Blob([fs.readFileSync(path.join(process.env.ALZO_QA_APPLE_AAC_DIR,name))],{type:'audio/mp4'})});
    const files={goal:fileBlob('11.m4a'),purpose:fileBlob('11.m4a'),reconnectionAnchor:fileBlob('11.m4a'),commitment:fileBlob('20.m4a')};
    const bad=await api.postPreAccountVoiceProcessingPayload({bundle,files:{...files,goal:fileBlob('6.999.m4a')}});
    if(bad.status!==422) throw new Error('expected HTTP422: '+JSON.stringify({error:bad.error,stage:bad.stage,status:bad.status}));
    expect(bad.status).toBe(422);
    expect(currentUploadFailure(api.getState()).failures[0]).toMatchObject({stage:'goal',code:'capture_duration_short'});
    expect(api.postOnboardingComplete({}).ok).toBe(false);
    expect(transcriptionCalls).toBe(0);
    expect(elevenState.cloneCalls).toBe(0);
    const good=await api.postPreAccountVoiceProcessingPayload({bundle,files});
    if(!good.ok) throw new Error('mobile HTTP retry: '+JSON.stringify({error:good.error,stage:good.stage,raw:good.raw}));
    expect(currentUploadFailure(api.getState())).toBeNull();
    expect(Object.values(api.getState().onboarding.semanticCaptures).map(item=>item.captureId)).toEqual(ids);
    expect(transcriptionCalls).toBe(4);
    expect(elevenState.cloneCalls).toBe(1);
    const message=selectCanonicalFirstMessage(api.getState());
    expect(message).toBeTruthy();
    const {privacyHash}=require(path.join(mobile,'firstMessageContextProof'));
    const resolved=good.upload.semanticContext;
    expect(message.contextProof.goal.valueHash).toBe(privacyHash(resolved.goal.text));
    expect(message.contextProof.purpose.valueHash).toBe(privacyHash(resolved.purpose.text));
    expect(message.contextProof.reconnectionAnchor.valueHash).toBe(privacyHash(resolved.reconnectionAnchor.text));
    const audio=await undiciFetch(new URL(message.audioUrl,url()));
    expect(audio.status).toBe(200);
    const played=path.join(TEST_ROOT,'playback.mp3');
    fs.writeFileSync(played,Buffer.from(await audio.arrayBuffer()));
    expect((await require('../backend/voice_validator').analyzeFile(played)).duration).toBeGreaterThanOrEqual(4);
    expect(api.postOnboardingComplete({}).ok).toBe(true);
    // Assembly reconciles the canonical message ID. The rendered app selects
    // from the new snapshot, so playback must use that current identity too.
    const activeMessage=selectCanonicalFirstMessage(api.getState());
    const playback=api.postMessagePlayback(activeMessage.id,'completed',{source:'playback_completed'});
    if(!playback.ok)throw new Error('mobile playback: '+JSON.stringify({error:playback.error,detail:playback.detail,provenance:message.audioProvenance,audioKind:message.audioKind,cloneMode:message.voiceDebug?.cloneMode}));
    expect(api.activateJourneyAfterFirstMessage().ok).toBe(true);
    expect(resolveInitialRouteId(api.getState())).toBe('home');
    const reopened=createMockApi({persistenceAdapter:createMemoryPersistenceAdapter(createV2Envelope(api.getState())),backendAuthAdapter:adapter});
    expect((await reopened.hydrate()).ok).toBe(true);
    expect(resolveInitialRouteId(reopened.getState())).toBe('home');
    expect(Object.values(reopened.getState().onboarding.semanticCaptures).map(item=>item.captureId)).toEqual(ids);
  },60000);
  (process.env.ALZO_QA_APPLE_AAC_DIR ? it : it.skip)('accepts CoreAudio AAC without edits and rejects short/truncated files before providers', async () => {
    await bootServer({ realAnalyzer: true });
    const { token } = await registerUser();
    const read = (name) => fs.readFileSync(path.join(process.env.ALZO_QA_APPLE_AAC_DIR, name));
    const common = { purpose: read('11.m4a'), reconnectionAnchor: read('11.m4a'), commitment: read('20.m4a') };
    for (const filename of ['6.999.m4a', 'truncated.m4a', 'unknown-priming.m4a']) {
      const rejected = await uploadContractBundle(token, `apple_${filename}`, {}, null, { ...common, goal: read(filename) });
      expect(rejected.status).toBe(422);
      expect(transcriptionCalls).toBe(0);
      expect(chatCalls).toBe(0);
      expect(elevenState.cloneCalls).toBe(0);
      expect(elevenState.ttsCalls).toBe(0);
    }
    const accepted = await uploadContractBundle(token, 'apple_exact7', {}, null, { ...common, goal: read('7.m4a') });
    if (accepted.status !== 200) throw new Error(JSON.stringify(accepted.body));
    expect(accepted.status).toBe(200);
    expect(transcriptionCalls).toBe(4);
  }, 60000);
  it('rejects both Daily routes before text or voice providers when the owned merged source is missing', async () => {
    const { token, userId, status } = await registerUser();
    expect(status).toBe(200);
    const db = new Database(TEST_DB);
    db.prepare("UPDATE users SET elevenlabsVoiceId = ?, subscriptionStatus = 'trialing' WHERE id = ?").run('legacy_voice_id_without_source', userId);
    db.close();
    const dailyContext = {
      schemaVersion: 'alzo.daily_context.v1',
      semanticContext: { goal: 'Run', purpose: 'Health', reconnectionAnchor: 'Start small' },
      sourceRefs: { goal: 'g1', purpose: 'p1', reconnectionAnchor: 'a1' },
      checkIn: { mood: 'Calm', alignment: 'Connected', alignmentSemantics: 'emotional_connection_only' },
      checkInRefs: { mood: 'm1', alignment: 'a2' },
      firstMessageReference: { id: 'first', transcript: 'I can return.', listenedAt: '2026-07-13T00:00:00Z' },
      recentDailyMessages: [],
    };
    for (const [route, body] of [
      ['/api/daily-message', { context: dailyContext }],
      ['/api/affirmation/today', { context: dailyContext }],
    ]) {
      const response = await request(url()).post(route).set('Authorization', `Bearer ${token}`).send(body);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('SELF_VOICE_SOURCE_MISSING');
    }
    expect(chatCalls).toBe(0);
    expect(elevenState.cloneCalls).toBe(0);
    expect(elevenState.ttsCalls).toBe(0);
  });
  it('measures actual AAC content before transcription, including padding and truncation', async () => {
    await bootServer({ realAnalyzer: true });
    const { token, status } = await registerUser();
    expect(status).toBe(200);
    const eleven = actualAac(11);
    const twenty = actualAac(20);
    const common = { purpose: eleven, reconnectionAnchor: eleven, commitment: twenty };
    const short = await uploadContractBundle(token, 'real_aac_6999', {}, null, { ...common, goal: actualAac(6.999) });
    expect(short.status).toBe(422);
    expect(transcriptionCalls).toBe(0);
    const original = actualAac(11);
    const truncated = await uploadContractBundle(token, 'real_aac_truncated', {}, null, { ...common, goal: original.subarray(0, Math.round(original.length / 3)) });
    expect(truncated.status).toBe(422);
    expect(transcriptionCalls).toBe(0);
    const valid = await uploadContractBundle(token, 'real_aac_7000', {}, null, { ...common, goal: actualAac(7) });
    expect(valid.status).toBe(200);
    expect(transcriptionCalls).toBe(4);
  }, 60000);
  const mobileModule = process.env.ALZO_MOBILE_CONTRACT_MODULE;
  (mobileModule ? it : it.skip)('accepts productProvenance made by the actual mobile bundle module', async () => {
    const mobile = require(mobileModule);
    const copy = require(path.join(path.dirname(mobileModule), 'onboardingCopy'));
    let onboarding = {};
    for (const [index, stage] of ['goal', 'purpose', 'resistance', 'commitmentReading'].entries()) {
      onboarding = mobile.upsertSemanticCapture(onboarding, {
        stage, captureId: `actual_mobile_${stage}`,
        localUri: `file:///synthetic/${stage}.m4a`,
        durationMs: [11000, 11000, 11000, 20000][index],
        semanticValue: stage === 'commitmentReading' ? copy.COMMITMENT_TEXT : `Synthetic ${stage} answer`,
        validationStatus: 'accepted',
      }).onboarding;
    }
    const built = mobile.buildPreAccountVoiceBundle(onboarding);
    expect(built.ok).toBe(true);
    const mobilePayload = mobile.buildVoiceProcessingPayloadFromBundle({ bundle: built.bundle });
    expect(mobilePayload.ok).toBe(true);
    const { token, status } = await registerUser();
    expect(status).toBe(200);
    const before = transcriptionCalls;
    const accepted = await uploadContractBundle(token, 'actual_mobile_v3', {}, mobilePayload.payload.productProvenance);
    expect(accepted.status).toBe(200);
    expect(transcriptionCalls).toBeGreaterThan(before);
    const bad = structuredClone(mobilePayload.payload.productProvenance);
    bad.captures[3].copySha256 = alzoR2.COMMITMENT_SHA256;
    const beforeBad = transcriptionCalls;
    const rejected = await uploadContractBundle(token, 'actual_mobile_mixed', {}, bad);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('voice_bundle_commitment_contract_invalid');
    expect(transcriptionCalls).toBe(beforeBad);
  }, 60000);
  it('accepts exact v3 and rejects mixed v2/v3 tuples before any paid transcription', async () => {
    const { token, status } = await registerUser();
    expect(status).toBe(200);
    const v3 = {
      text: alzoR2.COMMITMENT_V3_TEXT,
      copyVersion: alzoR2.COMMITMENT_V3_VERSION,
      copySha256: alzoR2.COMMITMENT_V3_SHA256,
    };
    const accepted = await uploadContractBundle(token, 'approved_v3', v3);
    expect(accepted.status).toBe(200);
    for (const [index, patch] of [
      { ...v3, copyVersion: alzoR2.COMMITMENT_VERSION },
      { ...v3, copySha256: alzoR2.COMMITMENT_SHA256 },
      { ...v3, text: alzoR2.COMMITMENT_TEXT },
      { ...v3, text: `${v3.text} ` },
    ].entries()) {
      const before = transcriptionCalls;
      const rejected = await uploadContractBundle(token, `mixed_v3_${index}`, patch);
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe('voice_bundle_commitment_contract_invalid');
      expect(transcriptionCalls).toBe(before);
    }
  }, 60000);
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
    expect(firstMessage.body.clone_verified).toBe(true);

    const cloneCallsAfterFirst = elevenState.cloneCalls;
    const reused = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${token}`)
      .send({ context: res.body.context, sessionId: res.body.sessionId, language: 'en-US' });
    expect(reused.status).toBe(200);
    expect(reused.body.clone_verified).toBe(true);
    expect(reused.body.voiceDebug).toMatchObject({ cloneMode: 'cached', cachedVoiceVerified: true });
    expect(elevenState.cloneCalls).toBe(cloneCallsAfterFirst);

    // A voice ID with no verified account/asset receipt is legacy unknown.
    const Database = require('better-sqlite3');
    const db = new Database(TEST_DB);
    db.prepare('UPDATE users SET elevenlabsVoiceProofSha256 = NULL WHERE id = ?').run(userId);
    db.close();
    const legacy = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${token}`)
      .send({ context: res.body.context, sessionId: res.body.sessionId, language: 'en-US' });
    expect(legacy.status).toBe(200);
    expect(legacy.body.voiceDebug?.cloneMode).toBe('cloned');
    expect(elevenState.cloneCalls).toBe(cloneCallsAfterFirst + 1);

    require('../backend/voice_validator').validateTtsRender.mockResolvedValueOnce({ ok: false, code: 'VOICE_CLONE_GLITCHED', http: 502, duration: 1, peak: 0.2 });
    const badCachedRender = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${token}`)
      .send({ context: res.body.context, sessionId: res.body.sessionId, language: 'en-US' });
    expect(badCachedRender.status).toBe(502);
    expect(badCachedRender.body.clone_verified).not.toBe(true);
    expect(elevenState.cloneCalls).toBe(cloneCallsAfterFirst + 1);
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

    const intruderOwn = await uploadContractBundle(intruder.token, 'intruder_own');
    expect(intruderOwn.status).toBe(200);
    const Database = require('better-sqlite3');
    const db = new Database(TEST_DB);
    const ownerVoice = db.prepare('SELECT elevenlabsVoiceId, elevenlabsVoiceProofSha256, elevenlabsVoiceVerifiedAt FROM users WHERE id = ?').get(owner.userId);
    db.prepare('UPDATE users SET elevenlabsVoiceId = ?, elevenlabsVoiceProofSha256 = ?, elevenlabsVoiceVerifiedAt = ? WHERE id = ?')
      .run(ownerVoice.elevenlabsVoiceId, ownerVoice.elevenlabsVoiceProofSha256, ownerVoice.elevenlabsVoiceVerifiedAt, intruder.userId);
    db.close();
    const beforeCrossAccountClone = elevenState.cloneCalls;
    const intruderFirst = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${intruder.token}`)
      .send({ context: intruderOwn.body.context, sessionId: intruderOwn.body.sessionId, language: 'en-US' });
    expect(intruderFirst.status).toBe(200);
    expect(intruderFirst.body.voiceDebug?.cloneMode).toBe('cloned');
    expect(elevenState.cloneCalls).toBe(beforeCrossAccountClone + 1);

    fs.unlinkSync(mergedPath);
    const missingArtifact = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ context: upload.body.context, sessionId, language: 'en-US' });
    expect(missingArtifact.status).toBe(422);
    expect(missingArtifact.body.error).toBe('r2_merged_artifact_missing');
  }, 60000);
});
