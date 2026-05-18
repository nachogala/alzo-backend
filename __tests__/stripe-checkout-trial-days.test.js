"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const request = require("supertest");

function pickFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function bootServer({ trialDays }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alzo-stripe-checkout-"));
  const port = await pickFreePort();
  const captured = { sessions: [], customers: [] };

  jest.resetModules();
  jest.doMock("stripe", () => {
    return jest.fn().mockImplementation(() => ({
      customers: {
        create: jest.fn(async (payload) => {
          captured.customers.push(payload);
          return { id: "cus_test_" + captured.customers.length };
        }),
      },
      checkout: {
        sessions: {
          create: jest.fn(async (payload) => {
            captured.sessions.push(payload);
            return { id: "cs_test_123", url: "https://checkout.stripe.test/session" };
          }),
        },
      },
    }));
  });

  process.env.DB_PATH = path.join(root, "alzo.db");
  process.env.PORT = String(port);
  process.env.STRIPE_SECRET_KEY = "sk_test_checkout";
  process.env.STRIPE_PRICE_ID = "price_test_monthly";
  process.env.TRIAL_DAYS = String(trialDays);
  process.env.SENTRY_DSN = "";
  process.env.NODE_ENV = "test";

  const before = new Set(
    process._getActiveHandles().filter((h) => h?.constructor?.name === "Server")
  );
  require("../server");

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const bound = await new Promise((resolve) => {
      const s = net.createConnection({ host: "127.0.0.1", port }, () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (bound) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const after = process._getActiveHandles().filter((h) => h?.constructor?.name === "Server");
  const handle = after.find((h) => !before.has(h));
  return {
    url: `http://127.0.0.1:${port}`,
    captured,
    close: () =>
      new Promise((resolve) => {
        if (!handle?.close) return resolve();
        handle.close(() => resolve());
        setTimeout(resolve, 1000);
      }),
  };
}

async function signup(baseUrl) {
  const email = `stripe-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}@thenetmencorp.com`;
  const res = await request(baseUrl)
    .post("/api/auth/signup")
    .send({ email, password: "test-pass-1234", name: "Stripe Checkout QA" });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeTruthy();
  return res.body.token;
}

describe("Stripe checkout trial days", () => {
  test("omits trial_period_days when TRIAL_DAYS=0", async () => {
    const server = await bootServer({ trialDays: 0 });
    try {
      const token = await signup(server.url);
      const res = await request(server.url)
        .post("/api/stripe/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(200);
      expect(server.captured.sessions[0].subscription_data).toEqual({
        metadata: expect.any(Object),
      });
      expect(server.captured.sessions[0].subscription_data).not.toHaveProperty("trial_period_days");
    } finally {
      await server.close();
    }
  });

  test("keeps trial_period_days when TRIAL_DAYS is positive", async () => {
    const server = await bootServer({ trialDays: 7 });
    try {
      const token = await signup(server.url);
      const res = await request(server.url)
        .post("/api/stripe/create-checkout-session")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(200);
      expect(server.captured.sessions[0].subscription_data.trial_period_days).toBe(7);
    } finally {
      await server.close();
    }
  });
});
