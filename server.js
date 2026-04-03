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
    createdAt TEXT DEFAULT (datetime('now'))
  );
`);

// Prepared statements
const stmts = {
  getByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  getByToken: db.prepare("SELECT * FROM users WHERE token = ?"),
  insert: db.prepare("INSERT INTO users (id, email, name, passwordHash, token, streak, language, plan) VALUES (?, ?, ?, ?, ?, 0, 'en-US', 'Free Trial')"),
  updateToken: db.prepare("UPDATE users SET token = ? WHERE email = ?"),
  updatePlan: db.prepare("UPDATE users SET plan = ? WHERE email = ?"),
  deleteUser: db.prepare("DELETE FROM users WHERE email = ?"),
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
  const { goal, goal90, mood, intro, weekGoal, whyItMatters, weeklyGoal, weekFocus, identity, blocker, vision, strength } = context;

  const contextBlock = [
    (weekGoal || weeklyGoal || weekFocus) && `⭐ THIS WEEK'S GOAL (most important): ${weekGoal || weeklyGoal || weekFocus}`,
    whyItMatters && `Why it matters to them (emotional fuel): ${whyItMatters}`,
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
          `You are a high-energy personal coach writing a 20-25 second spoken affirmation for the ALZO app. The affirmation plays in the user's own cloned voice every morning.

YOUR JOB: Transform their answers into pure motivational fuel. Do NOT repeat what they said. TRANSFORM it.

FORMULA (follow exactly, in order):
1. [Name] + short identity statement (who they are, 5-7 words, from their intro)
2. This week's goal stated as INEVITABLE FACT — not "you want", but "you will" or "this is happening"
3. Why it matters — connect to the emotional reason they gave (1 sentence, powerful)
4. One action for TODAY — specific, doable
5. 3-5 word HIGH-ENERGY closer

EXAMPLE OUTPUT:
"Nacho. You build things that don't exist yet.
This week, ALZO reaches its first users — that's not a goal, that's a fact.
Because you know that one app can change how people see themselves.
Today: one call, one post, one move.
Let's go."

TONE RULES based on mood:
- "on_track": celebratory, momentum, "you're doing it"
- "need_push": aggressive, urgent, no excuses, "get up"
- "pivoting": resilient, adaptive, "the best pivot and win"
- default: high energy, confident

HARD RULES:
- MAX 50 words. Non-negotiable.
- ONLY second person: "You", "Your" — NEVER "I am"
- Short punchy sentences. No filler.
- Extract name from intro if mentioned
- Fix brand names: "also" = "ALZO"
- NEVER: universe, manifest, journey, abundance, vibration

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

async function cloneVoiceAndSpeak(text, voiceFilePath, gender, language) {
  if (!ELEVENLABS_API_KEY) return null;

  try {
    // Step 1: Add a cloned voice using Instant Voice Cloning
    const formData = new FormData();
    formData.append("name", `alzo_${Date.now()}`);
    formData.append("description", "ALZO user voice clone for affirmations");
    // Send all available voice files for better clone quality
    if (Array.isArray(voiceFilePath)) {
      voiceFilePath.forEach((fp, i) => {
        const buf = fs.readFileSync(fp);
        formData.append("files", new Blob([buf], { type: "audio/m4a" }), `sample_${i}.m4a`);
      });
    } else {
      const fileBuffer = fs.readFileSync(voiceFilePath);
      formData.append("files", new Blob([fileBuffer], { type: "audio/m4a" }), "voice_sample.m4a");
    }

    const addVoiceRes = await withTimeout(fetch(`${ELEVENLABS_BASE}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: formData,
    }), 25000);

    if (!addVoiceRes || !addVoiceRes.ok) {
      console.error("Voice clone failed:", await addVoiceRes.text());
      return await textToSpeechFallback(text, gender, language);
    }

    const { voice_id } = await addVoiceRes.json();

    // Step 2: Generate speech with the cloned voice (30s timeout)
    const audioUrl = await withTimeout(generateSpeech(text, voice_id, language), 30000);
    if (!audioUrl) {
      fetch(`${ELEVENLABS_BASE}/voices/${voice_id}`, { method: 'DELETE', headers: { 'xi-api-key': ELEVENLABS_API_KEY } }).catch(() => {});
      return await textToSpeechFallback(text, gender, language);
    }

    // Step 3: Clean up — delete the cloned voice
    fetch(`${ELEVENLABS_BASE}/voices/${voice_id}`, {
      method: "DELETE",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    }).catch(() => {});

    return audioUrl;
  } catch (err) {
    console.error("ElevenLabs clone error:", err.message);
    return await textToSpeechFallback(text, gender, language);
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
  if (!ELEVENLABS_API_KEY) return null;

  try {
    const voices = PRESET_VOICES_BY_LANGUAGE[language] || PRESET_VOICES_BY_LANGUAGE['en-US'];
    const voiceId = voices[gender] || voices.female;
    return await generateSpeech(text, voiceId, language);
  } catch (err) {
    console.error("ElevenLabs TTS fallback error:", err.message);
    return null;
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
  return `/audio/${filename}`;
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

    let context = {
      blocker: "",
      vision: "",
      goal: "",
    };

    const audioFiles = [];
    // v3 FINAL: intro (q1=who you are), weekGoal (q2=this week), whyItMatters (q3=why)
    const questionKeys = ['intro', 'weekGoal', 'whyItMatters'];
    const uploadKeys = ['q1', 'q2', 'q3'];
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
    // Save ALL audio files for richer voice cloning
    const allVoiceFiles = [...audioFiles];
    if (combinedVoicePath && !allVoiceFiles.includes(combinedVoicePath)) {
      allVoiceFiles.push(combinedVoicePath);
    }
    if (allVoiceFiles.length > 0) {
      // Save paths list to a JSON file so generate-affirmation can find all samples
      const voiceManifest = path.join(__dirname, "uploads", `voice_manifest_${sessionId}.json`);
      fs.writeFileSync(voiceManifest, JSON.stringify(allVoiceFiles));
      // Also copy primary for backwards compat
      const destPath = path.join(__dirname, "uploads", `voice_${sessionId}.m4a`);
      fs.copyFileSync(allVoiceFiles[allVoiceFiles.length - 1], destPath);
      allVoiceFiles.forEach((f) => { if (f !== destPath) fs.unlink(f, () => {}); });
      res.json({ voiceReady, context, sessionId, detectedGender, language });
    } else {
      res.json({ voiceReady, context, sessionId, detectedGender, language });
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
    const manifestPath = path.join(__dirname, "uploads", `voice_manifest_${sessionId}.json`);
    const voicePathM4a = path.join(__dirname, "uploads", `voice_${sessionId}.m4a`);
    const voicePathWebm = path.join(__dirname, "uploads", `voice_${sessionId}.webm`);
    const voicePath = fs.existsSync(voicePathM4a) ? voicePathM4a : (fs.existsSync(voicePathWebm) ? voicePathWebm : null);

    if (sessionId && voicePath) {
      // Try to use manifest (all samples) for better clone
      let voiceArg = voicePath;
      if (fs.existsSync(manifestPath)) {
        try {
          const files = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).filter(f => fs.existsSync(f));
          if (files.length > 1) voiceArg = files;
        } catch {}
        fs.unlink(manifestPath, () => {});
      }
      audioUrl = await cloneVoiceAndSpeak(affirmationText, voiceArg, gender, language);
      fs.unlink(voicePath, () => {});
    } else {
      audioUrl = await textToSpeechFallback(affirmationText, gender, language);
    }

    res.json({ affirmationText, audioUrl });
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

app.get("/api/user/profile", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ALZO server running on port ${PORT}`);
  console.log(`ElevenLabs: ${ELEVENLABS_API_KEY ? 'enabled' : 'disabled'}`);
  console.log(`OpenAI: ${process.env.OPENAI_API_KEY ? 'enabled' : 'MISSING'}`);
});
