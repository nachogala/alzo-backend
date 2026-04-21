require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");

const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || process.env.RAILWAY_PORT || 8080;

// ── SQLite persistence ──────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || "./alzo.db");
db.pragma("journal_mode = WAL");

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

// Prepared statements
const stmts = {
  getByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  getByToken: db.prepare("SELECT * FROM users WHERE token = ?"),
  insert: db.prepare("INSERT INTO users (id, email, name, passwordHash, token, streak, language, plan) VALUES (?, ?, ?, ?, ?, 0, 'en-US', 'Free Trial')"),
  updateToken: db.prepare("UPDATE users SET token = ? WHERE email = ?"),
  updatePlan: db.prepare("UPDATE users SET plan = ? WHERE email = ?"),
  updateNotification: db.prepare("UPDATE users SET notificationHour = ?, notificationMinute = ? WHERE id = ?"),
  getVoiceId: db.prepare("SELECT elevenlabsVoiceId FROM users WHERE id = ?"),
  setVoiceId: db.prepare("UPDATE users SET elevenlabsVoiceId = ? WHERE id = ?"),
  deleteUser: db.prepare("DELETE FROM users WHERE email = ?"),
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

// Ensure directories exist
fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "public", "audio"), { recursive: true });

// Middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

// Multer for voice uploads
const upload = multer({
  dest: "uploads/",
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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ElevenLabs config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

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

async function generateAffirmation(context, language) {
  const { goal, goal90, mood, intro, weekGoal, bigGoal, whyItMatters, weeklyGoal, weekFocus, identity, blocker, vision, strength } = context;

  const contextBlock = [
    (bigGoal || goal90) && `🎯 90-DAY GOAL: ${bigGoal || goal90}`,
    (weekGoal || weeklyGoal || weekFocus) && `⭐ THIS WEEK'S FOCUS (most important): ${weekGoal || weeklyGoal || weekFocus}`,
    whyItMatters && `Why it matters (emotional fuel): ${whyItMatters}`,
    intro && `Who they are (extract name from this): ${intro}`,
    (vision || goal || goal90) && `Long-term: ${vision || goal || goal90}`,
  ]
    .filter(Boolean)
    .join("\n");

  // Default to English — never auto-detect from context
  const langInstruction = LANGUAGE_INSTRUCTIONS[language] || LANGUAGE_INSTRUCTIONS['en-US'];

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          `You are a FIRE personal coach writing a 10-15 second POWER affirmation for ALZO. It plays in the user's cloned voice every morning. It must hit like a punch — short, raw, electric.

YOUR JOB: Make them feel UNSTOPPABLE in under 30 words. No filler. No fluff. Every word earns its place.

FORMULA (follow exactly, in order):
1. [Name] + ONE powerful identity line (5 words max, from their intro)
2. This week's goal as DONE DEAL — "you WILL", not "you want"
3. ONE reason why it matters (emotional, raw, 6 words max)
4. 3-4 word CLOSER that hits hard

EXAMPLE OUTPUT:
"Nacho. You build what doesn't exist yet.
This week, ALZO hits its first users. Done.
Because one app changes everything.
Now move."

ANOTHER EXAMPLE:
"Sarah. You don't quit.
This week: 10 clients locked in.
Your future self is watching.
Go."

TONE RULES based on mood:
- "on_track": fire, momentum, "keep crushing"
- "need_push": aggressive, wake-up call, "no more excuses"
- "pivoting": resilient, "adapt and dominate"
- default: raw energy, unshakable confidence

HARD RULES:
- MAX 30 words. Non-negotiable. THIRTY WORDS MAX.
- ONLY second person: "You", "Your" — NEVER "I am"
- Ultra short sentences. 3-7 words each.
- Extract name from intro if mentioned
- Fix brand names: "also" = "ALZO"
- NEVER: universe, manifest, journey, abundance, vibration, greatness, pushing

CRITICAL LANGUAGE RULE: ${langInstruction} This is non-negotiable.`,
      },
      {
        role: "user",
        content: `Generate the daily affirmation.

Context:
${contextBlock}

Mood today: ${mood || "default"}

Output only the affirmation text. No quotes, no labels, no explanations.
Language: ${langInstruction}`,
      },
    ],
    temperature: 0.85,
    max_tokens: 500,
  });

  return response.choices[0].message.content.trim();
}

