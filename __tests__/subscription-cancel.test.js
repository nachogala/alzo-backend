const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const request = require('supertest');

const backendRoot = path.resolve(__dirname, '..');
const testDir = path.join(os.tmpdir(), 'alzo-subscription-cancel-test');
const TEST_DB = path.join(testDir, 'alzo.db');

let serverHandle = null;
let stripeInstances = [];

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function bootServer() {
  if (serverHandle) await closeServer();
  fs.mkdirSync(testDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + suffix); } catch (_) {}
  }

  const port = await pickFreePort();
  process.env.DB_PATH = TEST_DB;
  process.env.PORT = String(port);
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_cancel_route';
  process.env.SENTRY_DSN = '';
  process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';

  stripeInstances = [];
  jest.resetModules();
  jest.doMock('stripe', () => jest.fn().mockImplementation(() => {
    const instance = {
      subscriptions: {
        update: jest.fn().mockResolvedValue({
          id: 'sub_cancel_test',
          status: 'active',
          cancel_at_period_end: true,
        }),
      },
      webhooks: {
        constructEvent: jest.fn(),
      },
      customers: {
        create: jest.fn(),
        retrieve: jest.fn(),
      },
      checkout: {
        sessions: {
          create: jest.fn(),
        },
      },
    };
    stripeInstances.push(instance);
    return instance;
  }));

  const before = new Set(
    process._getActiveHandles().filter((h) => h?.constructor?.name === 'Server')
  );
  require(path.join(backendRoot, 'server.js'));

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (ok) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const after = process._getActiveHandles().filter((h) => h?.constructor?.name === 'Server');
  serverHandle = after.find((h) => !before.has(h));
  return port;
}

function closeServer() {
  return new Promise((resolve) => {
    if (!serverHandle?.close) return resolve();
    serverHandle.close(() => resolve());
    setTimeout(resolve, 1000);
  }).finally(() => {
    serverHandle = null;
  });
}

async function signup(baseUrl) {
  const email = `cancel-${Date.now()}-${Math.random().toString(36).slice(2)}@maestro.local`;
  const res = await request(baseUrl)
    .post('/api/auth/signup')
    .send({ email, password: 'test-pass-1234', name: 'Cancel QA' });
  expect(res.status).toBe(200);
  return { email, token: res.body.token };
}

function attachSubscription(email, subId = 'sub_cancel_test') {
  const db = new Database(TEST_DB);
  db.prepare(
    'UPDATE users SET stripeCustomerId = ?, stripeSubscriptionId = ?, subscriptionStatus = ?, subscriptionCurrentPeriodEnd = ? WHERE email = ?'
  ).run('cus_cancel_test', subId, 'active', 1893456000, email);
  db.close();
}

function readUser(email) {
  const db = new Database(TEST_DB, { readonly: true });
  const user = db.prepare('SELECT plan, stripeSubscriptionId, subscriptionStatus FROM users WHERE email = ?').get(email);
  db.close();
  return user;
}

afterEach(async () => {
  await closeServer();
  jest.dontMock('stripe');
});

test('POST /api/subscription/cancel requests Stripe cancel_at_period_end and does not mark the local plan Cancelled', async () => {
  const port = await bootServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { email, token } = await signup(baseUrl);
  attachSubscription(email);

  const first = await request(baseUrl)
    .post('/api/subscription/cancel')
    .set('Authorization', `Bearer ${token}`);
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    success: true,
    cancelAtPeriodEnd: true,
    subscriptionStatus: 'active',
  });

  const stripe = stripeInstances[0];
  expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_cancel_test', {
    cancel_at_period_end: true,
  });
  expect(readUser(email)).toMatchObject({
    plan: 'Free Trial',
    stripeSubscriptionId: 'sub_cancel_test',
    subscriptionStatus: 'active',
  });

  const second = await request(baseUrl)
    .post('/api/subscription/cancel')
    .set('Authorization', `Bearer ${token}`);
  expect(second.status).toBe(200);
  expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
});
