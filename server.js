require("dotenv").config();
const Sentry = require("@sentry/node");

const SENTRY_PRIVATE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

function sanitizeSentryEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const request = event.request;
  if (!request || typeof request !== 'object') return event;

  // Backend events never need request bodies or cookies. Remove them before
  // they leave the process instead of relying on provider-side scrubbing.
  delete request.data;
  delete request.cookies;

  if (Array.isArray(request.headers)) {
    request.headers = request.headers.filter(([name]) => !SENTRY_PRIVATE_HEADER_NAMES.has(String(name).toLowerCase()));
  } else if (request.headers && typeof request.headers === 'object') {
    for (const name of Object.keys(request.headers)) {
      if (SENTRY_PRIVATE_HEADER_NAMES.has(name.toLowerCase())) delete request.headers[name];
    }
  }
  return event;
}

Sentry.init({
  dsn: process.env.SENTRY_DSN || "",
  enabled: !!process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "production",
  serverName: "alzo-backend",
  tracesSampleRate: 0.1,
  beforeSend: sanitizeSentryEvent,
});
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");
const Stripe = require("stripe");

const crypto = require("crypto");
const { execFile } = require("child_process");
const ffmpegStatic = require("ffmpeg-static");
const Database = require("better-sqlite3");
const { OAuth2Client } = require("google-auth-library");
const appleSignin = require("apple-signin-auth");
// feature/voice-quality-detector: capa 1 (pre-clone) + capa 2 (post-clone)
// audio quality detector. Backs the Sentry `elevenlabs.clone_failed` 46-hit
// regression observed in Build 51.
const voiceValidator = require("./backend/voice_validator");
// qa-mock-tts kill switch: QA/Maestro/internal-build users get a static silent
// MP3 instead of an ElevenLabs call. Saves quota; see lib/qa-mock-tts.js.
const qaMockTts = require("./lib/qa-mock-tts");
const alzoR2 = require("./lib/alzo-r2-contracts");
const dailyContextBoundary = require("./lib/daily-context-boundary");
const { buildAuthoritativeAuthResponse, normalizeAuthoritativeProfile } = require("./lib/auth-contract");
const { WIRE_CONTRACT_VERSION, VOICE_MULTIPART_FIELDS, VOICE_DURATION_RULE } = require("./lib/release-contract");
// P0 (B53 REVENUE BLINDNESS): 6-event funnel helper. logEvent fires stdout +
// Sentry breadcrumb + (for revenue-critical names) Sentry captureMessage.
// See vault audits/2026-05-18-alzo-p0-analytics-observability.md.
const { logEvent: logAnalyticsEvent } = require("./lib/analytics-events");

const app = express();
const PORT = process.env.PORT || process.env.RAILWAY_PORT || 8080;
const configuredSemanticResolutionTimeoutMs = Number(process.env.SEMANTIC_RESOLUTION_TIMEOUT_MS || 120000);
const SEMANTIC_RESOLUTION_TIMEOUT_MS = Number.isFinite(configuredSemanticResolutionTimeoutMs) && configuredSemanticResolutionTimeoutMs > 0
  ? configuredSemanticResolutionTimeoutMs
  : 120000;