// ── ElevenLabs: clone voice and generate audio ───────────────────────
// Wrap any promise with a timeout — returns null if exceeded
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

async function cloneVoiceAndSpeak(text, voiceFilePath, gender, language, existingVoiceId = null) {
  const debug = {
    cloneMode: 'not_attempted',
    sampleCount: Array.isArray(voiceFilePath) ? voiceFilePath.length : (voiceFilePath ? 1 : 0),
    sampleFiles: (Array.isArray(voiceFilePath) ? voiceFilePath : [voiceFilePath]).filter(Boolean).map(fp => path.basename(fp)),
    fallbackUsed: false,
    fallbackBlocked: false,
    customVoiceId: null,
    playbackVoiceId: null,
    modelId: null,
    error: null,
  };

  if (!ELEVENLABS_API_KEY) {
    debug.cloneMode = 'disabled';
    debug.error = 'ELEVENLABS_API_KEY missing';
    return { audioUrl: null, voiceDebug: debug, voiceId: null };
  }

  // Fast path: user already has a cached voice_id → skip the clone (25s → 3s)
  if (existingVoiceId) {
    debug.customVoiceId = existingVoiceId;
    debug.playbackVoiceId = existingVoiceId;
    debug.cloneMode = 'reused';
    try {
      const speech = await withTimeout(generateSpeech(text, existingVoiceId, language), 30000);
      if (!speech || !speech.audioUrl) {
        debug.cloneMode = 'tts_failed_on_reuse';
        debug.error = 'speech generation failed with cached voice_id';
        debug.fallbackBlocked = true;
        return { audioUrl: null, voiceDebug: debug, voiceId: existingVoiceId };
      }
      debug.modelId = speech.modelId;
      return { audioUrl: speech.audioUrl, voiceDebug: debug, voiceId: existingVoiceId };
    } catch (err) {
      console.error('TTS with cached voice failed:', err.message);
      debug.cloneMode = 'tts_error_on_reuse';
      debug.error = err.message;
      debug.fallbackBlocked = true;
      return { audioUrl: null, voiceDebug: debug, voiceId: existingVoiceId };
    }
  }

  try {
    const formData = new FormData();
    formData.append("name", `alzo_${Date.now()}`);
    formData.append("description", "ALZO user voice clone for affirmations");
    if (Array.isArray(voiceFilePath)) {
      voiceFilePath.forEach((fp, i) => {
        const buf = fs.readFileSync(fp);
        formData.append("files", new Blob([buf], { type: "audio/m4a" }), `sample_${i}.m4a`);
      });
    } else if (voiceFilePath) {
      const fileBuffer = fs.readFileSync(voiceFilePath);
      formData.append("files", new Blob([fileBuffer], { type: "audio/m4a" }), "voice_sample.m4a");
    }

    debug.cloneMode = 'clone_attempted';
    console.log('Voice clone samples:', debug.sampleFiles);

    const addVoiceRes = await withTimeout(fetch(`${ELEVENLABS_BASE}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: formData,
    }), 25000);

    if (!addVoiceRes || !addVoiceRes.ok) {
      const errorText = addVoiceRes ? await addVoiceRes.text() : 'timeout adding voice';
      console.error("Voice clone failed:", errorText);
      debug.cloneMode = 'clone_failed';
      debug.error = errorText;
      debug.fallbackBlocked = true;
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
      return { audioUrl: null, voiceDebug: debug, voiceId: null };
    }

    debug.modelId = speech.modelId;
    // PERSIST the cloned voice so daily affirmations can reuse it. Caller must
    // save voiceId to the user row in DB so next call hits the reuse fast path.
    return { audioUrl: speech.audioUrl, voiceDebug: debug, voiceId: voice_id };
  } catch (err) {
    console.error("ElevenLabs clone error:", err.message);
    debug.cloneMode = 'clone_error';
    debug.error = err.message;
    debug.fallbackBlocked = true;
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
  // Use turbo for English (faster), multilingual v2 for other languages
  const isEnglish = !language || language.startsWith('en');
  const model = isEnglish ? 'eleven_turbo_v2_5' : 'eleven_multilingual_v2';
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
        voice_settings: { stability: 0.55, similarity_boost: 0.80 },
      }),
    }
  );

  if (!ttsRes.ok) {
    throw new Error(`TTS failed: ${await ttsRes.text()}`);
  }

  const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
  const filename = `affirmation_${Date.now()}.mp3`;
  const filepath = path.join(__dirname, "public", "audio", filename);
  fs.writeFileSync(filepath, audioBuffer);
  return { audioUrl: `/audio/${filename}`, voiceId, modelId: model };
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

// ── Transcribe audio with Whisper ────────────────────────────────────
// language: app language code (e.g. 'en-US', 'es-AR') — used to hint Whisper
// so it doesn't auto-detect the wrong language from accent/context
async function transcribeAudio(filePath, language) {
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
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.text || null;
  } catch (e) {
    console.error('Transcription error:', e.message);
    return null;
  }
}

// ── Detect gender from transcription text via GPT ────────────────────
async function detectGender(transcriptions) {
  if (!transcriptions || transcriptions.length === 0) return null;
  try {
    const combined = transcriptions.filter(Boolean).join(' ');
    if (combined.trim().length < 10) return null;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
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
    return null;
  }
}

app.post("/api/onboarding", onboardingUpload, async (req, res) => {
  try {
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

    let voiceReady = !!((audioFiles.length > 0 || combinedVoicePath) && ELEVENLABS_API_KEY);

    const sessionId = Date.now().toString();
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
      const voiceManifest = path.join(__dirname, "uploads", `voice_manifest_${sessionId}.json`);
      fs.writeFileSync(voiceManifest, JSON.stringify(allVoiceFiles));
      const destPath = path.join(__dirname, "uploads", `voice_${sessionId}.m4a`);
      fs.copyFileSync(allVoiceFiles[allVoiceFiles.length - 1], destPath);
      allVoiceFiles.forEach((f) => { if (f !== destPath) fs.unlink(f, () => {}); });
      res.json({ voiceReady, context, sessionId, detectedGender, language, voiceDebug });
    } else {
      res.json({ voiceReady, context, sessionId, detectedGender, language, voiceDebug });
    }
  } catch (err) {
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

    // 1. Generate affirmation text
    const affirmationText = await generateAffirmation(context, language);

    // 2. Generate audio — use all voice samples if available
    let audioUrl = null;
    let voiceDebug = { cloneMode: 'not_ready', fallbackUsed: false, error: null };
    const manifestPath = path.join(__dirname, "uploads", `voice_manifest_${sessionId}.json`);
    const voicePathM4a = path.join(__dirname, "uploads", `voice_${sessionId}.m4a`);
    const voicePathWebm = path.join(__dirname, "uploads", `voice_${sessionId}.webm`);
    const voicePath = fs.existsSync(voicePathM4a) ? voicePathM4a : (fs.existsSync(voicePathWebm) ? voicePathWebm : null);

    if (sessionId && voicePath) {
      // Check for a cached ElevenLabs voice_id on the authenticated user.
      // Daily affirmations reuse the cached voice — no re-clone, 1/10th the cost
      // and latency (~3s vs ~25s).
      const authedUser = getUserByToken(req);
      const cachedRow = authedUser ? stmts.getVoiceId.get(authedUser.id) : null;
      const cachedVoiceId = cachedRow?.elevenlabsVoiceId || null;

      // Try to use manifest (all samples) for better clone if no cache yet
      let voiceArg = voicePath;
      if (fs.existsSync(manifestPath)) {
        try {
          const files = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).filter(f => fs.existsSync(f));
          if (files.length > 1) voiceArg = files;
        } catch {}
        // Keep manifest so subsequent daily affirmations can reuse samples
      }
      const cloneResult = await cloneVoiceAndSpeak(affirmationText, voiceArg, gender, language, cachedVoiceId);
      audioUrl = cloneResult.audioUrl;
      voiceDebug = cloneResult.voiceDebug;
      // Persist the new voice_id so the next affirmation skips the clone step.
      if (authedUser && cloneResult.voiceId && cloneResult.voiceId !== cachedVoiceId) {
        stmts.setVoiceId.run(cloneResult.voiceId, authedUser.id);
      }
      // Do NOT delete voicePath — daily affirmations need the same sample.
    } else {
      const fallbackResult = await textToSpeechFallback(affirmationText, gender, language);
      audioUrl = fallbackResult.audioUrl;
      voiceDebug = fallbackResult.voiceDebug;
    }

    res.json({ affirmationText, audioUrl, voiceDebug });
  } catch (err) {
    console.error("Error generating affirmation:", err);
    res.status(500).json({ error: "Failed to generate affirmation" });
  }
});

// ── Auth endpoints ──────────────────────────────────────────────────
app.post("/api/auth/signup", (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const existing = stmts.getByEmail.get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: "Account already exists" });

  const userId = crypto.randomBytes(16).toString("hex");
  const token = generateToken();
  stmts.insert.run(userId, email.toLowerCase(), name || null, hashPassword(password), token);

  res.json({ token, userId });
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

  res.json({ token, userId: user.id });
});

// Apple Sign-in: identityToken from frontend, decode to get email + sub (apple user id)
app.post("/api/auth/apple", (req, res) => {
  const { identityToken, email: providedEmail, fullName } = req.body;
  if (!identityToken) return res.status(400).json({ error: "identityToken is required" });

  let appleSub, tokenEmail;
  try {
    const payload = JSON.parse(Buffer.from(identityToken.split(".")[1], "base64").toString("utf8"));
    appleSub = payload.sub;
    tokenEmail = payload.email;
  } catch (e) {
    return res.status(400).json({ error: "Invalid identityToken" });
  }

  const email = (tokenEmail || providedEmail || "").toLowerCase();
  if (!email) return res.status(400).json({ error: "No email available from Apple" });

  let user = stmts.getByEmail.get(email);
  const token = generateToken();

  if (user) {
    stmts.updateToken.run(token, email);
    return res.json({ token, userId: user.id, isNewUser: false });
  }

  const userId = crypto.randomBytes(16).toString("hex");
  const name = fullName || null;
  stmts.insert.run(userId, email, name, "apple_sso_" + appleSub, token);
  res.json({ token, userId, isNewUser: true });
});

// Google Sign-in: idToken from frontend, decode payload to get email + sub
// TODO: verify idToken signature with Google's public keys for production security
app.post("/api/auth/google", (req, res) => {
  const { idToken, email: providedEmail, name: providedName } = req.body;
  if (!idToken) return res.status(400).json({ error: "idToken is required" });

  let googleSub, tokenEmail;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString("utf8"));
    googleSub = payload.sub;
    tokenEmail = payload.email;
  } catch (e) {
    return res.status(400).json({ error: "Invalid idToken" });
  }

  const email = (tokenEmail || providedEmail || "").toLowerCase();
  if (!email) return res.status(400).json({ error: "No email available from Google" });

  let user = stmts.getByEmail.get(email);
  const token = generateToken();

  if (user) {
    stmts.updateToken.run(token, email);
    return res.json({ token, userId: user.id, isNewUser: false });
  }

  const userId = crypto.randomBytes(16).toString("hex");
  const name = providedName || null;
  stmts.insert.run(userId, email, name, "google_sso_" + googleSub, token);
  res.json({ token, userId, isNewUser: true });
});

app.get("/api/user/profile", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  // Decay plants on profile load (handles users who missed days)
  decayPlantHealth(user.id);
  res.json({ email: user.email, name: user.name, streak: user.streak, language: user.language, plan: user.plan });
});

app.delete("/api/user", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  stmts.deleteUser.run(user.email);
  res.json({ success: true });
});

app.post("/api/subscription/cancel", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  stmts.updatePlan.run("Cancelled", user.email);
  res.json({ success: true });
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

// ── Health check ─────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "ALZO",
    openai: !!process.env.OPENAI_API_KEY,
    elevenlabs: !!ELEVENLABS_API_KEY,
  });
});

// ── ALIGNMENT SYSTEM ENDPOINTS ──────────────────────────────────────

// Goals
app.post("/api/goals", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { type, description, audioUrl, motivation, motivationAudioUrl, horizonDays } = req.body;
  const id = crypto.randomUUID();
  const targetDate = new Date(Date.now() + (horizonDays || 90) * 86400000).toISOString();
  stmts.insertGoal.run(id, user.id, type || 'long', description, audioUrl, motivation, motivationAudioUrl, horizonDays || 90, targetDate);
  res.json({ id, success: true });
});

app.get("/api/goals", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const goals = stmts.getActiveGoals.all(user.id);
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
    const alignedDays = checkins.filter(c => c.alignment === 'yes' || c.alignment === 'mostly').length;

    const chronicleRes = await openai.chat.completions.create({
      model: "gpt-4o",
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
Days active: ${checkins.length}
Aligned days: ${alignedDays}
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
  const id = crypto.randomUUID();
  stmts.insertCheckin.run(id, user.id, goalId, intentionConfirmed ? 1 : 0, emotionalState, energyLevel || 3, alignment, microcommitment);

  // Decay plants that haven't been checked in (subtle withering)
  decayPlantHealth(user.id);

  // Update plant health based on alignment
  const plants = stmts.getActivePlants.all(user.id);
  for (const plant of plants) {
    if (plant.goalId === goalId || !goalId) {
      let healthDelta = 0;
      let growthDelta = 0;
      if (alignment === 'yes') { healthDelta = 0.05; growthDelta = 0.02; }
      else if (alignment === 'mostly') { healthDelta = 0.02; growthDelta = 0.01; }
      else if (alignment === 'no') { healthDelta = -0.02; growthDelta = 0; }
      else if (alignment === 'avoided') { healthDelta = -0.04; growthDelta = 0; }
      const newHealth = Math.max(0, Math.min(1, plant.health + healthDelta));
      const newGrowth = Math.min(1, plant.growthStage + growthDelta);
      stmts.updatePlantHealth.run(newHealth, newGrowth, plant.id);
    }
  }

  // Update streak
  db.prepare("UPDATE users SET streak = streak + 1 WHERE id = ?").run(user.id);

  // Check for new milestones (async, don't block response)
  const updatedUser = stmts.getByToken.get(user.token);
  const newMilestones = await checkMilestones(updatedUser).catch(() => []);

  res.json({ id, success: true, plantUpdated: plants.length > 0, newMilestones });
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

  // Calculate alignment score for the week
  const alignedCount = recentCheckins.filter(c => c.alignment === 'yes' || c.alignment === 'mostly').length;
  const totalCheckins = recentCheckins.length;
  const alignmentScore = totalCheckins > 0 ? Math.round((alignedCount / totalCheckins) * 100) : 0;

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
    alignmentScore,
    dominantMood,
    daysActive: totalCheckins,
    goalDaysRemaining: primaryGoal ? Math.max(0, Math.ceil((new Date(primaryGoal.targetDate) - Date.now()) / 86400000)) : null,
    goalProgress: primaryGoal ? Math.round(((primaryGoal.horizonDays - Math.max(0, Math.ceil((new Date(primaryGoal.targetDate) - Date.now()) / 86400000))) / primaryGoal.horizonDays) * 100) : 0,
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
  const audioUrl = req.file ? `/uploads/${req.file.filename}` : null;
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
  const alignedDays = checkins.filter(c => c.alignment === 'yes' || c.alignment === 'mostly').length;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
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
Aligned days: ${alignedDays} out of ${checkins.length}
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

// ── Start server ────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ALZO server running on port ${PORT}`);
  console.log(`ElevenLabs: ${ELEVENLABS_API_KEY ? 'enabled' : 'disabled'}`);
  console.log(`OpenAI: ${process.env.OPENAI_API_KEY ? 'enabled' : 'MISSING'}`);
  console.log(`Endpoints: goals, checkin, mirror, plants, garden, journal, messages, milestones, share`);
});
