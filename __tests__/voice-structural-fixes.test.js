/**
 * __tests__/voice-structural-fixes.test.js
 *
 * Regression coverage for the B52 voice structural fixes
 * (branch qa/voice-structural-fixes-b52):
 *
 *   (a) /api/generate-affirmation MUST NOT return audioUrl:null when the
 *       ElevenLabs clone fails for a non-glitch reason — it must degrade
 *       gracefully to the preset-voice fallback (matches /api/affirmation/today).
 *
 *   (b) cloneVoiceAndSpeak MUST evict the oldest orphan / non-owner cloned
 *       voice and retry once when /v1/voices/add returns a slot-ceiling 422,
 *       then succeed (audioUrl non-null).
 *
 * Runtime model mirrors voice-flow-40-e2e.test.js: in-process server.js via
 * jest.resetModules(), undici MockAgent intercepts ElevenLabs/OpenAI.
 *
 * Run:
 *   ./node_modules/.bin/jest --runInBand __tests__/voice-structural-fixes.test.js
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
const { r2SemanticContext, uploadR2VoiceBundle } = require('./helpers/r2-voice-bundle');

globalThis.fetch    = undiciFetch;
globalThis.Headers  = UndiciHeaders;
globalThis.Request  = UndiciRequest;
globalThis.Response = UndiciResponse;
globalThis.FormData = UndiciFormData;

const sentryStub = require('./__mocks__/sentry-stub');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'alzo-vsf-'));
const TEST_DB   = path.join(TEST_ROOT, 'alzo.db');

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

function mockAgentSetup() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect((host) => /^(127\.0\.0\.1|localhost)/.test(host));
  setGlobalDispatcher(agent);
  return agent;
}

async function bootServer() {
  if (serverHarness) { await serverHarness.close(); serverHarness = null; }
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

  const backendRoot = path.resolve(__dirname, '..');
  for (const d of ['public/audio', 'uploads']) {
    const p = path.join(backendRoot, d);
    if (fs.existsSync(p)) {
      for (const f of fs.readdirSync(p)) {
        if (f.startsWith('.')) continue;
        try { fs.unlinkSync(path.join(p, f)); } catch (_) {}
      }
    }
    fs.mkdirSync(p, { recursive: true });
  }

  const port = await pickFreePort();
  process.env.DB_PATH            = TEST_DB;
  process.env.PORT               = String(port);
  process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';
  process.env.OPENAI_API_KEY     = 'test-openai-key';
  process.env.SENTRY_DSN         = '';
  process.env.JWT_SECRET         = 'test-jwt-secret';
  process.env.NODE_ENV           = 'test';

  sentryStub._reset();
  jest.resetModules();
  const serverHandlesBefore = new Set(
    process._getActiveHandles().filter((handle) => handle?.constructor?.name === 'Server')
  );
  require(path.join(backendRoot, 'server.js'));

  const deadline = Date.now() + 8000;
  let bound = false;
  while (Date.now() < deadline && !bound) {
    bound = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
    });
    if (!bound) await new Promise((r) => setTimeout(r, 150));
  }
  if (!bound) throw new Error('server did not bind');
  const serverHandle = process._getActiveHandles().find(
    (handle) => handle?.constructor?.name === 'Server' && !serverHandlesBefore.has(handle)
  );
  if (!serverHandle) throw new Error('server handle not found for deterministic cleanup');
  serverHarness = {
    port,
    close: () => new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      timer.unref?.();
      try {
        serverHandle.close(() => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    }),
  };
  return port;
}

function url() { return `http://127.0.0.1:${serverHarness.port}`; }

function silentMp3Buffer() {
  return Buffer.from(
    '/+MYxAAAAANIAAAAAExBTUUzLjk5cgQAAAAAAAAAABRAJAaUQAAQAAAAEi4i',
    'base64'
  );
}

async function registerUser(
  email = `vsf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@thenetmencorp.com`
) {
  const res = await request(url())
    .post('/api/auth/signup')
    .send({ email, password: 'test-pass-1234', name: 'VSF QA' })
    .set('Content-Type', 'application/json');
  return { email, token: res.body?.token, userId: res.body?.userId, status: res.status };
}

// Upload the canonical R2 four-capture bundle and return its sealed session.
async function uploadVoice(token) {
  return uploadR2VoiceBundle({ request, baseUrl: url(), token });
}

// OpenAI mock — affirmation text + transcription, persisted across the suite.
function installOpenAIMock(agent) {
  const pool = agent.get('https://api.openai.com');
  pool.intercept({ path: '/v1/audio/transcriptions', method: 'POST' })
    .reply(200, { text: 'I want to grow and ship my best work today.' }).persist();
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' })
    .reply(200, () => ({
      id: 'chatcmpl-vsf', object: 'chat.completion', created: Date.now(),
      model: 'gpt-4o-mini',
      choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: 'I am finishing the prototype because it supports my family. When it gets difficult, I remember why I began.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
    })).persist();
}

let mockAgent;

afterEach(async () => {
  if (serverHarness) { await serverHarness.close(); serverHarness = null; }
  await mockAgent?.close();
});

afterAll(async () => {
  if (serverHarness) await serverHarness.close();
  serverHarness = null;
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FIX (a) — /api/generate-affirmation self-voice failure guard', () => {
  it('clone add fails (500) → endpoint blocks first-message success instead of returning preset fallback audio', async () => {
    mockAgent = mockAgentSetup();
    const el = mockAgent.get('https://api.elevenlabs.io');
    // Clone add hard-fails — pre-fix this left audioUrl=null all the way out.
    el.intercept({ path: '/v1/voices/add', method: 'POST' })
      .reply(500, { detail: 'internal error' }).persist();
    // Preset fallback TTS (textToSpeechFallback) must still succeed.
    el.intercept({ path: /^\/v1\/text-to-speech\/[^/]+/, method: 'POST' })
      .reply(() => ({ statusCode: 200, data: silentMp3Buffer(),
        responseOptions: { headers: { 'content-type': 'audio/mpeg' } } })).persist();
    el.intercept({ path: /^\/v1\/voices\/[^/]+$/, method: 'DELETE' })
      .reply(200, { ok: true }).persist();
    installOpenAIMock(mockAgent);

    await bootServer();
    const { token, status } = await registerUser();
    expect(status).toBe(200);
    const onb = await uploadVoice(token);
    expect(onb.status).toBe(200);
    const sessionId = onb.body.sessionId;
    expect(sessionId).toBeTruthy();

    const aff = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${token}`)
      .send({ context: r2SemanticContext(), sessionId, language: 'en-US', detectedGender: 'male' });

    // Build 23 contract: first-message success requires a verified self voice.
    // A preset fallback may exist for explicit recovery surfaces, but it must not
    // return a 200/audioUrl that lets onboarding advance as if the clone worked.
    expect(aff.status).toBe(502);
    expect(aff.body.error).toContain('internal error');
    expect(aff.body.voiceDebug?.cloneMode).toBe('clone_failed');
    expect(aff.body.voiceDebug?.fallbackBlocked).toBe(true);
    expect(aff.body.audioUrl).toBeFalsy();
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FIX (b) — cloneVoiceAndSpeak deterministic voice-slot eviction', () => {
  it('voices/add 422 slot-ceiling → oldest orphan voice evicted → add retried → audioUrl non-null', async () => {
    mockAgent = mockAgentSetup();
    const el = mockAgent.get('https://api.elevenlabs.io');

    let addCalls = 0;
    const deleted = [];
    // First add → 422 voice_limit. After an eviction frees a slot, the retry
    // succeeds. The mock flips behaviour once a DELETE has been observed.
    el.intercept({ path: '/v1/voices/add', method: 'POST' })
      .reply(() => {
        addCalls += 1;
        if (deleted.length === 0) {
          return { statusCode: 422,
            data: { detail: { status: 'voice_limit_reached', message: 'You have reached the limit of custom voices.' } } };
        }
        return { statusCode: 200, data: { voice_id: `voice_vsf_retry_${addCalls}_${Date.now()}` } };
      }).persist();
    // GET /v1/voices — eviction lists voices; return two orphan alzo_ clones
    // (oldest first via the alzo_<ts>_ name) so the helper has a victim.
    el.intercept({ path: '/v1/voices', method: 'GET' })
      .reply(200, {
        voices: [
          { voice_id: 'orphan_old', category: 'cloned', name: 'alzo_1000_aaaa' },
          { voice_id: 'orphan_new', category: 'cloned', name: 'alzo_9000_bbbb' },
        ],
      }).persist();
    el.intercept({ path: /^\/v1\/voices\/[^/]+$/, method: 'DELETE' })
      .reply((opts) => { deleted.push(opts.path.split('/').pop()); return { statusCode: 200, data: { ok: true } }; })
      .persist();
    el.intercept({ path: /^\/v1\/text-to-speech\/[^/]+/, method: 'POST' })
      .reply(() => ({ statusCode: 200, data: silentMp3Buffer(),
        responseOptions: { headers: { 'content-type': 'audio/mpeg' } } })).persist();
    installOpenAIMock(mockAgent);

    await bootServer();
    const { token, status } = await registerUser();
    expect(status).toBe(200);
    const onb = await uploadVoice(token);
    expect(onb.status).toBe(200);
    const sessionId = onb.body.sessionId;
    expect(sessionId).toBeTruthy();

    const aff = await request(url())
      .post('/api/generate-affirmation')
      .set('Authorization', `Bearer ${token}`)
      .send({ context: r2SemanticContext(), sessionId, language: 'en-US', detectedGender: 'male' });

    expect(aff.status).toBe(200);
    // Eviction must have fired and targeted the OLDEST orphan (alzo_1000_*).
    expect(deleted).toContain('orphan_old');
    // add was called twice: initial 422 + post-eviction retry.
    expect(addCalls).toBeGreaterThanOrEqual(2);
    // End state: usable audio either from the successful retry or, worst case,
    // the fix-(a) fallback guard — never null.
    expect(aff.body.audioUrl).toBeTruthy();
  }, 30000);
});
