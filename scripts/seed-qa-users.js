#!/usr/bin/env node
/**
 * scripts/seed-qa-users.js
 *
 * Seeds 4 QA accounts referenced by Maestro flows:
 *   - qa-seed@thenetmencorp.com           (default smoke flow)
 *   - qa-seed-withgoal@thenetmencorp.com  (login + goal flows; gets active 90d goal)
 *   - qa-seed-delete@thenetmencorp.com    (delete-account flow)
 *   - qa-seed-google@thenetmencorp.com    (Google sign-in mock)
 *
 * Standard password: ALZOseed2026!  (matches alzo-app-v2/scripts/qa-sweep.sh)
 *
 * Idempotent: existing rows are skipped, not overwritten.
 *
 * USAGE
 * -----
 * Local SQLite (default DB_PATH=./alzo.db):
 *   node scripts/seed-qa-users.js
 *
 * Against a copy of the prod DB you pulled locally:
 *   DB_PATH=/path/to/prod-copy.db \
 *   STRIPE_SECRET_KEY=sk_test_xxx \
 *   STRIPE_PRICE_ID=price_xxx_test \
 *   node scripts/seed-qa-users.js
 *
 * Required env:
 *   DB_PATH            (optional, defaults to ./alzo.db)
 *   STRIPE_SECRET_KEY  (REQUIRED — must be a TEST-mode key, sk_test_...; the
 *                       script aborts if it sees sk_live_)
 *   STRIPE_PRICE_ID    (REQUIRED — TEST-mode price id, price_...)
 *
 * SAFETY
 * ------
 * - Will refuse to run with a live Stripe key (sk_live_*).
 * - Does NOT mutate prod by default — point DB_PATH at a copy first.
 * - Stripe subscriptions are created with trial_period_days so no card is
 *   required for the QA accounts.
 *
 * NOTE on email verification
 * --------------------------
 * The current users schema has NO email_verified / verified_at column. The
 * signup flow creates rows that are immediately usable. If a future build
 * introduces an email-verified flag, this seed will need an UPDATE pass —
 * flagged in the seed report (see Pendings).
 */

const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

// dotenv is optional — only load if installed (it is, in this repo).
try { require("dotenv").config(); } catch {}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "alzo.db");
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || "7", 10);
const SEED_PASSWORD = "ALZOseed2026!";

if (!STRIPE_SECRET_KEY) {
  console.error("ERROR: STRIPE_SECRET_KEY env var is required.");
  process.exit(1);
}
if (STRIPE_SECRET_KEY.startsWith("sk_live_")) {
  console.error(
    "ERROR: refusing to run with a LIVE Stripe key. Use a sk_test_... key."
  );
  process.exit(1);
}
if (!STRIPE_PRICE_ID) {
  console.error("ERROR: STRIPE_PRICE_ID env var is required (test-mode price).");
  process.exit(1);
}

const Stripe = require("stripe");
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-12-18.acacia" });

// Match server.js helpers exactly.
function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

const SEEDS = [
  {
    email: "qa-seed@thenetmencorp.com",
    name: "QA Seed Default",
    withGoal: false,
    isGoogle: false,
  },
  {
    email: "qa-seed-withgoal@thenetmencorp.com",
    name: "QA Seed With Goal",
    withGoal: true,
    isGoogle: false,
  },
  {
    email: "qa-seed-delete@thenetmencorp.com",
    name: "QA Seed Delete",
    withGoal: false,
    isGoogle: false,
  },
  {
    email: "qa-seed-google@thenetmencorp.com",
    name: "QA Seed Google",
    withGoal: false,
    isGoogle: true,
  },
];