// ── SQLite persistence ──────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || "./alzo.db");
db.pragma("journal_mode = WAL");
// B48-29: enforce FK so a partial cascade can never leave dangling rows. The
// SQLite default is off; better-sqlite3 inherits that, but our FK declarations
// in the schema are useless without this. Turning it on also surfaces FK
// violations as actionable Sentry events instead of silent corruption.
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    passwordHash TEXT NOT NULL,
    token TEXT,
    streak INTEGER DEFAULT 0,
    language TEXT DEFAULT 'en-US',
    plan TEXT DEFAULT 'Free Trial',
    notificationHour INTEGER DEFAULT 7,
    notificationMinute INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'long', -- 'long' (90d) or 'short' (7d)
    description TEXT,
    audioUrl TEXT,
    motivation TEXT,
    motivationAudioUrl TEXT,
    horizonDays INTEGER DEFAULT 90,
    startDate TEXT DEFAULT (datetime('now')),
    targetDate TEXT,
    status TEXT DEFAULT 'active', -- active, completed, abandoned
    completedAt TEXT,
    FOREIGN KEY (userId) REFERENCES users(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS checkins (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    goalId TEXT,
    intentionConfirmed INTEGER DEFAULT 1,
    emotionalState TEXT, -- centered, restless, shutdown, avoiding, activated
    energyLevel INTEGER DEFAULT 3, -- 1-5
    alignment TEXT, -- yes, mostly, no, avoided
    microcommitment TEXT,
    createdAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (goalId) REFERENCES goals(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS plants (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    goalId TEXT NOT NULL,
    species TEXT NOT NULL, -- monstera, orchid, lavender, etc.
    name TEXT, -- user-given name
    color TEXT DEFAULT '#6B4EFF', -- user-chosen accent color
    health REAL DEFAULT 1.0, -- 0.0 to 1.0
    growthStage REAL DEFAULT 0.0, -- 0.0 to 1.0
    lastCheckIn TEXT,
    status TEXT DEFAULT 'active', -- active, garden, withered
    createdAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (goalId) REFERENCES goals(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS garden (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    plantId TEXT NOT NULL,
    goalId TEXT NOT NULL,
    chronicle TEXT, -- the story generated when goal is completed
    unlockedAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (plantId) REFERENCES plants(id),
    FOREIGN KEY (goalId) REFERENCES goals(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    goalId TEXT,
    audioUrl TEXT,
    duration INTEGER, -- seconds
    createdAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id)
  );
`);

// Migrations for existing DBs
try { db.exec("ALTER TABLE plants ADD COLUMN color TEXT DEFAULT '#6B4EFF'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN notificationHour INTEGER DEFAULT 7"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN notificationMinute INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN elevenlabsVoiceId TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN stripeCustomerId TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN stripeSubscriptionId TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN subscriptionStatus TEXT DEFAULT 'none'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN subscriptionCurrentPeriodEnd INTEGER"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN trialEndsAt INTEGER"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS affirmations (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    dateKey TEXT NOT NULL,
    text TEXT,
    audioUrl TEXT,
    voiceMode TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(userId, dateKey),
    FOREIGN KEY (userId) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS milestones (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    goalId TEXT,
    type TEXT NOT NULL, -- 'streak_7', 'streak_30', 'streak_60', 'goal_completed', 'first_checkin', 'garden_first'
    title TEXT,
    narrative TEXT, -- AI-generated narrative summary
    dayNumber INTEGER, -- which day this milestone was reached
    unlockedAt TEXT DEFAULT (datetime('now')),
    shared INTEGER DEFAULT 0,
    FOREIGN KEY (userId) REFERENCES users(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    goalId TEXT,
    text TEXT,
    audioUrl TEXT,
    tone TEXT DEFAULT 'grounding', -- grounding, mirror, push
    listenedAt TEXT,
    listenedFull INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id)
  );
`);

// ── B48-4 migration: sanitize stale horizonDays values ────────────────
// Joaquín reported a goal showing 17 days on Home. Investigation showed FE
// reads `durationDays`/`goalDaysRemaining` and any non-(7,90) horizonDays in
// the DB will leak through both fields. Reset any stale rows so the type
// implies the duration: 'short' → 7, 'long' (or anything else) → 90.
// Idempotent: safe to re-run on every boot.
try {
  const stale = db.prepare(
    "SELECT id, type, horizonDays FROM goals WHERE horizonDays NOT IN (7, 90)"
  ).all();
  if (stale.length > 0) {
    console.log(`[migration B48-4] sanitizing ${stale.length} stale goal(s)`);
    const upd = db.prepare("UPDATE goals SET horizonDays = ? WHERE id = ?");
    const txn = db.transaction((rows) => {
      for (const r of rows) {
        const fixed = r.type === 'short' ? 7 : 90;
        upd.run(fixed, r.id);
      }
    });
    txn(stale);
  }
} catch (e) {
  console.error('[migration B48-4] failed:', e.message);
}

// Prepared statements
const stmts = {
  getByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  getByToken: db.prepare("SELECT * FROM users WHERE token = ?"),
  insert: db.prepare("INSERT INTO users (id, email, name, passwordHash, token, streak, language, plan) VALUES (?, ?, ?, ?, ?, 0, 'en-US', 'Free Trial')"),
  updateToken: db.prepare("UPDATE users SET token = ? WHERE email = ?"),
  updatePlan: db.prepare("UPDATE users SET plan = ? WHERE email = ?"),
  updateNotification: db.prepare("UPDATE users SET notificationHour = ?, notificationMinute = ? WHERE id = ?"),
  getVoiceId: db.prepare("SELECT elevenlabsVoiceId FROM users WHERE id = ?"),
  getAllVoiceIds: db.prepare("SELECT elevenlabsVoiceId FROM users WHERE elevenlabsVoiceId IS NOT NULL"),
  setVoiceId: db.prepare("UPDATE users SET elevenlabsVoiceId = ? WHERE id = ?"),
  getAffirmationByDate: db.prepare("SELECT * FROM affirmations WHERE userId = ? AND dateKey = ?"),
  insertAffirmation: db.prepare("INSERT INTO affirmations (id, userId, dateKey, text, audioUrl, voiceMode) VALUES (?, ?, ?, ?, ?, ?)"),
  countUsers: db.prepare("SELECT COUNT(*) AS n FROM users"),
  setStripeCustomer: db.prepare("UPDATE users SET stripeCustomerId = ? WHERE id = ?"),
  setSubscription: db.prepare("UPDATE users SET stripeSubscriptionId = ?, subscriptionStatus = ?, subscriptionCurrentPeriodEnd = ? WHERE id = ?"),
  setSubscriptionByCustomerId: db.prepare("UPDATE users SET stripeSubscriptionId = ?, subscriptionStatus = ?, subscriptionCurrentPeriodEnd = ? WHERE stripeCustomerId = ?"),
  setTrial: db.prepare("UPDATE users SET trialEndsAt = ? WHERE id = ?"),
  getUserByStripeCustomer: db.prepare("SELECT * FROM users WHERE stripeCustomerId = ?"),
  deleteUser: db.prepare("DELETE FROM users WHERE email = ?"),
  // B48-21: cascade delete prepared statements. SQLite has no ON DELETE
  // CASCADE configured for these tables, so we tear down each child table
  // explicitly inside a transaction. Tokens are tied to the users row, so
  // dropping the row revokes auth.
  deleteGoalsByUser:    db.prepare("DELETE FROM goals          WHERE userId = ?"),
  deleteCheckinsByUser: db.prepare("DELETE FROM checkins       WHERE userId = ?"),
  deletePlantsByUser:   db.prepare("DELETE FROM plants         WHERE userId = ?"),
  deleteGardenByUser:   db.prepare("DELETE FROM garden         WHERE userId = ?"),
  deleteJournalByUser:  db.prepare("DELETE FROM journal_entries WHERE userId = ?"),
  deleteAffirmationsByUser: db.prepare("DELETE FROM affirmations WHERE userId = ?"),
  deleteMilestonesByUser:   db.prepare("DELETE FROM milestones   WHERE userId = ?"),
  deleteMessagesByUser: db.prepare("DELETE FROM messages       WHERE userId = ?"),
  deleteUserById:       db.prepare("DELETE FROM users          WHERE id = ?"),
  // Goals
  insertGoal: db.prepare("INSERT INTO goals (id, userId, type, description, audioUrl, motivation, motivationAudioUrl, horizonDays, targetDate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  getActiveGoals: db.prepare("SELECT * FROM goals WHERE userId = ? AND status = 'active' ORDER BY type ASC"),
  getGoal: db.prepare("SELECT * FROM goals WHERE id = ? AND userId = ?"),
  completeGoal: db.prepare("UPDATE goals SET status = 'completed', completedAt = datetime('now') WHERE id = ?"),
  // Check-ins
  insertCheckin: db.prepare("INSERT INTO checkins (id, userId, goalId, intentionConfirmed, emotionalState, energyLevel, alignment, microcommitment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  getRecentCheckins: db.prepare("SELECT * FROM checkins WHERE userId = ? ORDER BY createdAt DESC LIMIT ?"),
  getTodayCheckin: db.prepare("SELECT * FROM checkins WHERE userId = ? AND date(createdAt) = date('now') LIMIT 1"),
  // Plants
  insertPlant: db.prepare("INSERT INTO plants (id, userId, goalId, species, name, color) VALUES (?, ?, ?, ?, ?, ?)"),
  getActivePlants: db.prepare("SELECT * FROM plants WHERE userId = ? AND status = 'active'"),
  getPlant: db.prepare("SELECT * FROM plants WHERE id = ? AND userId = ?"),
  updatePlantHealth: db.prepare("UPDATE plants SET health = ?, growthStage = ?, lastCheckIn = datetime('now') WHERE id = ?"),
  updatePlantName: db.prepare("UPDATE plants SET name = ? WHERE id = ? AND userId = ?"),
  movePlantToGarden: db.prepare("UPDATE plants SET status = 'garden' WHERE id = ?"),
  // Garden
  insertGarden: db.prepare("INSERT INTO garden (id, userId, plantId, goalId, chronicle) VALUES (?, ?, ?, ?, ?)"),
  getGarden: db.prepare("SELECT g.*, p.species, p.name as plantName FROM garden g JOIN plants p ON g.plantId = p.id WHERE g.userId = ? ORDER BY g.unlockedAt DESC"),
  // Journal
  insertJournal: db.prepare("INSERT INTO journal_entries (id, userId, goalId, audioUrl, duration) VALUES (?, ?, ?, ?, ?)"),
  getJournal: db.prepare("SELECT * FROM journal_entries WHERE userId = ? ORDER BY createdAt DESC LIMIT ?"),
  // Messages
  insertMessage: db.prepare("INSERT INTO messages (id, userId, goalId, text, audioUrl, tone) VALUES (?, ?, ?, ?, ?, ?)"),
  getTodayMessage: db.prepare("SELECT * FROM messages WHERE userId = ? AND date(createdAt) = date('now') ORDER BY createdAt DESC LIMIT 1"),
  markListened: db.prepare("UPDATE messages SET listenedAt = datetime('now'), listenedFull = ? WHERE id = ?"),
  // Milestones
  insertMilestone: db.prepare("INSERT INTO milestones (id, userId, goalId, type, title, narrative, dayNumber) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  getMilestones: db.prepare("SELECT * FROM milestones WHERE userId = ? ORDER BY unlockedAt DESC"),
  getMilestoneByType: db.prepare("SELECT * FROM milestones WHERE userId = ? AND type = ? LIMIT 1"),
  markMilestoneShared: db.prepare("UPDATE milestones SET shared = 1 WHERE id = ?"),
  // Plant with color
  updatePlantColor: db.prepare("UPDATE plants SET color = ? WHERE id = ? AND userId = ?"),
};

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getUserByToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return stmts.getByToken.get(token) || null;
}

// Ensure directories exist. Railway has a persistent volume mounted at /data;
// production should set AUDIO_STORAGE_DIR=/data/audio and UPLOAD_STORAGE_DIR=/data/uploads.
const AUDIO_STORAGE_DIR = process.env.AUDIO_STORAGE_DIR
  ? path.resolve(process.env.AUDIO_STORAGE_DIR)
  : path.join(__dirname, "public", "audio");
const AUDIO_PUBLIC_PATH = "/audio";
const UPLOAD_STORAGE_DIR = process.env.UPLOAD_STORAGE_DIR
  ? path.resolve(process.env.UPLOAD_STORAGE_DIR)
  : path.join(__dirname, "uploads");
const UPLOAD_PUBLIC_PATH = "/uploads";

fs.mkdirSync(UPLOAD_STORAGE_DIR, { recursive: true });
fs.mkdirSync(AUDIO_STORAGE_DIR, { recursive: true });

// Middleware
// Stripe webhook requires the raw body to verify the signature. Keep it
// un-parsed by the global JSON middleware and let the webhook route handle
// its own express.raw() parsing below.
app.use((req, res, next) => {
  if (req.originalUrl === "/api/stripe/webhook") return next();
  return express.json({ limit: "50mb" })(req, res, next);
});
app.use(AUDIO_PUBLIC_PATH, express.static(AUDIO_STORAGE_DIR, {
  immutable: true,
  maxAge: "30d",
}));
app.use(UPLOAD_PUBLIC_PATH, express.static(UPLOAD_STORAGE_DIR, {
  immutable: true,
  maxAge: "30d",
}));
app.use(express.static("public"));

// Multer for voice uploads
const upload = multer({
  dest: UPLOAD_STORAGE_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are allowed"));
    }
  },
});

// OpenAI client
// 2026-05-04: lazy + DeepSeek-or-OpenAI auto-detect.
// Prefers DEEPSEEK_API_KEY (cheaper, OpenAI-compatible). Falls back to OPENAI_API_KEY.
let _openai = null;
const openai = new Proxy({}, {
  get(_t, prop) {
    if (!_openai) {
      const dsk = process.env.DEEPSEEK_API_KEY;
      const oak = process.env.OPENAI_API_KEY;
      if (dsk) {
        _openai = new OpenAI({
          apiKey: dsk,
          baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1"
        });
        console.log("OpenAI client → DeepSeek (cost-optimized)");
      } else if (oak) {
        _openai = new OpenAI({ apiKey: oak });
        console.log("OpenAI client → OpenAI");
      } else {
        const err = new Error("Neither DEEPSEEK_API_KEY nor OPENAI_API_KEY is set");
        err.code = "OPENAI_KEY_MISSING";
        throw err;
      }
    }
    const v = _openai[prop];
    return typeof v === "function" ? v.bind(_openai) : v;
  }
});

// 2026-05-04: model name mapping. DeepSeek uses deepseek-v4-{flash,pro} instead of gpt-4o-{mini,}.
const _DEFAULT_MODEL = process.env.OPENAI_MODEL_DEFAULT || (process.env.DEEPSEEK_API_KEY ? "deepseek-v4-pro" : "gpt-4o");
const _MINI_MODEL = process.env.OPENAI_MODEL_MINI || (process.env.DEEPSEEK_API_KEY ? "deepseek-v4-flash" : "gpt-4o-mini");
const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID || "";
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "com.alzo.app3";
const googleAuthClient = GOOGLE_WEB_CLIENT_ID ? new OAuth2Client(GOOGLE_WEB_CLIENT_ID) : null;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-12-18.acacia" })
  : null;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || "7", 10);
const APP_URL = process.env.APP_URL || "https://alzo.thenetmencorp.com";

// ElevenLabs config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

function recordVoiceMetric(event, fields = {}) {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  console.log(`[voice_metric] ${JSON.stringify(payload)}`);
  Sentry.addBreadcrumb({
    category: "voice.metric",
    level: fields.level || "info",
    message: event,
    data: payload,
  });
}

// ── Generate affirmation text via GPT-4o ─────────────────────────────

// Explicit, forceful language instructions — no auto-detection
const LANGUAGE_INSTRUCTIONS = {
  'en-US': 'Write ENTIRELY in American English. Do NOT use Spanish or any other language, regardless of what language the input context is in.',
  'es-AR': 'Escribí ENTERAMENTE en español rioplatense (vos, che, etc.). No uses inglés ni ningún otro idioma, sin importar el idioma del contexto recibido.',
  'es-MX': 'Escribe ENTERAMENTE en español mexicano (tú). No uses inglés ni ningún otro idioma, sin importar el idioma del contexto recibido.',
  'es-CO': 'Escribe ENTERAMENTE en español colombiano. No uses inglés ni ningún otro idioma, sin importar el idioma del contexto recibido.',
  'pt-BR': 'Escreva INTEIRAMENTE em português brasileiro (você). Não use inglês nem nenhum outro idioma, independente do idioma do contexto recebido.',
  'es-ES': 'Escribe ENTERAMENTE en español castellano (tú, vosotros). No uses inglés ni ningún otro idioma, sin importar el idioma del contexto recibido.',
};

// Maps app language code → Whisper ISO 639-1 language hint
// Critical: prevents Whisper from auto-detecting the wrong language
// (e.g. a Spanish-accented English speaker gets transcribed in Spanish)
const WHISPER_LANGUAGE = {
  'en-US': 'en',
  'es-AR': 'es',
  'es-MX': 'es',
  'es-CO': 'es',
  'pt-BR': 'pt',
  'es-ES': 'es',
};

// 2026-05-10 (Joaquín #alzo-dev2 14:59 EDT): defensive guard — prevent
// thinking-mode regressions (DeepSeek-v4-pro/flash, Qwen3) where message.content
// is empty because output went to reasoning_content, leading to 0.6s TTS,
// clone_glitched and orphan voice. Validate, retry once, fall back to a safe
// deterministic text long enough to pass the 4s TTS validator.
const AFFIRMATION_FALLBACK = (
  "You wake up. You move. You build what you said you would. " +
  "This week, the work continues. You don’t quit. Now go."
);
const AFFIRMATION_MIN_CHARS = 50;
const AFFIRMATION_MIN_WORDS = 8;
const AFFIRMATION_MIN_SENTENCES = 1;

function _validateAffirmationResponse(resp, model, retry_used) {
  const msg = (resp && resp.choices && resp.choices[0] && resp.choices[0].message) || {};
  const content = (msg.content || "").trim();
  const reasoning = (msg.reasoning_content || msg.reasoning || "").trim();
  const word_count = content ? content.split(/\s+/).filter(Boolean).length : 0;
  const sentence_count = (content.match(/[.!?]+/g) || []).length;

  let validation_result = "pass";
  if (!content) validation_result = "fail_empty";
  else if (word_count < AFFIRMATION_MIN_WORDS) validation_result = "fail_too_short_words";
  else if (content.length < AFFIRMATION_MIN_CHARS) validation_result = "fail_too_short_chars";
  else if (sentence_count < AFFIRMATION_MIN_SENTENCES) validation_result = "fail_no_sentences";

  recordVoiceMetric("generate_affirmation", {
    model_used: model,
    content_length: content.length,
    reasoning_length: reasoning.length,
    word_count,
    sentence_count,
    retry_used,
    fallback_used: false,
    validation_result,
  });

  return {
    ok: validation_result === "pass",
    text: content,
    validation_result,
    word_count,
    content_length: content.length,
    reasoning_length: reasoning.length,
  };
}

async function generateAffirmation(context, language, messageKind = 'first') {
  if (language && !String(language).toLowerCase().startsWith('en')) {
    const error = new Error('r2_english_only');
    error.code = 'R2_ENGLISH_ONLY';
    throw error;
  }
  const prompt = messageKind === 'daily'
    ? alzoR2.buildDailyPrompt(context)
    : alzoR2.buildFirstPrompt(context);

  async function attempt(messages, retryUsed, temperature) {
    let response = null;
    try {
      response = await openai.chat.completions.create({
        model: _DEFAULT_MODEL,
        messages,
        temperature,
        max_tokens: 500,
      });
    } catch (error) {
      Sentry.captureException(error, { tags: { area: `${messageKind}_message`, attempt: retryUsed ? '2' : '1', model: _DEFAULT_MODEL } });
    }
    const transport = _validateAffirmationResponse(response, _DEFAULT_MODEL, retryUsed);
    const policy = alzoR2.validateMessageText(transport.text || '');
    return { ok: transport.ok && policy.ok, transport, policy };
  }

  const first = await attempt(prompt.messages, false, 0.35);
  if (first.ok) return first.policy.text;

  Sentry.addBreadcrumb({
    category: `${messageKind}_message`,
    level: 'warning',
    message: `${messageKind}_message.pre_tts.failed`,
    data: { failureCodes: first.policy.failureCodes, transport: first.transport.validation_result, promptVersion: prompt.promptVersion },
  });
  const retryMessages = prompt.messages.concat([{
    role: 'user',
    content: alzoR2.buildMessageRepairInstruction({
      failureCodes: first.policy.failureCodes,
      matchedForbiddenWords: first.policy.matchedForbiddenWords,
      transportValidation: first.transport.validation_result,
    }),
  }]);
  const second = await attempt(retryMessages, true, 0.15);
  if (second.ok) return second.policy.text;

  const error = new Error(`${messageKind}_message_generation_failed`);
  error.code = messageKind === 'daily' ? 'DAILY_MESSAGE_GENERATION_FAILED' : 'FIRST_MESSAGE_GENERATION_FAILED';
  error.failureCodes = [...new Set([...(first.policy.failureCodes || []), ...(second.policy.failureCodes || [])])];
  throw error;
}

// ── ElevenLabs: clone voice and generate audio ───────────────────────
// Wrap any promise with a timeout — returns null if exceeded
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

function classifyElevenLabsFailure(status, bodyOrError) {
  const body = String(bodyOrError || '').toLowerCase();
  if (status === 401 || status === 403 || body.includes('unauthorized') || body.includes('forbidden') || body.includes('invalid api key')) return 'auth_error';
  if (status === 429 || body.includes('rate_limit') || body.includes('too many requests')) return 'rate_limit';
  if (!status || body.includes('timeout') || body.includes('deadline') || body.includes('aborted')) return 'provider_timeout';
  if (status >= 500 || body.includes('service unavailable') || body.includes('bad gateway')) return 'provider_down';
  if (body.includes('invalid_audio') || body.includes('audio') || body.includes('silence') || body.includes('too short')) return 'bad_audio';
  return 'provider_rejected';
}

function providerRetryAction(failureKind) {
  if (failureKind === 'auth_error') return 'fix_provider_credentials';
  if (failureKind === 'rate_limit') return 'retry_after_provider_backoff';
  if (failureKind === 'provider_timeout') return 'retry_provider_request';
  if (failureKind === 'provider_down') return 'retry_when_provider_available';
  if (failureKind === 'bad_audio') return 'recapture_voice_audio';
  if (failureKind === 'provider_job_timeout') return 'poll_or_retry_provider_job';
  if (failureKind === 'audio_return_missing') return 'retry_audio_return_fetch';
  return 'retry_provider_request';
}

async function readProviderBody(providerRes) {
  if (!providerRes) return null;
  try {
    const text = await providerRes.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  } catch (err) {
    return `body_read_failed:${err.message}`;
  }
}

async function checkElevenLabsEndpoint(pathname, { timeoutMs = 10000 } = {}) {
  const startedAt = Date.now();
  try {
    const providerRes = await withTimeout(fetch(`${ELEVENLABS_BASE}${pathname}`, {
      method: 'GET',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    }), timeoutMs);
    const durationMs = Date.now() - startedAt;
    if (!providerRes) {
      return { ok: false, status: null, error: 'provider_timeout', failureKind: 'provider_timeout', durationMs };
    }
    const body = await readProviderBody(providerRes);
    if (!providerRes.ok) {
      const failureKind = classifyElevenLabsFailure(providerRes.status, typeof body === 'string' ? body : JSON.stringify(body || {}));
      return { ok: false, status: providerRes.status, error: failureKind, failureKind, body, durationMs };
    }
    return { ok: true, status: providerRes.status, body, durationMs };
  } catch (err) {
    const failureKind = classifyElevenLabsFailure(null, err.message || err.name || 'provider_error');
    return { ok: false, status: null, error: failureKind, failureKind, body: err.message, durationMs: Date.now() - startedAt };
  }
}

// INC-V-010: deterministic voice-slot eviction. When the ElevenLabs account
// is at its custom-voice ceiling, free exactly one slot by deleting the oldest
// cloned voice that is NOT owned by any ALZO user (orphan QA / abandoned clone).
// Ownership-based — never evicts a live user's cached voice. Returns true if a
// slot was freed so the caller can retry the clone.
function isVoiceLimitError(bodyText, status) {
  const b = String(bodyText || '').toLowerCase();
  return (
    status === 422 || status === 400 ||
    b.includes('voice_limit') ||
    b.includes('can_not_use_instant_voice_cloning') ||
    b.includes('maximum number of') ||
    b.includes('voice limit') ||
    b.includes('reached the limit')
  );
}

async function evictOldestOrphanVoice() {
  try {
    const ownedIds = new Set(
      stmts.getAllVoiceIds.all().map((r) => r.elevenlabsVoiceId).filter(Boolean),
    );
    const listRes = await withTimeout(
      fetch(`${ELEVENLABS_BASE}/voices`, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }),
      15000,
    );
    if (!listRes || !listRes.ok) {
      recordVoiceMetric('slot_eviction_list_failed', {
        level: 'warning',
        status: listRes ? listRes.status : 'timeout',
      });
      return false;
    }
    const { voices = [] } = await listRes.json();
    // Candidates: cloned voices we created (name prefix alzo_) that no DB user
    // currently references. Oldest first — name carries the creation epoch
    // (alzo_<ms>_<hex>); fall back to created_at_unix when present.
    const candidates = voices
      .filter((v) => v.category === 'cloned')
      .filter((v) => !ownedIds.has(v.voice_id))
      .filter((v) => typeof v.name === 'string' && v.name.startsWith('alzo_'))
      .map((v) => {
        const m = /^alzo_(\d+)_/.exec(v.name || '');
        const ts = m ? Number(m[1]) : (v.created_at_unix ? v.created_at_unix * 1000 : 0);
        return { voice_id: v.voice_id, name: v.name, ts };
      })
      .sort((a, b) => a.ts - b.ts);
    if (candidates.length === 0) {
      recordVoiceMetric('slot_eviction_no_candidate', {
        level: 'warning',
        totalVoices: voices.length,
        ownedCount: ownedIds.size,
      });
      return false;
    }
    const victim = candidates[0];
    const delRes = await withTimeout(
      fetch(`${ELEVENLABS_BASE}/voices/${victim.voice_id}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      }),
      15000,
    );
    const ok = !!(delRes && delRes.ok);
    recordVoiceMetric('slot_evicted', {
      level: ok ? 'info' : 'warning',
      voiceId: victim.voice_id,
      voiceName: victim.name,
      voiceAgeMs: victim.ts ? Date.now() - victim.ts : null,
      ok,
    });
    Sentry.addBreadcrumb({
      category: 'elevenlabs.slot_eviction',
      level: ok ? 'info' : 'warning',
      message: ok ? 'orphan_voice_evicted' : 'orphan_voice_evict_failed',
      data: { voiceId: victim.voice_id, voiceName: victim.name },
    });
    return ok;
  } catch (err) {
    recordVoiceMetric('slot_eviction_error', { level: 'error', error: err.message });
    return false;
  }
}

async function cloneVoiceAndSpeak(text, voiceFilePath, gender, language, existingVoiceId = null) {
  const voiceFiles = (Array.isArray(voiceFilePath) ? voiceFilePath : [voiceFilePath]).filter(Boolean);
  const debug = {
    cloneMode: 'not_attempted',
    sampleCount: voiceFiles.length,
    sampleFiles: voiceFiles.map(fp => path.basename(fp)),
    fallbackUsed: false,
    fallbackBlocked: false,
    customVoiceId: null,
    playbackVoiceId: null,
    staleCachedVoiceId: null,
    staleVoiceReclone: false,
    modelId: null,
    error: null,
  };

  if (!ELEVENLABS_API_KEY) {
    debug.cloneMode = 'disabled';
    debug.error = 'ELEVENLABS_API_KEY missing';
    return { audioUrl: null, voiceDebug: debug, voiceId: null };
  }

  // Fast path: user already has a cached voice_id → skip the clone (25s → 3s).
  // If the provider says that cached voice is gone, treat it as stale and
  // re-clone from the retained sample instead of silently falling back forever.
  if (existingVoiceId) {
    debug.customVoiceId = existingVoiceId;
    debug.playbackVoiceId = existingVoiceId;
    debug.cloneMode = 'cached';
    try {
      const speech = await withTimeout(generateSpeech(text, existingVoiceId, language), 30000);
      if (!speech || !speech.audioUrl) {
        debug.cloneMode = 'tts_failed_on_reuse';
        debug.error = 'speech generation failed with cached voice_id';
        debug.fallbackBlocked = true;
        recordVoiceMetric('tts_failed_on_reuse', { level: 'error', voiceId: existingVoiceId, language });
        Sentry.captureMessage('elevenlabs.tts_failed_on_reuse', {
          level: 'warning',
          tags: { component: 'elevenlabs', cloneMode: 'tts_failed_on_reuse' },
          extra: { voiceId: existingVoiceId, language },
        });
        return { audioUrl: null, voiceDebug: debug, voiceId: existingVoiceId };
      }
      debug.modelId = speech.modelId;
      recordVoiceMetric('tts_reused_cached_voice', { voiceId: existingVoiceId, language, modelId: speech.modelId });
      return { audioUrl: speech.audioUrl, voiceDebug: debug, voiceId: existingVoiceId };
    } catch (err) {
      console.error('TTS with cached voice failed:', err.message);
      const providerBody = String(err.body || err.message || '');
      const staleCachedVoice = err.status === 404 || providerBody.includes('voice_not_found') || providerBody.includes('not_found');
      debug.cloneMode = staleCachedVoice ? 'stale_cached_voice' : 'tts_error_on_reuse';
      debug.error = err.message;
      debug.fallbackBlocked = !staleCachedVoice;
      debug.staleCachedVoiceId = staleCachedVoice ? existingVoiceId : null;
      Sentry.addBreadcrumb({
        category: 'elevenlabs.clone',
        level: 'error',
        message: debug.cloneMode,
        data: {
          voiceId: existingVoiceId,
          language,
          status: err.status,
          body: err.body ? String(err.body).slice(0, 500) : undefined,
        },
      });
      Sentry.captureException(err, {
        tags: { component: 'elevenlabs', cloneMode: debug.cloneMode },
        extra: { voiceId: existingVoiceId, language },
      });

      if (!staleCachedVoice || voiceFiles.length === 0) {
        // A known-stale voice with no retained sample must be cleared by the
        // caller so future runs do not keep retrying a dead provider id.
        return { audioUrl: null, voiceDebug: debug, voiceId: staleCachedVoice ? null : existingVoiceId };
      }

      recordVoiceMetric('stale_cached_voice_reclone', { level: 'warning', voiceId: existingVoiceId, language, sampleCount: voiceFiles.length });
      debug.cloneMode = 'stale_reclone_attempted';
      debug.staleVoiceReclone = true;
      debug.customVoiceId = null;
      debug.playbackVoiceId = null;
      debug.error = null;
      debug.fallbackBlocked = false;
    }
  }

  try {
    // Rebuildable: FormData wraps single-use streams, so a retry after slot
    // eviction needs a fresh instance. The clone name carries Date.now() so
    // eviction ordering (oldest-first) stays meaningful.
    const cloneVoiceName = `alzo_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const buildVoiceFormData = () => {
      const fd = new FormData();
      fd.append("name", cloneVoiceName);
      fd.append("description", "ALZO user voice clone for affirmations");
      // B48-3: clean up sample audio before fingerprinting — kicks clone quality
      // up materially when source has room tone, breath, fan noise, etc.
      fd.append("remove_background_noise", "true");
      if (Array.isArray(voiceFilePath)) {
        voiceFilePath.forEach((fp, i) => {
          const buf = fs.readFileSync(fp);
          fd.append("files", new Blob([buf], { type: "audio/m4a" }), `sample_${i}.m4a`);
        });
      } else if (voiceFilePath) {
        const fileBuffer = fs.readFileSync(voiceFilePath);
        fd.append("files", new Blob([fileBuffer], { type: "audio/m4a" }), "voice_sample.m4a");
      }
      return fd;
    };

    debug.cloneMode = 'clone_attempted';
    console.log('Voice clone samples:', debug.sampleFiles);

    // Wrapped so a provider voice-slot-ceiling rejection can trigger one
    // deterministic eviction + retry (INC-V-010) before we give up.
    const doAddVoice = () => withTimeout(fetch(`${ELEVENLABS_BASE}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      // formData is a single-use stream; rebuild on retry.
      body: buildVoiceFormData(),
    }), 25000);

    let addVoiceRes = await doAddVoice();
    let addErrorText = null;
    if (!addVoiceRes || !addVoiceRes.ok) {
      addErrorText = addVoiceRes ? await addVoiceRes.text() : 'timeout adding voice';
      const addStatus = addVoiceRes ? addVoiceRes.status : null;
      // INC-V-010: at the account voice-slot ceiling — evict the oldest orphan
      // QA / non-owner clone, then retry the add exactly once.
      if (addStatus && isVoiceLimitError(addErrorText, addStatus)) {
        debug.slotCeilingHit = true;
        recordVoiceMetric('voice_slot_ceiling', {
          level: 'warning', status: addStatus,
          body: String(addErrorText).slice(0, 300),
        });
        const freed = await evictOldestOrphanVoice();
        debug.slotEvicted = freed;
        if (freed) {
          addVoiceRes = await doAddVoice();
          if (addVoiceRes && addVoiceRes.ok) {
            addErrorText = null;
          } else {
            addErrorText = addVoiceRes ? await addVoiceRes.text() : 'timeout adding voice (post-eviction)';
          }
        }
      }
    }

    if (!addVoiceRes || !addVoiceRes.ok) {
      const errorText = addErrorText || 'timeout adding voice';
      console.error("Voice clone failed:", errorText);
      debug.cloneMode = 'clone_failed';
      debug.error = errorText;
      debug.fallbackBlocked = true;
      Sentry.addBreadcrumb({
        category: 'elevenlabs.clone',
        level: 'error',
        message: 'clone_failed',
        data: { status: addVoiceRes ? addVoiceRes.status : 'timeout', body: String(errorText).slice(0, 500), slotEvicted: debug.slotEvicted },
      });
      // (c) voice_error_class: timeout = no response; otherwise bucket the
      // provider HTTP status into 4xx / 5xx.
      const clf_status = addVoiceRes ? addVoiceRes.status : null;
      const voiceErrorClass = !clf_status ? 'timeout'
        : (clf_status >= 500 ? '5xx' : (clf_status >= 400 ? '4xx' : '5xx'));
      Sentry.captureMessage('elevenlabs.clone_failed', {
        level: 'warning',
        tags: { component: 'elevenlabs', cloneMode: 'clone_failed', voice_error_class: voiceErrorClass },
        extra: { errorBody: String(errorText).slice(0, 500), slotCeilingHit: !!debug.slotCeilingHit, slotEvicted: !!debug.slotEvicted, providerStatus: clf_status },
      });
      return { audioUrl: null, voiceDebug: debug, voiceId: null };
    }

    const { voice_id } = await addVoiceRes.json();
    debug.customVoiceId = voice_id;
    debug.playbackVoiceId = voice_id;
    debug.cloneMode = 'cloned';

    const speech = await withTimeout(generateSpeech(text, voice_id, language), 30000);
    if (!speech || !speech.audioUrl) {
      // Clone succeeded but TTS failed — clean up the orphan voice
      fetch(`${ELEVENLABS_BASE}/voices/${voice_id}`, { method: 'DELETE', headers: { 'xi-api-key': ELEVENLABS_API_KEY } }).catch(() => {});
      debug.cloneMode = 'tts_failed_after_clone';
      debug.error = 'speech generation failed after clone';
      debug.fallbackBlocked = true;
      Sentry.addBreadcrumb({
        category: 'elevenlabs.clone',
        level: 'error',
        message: 'tts_failed_after_clone',
        data: { voiceId: voice_id, language },
      });
      // (c) voice_error_class: generateSpeech wrapped in withTimeout — a null
      // result means the 30s race elapsed (timeout). A thrown provider error is
      // handled in the catch below; here null === timeout.
      Sentry.captureMessage('elevenlabs.tts_failed_after_clone', {
        level: 'warning',
        tags: { component: 'elevenlabs', cloneMode: 'tts_failed_after_clone', voice_error_class: 'timeout' },
        extra: { voiceId: voice_id, language },
      });
      return { audioUrl: null, voiceDebug: debug, voiceId: null };
    }

    debug.modelId = speech.modelId;

    // ── Capa 2: post-clone TTS render validator ─────────────────────
    // ElevenLabs sometimes returns a voice_id whose first synth is silence
    // or a 1s glitch. Verify the rendered MP3 is at least 4s of real audio
    // before handing the voice to the user. Failure-soft if decoder unavail.
    Sentry.setTag('voice_validator_step', 'post_clone');
    const v2 = await voiceValidator.validateTtsRender(speech.localFilePath);
    if (!v2.ok) {
      // Clean up: delete the bad voice from ElevenLabs AND the bad MP3 from
      // disk so it can never be served, then surface a structured error so
      // the caller returns 502 VOICE_CLONE_GLITCHED.
      fetch(`${ELEVENLABS_BASE}/voices/${voice_id}`, { method: 'DELETE', headers: { 'xi-api-key': ELEVENLABS_API_KEY } }).catch(() => {});
      try { if (speech.localFilePath) fs.unlinkSync(speech.localFilePath); } catch {}
      debug.cloneMode = 'clone_glitched';
      debug.error = `clone glitched (duration=${v2.duration}s peak=${v2.peak})`;
      debug.fallbackBlocked = true;
      debug.cloneVerified = false;
      debug.errorCode = v2.code;
      debug.errorHttp = v2.http;
      debug.errorMessage = v2.message;
      debug.validatorDuration = v2.duration;
      debug.validatorPeak = v2.peak;
      recordVoiceMetric('clone_glitched', { level: 'error', voiceId: voice_id, language, duration: v2.duration, peak: v2.peak });
      Sentry.captureMessage('voice_validator.post_clone_rejected', {
        level: 'error',
        tags: { component: 'voice_validator', step: 'post_clone', code: v2.code },
        extra: { voiceId: voice_id, language, duration: v2.duration, peak: v2.peak, tooShort: v2.tooShort, tooQuiet: v2.tooQuiet },
      });
      return { audioUrl: null, voiceDebug: debug, voiceId: null };
    }
    debug.cloneVerified = true;
    debug.validatorDuration = v2.duration;
    debug.validatorPeak = v2.peak;
    debug.validatorSoft = !!v2.soft;
    Sentry.addBreadcrumb({
      category: 'voice_validator',
      level: 'info',
      message: 'post_clone_passed',
      data: { voiceId: voice_id, duration: v2.duration, peak: v2.peak, soft: !!v2.soft },
    });

    // PERSIST the cloned voice so daily affirmations can reuse it. Caller must
    // save voiceId to the user row in DB so next call hits the reuse fast path.
    return { audioUrl: speech.audioUrl, voiceDebug: debug, voiceId: voice_id };
  } catch (err) {
    console.error("ElevenLabs clone error:", err.message);
    debug.cloneMode = 'clone_error';
    debug.error = err.message;
    debug.fallbackBlocked = true;
    // (c) voice_error_class: classify the thrown provider error. generateSpeech
    // attaches err.status on non-ok responses; absence => network/timeout.
    const ce_status = err && err.status;
    const ceErrorClass = !ce_status ? 'timeout'
      : (ce_status >= 500 ? '5xx' : (ce_status >= 400 ? '4xx' : '5xx'));
    Sentry.captureException(err, {
      tags: { component: 'elevenlabs', cloneMode: 'clone_error', voice_error_class: ceErrorClass },
      extra: { providerStatus: ce_status || null, body: err && err.body ? String(err.body).slice(0, 500) : null },
    });
    return { audioUrl: null, voiceDebug: debug, voiceId: null };
  }
}

// ElevenLabs preset voice IDs
// Accent-aware fallback voices per language
// en-US: Sarah (American female), Brian (American male)
// en-GB: Charlotte (British female), George (British male)
// es-*:  Valentina (Spanish female), Mateo (Spanish male) - using multilingual
// pt-BR: use multilingual model with neutral voice
const PRESET_VOICES_BY_LANGUAGE = {
  'en-US': { female: 'EXAVITQu4vr4xnSDxMaL', male: 'nPczCjzI2devNBz1zQrb' }, // Sarah / Brian (American)
  'en-GB': { female: 'XB0fDUnXU5powFXDhCwa', male: 'JBFqnCBsd6RMkjVDRZzb' }, // Charlotte / George (British)
  'es-AR': { female: 'Xb7hH8MSUJpSbSDYk0k2', male: 'bIHbv24MWmeRgasZH58o' }, // Alice / Will (multilingual)
  'es-MX': { female: 'Xb7hH8MSUJpSbSDYk0k2', male: 'bIHbv24MWmeRgasZH58o' },
  'es-CO': { female: 'Xb7hH8MSUJpSbSDYk0k2', male: 'bIHbv24MWmeRgasZH58o' },
  'es-ES': { female: 'Xb7hH8MSUJpSbSDYk0k2', male: 'bIHbv24MWmeRgasZH58o' },
  'pt-BR': { female: 'EXAVITQu4vr4xnSDxMaL', male: 'nPczCjzI2devNBz1zQrb' }, // fallback to neutral
};
// Default
const PRESET_VOICES = PRESET_VOICES_BY_LANGUAGE['en-US'];

// ── ElevenLabs: TTS with a preset voice (fallback) ──────────────────
async function textToSpeechFallback(text, gender, language) {
  if (!ELEVENLABS_API_KEY) return { audioUrl: null, voiceDebug: { cloneMode: 'disabled', fallbackUsed: false, error: 'ELEVENLABS_API_KEY missing' } };

  try {
    const voices = PRESET_VOICES_BY_LANGUAGE[language] || PRESET_VOICES_BY_LANGUAGE['en-US'];
    const voiceId = voices[gender] || voices.female;
    const speech = await generateSpeech(text, voiceId, language);
    return {
      audioUrl: speech.audioUrl,
      voiceDebug: {
        cloneMode: 'fallback',
        fallbackUsed: true,
        customVoiceId: null,
        playbackVoiceId: voiceId,
        modelId: speech.modelId,
        error: null,
      }
    };
  } catch (err) {
    console.error("ElevenLabs TTS fallback error:", err.message);
    return { audioUrl: null, voiceDebug: { cloneMode: 'fallback_failed', fallbackUsed: true, error: err.message } };
  }
}

async function generateSpeech(text, voiceId, language) {
  // B48-3: always use multilingual_v2 — turbo_v2_5 trades quality for latency,
  // wrong tradeoff for one-daily-affirmation use case. Quality > 200ms latency.
  // B48-8: capture full provider response body on failure so Sentry shows root cause.
  const model = 'eleven_multilingual_v2';
  const ttsRes = await fetch(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: model,
        // ElevenLabs-recommended IVC profile for emotive content (B48-3).
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.85,
          style: 0.15,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!ttsRes.ok) {
    const body = await ttsRes.text();
    Sentry.addBreadcrumb({
      category: 'elevenlabs.tts',
      level: 'error',
      message: 'TTS request failed',
      data: { status: ttsRes.status, voiceId, model, language, body: body.slice(0, 500) },
    });
    const err = new Error(`TTS failed: ${ttsRes.status} ${body}`);
    err.status = ttsRes.status;
    err.body = body;
    throw err;
  }

  const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
  const filename = `affirmation_${Date.now()}_${crypto.randomBytes(8).toString("hex")}.mp3`;
  const filepath = path.join(AUDIO_STORAGE_DIR, filename);
  fs.writeFileSync(filepath, audioBuffer);
  recordVoiceMetric('tts_audio_written', { voiceId, language, modelId: model, bytes: audioBuffer.length, storageDir: AUDIO_STORAGE_DIR });
  return { audioUrl: `${AUDIO_PUBLIC_PATH}/${filename}`, voiceId, modelId: model, localFilePath: filepath };
}

// ── Onboarding endpoint ─────────────────────────────────────────────
const onboardingUpload = upload.fields([
  { name: "q1", maxCount: 1 },
  { name: "q2", maxCount: 1 },
  { name: "q3", maxCount: 1 },
  { name: "q4", maxCount: 1 },
  { name: "q5", maxCount: 1 },
  { name: "voiceSample", maxCount: 1 }, // dedicated 30s reading for voice clone
]);

const preAccountVoiceBundleUpload = upload.fields([
  { name: VOICE_MULTIPART_FIELDS.goal, maxCount: 1 },
  { name: VOICE_MULTIPART_FIELDS.purpose, maxCount: 1 },
  { name: VOICE_MULTIPART_FIELDS.reconnectionAnchor, maxCount: 1 },
  { name: VOICE_MULTIPART_FIELDS.commitment, maxCount: 1 },
]);

function parseJsonBodyField(value, fallback = {}) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function safeVoiceOwnerId(userId) {
  return userId ? String(userId).replace(/[^a-zA-Z0-9_-]/g, '') : null;
}


function escapeFfmpegConcatPath(filePath) {
  return String(filePath).replace(/'/g, "'\\''");
}

function runExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function createMergedVoiceArtifact({ sessionId, sourceFiles, captureReceipt, voiceAttemptIds, orderedCaptureKinds, provenanceComplete }) {
  const files = (sourceFiles || []).filter(Boolean);
  if (files.length !== 4) {
    return { ok: false, error: 'merged_voice_source_count_required', expected: 4, actual: files.length };
  }
  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: 'merged_voice_source_missing', file: path.basename(filePath) };
    }
  }
  if (!ffmpegStatic) {
    return { ok: false, error: 'ffmpeg_required_for_merged_voice_artifact' };
  }

  const listPath = path.join(UPLOAD_STORAGE_DIR, `voice_merge_${sessionId}.txt`);
  const mergedPath = path.join(UPLOAD_STORAGE_DIR, `voice_${sessionId}_merged.m4a`);
  const sourceCaptureIds = (captureReceipt || []).map((item) => item.stage).filter(Boolean);
  fs.writeFileSync(listPath, files.map((filePath) => `file '${escapeFfmpegConcatPath(filePath)}'`).join('\n'));
  try {
    await runExecFile(ffmpegStatic, [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-vn',
      '-acodec', 'aac',
      '-b:a', '128k',
      mergedPath,
    ], { timeout: 45000 });
  } catch (err) {
    return {
      ok: false,
      error: 'merged_voice_artifact_failed',
      detail: String(err.stderr || err.message || err).slice(0, 500),
    };
  } finally {
    try { fs.unlinkSync(listPath); } catch {}
  }

  if (!fs.existsSync(mergedPath) || fs.statSync(mergedPath).size <= 0) {
    return { ok: false, error: 'merged_voice_artifact_missing_or_empty' };
  }

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(mergedPath)).digest('hex');
  Sentry.addBreadcrumb({ category: 'voice.bundle', level: 'info', message: 'voice.bundle.validation.started', data: { bundleIdHash: alzoR2.sha256(sessionId), sourceCount: files.length } });
  const validator = await voiceValidator.validateInputSample(mergedPath);
  if (!validator.ok) {
    try { fs.unlinkSync(mergedPath); } catch {}
    return {
      ok: false,
      error: validator.message || 'merged_voice_artifact_invalid',
      code: validator.code,
      http: validator.http,
      duration: validator.duration,
      peak: validator.peak,
    };
  }

  const mergedDurationMs = Number.isFinite(validator.duration) ? Math.round(validator.duration * 1000) : 0;
  const qualityGate = alzoR2.validateTrainingBundle({
    mergedDurationMs,
    validAudioDurationMs: mergedDurationMs,
    humanVoicePresent: validator.soft !== true && Number(validator.peak) >= voiceValidator.THRESHOLDS.MIN_PEAK_AMPLITUDE,
    silencePredominant: Number(validator.peak) < voiceValidator.THRESHOLDS.MIN_PEAK_AMPLITUDE,
    noisePredominant: (captureReceipt || []).some((item) => item.signalClass === 'noise_predominant'),
    sourceCount: files.length,
    providerFileCount: 1,
    provenanceComplete: provenanceComplete === true,
    orderedCaptureKinds,
  });
  if (!qualityGate.ok) {
    try { fs.unlinkSync(mergedPath); } catch {}
    Sentry.addBreadcrumb({ category: 'voice.bundle', level: 'warning', message: 'voice.bundle.validation.blocked', data: { failureCodes: qualityGate.failureCodes, mergedDurationMs, minimumDurationMs: qualityGate.minimumDurationMs } });
    Sentry.addBreadcrumb({ category: 'voice.bundle', level: 'warning', message: 'voice.bundle.recovery.required', data: { recoveryKind: qualityGate.recoveryKind, failureCodes: qualityGate.failureCodes, minimumDurationMs: qualityGate.minimumDurationMs, currentValidDurationMs: mergedDurationMs } });
    return {
      ok: false,
      error: 'voice_bundle_quality_gate_blocked',
      code: qualityGate.failureCodes[0],
      http: 422,
      duration: validator.duration,
      peak: validator.peak,
      validation: qualityGate,
    };
  }
  Sentry.addBreadcrumb({ category: 'voice.bundle', level: 'info', message: 'voice.bundle.validation.passed', data: { mergedDurationMs, validAudioDurationMs: mergedDurationMs, humanVoicePresent: true, silencePredominant: false, noisePredominant: false, sourceCount: 4, providerFileCount: 1, provenanceComplete: true } });

  return {
    ok: true,
    path: mergedPath,
    artifact: {
      path: mergedPath,
      filename: path.basename(mergedPath),
      sourceCaptures: files.length,
      captureIds: sourceCaptureIds,
      voiceAttemptIds: Array.isArray(voiceAttemptIds) ? voiceAttemptIds : [],
      totalDurationSeconds: validator.duration || null,
      mergedDurationMs,
      validAudioDurationMs: mergedDurationMs,
      validationPassed: true,
      minimumDurationMs: alzoR2.MIN_VALID_AUDIO_MS,
      peak: validator.peak || null,
      sha256,
      providerJobId: sessionId,
      providerFileCount: 1,
      createdAt: new Date().toISOString(),
    },
  };
}

function parseVoiceManifest(raw) {
  if (Array.isArray(raw)) {
    return { providerFiles: raw, sourceCaptureFiles: raw, mergedVoiceArtifact: null, legacyArray: true };
  }
  if (raw && typeof raw === 'object') {
    return {
      providerFiles: Array.isArray(raw.providerFiles) ? raw.providerFiles : [],
      sourceCaptureFiles: Array.isArray(raw.sourceCaptureFiles) ? raw.sourceCaptureFiles : [],
      mergedVoiceArtifact: raw.mergedVoiceArtifact || null,
      legacyArray: false,
    };
  }
  return { providerFiles: [], sourceCaptureFiles: [], mergedVoiceArtifact: null, legacyArray: false };
}

function findLatestValidatedR2MergedVoiceForUser(userId) {
  if (!userId || !fs.existsSync(UPLOAD_STORAGE_DIR)) return null;
  const candidates = [];
  for (const filename of fs.readdirSync(UPLOAD_STORAGE_DIR)) {
    if (!/^voice_manifest_.+\.json$/.test(filename)) continue;
    const manifestPath = path.join(UPLOAD_STORAGE_DIR, filename);
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (raw.schemaVersion !== 'alzo.voice_manifest.r2.v1') continue;
      if (raw.voiceOwnerId !== userId) continue;
      if (raw.mergedVoiceArtifact?.validationPassed !== true) continue;
      if (Number(raw.mergedVoiceArtifact?.validAudioDurationMs) < alzoR2.MIN_VALID_AUDIO_MS) continue;
      if (!Array.isArray(raw.providerFiles) || raw.providerFiles.length !== 1) continue;
      const providerFile = raw.providerFiles[0];
      if (!providerFile || !fs.existsSync(providerFile)) continue;
      candidates.push({
        providerFile,
        createdAt: Date.parse(raw.mergedVoiceArtifact?.createdAt || '') || fs.statSync(manifestPath).mtimeMs,
      });
    } catch {}
  }
  candidates.sort((a, b) => b.createdAt - a.createdAt);
  return candidates[0]?.providerFile || null;
}

// ── Transcribe audio with Whisper ────────────────────────────────────
// language: app language code (e.g. 'en-US', 'es-AR') — used to hint Whisper
// so it doesn't auto-detect the wrong language from accent/context
async function transcribeAudio(filePath, language, { signal } = {}) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'audio/m4a' });
    const formData = new FormData();
    formData.append('file', blob, 'audio.m4a');
    formData.append('model', 'whisper-1');
    // Force Whisper to transcribe in the user's selected language
    const whisperLang = WHISPER_LANGUAGE[language] || 'en';
    formData.append('language', whisperLang);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.text || null;
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw e;
    console.error('Transcription error:', e.message);
    return null;
  }
}

// ── Detect gender from transcription text via GPT ────────────────────
async function detectGender(transcriptions, { signal } = {}) {
  if (!transcriptions || transcriptions.length === 0) return null;
  try {
    const combined = transcriptions.filter(Boolean).join(' ');
    if (combined.trim().length < 10) return null;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: _MINI_MODEL,
        messages: [
          { role: 'system', content: 'You detect the speaker\'s gender from their speech. Reply with ONLY "male" or "female". Base it on pronouns, names, or contextual clues. If unclear, reply "unknown".' },
          { role: 'user', content: `Detect gender from this speech: "${combined.substring(0, 500)}"` }
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const answer = data.choices[0].message.content.trim().toLowerCase();
    if (answer === 'male' || answer === 'female') return answer;
    return null;
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw e;
    return null;
  }
}

app.post("/api/onboarding/voice-bundle", preAccountVoiceBundleUpload, async (req, res) => {
  const requestId = req.get('x-request-id') || crypto.randomUUID();
  const correlationId = req.get('x-correlation-id') || req.get('x-voice-attempt-id') || req.body?.bundleId || requestId;
  const startedAt = Date.now();

  try {
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized", requestId, correlationId });

    const language = req.body.language || user.language || 'en-US';
    const bundleId = req.body.bundleId || correlationId;
    const preAccountVoiceBundle = parseJsonBodyField(req.body.preAccountVoiceBundle, null);
    const voiceProcessingPayload = parseJsonBodyField(req.body.voiceProcessingPayload, null);
    const productProvenance = parseJsonBodyField(req.body.productProvenance, voiceProcessingPayload?.productProvenance || null);
    const semanticCaptureOrder = parseJsonBodyField(req.body.semanticCaptureOrder, alzoR2.CAPTURE_ORDER);
    const voiceAttemptIds = parseJsonBodyField(req.body.voiceAttemptIds, []);
    const answerMeta = {
      endpoint: 'voice-bundle',
      schemaVersion: req.body.schemaVersion || voiceProcessingPayload?.schemaVersion || null,
      bundleId,
      semanticCaptureOrder,
      voiceAttemptIds,
      productProvenance,
      requestId,
      correlationId,
    };

    if (JSON.stringify(semanticCaptureOrder) !== JSON.stringify(alzoR2.CAPTURE_ORDER)) {
      return res.status(400).json({ error: 'voice_bundle_capture_order_invalid', required: alzoR2.CAPTURE_ORDER, actual: semanticCaptureOrder, requestId, correlationId });
    }

    const captureSpecs = [
      { stage: 'goal', part: VOICE_MULTIPART_FIELDS.goal },
      { stage: 'purpose', part: VOICE_MULTIPART_FIELDS.purpose },
      { stage: 'reconnectionAnchor', part: VOICE_MULTIPART_FIELDS.reconnectionAnchor },
      { stage: 'commitment', part: VOICE_MULTIPART_FIELDS.commitment },
    ];

    const uploadedFor = (spec) => req.files?.[spec.part]?.[0];
    const missing = captureSpecs.filter((spec) => !uploadedFor(spec)).map((spec) => spec.part);
    if (missing.length > 0) {
      return res.status(400).json({
        error: 'voice_bundle_missing_required_captures',
        missing,
        required: captureSpecs.map((spec) => spec.part),
        requestId,
        correlationId,
      });
    }

    const transcriptByStage = {};
    const audioFiles = captureSpecs.map((spec) => uploadedFor(spec).path);
    const transcriptions = [];
    const captureReceipt = [];
    const provenanceCaptures = Array.isArray(productProvenance?.captures) ? productProvenance.captures : [];
    const semanticResolutionController = new AbortController();
    const semanticResolutionTimer = setTimeout(() => semanticResolutionController.abort(), SEMANTIC_RESOLUTION_TIMEOUT_MS);
    semanticResolutionTimer.unref?.();
    let semanticExtraction;
    let detectedGender;
    try {
      const transcriptionResults = await Promise.all(captureSpecs.map(async (spec) => {
        const uploaded = uploadedFor(spec);
        const transcription = await transcribeAudio(uploaded.path, language, { signal: semanticResolutionController.signal });
        return { spec, uploaded, transcription };
      }));

      for (const [index, result] of transcriptionResults.entries()) {
        const { spec, uploaded, transcription } = result;
        if (transcription && transcription.trim().length > 5) {
          transcriptByStage[spec.stage] = transcription;
          transcriptions.push(transcription);
        }
        const provenance = provenanceCaptures.find((item) => item.stage === spec.stage || (spec.stage === 'reconnectionAnchor' && item.stage === 'resistance') || (spec.stage === 'commitment' && item.stage === 'commitmentReading')) || {};
        captureReceipt.push({
          stage: spec.stage,
          partName: spec.part,
          captureId: provenance.captureId || null,
          signalClass: provenance.signalClass || 'human_voice_detected',
          voiceAttemptId: Array.isArray(voiceAttemptIds)
            ? voiceAttemptIds[index] || null
            : (voiceAttemptIds && voiceAttemptIds[spec.stage]) || null,
          originalName: uploaded.originalname || null,
          mimeType: uploaded.mimetype || null,
          size: uploaded.size || null,
          transcribed: Boolean(transcription && transcription.trim().length > 5),
        });
      }

      semanticExtraction = alzoR2.buildSemanticExtraction({
        goal: { ...provenanceCaptures.find((item) => item.stage === 'goal'), transcript: transcriptByStage.goal, goalConcrete: true },
        purpose: { ...provenanceCaptures.find((item) => item.stage === 'purpose'), transcript: transcriptByStage.purpose },
        reconnectionAnchor: { ...provenanceCaptures.find((item) => item.stage === 'reconnectionAnchor' || item.stage === 'resistance'), transcript: transcriptByStage.reconnectionAnchor },
      });
      if (semanticExtraction.status !== 'ready') {
        audioFiles.forEach((file) => { try { fs.unlinkSync(file); } catch {} });
        Sentry.addBreadcrumb({ category: 'voice.semantic', level: 'warning', message: 'voice.semantic_extraction.failed', data: { blockingCaptureKinds: semanticExtraction.assessments.filter((item) => item.disposition === 'rerecord').map((item) => item.captureKind), reasonCodes: semanticExtraction.assessments.map((item) => item.reasonCode), requestId, correlationId } });
        return res.status(422).json({ error: 'semantic_extraction_rerecord_required', semanticExtraction, requestId, correlationId });
      }
      Sentry.addBreadcrumb({ category: 'voice.semantic', level: 'info', message: 'voice.semantic_extraction.completed', data: { semanticContextSha256: semanticExtraction.semanticContextSha256, dispositions: semanticExtraction.assessments.map((item) => `${item.captureKind}:${item.disposition}`), requestId, correlationId } });
      detectedGender = await detectGender(
        [transcriptByStage.goal, transcriptByStage.purpose, transcriptByStage.reconnectionAnchor].filter(Boolean),
        { signal: semanticResolutionController.signal },
      );
    } catch (error) {
      if (!semanticResolutionController.signal.aborted && error?.name !== 'AbortError') throw error;
      audioFiles.forEach((file) => { try { fs.unlinkSync(file); } catch {} });
      Sentry.captureMessage('voice.semantic_resolution.failed', {
        level: 'warning',
        tags: { component: 'voice_semantic_resolution', step: 'backend_transcription', failure_kind: 'provider_timeout' },
        extra: { requestId, correlationId, bundleId, timeoutMs: SEMANTIC_RESOLUTION_TIMEOUT_MS },
      });
      return res.status(504).json({
        error: 'semantic_resolution_timeout',
        failureKind: 'provider_timeout',
        stage: 'semantic_resolution',
        retryAction: 'record_again',
        timeoutMs: SEMANTIC_RESOLUTION_TIMEOUT_MS,
        requestId,
        correlationId,
      });
    } finally {
      clearTimeout(semanticResolutionTimer);
    }

    const sessionId = Date.now().toString();
    const voiceOwnerId = safeVoiceOwnerId(user.id);
    const persistedVoiceFiles = audioFiles.map((sourcePath, index) => {
      const ext = path.extname(sourcePath) || ".m4a";
      const destPath = path.join(UPLOAD_STORAGE_DIR, `voice_${sessionId}_${index + 1}${ext}`);
      fs.copyFileSync(sourcePath, destPath);
      return destPath;
    });


    const mergeResult = await createMergedVoiceArtifact({
      sessionId,
      sourceFiles: persistedVoiceFiles,
      captureReceipt,
      voiceAttemptIds,
      orderedCaptureKinds: semanticCaptureOrder,
      provenanceComplete: captureReceipt.every((item) => item.captureId && item.voiceAttemptId),
    });
    if (!mergeResult.ok) {
      audioFiles.forEach((f) => { try { fs.unlink(f, () => {}); } catch {} });
      persistedVoiceFiles.forEach((f) => { try { fs.unlinkSync(f); } catch {} });
      Sentry.captureMessage('voice_validator.merged_voice_rejected', {
        level: 'warning',
        tags: { component: 'voice_validator', step: 'merged_voice_artifact', code: mergeResult.code || mergeResult.error },
        extra: { bundleId, requestId, correlationId, error: mergeResult.error, detail: mergeResult.detail || null, duration: mergeResult.duration || null, peak: mergeResult.peak || null },
      });
      return res.status(mergeResult.http || 400).json({
        error: mergeResult.error,
        code: mergeResult.code || mergeResult.error,
        requestId,
        correlationId,
        voiceValidator: { step: 'merged_voice_artifact', duration: mergeResult.duration || null, peak: mergeResult.peak || null },
      });
    }

    const providerVoiceFiles = [mergeResult.path];
    if (mergeResult.path) {
      const legacyVoicePath = path.join(UPLOAD_STORAGE_DIR, `voice_${sessionId}.m4a`);
      fs.copyFileSync(mergeResult.path, legacyVoicePath);
      if (voiceOwnerId) {
        const userVoicePath = path.join(UPLOAD_STORAGE_DIR, `voice_user_${voiceOwnerId}_${sessionId}.m4a`);
        fs.copyFileSync(mergeResult.path, userVoicePath);
      }
      const voiceManifest = path.join(UPLOAD_STORAGE_DIR, `voice_manifest_${sessionId}.json`);
      fs.writeFileSync(voiceManifest, JSON.stringify({
        schemaVersion: 'alzo.voice_manifest.r2.v1',
        voiceOwnerId,
        providerFiles: providerVoiceFiles,
        sourceCaptureFiles: persistedVoiceFiles,
        mergedVoiceArtifact: mergeResult.artifact,
        semanticCaptureOrder,
        semanticContext: semanticExtraction.semanticContext,
        semanticContextSha256: semanticExtraction.semanticContextSha256,
        provenanceComplete: captureReceipt.every((item) => item.captureId && item.voiceAttemptId),
      }));
    }
    audioFiles.forEach((f) => { try { fs.unlink(f, () => {}); } catch {} });

    const voiceDebug = {
      cloneMode: ELEVENLABS_API_KEY ? 'pending' : 'not_ready',

      sampleCount: providerVoiceFiles.length,
      sourceSampleCount: persistedVoiceFiles.length,
      sampleFiles: providerVoiceFiles.map((f) => path.basename(f)),
      sourceSampleFiles: persistedVoiceFiles.map((f) => path.basename(f)),
      mergedVoiceArtifact: mergeResult.artifact,
      answerMeta,
      fallbackUsed: false,
      customVoiceId: null,
      playbackVoiceId: null,
      modelId: null,
      error: null,
    };

    Sentry.addBreadcrumb({
      category: 'voice.upload',
      level: 'info',
      message: 'pre_account_voice_bundle.accepted',

      data: { requestId, correlationId, bundleId, sessionId, sourceFileCount: persistedVoiceFiles.length, providerFileCount: providerVoiceFiles.length, mergedVoiceArtifact: mergeResult.artifact?.filename || null },
    });

    return res.json({
      ok: true,
      status: 'submitted',
      provider: 'elevenlabs',
      providerJobId: sessionId,
      sessionId,
      receiptId: sessionId,
      bundleId,
      fileCount: persistedVoiceFiles.length,

      providerFileCount: providerVoiceFiles.length,
      mergedVoiceArtifact: mergeResult.artifact,
      semanticCaptureOrder,
      voiceAttemptIds,
      productProvenance,
      preAccountVoiceBundleAccepted: Boolean(preAccountVoiceBundle),
      voiceProcessingPayloadAccepted: Boolean(voiceProcessingPayload),
      captureReceipt,
      context: semanticExtraction.semanticContext,
      semanticContext: semanticExtraction.semanticContext,
      semanticExtraction,
      detectedGender,
      language,
      voiceReady: Boolean(persistedVoiceFiles.length && ELEVENLABS_API_KEY),
      voiceCloneStatus: 'processing',
      activeVoiceKind: 'temporary_preview',
      voiceCloneEta: '~2 hours',
      voiceDebug,
      requestId,
      correlationId,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { area: 'voice_upload', endpoint: 'onboarding_voice_bundle' },
      extra: { fileKeys: Object.keys(req.files || {}), requestId, correlationId },
    });
    console.error("Voice bundle onboarding error:", err);
    return res.status(500).json({ error: "Voice bundle onboarding failed", requestId, correlationId });
  }
});

app.post("/api/onboarding", onboardingUpload, async (req, res) => {
  try {
    return res.status(410).json({
      error: 'legacy_onboarding_disabled_use_r2_voice_bundle',
      canonicalEndpoint: '/api/onboarding/voice-bundle',
    });
    /* istanbul ignore next -- superseded R1 implementation retained temporarily for rollback archaeology only. */
    const language = req.body.language || 'en-US';
    const answerMeta = (() => { try { return JSON.parse(req.body.answerMeta || '{}'); } catch { return {}; } })();

    let context = {
      blocker: "",
      vision: "",
      goal: "",
    };

    const audioFiles = [];
    // v4: intro (q1=who), bigGoal (q2=90 days), weekFocus (q3=this week), whyItMatters (q4=why)
    const questionKeys = ['intro', 'bigGoal', 'weekFocus', 'whyItMatters'];
    const uploadKeys = ['q1', 'q2', 'q3', 'q4'];
    const transcriptions = [];

    for (let i = 0; i < uploadKeys.length; i++) {
      const key = uploadKeys[i];
      if (req.files && req.files[key] && req.files[key][0]) {
        const filePath = req.files[key][0].path;
        audioFiles.push(filePath);
        const transcription = await transcribeAudio(filePath, language);
        if (transcription && transcription.trim().length > 5) {
          context[questionKeys[i]] = transcription;
          transcriptions.push(transcription);
          console.log(`Transcribed q${i+1} [${language}]:`, transcription.substring(0, 50));
        }
      }
    }

    // Auto-detect gender from transcriptions
    const detectedGender = await detectGender(transcriptions);
    console.log('Detected gender:', detectedGender);

    // Priority: use dedicated voiceSample for cloning (better quality)
    // Fall back to last question audio if no voiceSample
    let combinedVoicePath = null;
    if (req.files && req.files['voiceSample'] && req.files['voiceSample'][0]) {
      combinedVoicePath = req.files['voiceSample'][0].path;
      console.log('Using dedicated voice sample for cloning');
    } else if (audioFiles.length > 0) {
      combinedVoicePath = audioFiles[audioFiles.length - 1];
      console.log('Using question audio for cloning (no dedicated sample)');
    }

    // ── Capa 1: pre-clone audio quality detector ─────────────────────
    // Reject too-short or silent uploads BEFORE we burn an ElevenLabs clone
    // call. Failure-soft if the decoder isn't available — better some clones
    // than none. See backend/voice_validator.js + Build 51 Sentry regression.
    if (combinedVoicePath) {
      Sentry.setTag('voice_validator_step', 'pre_clone');
      const v1 = await voiceValidator.validateInputSample(combinedVoicePath);
      if (!v1.ok) {
        Sentry.captureMessage('voice_validator.pre_clone_rejected', {
          level: 'warning',
          tags: { component: 'voice_validator', step: 'pre_clone', code: v1.code },
          extra: { duration: v1.duration, peak: v1.peak, file: path.basename(combinedVoicePath) },
        });
        // Clean up uploaded files since we are aborting.
        const cleanup = [...audioFiles, combinedVoicePath].filter(Boolean);
        cleanup.forEach((f) => { try { fs.unlink(f, () => {}); } catch {} });
        return res.status(v1.http || 400).json({
          error: v1.message,
          code: v1.code,
          voiceValidator: { step: 'pre_clone', duration: v1.duration, peak: v1.peak },
        });
      }
      Sentry.addBreadcrumb({
        category: 'voice_validator',
        level: 'info',
        message: 'pre_clone_passed',
        data: { duration: v1.duration, peak: v1.peak, soft: !!v1.soft, reason: v1.reason || null },
      });
    }

    let voiceReady = !!((audioFiles.length > 0 || combinedVoicePath) && ELEVENLABS_API_KEY);

    const sessionId = Date.now().toString();
    const voiceOwner = getUserByToken(req);
    const voiceOwnerId = voiceOwner?.id ? String(voiceOwner.id).replace(/[^a-zA-Z0-9_-]/g, '') : null;
    const voiceDebug = {
      cloneMode: voiceReady ? 'pending' : 'not_ready',
      sampleCount: 0,
      sampleFiles: [],
      answerMeta,
      fallbackUsed: false,
      customVoiceId: null,
      playbackVoiceId: null,
      modelId: null,
      error: null,
    };
    // Save ALL audio files for richer voice cloning
    const allVoiceFiles = [...audioFiles];
    if (combinedVoicePath && !allVoiceFiles.includes(combinedVoicePath)) {
      allVoiceFiles.push(combinedVoicePath);
    }
    voiceDebug.sampleCount = allVoiceFiles.length;
    voiceDebug.sampleFiles = allVoiceFiles.map(f => path.basename(f));

    if (allVoiceFiles.length > 0) {
      const voiceManifest = path.join(UPLOAD_STORAGE_DIR, `voice_manifest_${sessionId}.json`);
      const persistedVoiceFiles = allVoiceFiles.map((sourcePath, index) => {
        const ext = path.extname(sourcePath) || ".m4a";
        const destPath = path.join(UPLOAD_STORAGE_DIR, `voice_${sessionId}_${index + 1}${ext}`);
        fs.copyFileSync(sourcePath, destPath);
        return destPath;
      });

      // Backwards-compatible single-sample path for first-output generation by sessionId.
      const legacyVoicePath = path.join(UPLOAD_STORAGE_DIR, `voice_${sessionId}.m4a`);
      fs.copyFileSync(persistedVoiceFiles[persistedVoiceFiles.length - 1], legacyVoicePath);

      // User-scoped single-sample path for daily affirmation re-clone fallback.
      if (voiceOwnerId) {
        const userVoicePath = path.join(UPLOAD_STORAGE_DIR, `voice_user_${voiceOwnerId}_${sessionId}.m4a`);
        fs.copyFileSync(persistedVoiceFiles[persistedVoiceFiles.length - 1], userVoicePath);
      }

      fs.writeFileSync(voiceManifest, JSON.stringify(persistedVoiceFiles));
      allVoiceFiles.forEach((f) => fs.unlink(f, () => {}));
      voiceDebug.sampleFiles = persistedVoiceFiles.map(f => path.basename(f));
      res.json({ voiceReady, context, sessionId, detectedGender, language, voiceDebug });
    } else {
      res.json({ voiceReady, context, sessionId, detectedGender, language, voiceDebug });
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { area: 'voice_upload', endpoint: 'onboarding' },
      extra: { fileKeys: Object.keys(req.files || {}) },
    });
    console.error("Onboarding error:", err);
    res.status(500).json({ error: "Onboarding failed" });
  }
});

// ── Generate affirmation endpoint ───────────────────────────────────
app.post("/api/generate-affirmation", express.json(), async (req, res) => {
  try {
    const { context, sessionId, language, detectedGender } = req.body;
    const gender = detectedGender;
    if (!context) {
      return res.status(400).json({ error: "Context is required" });
    }
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const authedUser = getUserByToken(req);
    if (!authedUser) return res.status(401).json({ error: 'authentication_required_for_r2_first_message' });
    const expectedVoiceOwnerId = safeVoiceOwnerId(authedUser.id);
    const manifestPath = path.join(UPLOAD_STORAGE_DIR, `voice_manifest_${sessionId}.json`);
    let r2Manifest = null;
    try { r2Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
    if (r2Manifest && r2Manifest.voiceOwnerId !== expectedVoiceOwnerId) {
      return res.status(403).json({ error: 'r2_voice_owner_mismatch', sessionId });
    }
    const authoritativeContextResult = alzoR2.resolveAuthoritativeSemanticContext({ manifest: r2Manifest || {}, requestContext: context });
    const manifestGate = r2Manifest
      && r2Manifest.schemaVersion === 'alzo.voice_manifest.r2.v1'
      && r2Manifest.voiceOwnerId === expectedVoiceOwnerId
      && r2Manifest.mergedVoiceArtifact?.validationPassed === true
      && Number(r2Manifest.mergedVoiceArtifact?.validAudioDurationMs) >= alzoR2.MIN_VALID_AUDIO_MS
      && Array.isArray(r2Manifest.providerFiles)
      && r2Manifest.providerFiles.length === 1
      && r2Manifest.provenanceComplete === true
      && JSON.stringify(r2Manifest.semanticCaptureOrder) === JSON.stringify(alzoR2.CAPTURE_ORDER)
      && authoritativeContextResult.ok;
    if (!manifestGate) {
      const gateError = r2Manifest && !authoritativeContextResult.ok
        ? authoritativeContextResult.error
        : 'r2_bundle_validation_required_before_first_message';
      return res.status(422).json({ error: gateError, sessionId });
    }
    const authoritativeContext = authoritativeContextResult.semanticContext;

    // ── QA kill switch ────────────────────────────────────────────────
    // Short-circuit BEFORE generating text + voice for QA/Maestro/internal
    // users. Saves ElevenLabs quota and OpenAI generation tokens.
    {
      const probe = qaMockTts.shouldServeMock(req, getUserByToken(req));
      if (probe.mock) {
        const mock = qaMockTts.buildMockResponse({
          user: getUserByToken(req),
          reason: probe.reason,
          affirmationText: "QA mock affirmation — voice path bypassed.",
        });
        return res.json({
          affirmationText: mock.affirmationText,
          audioUrl: mock.audioUrl,
          voiceDebug: { cloneMode: mock.cloneMode, fallbackUsed: false, error: null, mockReason: probe.reason },
          clone_verified: false,
        });
      }
    }

    // 1. Generate the source-grounded First Message from manifest context only.
    Sentry.addBreadcrumb({ category: 'first_message', level: 'info', message: 'first_message.generation.started', data: { semanticContextSha256: r2Manifest.semanticContextSha256 } });
    const affirmationText = await generateAffirmation(authoritativeContext, language, 'first');

    // 2. Generate audio — use the single R2 merged training artifact only.
    let audioUrl = null;
    let voiceDebug = { cloneMode: 'not_ready', fallbackUsed: false, error: null };

    // R2 Final: First Message may use only the single merged artifact sealed in
    // the validated server manifest. No legacy/session/user-generic fallback.
    const lookupUserId = authedUser ? authedUser.id : null;
    let voicePath = r2Manifest.providerFiles[0];
    let voiceLookupMethod = 'r2Manifest';
    if (!voicePath || !fs.existsSync(voicePath)) {
      return res.status(422).json({ error: 'r2_merged_artifact_missing', sessionId });
    }

    console.log(`[generate-affirmation] voice-lookup method=${voiceLookupMethod} ` +
      `file=${path.basename(voicePath)} sessionId=${sessionId} userId=${lookupUserId || 'null'}`);

    if (sessionId && voicePath) {
      // Check for a cached ElevenLabs voice_id on the authenticated user.
      // Daily affirmations reuse the cached voice — no re-clone, 1/10th the cost
      // and latency (~3s vs ~25s).
      const cachedRow = authedUser ? stmts.getVoiceId.get(authedUser.id) : null;
      const cachedVoiceId = cachedRow?.elevenlabsVoiceId || null;

      // Try manifest provider files first. Build 23 writes a v2 manifest where
      // providerFiles contains exactly one merged voice-training artifact while
      // sourceCaptureFiles preserves the four emotional captures. Legacy array
      // manifests remain supported for older sessions only.
      let voiceArg = voicePath;
      if (fs.existsSync(manifestPath)) {
        try {
          const parsedManifest = parseVoiceManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
          const files = (parsedManifest.providerFiles.length ? parsedManifest.providerFiles : parsedManifest.sourceCaptureFiles).filter(f => fs.existsSync(f));
          if (files.length > 0) voiceArg = files.length === 1 ? files[0] : files;
          if (parsedManifest.mergedVoiceArtifact) {
            voiceLookupMethod = 'mergedVoiceArtifact';
          }
        } catch {}
        // Keep manifest so subsequent daily affirmations can reuse samples
      }
      const cloneResult = await cloneVoiceAndSpeak(affirmationText, voiceArg, gender, language, cachedVoiceId);
      audioUrl = cloneResult.audioUrl;
      voiceDebug = cloneResult.voiceDebug;
      // Persist the new voice_id so the next affirmation skips the clone step.
      if (authedUser && cloneResult.voiceId && cloneResult.voiceId !== cachedVoiceId) {
        stmts.setVoiceId.run(cloneResult.voiceId, authedUser.id);
      } else if (authedUser && cachedVoiceId && cloneResult.voiceDebug?.staleCachedVoiceId && !cloneResult.voiceId) {
        stmts.setVoiceId.run(null, authedUser.id);
        recordVoiceMetric('stale_cached_voice_cleared', { userId: authedUser.id, voiceId: cachedVoiceId, endpoint: 'generate_affirmation' });
      }
      // Do NOT delete voicePath — daily affirmations need the same sample.

      // Capa 2 surfaced a glitched clone — return 502 so the app can prompt
      // the user to retry with a clearer recording. Falling back to a preset
      // voice here would lie ("your voice" but it isn't), so we error.
      if (cloneResult.voiceDebug?.errorCode === 'VOICE_CLONE_GLITCHED') {
        return res.status(cloneResult.voiceDebug.errorHttp || 502).json({
          error: cloneResult.voiceDebug.errorMessage,
          code: 'VOICE_CLONE_GLITCHED',
          voiceDebug: cloneResult.voiceDebug,
        });
      }
    } else {
      return res.status(409).json({
        error: 'voice_sample_required_for_self_voice_first_message',
        code: 'VOICE_SAMPLE_REQUIRED',
        voiceDebug: { cloneMode: 'not_ready', fallbackUsed: false, error: 'voice_sample_required_for_self_voice_first_message' },
        clone_verified: false,
      });
    }

    // Build 23 contract: /api/generate-affirmation is the onboarding first
    // message path. A fallback/preset voice may be useful in a recovery screen,
    // but it must never complete onboarding or emit first_message.ready. If a
    // voice clone/TTS failed after samples existed, surface a structured retry.
    if (!audioUrl) {
      return res.status(502).json({
        error: voiceDebug?.error || 'self_voice_generation_failed',
        code: voiceDebug?.errorCode || 'SELF_VOICE_GENERATION_FAILED',
        retryAction: 'retry_voice_generation',
        voiceDebug,
        clone_verified: false,
      });
    }

    const cloneVerified = voiceDebug?.cloneVerified === true;
    console.log(`[generate-affirmation] result voice-lookup method=${voiceLookupMethod} ` +
      `file=${voicePath ? path.basename(voicePath) : 'null'} ` +
      `sessionId=${sessionId} userId=${lookupUserId || 'null'} ` +
      `cloneMode=${voiceDebug?.cloneMode || 'unknown'}`);
    res.json({ affirmationText, audioUrl, voiceDebug, clone_verified: cloneVerified });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { area: 'voice_clone', endpoint: 'generate_affirmation' },
      extra: { hasSessionId: Boolean(req.body?.sessionId), language: req.body?.language || null },
    });
    console.error("Error generating affirmation:", err);
    res.status(500).json({ error: "Failed to generate affirmation" });
  }
});

// R3 guided Daily Message: strict DTO boundary, no legacy context.
app.post("/api/daily-message", express.json(), async (req, res) => {
  try {
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: 'authentication_required_for_daily_message' });
    const boundary = dailyContextBoundary.validateDailyContext(req.body?.context);
    if (!boundary.ok) return res.status(422).json({ error: boundary.error, code: 'DAILY_CONTEXT_REJECTED' });
    const nowSec = Math.floor(Date.now() / 1000);
    const subActive = ["active", "trialing", "past_due"].includes(user.subscriptionStatus || "");
    const inTrial = user.trialEndsAt && nowSec < user.trialEndsAt;
    if (!subActive && !inTrial) return res.status(402).json({ error: 'subscription_required' });
    const dateKey = new Date().toISOString().slice(0, 10);
    const cached = stmts.getAffirmationByDate.get(user.id, dateKey);
    if (cached) return res.json({ message: { id: cached.id || `daily_${dateKey}`, dateKey, transcript: cached.text, audioUrl: cached.audioUrl, realAudioUrl: cached.audioUrl, voiceMode: cached.voiceMode, cached: true, generationProvenance: boundary.generationProvenance } });
    const cachedVoiceId = stmts.getVoiceId.get(user.id)?.elevenlabsVoiceId || null;
    if (!cachedVoiceId) return res.status(409).json({ error: 'verified_self_voice_required_for_daily', code: 'SELF_VOICE_REQUIRED' });
    const text = await generateAffirmation(boundary.context, 'en-US', 'daily');
    const retainedMergedVoice = findLatestValidatedR2MergedVoiceForUser(user.id);
    const cloneResult = await cloneVoiceAndSpeak(text, retainedMergedVoice, null, 'en-US', cachedVoiceId);
    const mode = cloneResult.voiceDebug?.cloneMode;
    if (!cloneResult.audioUrl || !['cached', 'cloned'].includes(mode)) return res.status(502).json({ error: 'daily_self_voice_tts_failed', voiceDebug: cloneResult.voiceDebug });
    if (cloneResult.voiceId && cloneResult.voiceId !== cachedVoiceId) stmts.setVoiceId.run(cloneResult.voiceId, user.id);
    const id = crypto.randomBytes(12).toString('hex');
    try {
      stmts.insertAffirmation.run(id, user.id, dateKey, text, cloneResult.audioUrl, mode);
    } catch (error) {
      const row = stmts.getAffirmationByDate.get(user.id, dateKey);
      if (row) return res.json({ message: { id: row.id || `daily_${dateKey}`, dateKey, transcript: row.text, audioUrl: row.audioUrl, realAudioUrl: row.audioUrl, voiceMode: row.voiceMode, cached: true, generationProvenance: boundary.generationProvenance } });
      throw error;
    }
    return res.json({ message: { id, dateKey, transcript: text, audioUrl: cloneResult.audioUrl, realAudioUrl: cloneResult.audioUrl, voiceMode: mode, cached: false, generationProvenance: boundary.generationProvenance } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'daily_message_r3', endpoint: 'daily-message' } });
    return res.status(500).json({ error: error.code || 'daily_message_generation_failed' });
  }
});

// ── Daily affirmation (lazy generation, one per user per day) ───────
// App hits this when opening the home screen. If the user already has today's
// affirmation, return it instantly. Otherwise generate it on-demand using the
// cached voice_id (fast path, ~3s) and store it so the rest of the day the
// call is free (DB cache hit).
app.post("/api/affirmation/today", express.json(), async (req, res) => {
  try {
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    // ── QA kill switch ────────────────────────────────────────────────
    // Short-circuit BEFORE paywall + voice path for QA/Maestro/internal
    // users. Saves ElevenLabs quota and Stripe-state coupling in tests.
    {
      const probe = qaMockTts.shouldServeMock(req, user);
      if (probe.mock) {
        const tz = Number.isFinite(req.body?.timezoneOffsetMinutes) ? req.body.timezoneOffsetMinutes : 0;
        const local = new Date(Date.now() - tz * 60 * 1000);
        const dateKey = local.toISOString().slice(0, 10);
        const mock = qaMockTts.buildMockResponse({
          user,
          reason: probe.reason,
          affirmationText: "QA mock affirmation — voice path bypassed.",
        });
        return res.json({
          dateKey,
          affirmationText: mock.affirmationText,
          audioUrl: mock.audioUrl,
          voiceMode: mock.cloneMode,
          cached: false,
          mockReason: probe.reason,
        });
      }
    }

    // Paywall gate: active subscription OR within trial. Otherwise 402 with
    // a hint for the app to open checkout.
    const nowSec = Math.floor(Date.now() / 1000);
    const subActive = ["active", "trialing", "past_due"].includes(user.subscriptionStatus || "");
    const inTrial = user.trialEndsAt && nowSec < user.trialEndsAt;
    if (!subActive && !inTrial) {
      return res.status(402).json({
        error: "Subscription required",
        message: "Your free trial ended. Subscribe to keep getting daily affirmations.",
        checkoutPath: "/api/stripe/create-checkout-session",
      });
    }

    const { context, language, detectedGender, timezoneOffsetMinutes } = req.body || {};
    // dateKey = the user's local date, so cron behavior is timezone-friendly.
    // timezoneOffsetMinutes: JS Date.getTimezoneOffset() value (UTC-local in minutes).
    // e.g. NYC EDT = 240 (positive means behind UTC). Normalize to user local midnight.
    const tz = Number.isFinite(timezoneOffsetMinutes) ? timezoneOffsetMinutes : 0;
    const local = new Date(Date.now() - tz * 60 * 1000);
    const dateKey = local.toISOString().slice(0, 10); // YYYY-MM-DD in user-local time

    const cached = stmts.getAffirmationByDate.get(user.id, dateKey);
    if (cached) {
      return res.json({
        dateKey,
        affirmationText: cached.text,
        audioUrl: cached.audioUrl,
        voiceMode: cached.voiceMode,
        cached: true,
      });
    }

    if (!context) {
      return res.status(400).json({ error: "R2 Daily context is required for first-of-day generation" });
    }

    const cachedRow = stmts.getVoiceId.get(user.id);
    const cachedVoiceId = cachedRow?.elevenlabsVoiceId || null;
    if (!cachedVoiceId) {
      return res.status(409).json({ error: 'verified_self_voice_required_for_daily', code: 'SELF_VOICE_REQUIRED' });
    }

    const dailyPrompt = alzoR2.buildDailyPrompt(context);
    Sentry.addBreadcrumb({
      category: 'daily_message',
      level: 'info',
      message: 'daily_context.built',
      data: {
        contextSha256: alzoR2.sha256(JSON.stringify(dailyPrompt.semanticContext)),
        historyAvailableCount: Array.isArray(context.recentDailyMessages || context.dailyHistory) ? (context.recentDailyMessages || context.dailyHistory).length : 0,
        historyReviewedCount: dailyPrompt.historyReviewedIds.length,
        firstMessageReferencePresent: Boolean(context.firstMessageReference),
      },
    });
    const affirmationText = await generateAffirmation(context, language, 'daily');

    const retainedMergedVoice = findLatestValidatedR2MergedVoiceForUser(user.id);
    const cloneResult = await cloneVoiceAndSpeak(
      affirmationText,
      retainedMergedVoice,
      detectedGender,
      language,
      cachedVoiceId,
    );
    const dailyVoiceMode = cloneResult.voiceDebug?.cloneMode;
    const validCachedTts = dailyVoiceMode === 'cached';
    const validStaleReclone = dailyVoiceMode === 'cloned' && cloneResult.voiceDebug?.staleVoiceReclone === true;
    if (cloneResult.voiceId && cloneResult.voiceId !== cachedVoiceId) {
      stmts.setVoiceId.run(cloneResult.voiceId, user.id);
    } else if (cloneResult.voiceDebug?.staleCachedVoiceId && !cloneResult.voiceId) {
      stmts.setVoiceId.run(null, user.id);
    }
    if (!cloneResult.audioUrl || (!validCachedTts && !validStaleReclone)) {
      return res.status(502).json({ error: 'daily_self_voice_tts_failed', voiceDebug: cloneResult.voiceDebug });
    }
    const audioUrl = cloneResult.audioUrl;
    const voiceMode = validStaleReclone ? 'recloned' : 'cached';

    const id = crypto.randomBytes(12).toString("hex");
    try {
      stmts.insertAffirmation.run(id, user.id, dateKey, affirmationText, audioUrl, voiceMode);
    } catch (e) {
      // If two concurrent requests both generated, the UNIQUE(userId, dateKey) will
      // reject one. Return the now-stored row in that case.
      const row = stmts.getAffirmationByDate.get(user.id, dateKey);
      if (row) {
        return res.json({
          dateKey,
          affirmationText: row.text,
          audioUrl: row.audioUrl,
          voiceMode: row.voiceMode,
          cached: true,
        });
      }
      throw e;
    }

    res.json({ dateKey, affirmationText, audioUrl, voiceMode, cached: false });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { area: 'voice_daily', endpoint: 'affirmation_today' },
      extra: { hasContext: Boolean(req.body?.context), language: req.body?.language || null },
    });
    console.error("affirmation/today error:", err);
    res.status(500).json({ error: "Failed to generate today's affirmation" });
  }
});

// ── Stripe endpoints ───────────────────────────────────────────────
// POST /api/stripe/create-checkout-session
// Authenticated. Creates or reuses a Stripe customer, opens a Checkout session
// for STRIPE_PRICE_ID (the Monthly plan), returns the hosted URL.
app.post("/api/stripe/create-checkout-session", express.json(), async (req, res) => {
  try {
    if (!stripe || !STRIPE_PRICE_ID) {
      return res.status(503).json({ error: "Stripe not configured" });
    }
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || undefined,
        metadata: { alzoUserId: user.id },
      });
      customerId = customer.id;
      stmts.setStripeCustomer.run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: TRIAL_DAYS > 0
        ? {
            trial_period_days: TRIAL_DAYS,
            metadata: { alzoUserId: user.id },
          }
        : {
            metadata: { alzoUserId: user.id },
          },
      success_url: `${APP_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/subscription/cancel`,
      allow_promotion_codes: true,
      metadata: { alzoUserId: user.id },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("create-checkout-session error:", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// POST /api/stripe/webhook
// Stripe signs the webhook body — we verify via STRIPE_WEBHOOK_SECRET, then
// react to subscription lifecycle events.
//
// Important: Stripe needs the RAW body (not the JSON-parsed one) to verify the
// signature. Using express.raw({ type: 'application/json' }) for this route
// only. Must be registered BEFORE the catch-all express.json() middleware that
// lives above.
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(503).send("Stripe webhook not configured");
    }
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const customerId = session.customer;
          const subscriptionId = session.subscription;
          if (subscriptionId && customerId) {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            stmts.setSubscriptionByCustomerId.run(
              subscriptionId,
              sub.status,
              sub.current_period_end,
              customerId,
            );
            // P0 REVENUE BLINDNESS — funnel events #4 + #5
            // checkout.session.completed is the moment Stripe confirms the
            // first payment for a checkout flow, so we treat it as both
            // purchase_success AND the entitlement transition (none|trial → active).
            const row = stmts.getUserByStripeCustomer.get(customerId);
            const uid = row && row.id ? row.id : null;
            logAnalyticsEvent("purchase_success", {
              source: "stripe.webhook.checkout_completed",
              customer_id: customerId,
              subscription_id: subscriptionId,
              status: sub.status,
              current_period_end: sub.current_period_end,
            }, uid);
            logAnalyticsEvent("entitlement_changed", {
              source: "stripe.webhook.checkout_completed",
              customer_id: customerId,
              subscription_id: subscriptionId,
              new_status: sub.status,
            }, uid);
          }
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.created": {
          const sub = event.data.object;
          const upd = stmts.setSubscriptionByCustomerId.run(
            sub.id,
            sub.status,
            sub.current_period_end,
            sub.customer,
          );
          // P0 REVENUE BLINDNESS — funnel event #5 (entitlement_changed)
          // Fires for any Stripe-side subscription mutation (trial→active,
          // active→past_due, plan upgrade/downgrade, etc.). The fallback-by-
          // email branch below re-resolves the user id and we log there too if
          // needed; this top-level emit covers the happy path where the
          // customer↔user link already exists.
          const _entRow = stmts.getUserByStripeCustomer.get(sub.customer);
          logAnalyticsEvent("entitlement_changed", {
            source: "stripe.webhook." + event.type,
            customer_id: sub.customer,
            subscription_id: sub.id,
            new_status: sub.status,
            current_period_end: sub.current_period_end,
            updated_changes: upd.changes,
          }, _entRow && _entRow.id ? _entRow.id : null);
          if (upd.changes === 0) {
            // Fallback: customer was created out-of-band (e.g. via API, not checkout flow).
            // Match user by normalized email; fail closed on duplicates.
            try {
              const customer = await stripe.customers.retrieve(sub.customer);
              const email = (customer && customer.email ? String(customer.email).trim().toLowerCase() : "");
              if (email) {
                const matches = db.prepare("SELECT id FROM users WHERE LOWER(TRIM(email)) = ?").all(email);
                if (matches.length === 1) {
                  const userId = matches[0].id;
                  stmts.setStripeCustomer.run(sub.customer, userId);
                  stmts.setSubscriptionByCustomerId.run(
                    sub.id,
                    sub.status,
                    sub.current_period_end,
                    sub.customer,
                  );
                  Sentry.addBreadcrumb({
                    category: "stripe.webhook",
                    level: "info",
                    message: "webhook.fallback_by_email.linked",
                    data: { email, userId, customerId: sub.customer, subscriptionId: sub.id, eventType: event.type },
                  });
                } else if (matches.length > 1) {
                  Sentry.captureMessage("stripe.webhook.fallback_by_email.duplicate", {
                    level: "error",
                    extra: { email, customerId: sub.customer, count: matches.length, eventType: event.type },
                  });
                } else {
                  Sentry.addBreadcrumb({
                    category: "stripe.webhook",
                    level: "warning",
                    message: "webhook.fallback_by_email.no_match",
                    data: { email, customerId: sub.customer, eventType: event.type },
                  });
                }
              }
            } catch (fallbackErr) {
              Sentry.captureException(fallbackErr, { tags: { source: "stripe.webhook.fallback_by_email" } });
            }
          }
          break;
        }
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          stmts.setSubscriptionByCustomerId.run(
            sub.id,
            "canceled",
            sub.current_period_end,
            sub.customer,
          );
          // P0 REVENUE BLINDNESS — funnel event #5 (entitlement_changed → canceled)
          const _delRow = stmts.getUserByStripeCustomer.get(sub.customer);
          logAnalyticsEvent("entitlement_changed", {
            source: "stripe.webhook.subscription_deleted",
            customer_id: sub.customer,
            subscription_id: sub.id,
            new_status: "canceled",
          }, _delRow && _delRow.id ? _delRow.id : null);
          break;
        }
      }
      res.json({ received: true });
    } catch (err) {
      console.error("Stripe webhook handler error:", err.message);
      res.status(500).send("Webhook handler error");
    }
  }
);

// GET /api/subscription/status — authenticated. Returns whether the user has
// access (active, trialing, or within trialEndsAt).
app.get("/api/subscription/status", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const now = Math.floor(Date.now() / 1000);
  const status = user.subscriptionStatus || "none";
  const inTrial = user.trialEndsAt && now < user.trialEndsAt;
  const subActive = ["active", "trialing", "past_due"].includes(status);
  const hasAccess = subActive || inTrial;

  res.json({
    hasAccess,
    status,
    inTrial: !!inTrial,
    trialEndsAt: user.trialEndsAt || null,
    subscriptionCurrentPeriodEnd: user.subscriptionCurrentPeriodEnd || null,
  });
});

// ── Auth endpoints ──────────────────────────────────────────────────
app.post("/api/auth/signup", (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const existing = stmts.getByEmail.get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: "Account already exists" });

  // MVP user cap. Raise BETA_USER_CAP env var to open the gate.
  const USER_CAP = parseInt(process.env.BETA_USER_CAP || "1000", 10);
  const current = stmts.countUsers.get().n;
  if (current >= USER_CAP) {
    return res.status(503).json({
      error: "Beta full",
      message: "ALZO beta is full. Join the waitlist and we'll reach out as slots open.",
      waitlistUrl: "https://thenetmencorp.com/alzo-waitlist",
    });
  }

  const userId = crypto.randomBytes(16).toString("hex");
  const token = generateToken();
  stmts.insert.run(userId, email.toLowerCase(), name || null, hashPassword(password), token);

  // Grant free trial so the user can use the app for TRIAL_DAYS before paywall kicks in.
  const trialEndsAt = Math.floor(Date.now() / 1000) + TRIAL_DAYS * 86400;
  stmts.setTrial.run(trialEndsAt, userId);

  // P0 REVENUE BLINDNESS — funnel event #1
  logAnalyticsEvent("signup", { provider: "email", trial_ends_at: trialEndsAt }, userId);

  const storedUser = stmts.getByEmail.get(email.toLowerCase());
  res.json({
    ...buildAuthoritativeAuthResponse({ token, user: storedUser, isNewUser: true, provider: 'email' }),
    trialEndsAt,
  });
});

app.post("/api/auth/reset-password", (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).json({ error: "Email and new password are required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const user = stmts.getByEmail.get(email.toLowerCase());
  if (!user) return res.status(404).json({ error: "Account not found" });

  db.prepare("UPDATE users SET passwordHash = ? WHERE email = ?").run(hashPassword(newPassword), email.toLowerCase());
  res.json({ success: true });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  const user = stmts.getByEmail.get(email.toLowerCase());
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = generateToken();
  stmts.updateToken.run(token, email.toLowerCase());
  const storedUser = stmts.getByEmail.get(email.toLowerCase());

  res.json(buildAuthoritativeAuthResponse({ token, user: storedUser, isNewUser: false, provider: 'email' }));
});

function classifyAppleIdentityTokenFailure(error) {
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  if (/audience|unexpected[^\n]*\baud\b|\baud\b[^\n]*claim/.test(message)) return 'audience_mismatch';
  if (/expired|expiration|\bexp\b[^\n]*claim|tokenexpir/.test(message)) return 'expired';
  return 'malformed';
}

function safeCorrelationHeader(req, headerName) {
  const value = String(req.get(headerName) || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : 'none';
}

function captureAppleVerificationFailure(req, reasonCode) {
  const requestId = safeCorrelationHeader(req, 'x-request-id');
  const correlationId = safeCorrelationHeader(req, 'x-correlation-id');
  const sessionId = safeCorrelationHeader(req, 'x-alzo-session-id');
  const tags = {
    event_name: 'auth.apple.verify.failed',
    provider: 'apple',
    reason_code: reasonCode,
    http_status: '401',
    request_id: requestId,
    correlation_id: correlationId,
    session_id: sessionId,
  };
  const extra = {
    provider: 'apple',
    status: 401,
    reasonCode,
    requestId,
    correlationId,
    sessionId,
  };
  try {
    Sentry.captureMessage('auth.apple.verify.failed', { level: 'warning', tags, extra });
  } catch (_) {}
}

// Apple Sign-in: identityToken from frontend, verify signature against Apple JWKS
app.post("/api/auth/apple", async (req, res) => {
  const { identityToken, email: providedEmail, fullName } = req.body;
  if (!identityToken) return res.status(400).json({ error: "identityToken is required" });

  let appleSub, tokenEmail;
  try {
    const payload = await appleSignin.verifyIdToken(identityToken, {
      audience: APPLE_BUNDLE_ID,
      ignoreExpiration: false,
    });
    appleSub = payload.sub;
    tokenEmail = payload.email;
  } catch (e) {
    const reasonCode = classifyAppleIdentityTokenFailure(e);
    console.error("Apple token verification failed:", reasonCode);
    captureAppleVerificationFailure(req, reasonCode);
    return res.status(401).json({ error: "Authentication failed", reasonCode });
  }

  const email = (tokenEmail || providedEmail || "").toLowerCase();
  if (!email) return res.status(400).json({ error: "No email available from Apple" });

  let user = stmts.getByEmail.get(email);
  const token = generateToken();

  if (user) {
    stmts.updateToken.run(token, email);
    const storedUser = stmts.getByEmail.get(email);
    return res.json(buildAuthoritativeAuthResponse({
      token,
      user: storedUser,
      isNewUser: false,
      provider: 'apple',
    }));
  }

  const userId = crypto.randomBytes(16).toString("hex");
  const name = fullName || null;
  stmts.insert.run(userId, email, name, "apple_sso_" + appleSub, token);
  // P0 REVENUE BLINDNESS — funnel event #1 (Apple SSO new user)
  logAnalyticsEvent("signup", { provider: "apple" }, userId);
  const storedUser = stmts.getByEmail.get(email);
  res.json(buildAuthoritativeAuthResponse({
    token,
    user: storedUser,
    isNewUser: true,
    provider: 'apple',
  }));
});

// Google Sign-in: idToken from frontend, verify signature against Google JWKS
app.post("/api/auth/google", async (req, res) => {
  const { idToken, email: providedEmail, name: providedName } = req.body;
  if (!idToken) return res.status(400).json({ error: "idToken is required" });
  if (!googleAuthClient) {
    console.error("Google auth misconfigured: GOOGLE_WEB_CLIENT_ID missing");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  let googleSub, tokenEmail;
  try {
    const ticket = await googleAuthClient.verifyIdToken({
      idToken,
      audience: GOOGLE_WEB_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    googleSub = payload.sub;
    tokenEmail = payload.email;
  } catch (e) {
    console.error("Google token verification failed:", e.message);
    return res.status(401).json({ error: "Authentication failed" });
  }

  const email = (tokenEmail || providedEmail || "").toLowerCase();
  if (!email) return res.status(400).json({ error: "No email available from Google" });

  let user = stmts.getByEmail.get(email);
  const token = generateToken();

  if (user) {
    stmts.updateToken.run(token, email);
    const storedUser = stmts.getByEmail.get(email);
    return res.json(buildAuthoritativeAuthResponse({
      token,
      user: storedUser,
      isNewUser: false,
      provider: 'google',
    }));
  }

  const userId = crypto.randomBytes(16).toString("hex");
  const name = providedName || null;
  stmts.insert.run(userId, email, name, "google_sso_" + googleSub, token);
  // P0 REVENUE BLINDNESS — funnel event #1 (Google SSO new user)
  logAnalyticsEvent("signup", { provider: "google" }, userId);
  const storedUser = stmts.getByEmail.get(email);
  res.json(buildAuthoritativeAuthResponse({
    token,
    user: storedUser,
    isNewUser: true,
    provider: 'google',
  }));
});

app.get("/api/user/profile", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  // Decay plants on profile load (handles users who missed days)
  decayPlantHealth(user.id);
  res.json({
    userId: user.id,
    accountCreated: true,
    profile: normalizeAuthoritativeProfile(user),
  });
});

// B48-21: account deletion with cascade. Steps:
//   1) Cancel any active Stripe subscription (best-effort; failure is logged
//      but does not block deletion — we cannot leave the user with no DB row
//      yet still active billing).
//   2) Delete every child row in a single transaction (goals, checkins,
//      plants, garden, journal_entries, affirmations, milestones, messages).
//   3) Delete the user row itself, which revokes the auth token (the token
//      lives in the users row).
//
// `/api/user/me` is the canonical path used by the FE; `/api/user` is kept
// as a compatibility alias for older clients.
const handleDeleteAccount = async (req, res) => {
  // B48-29: tag the entire flow so every event raised below — Stripe cancel,
  // each cascade step, the final user delete — groups into ALZO-BACKEND-3
  // and the FK violation that opened this ticket can be diagnosed at the
  // sub-step level.
  Sentry.setTag("flow", "delete_account");

  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  Sentry.setUser({ id: user.id, email: user.email });

  // 1) Stripe — cancel subscription if present. We try the live cancel via
  //    the Stripe API; if Stripe is not configured (no STRIPE_SECRET_KEY) we
  //    just zero out the subscription columns locally.
  if (user.stripeSubscriptionId) {
    try {
      if (stripe) {
        await stripe.subscriptions.cancel(user.stripeSubscriptionId);
        Sentry.addBreadcrumb({
          category: "billing",
          level: "info",
          message: "delete_account.stripe_canceled",
          data: { subId: user.stripeSubscriptionId },
        });
      }
    } catch (e) {
      // Don't block the DB delete — log and move on.
      Sentry.captureException(e, {
        tags: { flow: "delete_account", step: "stripe_cancel" },
        extra: { userId: user.id, subId: user.stripeSubscriptionId },
      });
    }
  }

  // 2) ElevenLabs voice cleanup — best-effort, never blocks DB cascade.
  //    Path C (Joaquín 2026-05-09): the previous "cascade fix" referenced
  //    commit 4965746 was never actually written. This adds the missing API
  //    call so a deleted account also removes its cloned voice from
  //    ElevenLabs (frees the slot + closes the privacy gap).
  if (user.elevenlabsVoiceId && ELEVENLABS_API_KEY) {
    try {
      const elDelRes = await withTimeout(
        fetch(`${ELEVENLABS_BASE}/voices/${user.elevenlabsVoiceId}`, {
          method: "DELETE",
          headers: { "xi-api-key": ELEVENLABS_API_KEY },
        }),
        8000,
      );
      const ok = !!(elDelRes && elDelRes.ok);
      Sentry.addBreadcrumb({
        category: "elevenlabs.delete",
        level: ok ? "info" : "warning",
        message: "delete_account.elevenlabs_voice_deleted",
        data: { voice_id: user.elevenlabsVoiceId, status: elDelRes && elDelRes.status, ok },
      });
      if (!ok) {
        Sentry.captureMessage("delete_account.elevenlabs_voice_delete_failed", {
          level: "warning",
          tags: { flow: "delete_account", step: "elevenlabs_delete" },
          extra: {
            userId: user.id,
            voiceId: user.elevenlabsVoiceId,
            status: elDelRes && elDelRes.status,
          },
        });
      }
    } catch (e) {
      // Network/timeout/etc — best-effort. Do NOT block DB cascade.
      Sentry.captureException(e, {
        tags: { flow: "delete_account", step: "elevenlabs_delete" },
        extra: { userId: user.id, voiceId: user.elevenlabsVoiceId },
      });
    }
  }

  // 3) + 4) Cascade DB delete inside a transaction.
  //    PRAGMA foreign_keys is now ON (see init): rows that are referenced by
  //    other rows must go last. Deletion order, child → parent:
  //      checkins (refs goals)            → must precede goals
  //      garden   (refs plants + goals)   → must precede plants & goals
  //      plants   (refs goals)            → must precede goals
  //      goals
  //      journal_entries / affirmations / milestones / messages — refs only users
  //      users                            → last
  //
  //    Each step runs its own try/Sentry.captureException with a  tag
  //    so Sentry can pin-point which child table is the FK culprit when the
  //    edge case fires (this is what blew up in ALZO-BACKEND-3 before B48-29).
  const STEPS = [
    ["delete_checkins",     stmts.deleteCheckinsByUser],
    ["delete_garden",       stmts.deleteGardenByUser],
    ["delete_plants",       stmts.deletePlantsByUser],
    ["delete_goals",        stmts.deleteGoalsByUser],
    ["delete_journal",      stmts.deleteJournalByUser],
    ["delete_affirmations", stmts.deleteAffirmationsByUser],
    ["delete_milestones",   stmts.deleteMilestonesByUser],
    ["delete_messages",     stmts.deleteMessagesByUser],
    ["delete_user",         stmts.deleteUserById],
  ];

  try {
    const cascade = db.transaction((uid) => {
      for (const [step, stmt] of STEPS) {
        try {
          stmt.run(uid);
        } catch (stepErr) {
          // Re-throw to abort the transaction, but also tag the failure with
          // the exact step so Sentry surfaces the FK culprit.
          Sentry.captureException(stepErr, {
            tags: { flow: "delete_account", step },
            extra: { userId: uid },
          });
          throw stepErr;
        }
      }
    });
    cascade(user.id);
  } catch (e) {
    Sentry.captureException(e, {
      tags: { flow: "delete_account", step: "cascade" },
      extra: { userId: user.id, message: e?.message, code: e?.code },
    });
    return res.status(500).json({ error: "Account deletion failed" });
  }

  // P0 REVENUE BLINDNESS — funnel event #6 (delete_account success).
  // Fires only on the success path (the 500 above returns before this line),
  // so any "delete_account" event in the log is by definition a completed
  // cascade. Payload includes whether the user had an active sub at delete
  // time so we can measure churn vs free-tier delete.
  logAnalyticsEvent("delete_account", {
    had_subscription: !!user.stripeSubscriptionId,
    previous_status: user.subscriptionStatus || "none",
    had_voice: !!user.elevenlabsVoiceId,
  }, user.id);

  res.json({ success: true });
};

app.delete("/api/user/me", handleDeleteAccount);
app.delete("/api/user", handleDeleteAccount);

app.post("/api/subscription/cancel", async (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // Stripe is source of truth. We do NOT mutate local plan here;
  // the customer.subscription.updated webhook drives entitlement/status.
  if (!user.stripeSubscriptionId) {
    return res.status(404).json({ error: "no_active_subscription" });
  }

  if (!stripe) {
    Sentry.captureMessage("subscription.cancel.stripe_unavailable", {
      level: "error",
      extra: { userId: user.id },
    });
    return res.status(502).json({ error: "stripe_unavailable" });
  }

  try {
    // Idempotency: if already scheduled for cancel, skip the Stripe call.
    const current = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    if (current?.cancel_at_period_end === true) {
      return res.json({
        success: true,
        already_cancelled: true,
        cancel_at_period_end: true,
        current_period_end: current.current_period_end,
      });
    }

    const sub = await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    Sentry.addBreadcrumb({
      category: "subscription",
      message: "subscription.cancel.scheduled",
      data: { subId: user.stripeSubscriptionId, cancel_at: sub.cancel_at },
    });
    return res.json({
      success: true,
      cancel_at_period_end: sub.cancel_at_period_end,
      current_period_end: sub.current_period_end,
    });
  } catch (e) {
    Sentry.captureException(e, {
      tags: { endpoint: "subscription.cancel" },
      extra: { userId: user.id, subId: user.stripeSubscriptionId },
    });
    return res.status(502).json({ error: "stripe_error", message: e.message });
  }
});

// ── Demo audio endpoint ─────────────────────────────────────────────
app.get("/audio/demo.mp3", (req, res) => {
  const demoPath = path.join(__dirname, "public", "audio", "demo.mp3");
  if (fs.existsSync(demoPath)) {
    res.sendFile(demoPath);
  } else {
    res.status(404).json({ error: "Demo not available" });
  }
});

// ── Release authority and non-PII canary trace ───────────────────────
const releaseSha = () => process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || process.env.COMMIT_SHA || "unknown";
const canaryTraces = new Map();

app.get("/api/release-contract", (req, res) => {
  res.json({
    ok: true,
    backendLiveSha: releaseSha(),
    wireContractVersion: WIRE_CONTRACT_VERSION,
    voiceMultipartFields: VOICE_MULTIPART_FIELDS,
    voiceDurationRule: VOICE_DURATION_RULE,
  });
});

app.post("/api/observability/canary", (req, res) => {
  const correlationId = String(req.get('x-correlation-id') || req.body?.correlationId || crypto.randomUUID()).slice(0, 160);
  const receipt = {
    schema: 'alzo.backend_canary_trace.v1',
    correlationId,
    status: 'completed',
    backendLiveSha: releaseSha(),
    wireContractVersion: WIRE_CONTRACT_VERSION,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  canaryTraces.set(correlationId, receipt);
  if (canaryTraces.size > 100) canaryTraces.delete(canaryTraces.keys().next().value);
  console.log(JSON.stringify({ event: 'observability.canary.completed', ...receipt }));
  res.set('x-correlation-id', correlationId).json(receipt);
});

app.get("/api/observability/canary/:correlationId", (req, res) => {
  const correlationId = String(req.params.correlationId || '').slice(0, 160);
  const receipt = canaryTraces.get(correlationId);
  if (!receipt) return res.status(404).json({ error: 'canary_trace_not_found', correlationId });
  return res.json(receipt);
});

// ── Health check ─────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "ALZO",
    version: releaseSha(),
    backendLiveSha: releaseSha(),
    wireContractVersion: WIRE_CONTRACT_VERSION,
    voiceDurationRuleVersion: VOICE_DURATION_RULE.version,
    openai: !!process.env.OPENAI_API_KEY,
    elevenlabs: !!ELEVENLABS_API_KEY,
    audioStorage: {
      path: AUDIO_STORAGE_DIR,
      publicPath: AUDIO_PUBLIC_PATH,
      persistentConfigured: Boolean(process.env.AUDIO_STORAGE_DIR),
    },
    uploadStorage: {
      path: UPLOAD_STORAGE_DIR,
      publicPath: UPLOAD_PUBLIC_PATH,
      persistentConfigured: Boolean(process.env.UPLOAD_STORAGE_DIR),
    },
  });
});

app.get("/api/health/voice", async (req, res) => {
  const requestId = req.get('x-request-id') || crypto.randomUUID();
  const correlationId = req.get('x-correlation-id') || req.get('x-voice-attempt-id') || requestId;
  const startedAt = Date.now();
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized", requestId, correlationId });

  const basePayload = {
    ok: false,
    provider: 'elevenlabs',
    stage: 'provider_health',
    requestId,
    correlationId,
    apiKeyPresent: !!ELEVENLABS_API_KEY,
    connectivity: false,
    liveEndpointAvailable: false,
    cloneEndpoint: 'not_checked',
    generationEndpoint: 'not_checked',
    cachedVoiceChecked: false,
    cachedVoiceStatus: 'not_checked',
    coverage: 'live_provider_account_probe_no_mutation',
  };

  const finish = (httpStatus, payload) => {
    const finalPayload = { ...basePayload, ...payload, durationMs: Date.now() - startedAt };
    Sentry.addBreadcrumb({
      category: 'voice.provider.health',
      level: finalPayload.ok ? 'info' : 'warning',
      message: finalPayload.ok ? 'ready' : 'failed',
      data: {
        requestId,
        correlationId,
        failureKind: finalPayload.failureKind || null,
        status: finalPayload.providerStatus || null,
      },
    });
    if (!finalPayload.ok) {
      Sentry.captureMessage('voice.provider.health.failed', {
        level: finalPayload.failureKind === 'auth_error' ? 'error' : 'warning',
        tags: {
          component: 'elevenlabs',
          endpoint: 'health_voice',
          provider: 'elevenlabs',
          failure_kind: finalPayload.failureKind || 'unknown',
        },
        extra: {
          requestId,
          correlationId,
          providerStatus: finalPayload.providerStatus || null,
          providerBody: finalPayload.providerBody || null,
          cachedVoiceStatus: finalPayload.cachedVoiceStatus || null,
        },
      });
    }
    return res.status(httpStatus).json(finalPayload);
  };

  if (!ELEVENLABS_API_KEY) {
    return finish(503, {
      error: 'elevenlabs_api_key_missing',
      failureKind: 'auth_error',
      retryAction: providerRetryAction('auth_error'),
    });
  }

  const accountCheck = await checkElevenLabsEndpoint('/voices', { timeoutMs: 10000 });
  if (!accountCheck.ok) {
    const failureKind = accountCheck.failureKind || classifyElevenLabsFailure(accountCheck.status, accountCheck.error || accountCheck.body);
    const httpStatus = failureKind === 'auth_error' ? 401 : failureKind === 'rate_limit' ? 429 : failureKind === 'provider_timeout' ? 504 : 502;
    return finish(httpStatus, {
      error: accountCheck.error || failureKind,
      failureKind,
      retryAction: providerRetryAction(failureKind),
      providerStatus: accountCheck.status,
      providerBody: typeof accountCheck.body === 'string' ? accountCheck.body.slice(0, 500) : accountCheck.body,
      connectivity: Boolean(accountCheck.status),
      liveEndpointAvailable: false,
      cloneEndpoint: 'voices_list_failed',
      generationEndpoint: 'not_checked',
    });
  }

  const cachedVoiceId = stmts.getVoiceId.get(user.id)?.elevenlabsVoiceId || null;
  let cachedVoiceStatus = cachedVoiceId ? 'not_checked' : 'missing';
  let cachedVoiceCheck = null;
  if (cachedVoiceId) {
    cachedVoiceCheck = await checkElevenLabsEndpoint(`/voices/${encodeURIComponent(cachedVoiceId)}`, { timeoutMs: 10000 });
    cachedVoiceStatus = cachedVoiceCheck.ok ? 'ok' : (cachedVoiceCheck.status === 404 ? 'stale' : 'provider_error');
  }

  if (cachedVoiceCheck && !cachedVoiceCheck.ok && cachedVoiceCheck.status !== 404) {
    const failureKind = cachedVoiceCheck.failureKind || classifyElevenLabsFailure(cachedVoiceCheck.status, cachedVoiceCheck.error || cachedVoiceCheck.body);
    const httpStatus = failureKind === 'auth_error' ? 401 : failureKind === 'rate_limit' ? 429 : failureKind === 'provider_timeout' ? 504 : 502;
    return finish(httpStatus, {
      error: cachedVoiceCheck.error || failureKind,
      failureKind,
      retryAction: providerRetryAction(failureKind),
      providerStatus: cachedVoiceCheck.status,
      providerBody: typeof cachedVoiceCheck.body === 'string' ? cachedVoiceCheck.body.slice(0, 500) : cachedVoiceCheck.body,
      connectivity: true,
      liveEndpointAvailable: true,
      cloneEndpoint: 'voices_list_checked',
      generationEndpoint: 'cached_voice_lookup_failed',
      cachedVoiceChecked: true,
      cachedVoiceStatus,
      cachedVoiceId,
    });
  }

  return finish(200, {
    ok: true,
    status: cachedVoiceStatus === 'stale' ? 'stale_cached_voice' : 'ok',
    connectivity: true,
    liveEndpointAvailable: true,
    cloneEndpoint: 'voices_list_checked',
    generationEndpoint: cachedVoiceId ? 'cached_voice_lookup_checked' : 'not_mutated_no_cached_voice',
    cachedVoiceChecked: Boolean(cachedVoiceId),
    cachedVoiceStatus,
    cachedVoiceId: cachedVoiceId || null,
    providerStatus: accountCheck.status,
    failureKind: cachedVoiceStatus === 'stale' ? 'provider_job_timeout' : null,
    retryAction: cachedVoiceStatus === 'stale' ? providerRetryAction('provider_job_timeout') : null,
  });
});

// ── ALIGNMENT SYSTEM ENDPOINTS ──────────────────────────────────────

// Goals
app.post("/api/goals", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { type, description, audioUrl, motivation, motivationAudioUrl, horizonDays } = req.body;
  // B48-22: enforce 2-of-a-kind cap server-side as a safety net behind the
  // FE block. type values: 'short' = 7d (cap 2), anything else = 'long' / 90d
  // (cap 2). Reject with 409 + the canonical FE copy so any legacy client
  // that misses the FE check still gets the same UX message.
  const goalType = type || 'long';
  const activeOfKind = stmts.getActiveGoals
    .all(user.id)
    .filter((g) => (g.type || 'long') === goalType);
  if (activeOfKind.length >= 2) {
    return res.status(409).json({
      error: "Cap reached: cancel one to add new",
      code: "GOAL_CAP_REACHED",
      kind: goalType,
    });
  }
  const id = crypto.randomUUID();
  const targetDate = new Date(Date.now() + (horizonDays || 90) * 86400000).toISOString();
  stmts.insertGoal.run(id, user.id, goalType, description, audioUrl, motivation, motivationAudioUrl, horizonDays || 90, targetDate);
  res.json({ id, success: true });
});

app.get("/api/goals", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const rows = stmts.getActiveGoals.all(user.id);
  // B48-4/Day 17: DB column is `startDate` + `horizonDays`; FE needs
  // canonical `startedAt` + `durationDays` so day count/progress do not drift.
  const goals = rows.map((goal) => ({
    ...goal,
    startedAt: goal.startedAt || goal.startDate || goal.createdAt || null,
    durationDays: goal.durationDays || goal.horizonDays || (goal.type === 'short' ? 7 : 90),
  }));
  res.json({ goals });
});

app.post("/api/goals/:id/complete", async (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const goal = stmts.getGoal.get(req.params.id, user.id);
  if (!goal) return res.status(404).json({ error: "Goal not found" });
  stmts.completeGoal.run(goal.id);

  // Generate chronicle and move plant to garden
  try {
    const plants = stmts.getActivePlants.all(user.id);
    const goalPlant = plants.find(p => p.goalId === goal.id);
    const checkins = stmts.getRecentCheckins.all(user.id, 90);


    const chronicleRes = await openai.chat.completions.create({
      model: _DEFAULT_MODEL,
      messages: [
        {
          role: "system",
          content: `You write short, powerful achievement stories for the ALZO app. 3-4 sentences. Like a narrator telling someone's journey. Premium, emotional, grounded. Use the user's name. Write in ${user.language || 'en-US'}.`
        },
        {
          role: "user",
          content: `Write a chronicle for completing this goal.
Name: ${user.name || 'User'}
Goal: ${goal.description}
Days with check-ins: ${checkins.length}
Plant: ${goalPlant?.species || 'unknown'} named "${goalPlant?.name || 'companion'}"`
        }
      ],
      temperature: 0.8,
      max_tokens: 200,
    });

    const chronicle = chronicleRes.choices[0].message.content.trim();

    if (goalPlant) {
      stmts.movePlantToGarden.run(goalPlant.id);
      const gardenId = crypto.randomUUID();
      stmts.insertGarden.run(gardenId, user.id, goalPlant.id, goal.id, chronicle);
    }

    // Create goal completion milestone
    const milestoneId = crypto.randomUUID();
    stmts.insertMilestone.run(milestoneId, user.id, goal.id, 'goal_completed', 'Goal Completed', chronicle, checkins.length);

    res.json({ success: true, chronicle });
  } catch (err) {
    console.error('Chronicle generation error:', err.message);
    res.json({ success: true, chronicle: null });
  }
});

// Check-in
app.post("/api/checkin", async (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { goalId, intentionConfirmed, emotionalState, energyLevel, alignment, microcommitment } = req.body;
  if (typeof alignment === 'number' || /^\s*\d+(?:\.\d+)?\s*$/.test(String(alignment || ''))) {
    return res.status(400).json({ error: 'alignment_must_be_emotional_relationship_not_numeric_score' });
  }
  const id = crypto.randomUUID();
  stmts.insertCheckin.run(id, user.id, goalId, intentionConfirmed ? 1 : 0, emotionalState || null, energyLevel ?? null, alignment || null, microcommitment || null);

  // R2 Final: submission records context only. Strike, streak and plant growth
  // must wait for credible native Daily Message playback completion.
  res.json({
    id,
    success: true,
    status: 'awaiting_daily_playback',
    alignmentSemantics: 'emotional_connection_only',
    visibleNumericScore: false,
    scoringEnabled: false,
    plantUpdated: false,
    strikeActivated: false,
    growthAwaitingPlayback: true,
    newMilestones: [],
  });
});

app.get("/api/checkin/today", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const checkin = stmts.getTodayCheckin.get(user.id);
  res.json({ checkin: checkin || null, completed: !!checkin });
});

// Mirror
app.get("/api/mirror", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const goals = stmts.getActiveGoals.all(user.id);
  const recentCheckins = stmts.getRecentCheckins.all(user.id, 7);

  const primaryGoal = goals.find(g => g.type === 'long') || goals[0];
  const lastCheckin = recentCheckins[0];

  const totalCheckins = recentCheckins.length;

  // Determine dominant mood
  const moods = recentCheckins.map(c => c.emotionalState).filter(Boolean);
  const moodCounts = {};
  moods.forEach(m => { moodCounts[m] = (moodCounts[m] || 0) + 1; });
  const dominantMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

  res.json({
    intention: primaryGoal?.description || null,
    lastState: lastCheckin?.emotionalState || null,
    lastEnergy: lastCheckin?.energyLevel || null,
    lastAlignment: lastCheckin?.alignment || null,
    alignmentSemantics: 'emotional_connection_only',
    visibleNumericScore: false,
    scoringEnabled: false,
    dominantMood,
    daysActive: totalCheckins,
    goalDaysRemaining: primaryGoal ? Math.max(0, Math.ceil((new Date(primaryGoal.targetDate) - Date.now()) / 86400000)) : null,
    goalProgress: primaryGoal ? Math.round(((primaryGoal.horizonDays - Math.max(0, Math.ceil((new Date(primaryGoal.targetDate) - Date.now()) / 86400000))) / primaryGoal.horizonDays) * 100) : 0,
    // B48-4: explicit duration so FE can render "X days" without computing
    // remaining-days from a stale targetDate. Both names exposed for compat.
    goalHorizonDays: primaryGoal?.horizonDays ?? null,
    goalDurationDays: primaryGoal?.horizonDays ?? null,
  });
});

// Plants
app.post("/api/plants", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { goalId, species, name, color } = req.body;
  const id = crypto.randomUUID();
  stmts.insertPlant.run(id, user.id, goalId, species, name, color || '#6B4EFF');
  res.json({ id, success: true });
});

app.get("/api/plants", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const plants = stmts.getActivePlants.all(user.id);
  res.json({ plants });
});

app.put("/api/plants/:id/name", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  stmts.updatePlantName.run(req.body.name, req.params.id, user.id);
  res.json({ success: true });
});

// Garden
app.get("/api/garden", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const entries = stmts.getGarden.all(user.id);
  res.json({ garden: entries });
});

// Journal
app.post("/api/journal", upload.single("audio"), (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const id = crypto.randomUUID();
  const audioUrl = req.file ? `${UPLOAD_PUBLIC_PATH}/${req.file.filename}` : null;
  const duration = parseInt(req.body.duration) || 0;
  stmts.insertJournal.run(id, user.id, req.body.goalId, audioUrl, duration);
  res.json({ id, success: true });
});

app.get("/api/journal", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const limit = parseInt(req.query.limit) || 20;
  const entries = stmts.getJournal.all(user.id, limit);
  res.json({ entries });
});

// Messages
app.get("/api/message/today", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const message = stmts.getTodayMessage.get(user.id);
  res.json({ message: message || null });
});

app.post("/api/message/:id/listened", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  stmts.markListened.run(req.body.full ? 1 : 0, req.params.id);
  res.json({ success: true });
});

// Notification schedule
app.put("/api/user/notification", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { hour, minute } = req.body;
  stmts.updateNotification.run(hour || 7, minute || 0, user.id);
  res.json({ success: true });
});

// ── Plant species list ──────────────────────────────────────────────
const PLANT_SPECIES = [
  { id: "pothos", name: "Pothos", meaning: "Growth and resilience", rarity: "common" },
  { id: "monstera", name: "Monstera", meaning: "Expansion and abundance", rarity: "common" },
  { id: "peace_lily", name: "Peace Lily", meaning: "Peace and renewal", rarity: "common" },
  { id: "snake_plant", name: "Snake Plant", meaning: "Strength and constancy", rarity: "common" },
  { id: "lavender", name: "Lavender", meaning: "Calm and clarity", rarity: "common" },
  { id: "jade", name: "Jade Plant", meaning: "Prosperity", rarity: "common" },
  { id: "orchid", name: "Orchid", meaning: "Beauty and refinement", rarity: "rare" },
  { id: "bird_paradise", name: "Bird of Paradise", meaning: "Freedom and expression", rarity: "rare" },
  { id: "anthurium", name: "Anthurium", meaning: "Vitality and passion", rarity: "rare" },
  { id: "ficus", name: "Ficus Lyrata", meaning: "Presence and elevation", rarity: "rare" },
  { id: "calathea", name: "Calathea", meaning: "Balance and ritual", rarity: "rare" },
  { id: "olive", name: "Olive Tree", meaning: "Wisdom and longevity", rarity: "epic" },
  { id: "maple", name: "Japanese Maple", meaning: "Transformation and elegance", rarity: "epic" },
  { id: "rosemary", name: "Rosemary", meaning: "Memory and focus", rarity: "epic" },
  { id: "blue_orchid", name: "Blue Orchid", meaning: "Singularity and aspiration", rarity: "epic" },
];

app.get("/api/plants/species", (req, res) => {
  res.json({ species: PLANT_SPECIES });
});

// ── Milestone narrative generation ──────────────────────────────────
async function generateMilestoneNarrative(user, milestone, goals, checkins) {
  const primaryGoal = goals.find(g => g.type === 'long') || goals[0];


  const response = await openai.chat.completions.create({
    model: _DEFAULT_MODEL,
    messages: [
      {
        role: "system",
        content: `You write short, powerful milestone narratives for the ALZO app. 2-3 sentences max. Celebratory but grounded. Premium tone — no cheesy motivational quotes. Use the user's name if available. Write in the language matching the user's preference (${user.language || 'en-US'}).`
      },
      {
        role: "user",
        content: `Generate a milestone narrative.
Name: ${user.name || 'User'}
Milestone: ${milestone.type} (day ${milestone.dayNumber})
Goal: ${primaryGoal?.description || 'personal growth'}
Days with check-ins: ${checkins.length}
Streak: ${user.streak}`
      }
    ],
    temperature: 0.8,
    max_tokens: 150,
  });

  return response.choices[0].message.content.trim();
}

// Check and unlock milestones after check-in
async function checkMilestones(user) {
  const MILESTONE_DAYS = [
    { day: 1, type: 'first_checkin', title: 'First Step' },
    { day: 7, type: 'streak_7', title: '7 Days Strong' },
    { day: 30, type: 'streak_30', title: '30 Day Milestone' },
    { day: 60, type: 'streak_60', title: '60 Day Milestone' },
  ];

  const newMilestones = [];
  for (const m of MILESTONE_DAYS) {
    if (user.streak >= m.day) {
      const existing = stmts.getMilestoneByType.get(user.id, m.type);
      if (!existing) {
        const goals = stmts.getActiveGoals.all(user.id);
        const checkins = stmts.getRecentCheckins.all(user.id, m.day);
        let narrative = null;
        try {
          narrative = await generateMilestoneNarrative(user, { type: m.type, dayNumber: m.day }, goals, checkins);
        } catch (err) {
          console.error('Milestone narrative error:', err.message);
        }
        const id = crypto.randomUUID();
        stmts.insertMilestone.run(id, user.id, null, m.type, m.title, narrative, m.day);
        newMilestones.push({ id, type: m.type, title: m.title, narrative, dayNumber: m.day });
      }
    }
  }
  return newMilestones;
}

// ── Plant health decay ─────────────────────────────────────────────
// Call this on login or check-in to wither plants that haven't been checked in
function decayPlantHealth(userId) {
  const plants = stmts.getActivePlants.all(userId);
  const now = Date.now();
  for (const plant of plants) {
    if (!plant.lastCheckIn) continue;
    const lastCheck = new Date(plant.lastCheckIn).getTime();
    const daysMissed = Math.floor((now - lastCheck) / 86400000) - 1; // -1 because today might not be done yet
    if (daysMissed > 0) {
      const decay = Math.min(daysMissed * 0.03, 0.3); // max 30% decay
      const newHealth = Math.max(0, plant.health - decay);
      if (newHealth !== plant.health) {
        stmts.updatePlantHealth.run(newHealth, plant.growthStage, plant.id);
      }
    }
  }
}

// ── Milestones endpoints ───────────────────────────────────────────
app.get("/api/milestones", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const milestones = stmts.getMilestones.all(user.id);
  res.json({ milestones });
});

app.post("/api/milestones/:id/share", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  stmts.markMilestoneShared.run(req.params.id);
  res.json({ success: true });
});

// ── Share data endpoint ────────────────────────────────────────────
app.get("/api/share/profile", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const plants = stmts.getActivePlants.all(user.id);
  const milestones = stmts.getMilestones.all(user.id);
  const gardenEntries = stmts.getGarden.all(user.id);
  const journal = stmts.getJournal.all(user.id, 5);

  res.json({
    name: user.name,
    streak: user.streak,
    plants: plants.map(p => ({ species: p.species, name: p.name, color: p.color, health: p.health, growthStage: p.growthStage })),
    milestones: milestones.map(m => ({ type: m.type, title: m.title, dayNumber: m.dayNumber, unlockedAt: m.unlockedAt })),
    gardenSize: gardenEntries.length,
    journalCount: journal.length,
  });
});

// ── Plant color endpoint ───────────────────────────────────────────
app.put("/api/plants/:id/color", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  stmts.updatePlantColor.run(req.body.color, req.params.id, user.id);
  res.json({ success: true });
});




// Normalize expected upload validation failures before Sentry so malformed
// clients/QA probes get a clean 400 instead of lowering crash-free health.
app.use((err, req, res, next) => {
  if (err && err.message === "Only audio files are allowed") {
    return res.status(400).json({ error: "Only audio files are allowed" });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  return next(err);
});

// Sentry error handler — must be registered after all routes.
Sentry.setupExpressErrorHandler(app);

// ── Start server ────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ALZO server running on port ${PORT}`);
  console.log(`ElevenLabs: ${ELEVENLABS_API_KEY ? 'enabled' : 'disabled'}`);
  console.log(`OpenAI: ${process.env.OPENAI_API_KEY ? 'enabled' : 'MISSING'}`);
  console.log(`Sentry: ${process.env.SENTRY_DSN ? 'enabled' : 'disabled'}`);
  console.log(`Endpoints: goals, checkin, mirror, plants, garden, journal, messages, milestones, share`);
});
