/**
 * __tests__/voice-flow-40-e2e.test.js
 *
 * FLOW-40 — Server-side E2E: Voice Pipeline (Fase 1, Tier 1)
 *
 * Proves the FULL server-side chain in one deterministic, device-free run:
 *   upload (3 voice clips via POST /api/onboarding)
 *   → backend processing
 *   → clone generation (ElevenLabs mocked)
 *   → voice_id persisted in DB
 *   → playback URL returned by /api/affirmation/today
 *   → playback URL is fetchable (non-empty audio response)
 *
 * Runtime model: identical to voice-flow.test.js — in-process server.js loaded
 * via jest.resetModules(), undici MockAgent intercepts all ElevenLabs/OpenAI
 * calls, supertest drives the HTTP layer.
 *
 * Run:
 *   ELEVENLABS_API_KEY=test-fake-key NODE_ENV=test \
 *     ./node_modules/.bin/jest --runInBand __tests__/voice-flow-40-e2e.test.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');

const {
  MockAgent,
  setGlobalDispatcher,
  fetch:    undiciFetch,
  Headers:  UndiciHeaders,
  Request:  UndiciRequest,
  Response: UndiciResponse,
  FormData: UndiciFormData,
} = require('undici');
const request = require('supertest');

// ── Force undici fetch so MockAgent can intercept SUT's `fetch()` calls ──────
globalThis.fetch    = undiciFetch;
globalThis.Headers  = UndiciHeaders;
globalThis.Request  = UndiciRequest;
globalThis.Response = UndiciResponse;
globalThis.FormData = UndiciFormData;

// ── Sentry stub (already wired via jest moduleNameMapper) ────────────────────
const sentryStub = require('./__mocks__/sentry-stub');

// ── Isolated temp workspace ───────────────────────────────────────────────────
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'alzo-flow40-'));
const TEST_DB   = path.join(TEST_ROOT, 'alzo.db');

// ── Port helper ───────────────────────────────────────────────────────────────
function pickFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── Server lifecycle ──────────────────────────────────────────────────────────
let serverHarness;

function mockAgentSetup() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  // Allow loopback so supertest can reach the in-process server
  agent.enableNetConnect((host) => /^(127\.0\.0\.1|localhost)/.test(host));
  setGlobalDispatcher(agent);
  return agent;
}

async function bootServer({ wipeFs = false, wipeDb = false } = {}) {
  if (serverHarness) {
    await serverHarness.close();
    serverHarness = null;
  }
  if (wipeDb && fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

  const backendRoot = path.resolve(__dirname, '..');
  if (wipeFs) {
    for (const d of ['public/audio', 'uploads']) {
      const p = path.join(backendRoot, d);
      if (fs.existsSync(p)) {
        for (const f of fs.readdirSync(p)) {
          if (f.startsWith('.')) continue;
          try { fs.unlinkSync(path.join(p, f)); } catch (_) {}
        }
      }
    }
  }
  for (const d of ['public/audio', 'uploads']) {
    fs.mkdirSync(path.join(backendRoot, d), { recursive: true });
  }

  const port = await pickFreePort();

  process.env.DB_PATH             = TEST_DB;
  process.env.PORT                = String(port);
  process.env.ELEVENLABS_API_KEY  = 'test-elevenlabs-key';
  process.env.OPENAI_API_KEY      = 'test-openai-key';
  process.env.SENTRY_DSN          = '';
  process.env.JWT_SECRET          = 'test-jwt-secret';
  process.env.NODE_ENV            = 'test';

  sentryStub._reset();
  jest.resetModules();

  const before = new Set(
    process._getActiveHandles().filter(
      (h) => h && h.constructor && h.constructor.name === 'Server'
    )
  );

  try {
    require(path.join(backendRoot, 'server.js'));
  } catch (e) {
    console.error('[bootServer] server.js require threw:', e);
    throw e;
  }

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

  const after     = process._getActiveHandles().filter(
    (h) => h && h.constructor && h.constructor.name === 'Server'
  );
  const newServer = after.find((h) => !before.has(h));

  serverHarness = {
    port,
    handle: newServer || null,
    close: () =>
      new Promise((resolve) => {
        if (newServer && typeof newServer.close === 'function') {
          let done = false;
          try {
            newServer.close(() => { if (!done) { done = true; resolve(); } });
          } catch { done = true; resolve(); }
          setTimeout(() => { if (!done) { done = true; resolve(); } }, 1000);
        } else { resolve(); }
      }),
  };
  return serverHarness;
}

function url() { return `http://127.0.0.1:${serverHarness.port}`; }

// ── Helpers ───────────────────────────────────────────────────────────────────
async function registerUser(
  email = `flow40-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@thenetmencorp.com`
) {
  const res = await request(url())
    .post('/api/auth/signup')
    .send({ email, password: 'test-pass-1234', name: 'Flow40 QA' })
    .set('Content-Type', 'application/json');
  return { email, token: res.body?.token, userId: res.body?.userId, status: res.status };
}

function silentMp3Buffer() {
  // 1-second silent ID3-tagged mp3 — tiny but valid for multer
  return Buffer.from(
    '/+MYxAAAAANIAAAAAExBTUUzLjk5cgQAAAAAAAAAABRAJAaUQAAQAAAAEi4i',
    'base64'
  );
}

// ── ElevenLabs mock (mirrors voice-flow.test.js exactly) ─────────────────────
function installElevenLabsMock(agent) {
  const pool  = agent.get('https://api.elevenlabs.io');
  const state = { cloneCalls: 0, ttsCalls: 0, lastCloneVoiceId: null };

  pool
    .intercept({ path: '/v1/voices/add', method: 'POST' })
    .reply(200, () => {
      state.cloneCalls += 1;
      state.lastCloneVoiceId = `voice_clone_f40_${state.cloneCalls}_${Date.now()}`;
      return { voice_id: state.lastCloneVoiceId };
    })
    .persist();

  pool
    .intercept({ path: /^\/v1\/text-to-speech\/[^/]+/, method: 'POST' })
    .reply(() => {
      state.ttsCalls += 1;
      return {
        statusCode: 200,
        data: silentMp3Buffer(),
        responseOptions: { headers: { 'content-type': 'audio/mpeg' } },
      };
    })
    .persist();

  pool
    .intercept({ path: /^\/v1\/voices\/[^/]+$/, method: 'DELETE' })
    .reply(() => ({ statusCode: 200, data: { ok: true } }))
    .persist();

  pool
    .intercept({ path: /^\/v1\/voices\/[^/]+$/, method: 'GET' })
    .reply((opts) => {
      const voiceId = opts.path.split('/').pop();
      return { statusCode: 200, data: { voice_id: voiceId, name: 'mock' } };
    })
    .persist();

  return state;
}

function installOpenAIMock(agent) {
  const pool = agent.get('https://api.openai.com');
  pool
    .intercept({ path: '/v1/audio/transcriptions', method: 'POST' })
    .reply(200, { text: 'I want to grow, show up, and launch my best work.' })
    .persist();
  pool
    .intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, () => ({
      id: 'chatcmpl-flow40-mock',
      object: 'chat.completion',
      created: Date.now(),
      model: 'gpt-4o-mini',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'You are unstoppable. Show up today.' },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
    }))
    .persist();
}

// ── Suite lifecycle ───────────────────────────────────────────────────────────
let mockAgent;
let elState;

beforeAll(async () => {
  mockAgent = mockAgentSetup();
  elState   = installElevenLabsMock(mockAgent);
  installOpenAIMock(mockAgent);
  await bootServer({ wipeFs: true, wipeDb: true });
}, 20000);

afterAll(async () => {
  if (serverHarness) await serverHarness.close();
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  await mockAgent?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// FLOW-40 — Server-side E2E: Full Voice Pipeline
// ─────────────────────────────────────────────────────────────────────────────
describe('FLOW-40 — server-side E2E: voice pipeline full chain', () => {
  /**
   * Single test — all 6 chain steps executed sequentially inside one it() block
   * so failures pinpoint the exact step without cross-test state leakage.
   */
  it('upload 3 clips → clone triggered → voice_id persisted → affirmation audioUrl returned → URL fetchable', async () => {
    // ── STEP 1: Authenticate a test user ──────────────────────────────────────
    const { email, token, status: signupStatus } = await registerUser();
    expect(signupStatus).toBe(200);
    expect(token).toBeTruthy();
    // STEP 1 PASS: user registered, JWT token obtained.

    // ── STEP 2: POST 3 voice clips to /api/onboarding ─────────────────────────
    // The endpoint accepts multipart fields: q1, q2 (question responses) +
    // voiceSample (dedicated clone source). Using real fixture buffer.
    const onboardingRes = await request(url())
      .post('/api/onboarding')
      .set('Authorization', `Bearer ${token}`)
      .field('language', 'en-US')
      .attach('q1', silentMp3Buffer(), { filename: 'q1.m4a', contentType: 'audio/mp4' })
      .attach('q2', silentMp3Buffer(), { filename: 'q2.m4a', contentType: 'audio/mp4' })
      .attach('voiceSample', silentMp3Buffer(), { filename: 'voice_sample.m4a', contentType: 'audio/mp4' });

    // STEP 2 PASS: 200 + voiceDebug block present + samples accepted.
    // NOTE: onboarding defers clone to the first affirmation call — cloneMode
    // will be "pending" here (samples saved, clone not yet triggered).
    expect(onboardingRes.status).toBe(200);
    expect(onboardingRes.body).toBeDefined();
    const voiceDebug = onboardingRes.body.voiceDebug;
    expect(voiceDebug).toBeTruthy();
    // Samples were received and saved
    expect(voiceDebug.sampleCount).toBeGreaterThanOrEqual(3);
    // STEP 2 PASS: 3 clips accepted, sampleCount >= 3, samples persisted to disk.

    // ── STEP 5 (before Steps 3+4): Request affirmation — this triggers clone ──
    // Architecture: clone is lazy — triggered on first affirmation request, not
    // during onboarding. Steps 3 and 4 are therefore verified after this call.
    const affRes = await request(url())
      .post('/api/affirmation/today')
      .set('Authorization', `Bearer ${token}`)
      .send({
        context: {
          blocker:  'fear of failure',
          vision:   'launch ALZO worldwide',
          goal:     'ship flow-40 clean',
        },
        language:               'en-US',
        detectedGender:         'male',
        timezoneOffsetMinutes:  240,
      });

    // STEP 5 PASS: 200 + audioUrl present
    expect(affRes.status).toBe(200);
    const audioUrl = affRes.body.audioUrl;

    // ── STEP 3: Assert clone generation was triggered (ElevenLabs mock hit) ───
    // The mock intercepts POST /v1/voices/add and increments cloneCalls.
    // This MUST be checked AFTER affirmation/today, which is the trigger point.
    expect(elState.cloneCalls).toBeGreaterThanOrEqual(1);
    const affVoiceDebug = affRes.body.voiceDebug;
    if (affVoiceDebug) {
      expect(['cloned', 'clone_reused'].some((m) => affVoiceDebug.cloneMode === m)).toBe(true);
    }
    // STEP 3 PASS: ElevenLabs POST /v1/voices/add intercepted (cloneCalls >= 1).

    // ── STEP 4: Assert voice_id is persisted in the DB ────────────────────────
    const Database = require('better-sqlite3');
    const db  = new Database(TEST_DB);
    const row = db.prepare('SELECT elevenlabsVoiceId FROM users WHERE email = ?').get(email);
    db.close();
    expect(row).toBeTruthy();
    expect(row.elevenlabsVoiceId).toBeTruthy();
    // The stored voice_id must match the mock-generated pattern
    expect(row.elevenlabsVoiceId).toMatch(/voice_clone_f40_/);
    // STEP 4 PASS: voice_id written to users.elevenlabsVoiceId in SQLite.
    expect(audioUrl).toBeTruthy();
    expect(typeof audioUrl).toBe('string');
    expect(audioUrl.length).toBeGreaterThan(0);
    // STEP 5 PASS: /api/affirmation/today returned a non-empty audioUrl.

    // ── STEP 6: Fetch the playback URL and assert non-empty audio response ────
    const audioRes = await request(url()).get(audioUrl);
    expect(audioRes.status).toBe(200);
    // Must have audio content
    const contentType = audioRes.headers['content-type'] || '';
    expect(contentType).toMatch(/audio/);
    // Body must be non-empty bytes
    expect(audioRes.body).toBeTruthy();
    // If body is a Buffer, check length; if a string fallback, check that too
    const bodyLen =
      Buffer.isBuffer(audioRes.body) ? audioRes.body.length :
      typeof audioRes.body === 'string' ? audioRes.body.length :
      (audioRes.body && typeof audioRes.body === 'object') ? JSON.stringify(audioRes.body).length : 0;
    expect(bodyLen).toBeGreaterThan(0);
    // STEP 6 PASS: audioUrl is fetchable and returns audio/mpeg bytes.
  }, 30000);
});
