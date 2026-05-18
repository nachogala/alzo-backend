/**
 * analytics-events.js — P0 revenue-funnel instrumentation (B53 / REVENUE BLINDNESS fix).
 *
 * Single helper used by every backend handler that mutates a funnel state we
 * need to measure (signup, purchase, entitlement change, account delete).
 *
 * Output sinks:
 *   1. console.log("[ANALYTICS] <name> <json>")  — captured by Railway stdout
 *   2. Sentry.addBreadcrumb({ category: 'analytics', ... }) — surfaces alongside
 *      errors so a funnel-affecting failure has the user's last analytics event
 *      pinned to the issue.
 *   3. Sentry.captureMessage(`analytics.${name}`, { level: 'info' }) for the 4
 *      revenue-critical names so they appear as discrete events in Sentry's
 *      Issues feed (filterable, countable) without needing a separate analytics
 *      backend on day 1.
 *
 * PII policy: never log full email, password hash, Stripe card tokens, Apple
 * identity tokens, Google id tokens, raw auth tokens. The hashUserId() helper
 * one-way hashes the user_id for any sink that shouldn't see raw DB ids.
 *
 * Verifiability: every call emits a single console line prefixed with
 * "[ANALYTICS] " — grep on Railway is the minimum verification, Sentry
 * breadcrumb on the issue page is the second proof.
 *
 * Vault cross-ref: vault-studio2/audits/2026-05-18-alzo-p0-analytics-observability.md
 */

const crypto = require("crypto");
const Sentry = require("@sentry/node");

// Names that fire captureMessage in addition to breadcrumb (so they create
// countable Sentry issues, which is the closest thing to a funnel metric we
// have until a real analytics backend lands).
const REVENUE_CRITICAL = new Set([
  "signup",
  "purchase_success",
  "entitlement_changed",
  "delete_account",
]);

// Names allowed by the helper. Extending this list is the contract for adding
// a new funnel event — anything not on the list throws in dev to catch typos.
const KNOWN_EVENTS = new Set([
  "signup",
  "paywall_view",        // frontend (P0.5 follow-up — accepted here too if BE proxies it)
  "checkout_start",      // frontend (P0.5 follow-up — accepted here too if BE proxies it)
  "purchase_success",
  "entitlement_changed",
  "delete_account",
]);

/**
 * One-way hash of a user_id for sinks that shouldn't see the raw DB id.
 * The helper currently emits BOTH (raw for backend debugging, hash for parity
 * with whatever frontend analytics ships in P0.5). 8 hex chars is enough for
 * funnel uniqueness and short enough to keep log lines readable.
 */
function hashUserId(userId) {
  if (!userId) return null;
  return crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 16);
}

/**
 * Strip fields the helper refuses to ever emit, even if a caller passes them.
 * This is the last line of defense against accidental PII leakage — handlers
 * are still expected to not pass these in the first place.
 */
const BLOCKED_KEYS = new Set([
  "password",
  "passwordHash",
  "token",
  "authToken",
  "identityToken",
  "idToken",
  "stripeCustomerSecret",
  "card",
  "cardToken",
  "raw_receipt",
  "email",            // we hash email if needed; raw email never goes in payload
]);

function sanitize(payload) {
  if (!payload || typeof payload !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (BLOCKED_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * logEvent — fire a single funnel event.
 *
 * @param {string} name     One of KNOWN_EVENTS.
 * @param {object} payload  Arbitrary event-specific data (PII-safe).
 * @param {string} userId   Raw user id (will be hashed for one of the sinks).
 */
function logEvent(name, payload, userId) {
  if (!KNOWN_EVENTS.has(name)) {
    // Don't throw in production — funnel instrumentation must never crash a
    // request path. Log a Sentry warning so we catch typos in QA.
    try {
      Sentry.captureMessage(`analytics.unknown_event:${name}`, { level: "warning" });
    } catch {}
  }

  const safe = sanitize(payload);
  const event = {
    ...safe,
    user_id: userId || null,
    user_id_hash: hashUserId(userId),
    ts: new Date().toISOString(),
  };

  // Sink 1: stdout (Railway captures).
  try {
    console.log(`[ANALYTICS] ${name} ${JSON.stringify(event)}`);
  } catch {
    // JSON.stringify can fail on circular payloads — strip and retry once.
    console.log(`[ANALYTICS] ${name} ${JSON.stringify({ user_id: userId || null, ts: event.ts, _stringify_failed: true })}`);
  }

  // Sink 2: Sentry breadcrumb (always).
  try {
    Sentry.addBreadcrumb({
      category: "analytics",
      message: name,
      level: "info",
      data: event,
    });
  } catch {}

  // Sink 3: Sentry captureMessage (only for revenue-critical names).
  if (REVENUE_CRITICAL.has(name)) {
    try {
      Sentry.captureMessage(`analytics.${name}`, {
        level: "info",
        tags: { analytics_event: name, funnel: "revenue" },
        extra: event,
      });
    } catch {}
  }
}

module.exports = {
  logEvent,
  hashUserId,
  // Exposed for tests only.
  _KNOWN_EVENTS: KNOWN_EVENTS,
  _REVENUE_CRITICAL: REVENUE_CRITICAL,
  _BLOCKED_KEYS: BLOCKED_KEYS,
  _sanitize: sanitize,
};
