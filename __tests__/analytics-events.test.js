/**
 * analytics-events.test.js — unit tests for the 6 funnel events helper.
 *
 * Verifies each of the 6 documented events fires the expected sink:
 *   - stdout line begins with "[ANALYTICS] <name> "
 *   - Sentry breadcrumb pushed with category 'analytics'
 *   - Revenue-critical events also captureMessage(level: 'info')
 *   - PII-blocked keys are stripped
 *
 * Uses the existing sentry-stub via the Jest moduleNameMapper, so the breadcrumb
 * + message log lives in globalThis.__SENTRY_STUB_STATE__.
 */

const sentryStub = require("./__mocks__/sentry-stub");
const analytics = require("../lib/analytics-events");

const EVENT_NAMES = [
  "signup",
  "paywall_view",
  "checkout_start",
  "purchase_success",
  "entitlement_changed",
  "delete_account",
];

const REVENUE_CRITICAL = new Set([
  "signup",
  "purchase_success",
  "entitlement_changed",
  "delete_account",
]);

function captureStdout(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

describe("analytics-events helper — 6 funnel events", () => {
  beforeEach(() => {
    sentryStub._reset();
  });

  for (const name of EVENT_NAMES) {
    test(`event "${name}" fires console + breadcrumb`, () => {
      const userId = "u_test_" + name;
      const payload = { source: "test", plan: "trial" };

      const lines = captureStdout(() => {
        analytics.logEvent(name, payload, userId);
      });

      // Sink 1: stdout
      const matched = lines.find((l) => l.startsWith(`[ANALYTICS] ${name} `));
      expect(matched).toBeDefined();
      // Body must be valid JSON after the name prefix
      const jsonStr = matched.substring(`[ANALYTICS] ${name} `.length);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.user_id).toBe(userId);
      expect(parsed.user_id_hash).toMatch(/^[a-f0-9]{16}$/);
      expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(parsed.source).toBe("test");

      // Sink 2: Sentry breadcrumb
      const breadcrumbs = sentryStub.getBreadcrumbs();
      const bc = breadcrumbs.find((b) => b.category === "analytics" && b.message === name);
      expect(bc).toBeDefined();
      expect(bc.level).toBe("info");
      expect(bc.data.user_id).toBe(userId);

      // Sink 3: Sentry captureMessage — only revenue-critical events
      const messages = sentryStub.getMessages();
      const msg = messages.find((m) => m.msg === `analytics.${name}`);
      if (REVENUE_CRITICAL.has(name)) {
        expect(msg).toBeDefined();
        expect(msg.opts.level).toBe("info");
        expect(msg.opts.tags.analytics_event).toBe(name);
        expect(msg.opts.tags.funnel).toBe("revenue");
      } else {
        expect(msg).toBeUndefined();
      }
    });
  }

  test("PII-blocked keys are stripped from payload", () => {
    const lines = captureStdout(() => {
      analytics.logEvent("signup", {
        password: "hunter2",
        identityToken: "apple_secret",
        idToken: "google_secret",
        email: "leak@example.com",
        token: "auth_secret",
        cardToken: "tok_visa",
        safe_field: "ok",
      }, "u_pii_test");
    });
    const line = lines.find((l) => l.startsWith("[ANALYTICS] signup "));
    expect(line).toBeDefined();
    for (const banned of ["hunter2", "apple_secret", "google_secret", "leak@example.com", "auth_secret", "tok_visa"]) {
      expect(line).not.toContain(banned);
    }
    expect(line).toContain("safe_field");
  });

  test("unknown event name does not throw, surfaces Sentry warning", () => {
    expect(() => {
      captureStdout(() => analytics.logEvent("not_a_real_event", {}, "u1"));
    }).not.toThrow();
    const warnings = sentryStub.getMessages().filter((m) => m.msg.startsWith("analytics.unknown_event:"));
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("hashUserId is deterministic and 16-char hex", () => {
    const a = analytics.hashUserId("u1");
    const b = analytics.hashUserId("u1");
    const c = analytics.hashUserId("u2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    expect(analytics.hashUserId(null)).toBeNull();
  });
});
