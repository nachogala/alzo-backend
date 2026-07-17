'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const request = require('supertest');
const sentryStub = require('./__mocks__/sentry-stub');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'alzo-google-auth-'));
const TEST_DB = path.join(TEST_ROOT, 'alzo.db');
const GOOGLE_WEB_CLIENT_ID = 'qa-web-client.apps.googleusercontent.com';

function pickFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server failed to bind on 127.0.0.1:${port}`);
}

describe('Google native ID-token authoritative auth contract', () => {
  let serverHandle;
  let verifyIdToken;
  let port;

  beforeAll(async () => {
    port = await pickFreePort();
    process.env.DB_PATH = TEST_DB;
    process.env.PORT = String(port);
    process.env.NODE_ENV = 'test';
    process.env.SENTRY_DSN = '';
    process.env.GOOGLE_WEB_CLIENT_ID = GOOGLE_WEB_CLIENT_ID;

    verifyIdToken = jest.fn(async () => ({
      getPayload: () => ({ sub: 'google-qa-user', email: 'google@qa.alzo.app' }),
    }));
    jest.resetModules();
    jest.doMock('google-auth-library', () => ({
      OAuth2Client: jest.fn(() => ({ verifyIdToken })),
    }));

    const before = new Set(process._getActiveHandles().filter((handle) => handle?.constructor?.name === 'Server'));
    require(path.resolve(__dirname, '..', 'server.js'));
    await waitForPort(port);
    const after = process._getActiveHandles().filter((handle) => handle?.constructor?.name === 'Server');
    serverHandle = after.find((handle) => !before.has(handle));
  });

  beforeEach(() => {
    sentryStub._reset();
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: 'google-qa-user', email: 'google@qa.alzo.app' }),
    });
  });

  afterAll(async () => {
    if (serverHandle && typeof serverHandle.close === 'function') {
      await new Promise((resolve) => serverHandle.close(() => resolve()));
    }
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    delete process.env.GOOGLE_WEB_CLIENT_ID;
    jest.dontMock('google-auth-library');
  });

  test('verifies against GOOGLE_WEB_CLIENT_ID and returns the authoritative provider shape', async () => {
    const idToken = 'qa-google-native-id-token';
    const response = await request(`http://127.0.0.1:${port}`)
      .post('/api/auth/google')
      .send({ idToken, name: 'Google QA' });

    expect(verifyIdToken).toHaveBeenCalledWith({ idToken, audience: GOOGLE_WEB_CLIENT_ID });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      token: expect.any(String),
      accountCreated: true,
      isNewUser: true,
      provider: 'google',
      profile: expect.objectContaining({
        id: expect.any(String),
        email: 'google@qa.alzo.app',
        displayName: 'Google QA',
      }),
    }));
  });

  test.each([
    ['Wrong recipient, payload audience != requiredAudience', 'audience_mismatch'],
    ['Token used too late, expired', 'expired'],
    ['Wrong number of segments', 'malformed'],
  ])('returns and captures only the safe %s classification', async (message, reasonCode) => {
    verifyIdToken.mockRejectedValueOnce(new Error(message));
    const idToken = `private-google-token-${reasonCode}`;
    const response = await request(`http://127.0.0.1:${port}`)
      .post('/api/auth/google')
      .set('x-request-id', `req_${reasonCode}`)
      .set('x-correlation-id', `corr_${reasonCode}`)
      .set('x-alzo-session-id', `session_${reasonCode}`)
      .send({ idToken, email: `${reasonCode}@example.test` });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Authentication failed', reasonCode });
    const event = sentryStub.getMessages().find((entry) => entry.msg === 'auth.google.verify.failed');
    expect(event).toEqual(expect.objectContaining({
      opts: expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          provider: 'google',
          reason_code: reasonCode,
          request_id: `req_${reasonCode}`,
          correlation_id: `corr_${reasonCode}`,
          session_id: `session_${reasonCode}`,
        }),
        extra: {
          provider: 'google',
          status: 401,
          reasonCode,
          requestId: `req_${reasonCode}`,
          correlationId: `corr_${reasonCode}`,
          sessionId: `session_${reasonCode}`,
        },
      }),
    }));
    const serializedEvent = JSON.stringify(event);
    expect(serializedEvent).not.toContain(idToken);
    expect(serializedEvent).not.toContain(message);
    expect(serializedEvent).not.toContain(`${reasonCode}@example.test`);
  });
});
