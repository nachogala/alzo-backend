require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");

const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || process.env.RAILWAY_PORT || 8080;

// ── In-memory user store ────────────────────────────────────────────
const users = new Map(); // email → { userId, email, passwordHash, token, streak, language, plan }
const tokens = new Map(); // token → email

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
  const email = tokens.get(token);
  if (!email) return null;
  return users.get(email) || null;
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
  const { goal, mood, identity, blocker, strength, gratitude, selfMessage, weeklyGoal } = context;

  const contextBlock = [
    weeklyGoal && `⭐ THIS WEEK'S FOCUS (build the affirmation around this): ${weeklyGoal}`,
    goal && `90-day goal: ${goal}`,
    identity && `Who they are becoming: ${identity}`,
    blocker && `The belief/habit they are DONE with (reframe and crush this): ${blocker}`,
    strength && `Their core strength (anchor to this): ${strength}`,
    selfMessage && `What they need to hear (honor this tone): ${selfMessage}`,
    mood && `How they feel today: ${mood}`,
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
          `You are a high-performance coach creating a daily spoken affirmation for ALZO — like a great coach speaking fire into their athlete before a game. Short, direct, energy-packed. You speak TO the person, not about them.

Psychological principles you apply:
- Self-affirmation theory: reinforce who they are becoming, not just what they want
- Implementation intention: tie the affirmation to a concrete action TODAY
- Inner critic reframe: if they named a blocker, acknowledge and crush it in one line
- Strength anchoring: invoke their stated strength as the engine

Style rules:
- Address them directly ("You are...", "You have what it takes...", "Today you...")
- Short punchy sentences. High energy. Coach voice.
- Do NOT summarize their answers — use them as fuel, not content
- NEVER say: "universe", "manifest", "journey", "abundance", "vibration"
- End with one specific action they take TODAY toward their goal

CRITICAL LANGUAGE RULE: ${langInstruction} This is non-negotiable.`,
      },
      {
        role: "user",
        content: `Generate a punchy, energetic 20-second spoken affirmation for this person:

${contextBlock}

Rules:
- LANGUAGE: ${langInstruction}
- Write in first person, present tense
- 50-70 words MAX — short, punchy, powerful
- The affirmation must DIRECTLY reference their specific 90-day goal — make it the center
- High energy, confident, like a coach firing them up before a game
- No clichés (no "universe", "manifest", "journey") — real language
- End with ONE clear action they take TODAY toward the goal
- No title, no labels — just the spoken text

REMINDER: ${langInstruction}`,
      },
    ],
    temperature: 0.8,
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

async function cloneVoiceAndSpeak(text, voiceFilePath, gender) {
  if (!ELEVENLABS_API_KEY) return null;

  try {
    // Step 1: Add a cloned voice using Instant Voice Cloning
    const formData = new FormData();
    formData.append("name", `alzo_${Date.now()}`);
    formData.append("description", "ALZO user voice clone for affirmations");
    const fileBuffer = fs.readFileSync(voiceFilePath);
    formData.append(
      "files",
      new Blob([fileBuffer], { type: "audio/webm" }),
      "voice_sample.webm"
    );

    const addVoiceRes = await withTimeout(fetch(`${ELEVENLABS_BASE}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: formData,
    }), 25000);

    if (!addVoiceRes || !addVoiceRes.ok) {
      console.error("Voice clone failed:", await addVoiceRes.text());
      return await textToSpeechFallback(text, gender);
    }

    const { voice_id } = await addVoiceRes.json();

    // Step 2: Generate speech with the cloned voice (30s timeout)
    const audioUrl = await withTimeout(generateSpeech(text, voice_id), 30000);
    if (!audioUrl) {
      fetch(`${ELEVENLABS_BASE}/voices/${voice_id}`, { method: 'DELETE', headers: { 'xi-api-key': ELEVENLABS_API_KEY } }).catch(() => {});
      return await textToSpeechFallback(text, gender);
    }

    // Step 3: Clean up — delete the cloned voice
    fetch(`${ELEVENLABS_BASE}/voices/${voice_id}`, {
      method: "DELETE",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    }).catch(() => {});

    return audioUrl;
  } catch (err) {
    console.error("ElevenLabs clone error:", err.message);
    return await textToSpeechFallback(text, gender);
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
      mood: "",
      goal: "",
      identity: "",
      gratitude: "",
      selfMessage: "",
    };

    const audioFiles = [];
    const questionKeys = ['goal', 'identity', 'blocker', 'strength', 'selfMessage'];
    const uploadKeys = ['q1', 'q2', 'q3', 'q4', 'q5'];
    const transcriptions = [];

    for (let i = 0; i < uploadKeys.length; i++) {
      const key = uploadKeys[i];
      if (req.files && req.files[key] && req.files[key][0]) {
        const filePath = req.files[key][0].path;
        audioFiles.push(filePath);

        // Pass language so Whisper transcribes in the correct language
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

    let combinedVoicePath = null;
    if (audioFiles.length > 0) {
      combinedVoicePath = audioFiles[audioFiles.length - 1];
    }

    let voiceReady = !!(combinedVoicePath && ELEVENLABS_API_KEY);

    const sessionId = Date.now().toString();
    if (combinedVoicePath) {
      const destPath = path.join(__dirname, "uploads", `voice_${sessionId}.webm`);
      fs.copyFileSync(combinedVoicePath, destPath);
      audioFiles.forEach((f) => fs.unlink(f, () => {}));
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

    // 2. Generate audio
    let audioUrl = null;
    const voicePath = path.join(
      __dirname,
      "uploads",
      `voice_${sessionId}.webm`
    );

    if (sessionId && fs.existsSync(voicePath)) {
      audioUrl = await cloneVoiceAndSpeak(affirmationText, voicePath, gender);
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
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (users.has(email.toLowerCase())) return res.status(409).json({ error: "Account already exists" });

  const userId = crypto.randomBytes(16).toString("hex");
  const token = generateToken();
  const user = { userId, email: email.toLowerCase(), passwordHash: hashPassword(password), token, streak: 0, language: "en-US", plan: "Free Trial" };
  users.set(email.toLowerCase(), user);
  tokens.set(token, email.toLowerCase());

  res.json({ token, userId });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  const user = users.get(email.toLowerCase());
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = generateToken();
  if (user.token) tokens.delete(user.token);
  user.token = token;
  tokens.set(token, email.toLowerCase());

  res.json({ token, userId: user.userId });
});

app.get("/api/user/profile", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ email: user.email, streak: user.streak, language: user.language, plan: user.plan });
});

app.delete("/api/user", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  tokens.delete(user.token);
  users.delete(user.email);
  res.json({ success: true });
});

app.post("/api/subscription/cancel", (req, res) => {
  const user = getUserByToken(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  user.plan = "Cancelled";
  res.json({ success: true });
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