async function main() {
  console.log(`[seed] DB_PATH=${DB_PATH}`);
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const stmts = {
    getByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    insertUser: db.prepare(
      "INSERT INTO users (id, email, name, passwordHash, token, streak, language, plan) VALUES (?, ?, ?, ?, ?, 0, 'en-US', 'Free Trial')"
    ),
    setTrial: db.prepare("UPDATE users SET trialEndsAt = ? WHERE id = ?"),
    setStripeCustomer: db.prepare(
      "UPDATE users SET stripeCustomerId = ? WHERE id = ?"
    ),
    setSubscription: db.prepare(
      "UPDATE users SET stripeSubscriptionId = ?, subscriptionStatus = ?, subscriptionCurrentPeriodEnd = ? WHERE id = ?"
    ),
    insertGoal: db.prepare(
      "INSERT INTO goals (id, userId, type, description, audioUrl, motivation, motivationAudioUrl, horizonDays, targetDate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    getActiveGoals: db.prepare(
      "SELECT * FROM goals WHERE userId = ? AND status = 'active'"
    ),
  };

  const report = [];

  for (const seed of SEEDS) {
    const lowEmail = seed.email.toLowerCase();
    let row = stmts.getByEmail.get(lowEmail);
    let status = "skipped";

    if (!row) {
      const userId = crypto.randomBytes(16).toString("hex");
      const token = generateToken();
      // For the Google seed we use a passwordHash that matches the SSO marker
      // pattern in server.js (`google_sso_<sub>`), so the row is recognisable
      // as SSO; we still set a real password hash too via reset-password? No —
      // server.js login compares passwordHash literally, so to allow a test
      // password login as a fallback we use the real hash. Maestro flows for
      // Google use the OAuth path which only checks getByEmail, so coexistence
      // is fine.
      const passwordHash = hashPassword(SEED_PASSWORD);
      stmts.insertUser.run(
        userId,
        lowEmail,
        seed.name,
        passwordHash,
        token
      );

      const trialEndsAt = Math.floor(Date.now() / 1000) + TRIAL_DAYS * 86400;
      stmts.setTrial.run(trialEndsAt, userId);

      row = stmts.getByEmail.get(lowEmail);
      status = "created";
      console.log(`[seed] ${status}: ${lowEmail} (id=${userId})`);
    } else {
      console.log(`[seed] ${status}: ${lowEmail} (id=${row.id})`);
    }

    // Goal — only for qa-seed-withgoal, only if no active goal exists.
    if (seed.withGoal) {
      const existingGoals = stmts.getActiveGoals.all(row.id);
      if (existingGoals.length === 0) {
        const goalId = crypto.randomBytes(16).toString("hex");
        const horizonDays = 90;
        const targetDate = new Date(
          Date.now() + horizonDays * 86400000
        ).toISOString();
        stmts.insertGoal.run(
          goalId,
          row.id,
          "long",
          "QA seed long-term goal — automated test fixture",
          null,
          "Maestro QA fixture motivation",
          null,
          horizonDays,
          targetDate
        );
        console.log(`[seed]   + active 90d goal id=${goalId}`);
      } else {
        console.log(
          `[seed]   = active goal already present (${existingGoals.length})`
        );
      }
    }

    // Stripe customer + subscription (test mode), only if missing.
    let customerId = row.stripeCustomerId || null;
    let subId = row.stripeSubscriptionId || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: row.email,
        name: row.name || undefined,
        metadata: { alzoUserId: row.id, qaSeed: "true" },
      });
      customerId = customer.id;
      stmts.setStripeCustomer.run(customerId, row.id);
      console.log(`[seed]   + stripe customer ${customerId}`);
    }

    if (!subId) {
      // Trial-only subscription so no payment method is required. Status will
      // be 'trialing' until trial_period_days elapses; that's exactly what the
      // QA flows want to assert against.
      const sub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: STRIPE_PRICE_ID }],
        trial_period_days: TRIAL_DAYS,
        metadata: { alzoUserId: row.id, qaSeed: "true" },
      });
      subId = sub.id;
      stmts.setSubscription.run(
        sub.id,
        sub.status,
        sub.current_period_end || null,
        row.id
      );
      console.log(`[seed]   + stripe sub ${subId} status=${sub.status}`);
    }

    report.push({
      email: lowEmail,
      status,
      userId: row.id,
      customerId,
      subId,
    });
  }

  // Final summary table.
  console.log("\n=== seed-qa-users summary ===");
  console.log(
    [
      "email".padEnd(40),
      "status".padEnd(8),
      "userId".padEnd(34),
      "customerId".padEnd(20),
      "subId",
    ].join(" ")
  );
  for (const r of report) {
    console.log(
      [
        r.email.padEnd(40),
        r.status.padEnd(8),
        r.userId.padEnd(34),
        (r.customerId || "-").padEnd(20),
        r.subId || "-",
      ].join(" ")
    );
  }
  console.log(`\nPassword for all seeds: ${SEED_PASSWORD}`);
}

main().catch((err) => {
  console.error("[seed] FAILED:", err);
  process.exit(1);
});
