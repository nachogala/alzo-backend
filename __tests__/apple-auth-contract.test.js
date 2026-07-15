'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const request = require('supertest');
const sentryStub = require('./__mocks__/sentry-stub');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'alzo-apple-auth-'));
const TEST_DB = path.join(TEST_ROOT, 'alzo.db');

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function unsignedIdentityToken(payload) {
  return `${base64UrlJson({ alg: 'RS256', kid: 'apple-test-key' })}.${base64UrlJson(payload)}.test-signature`;
}

function decodePayload(token) {
  return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
}

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

describe('Apple native identity-token audience contract', () => {
  let serverHandle;
  let verifyIdToken;
  let port;

  beforeAll(async () => {
    port = await pickFreePort();
    process.env.DB_PATH = TEST_DB;
    process.env.PORT = String(port);
    process.env.NODE_ENV = 'test';
    process.env.SENTRY_DSN = '';
    delete process.env.APPLE_BUNDLE_ID;

    verifyIdToken = jest.fn(async (identityToken, options) => {
      const payload = decodePayload(identityToken);
      if (payload.aud !== options.audience) {
        throw new Error(`jwt audience invalid. expected: ${options.audience}`);
      }
      return payload;
    });
    jest.resetModules();
    jest.doMock('apple-signin-auth', () => ({ verifyIdToken }));

    const before = new Set(
      process._getActiveHandles().filter((handle) => handle?.constructor?.name === 'Server')
    );
    require(path.resolve(__dirname, '..', 'server.js'));
    await waitForPort(port);
    const after = process._getActiveHandles().filter((handle) => handle?.constructor?.name === 'Server');
    serverHandle = after.find((handle) => !before.has(handle));
  });

  beforeEach(() => {
    sentryStub._reset();
    verifyIdToken.mockImplementation(async (identityToken, options) => {
      const payload = decodePayload(identityToken);
      if (payload.aud !== options.audience) {
        throw new Error(`jwt audience invalid. expected: ${options.audience}`);
      }
      return payload;
    });
  });

  afterAll(async () => {
    if (serverHandle && typeof serverHandle.close === 'function') {
      await new Promise((resolve) => serverHandle.close(() => resolve()));
    }
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    delete process.env.APPLE_BUNDLE_ID;
    jest.dontMock('apple-signin-auth');
  });

  test('accepts a fresh native token whose aud is the canonical com.alzo.app3 bundle', async () => {
    const now = Math.floor(Date.now() / 1000);
    const identityToken = unsignedIdentityToken({
      iss: 'https://appleid.apple.com',
      aud: 'com.alzo.app3',
      sub: 'apple-native-app3-user',
      email: 'apple-app3@example.test',
      iat: now,
      exp: now + 300,
    });

    const response = await request(`http://127.0.0.1:${port}`)
      .post('/api/auth/apple')
      .set('x-request-id', 'req_apple_app3_contract')
      .set('x-correlation-id', 'corr_apple_app3_contract')
      .set('x-alzo-session-id', 'session_apple_app3_contract')
      .send({ identityToken });

    expect(verifyIdToken).toHaveBeenCalledWith(identityToken, {
      audience: 'com.alzo.app3',
      ignoreExpiration: false,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      accountCreated: true,
      isNewUser: true,
      provider: 'apple',
    }));
  });

  test.each([
    ['jwt audience invalid. expected: com.alzo.app', 'audience_mismatch'],
    ['jwt expired', 'expired'],
    ['jwt malformed', 'malformed'],
  ])('returns and captures the safe %s classification', async (message, reasonCode) => {
    verifyIdToken.mockRejectedValueOnce(new Error(message));
    const now = Math.floor(Date.now() / 1000);
    const identityToken = unsignedIdentityToken({
      iss: 'https://appleid.apple.com',
      aud: 'com.alzo.app3',
      sub: `apple-${reasonCode}`,
      email: `${reasonCode}@example.test`,
      iat: now,
      exp: now + 300,
    });

    const response = await request(`http://127.0.0.1:${port}`)
      .post('/api/auth/apple')
      .set('x-request-id', `req_${reasonCode}`)
      .set('x-correlation-id', `corr_${reasonCode}`)
      .set('x-alzo-session-id', `session_${reasonCode}`)
      .send({ identityToken, email: `${reasonCode}@example.test` });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Authentication failed', reasonCode });
    const event = sentryStub.getMessages().find((entry) => entry.msg === 'auth.apple.verify.failed');
    expect(event).toEqual(expect.objectContaining({
      opts: expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          provider: 'apple',
          reason_code: reasonCode,
          request_id: `req_${reasonCode}`,
          correlation_id: `corr_${reasonCode}`,
          session_id: `session_${reasonCode}`,
        }),
        extra: {
          provider: 'apple',
          status: 401,
          reasonCode,
          requestId: `req_${reasonCode}`,
          correlationId: `corr_${reasonCode}`,
          sessionId: `session_${reasonCode}`,
        },
      }),
    }));
    const serializedEvent = JSON.stringify(event);
    expect(serializedEvent).not.toContain(identityToken);
    expect(serializedEvent).not.toContain(`${reasonCode}@example.test`);
    expect(serializedEvent).not.toContain('identityToken');
    expect(serializedEvent).not.toContain('body');
  });
});
