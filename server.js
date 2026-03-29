require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

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

// Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ElevenLabs config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// ── Generate affirmation text via Claude ─────────────────────────────
async function generateAffirmation(goal) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system: "You are a personal affirmation writer. You write powerful, grounded, first-person affirmations that feel real — not woo-woo. No clichés like 'universe' or 'manifest'. Keep it confident, present tense, and emotionally resonant.",
    messages: [
      {
        role: "user",
        content: `Generate a powerful, personal 60-second spoken affirmation for someone whose goal is: ${goal}

Rules:
- Write in first person ("I am", "I have", "I create")
- 150-200 words
- Confident, present tense, emotionally resonant
- No clichés like "universe" or "manifest" — keep it grounded and real
- End with a specific action statement tied to the goal
- No title or labels — just the affirmation text ready to be spoken aloud`,
      },
    ],
  });

  return response.content[0].text.trim();
}

// ── ElevenLabs: clone voice and generate audio ───────────────────────
async function cloneVoiceAndSpeak(text, voiceFilePath) {
  if (!ELEVENLABS_API_KEY) return null;

  try {
    // Step 1: Add a cloned voice using Instant Voice Cloning
    const formData = new FormData();
    formData.append("name", `innervoice_${Date.now()}`);
    formData.append(
      "description",
      "InnerVoice user clone for affirmations"
    );
    const fileBuffer = fs.readFileSync(voiceFilePath);
    formData.append(
      "files",
      new Blob([fileBuffer], { type: "audio/webm" }),
      "voice_sample.webm"
    );

    const addVoiceRes = await fetch(`${ELEVENLABS_BASE}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: formData,
    });

    if (!addVoiceRes.ok) {
      console.error("Voice clone failed:", await addVoiceRes.text());
      return await textToSpeechFallback(text);
    }

    const { voice_id } = await addVoiceRes.json();

    // Step 2: Generate speech with the cloned voice
    const audioUrl = await generateSpeech(text, voice_id);

    // Step 3: Clean up — delete the cloned voice (optional, keeps quota tidy)
    fetch(`${ELEVENLABS_BASE}/voices/${voice_id}`, {
      method: "DELETE",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    }).catch(() => {});

    return audioUrl;
  } catch (err) {
    console.error("ElevenLabs clone error:", err.message);
    return await textToSpeechFallback(text);
  }
}

// ── ElevenLabs: TTS with a preset voice (fallback) ──────────────────
async function textToSpeechFallback(text) {
  if (!ELEVENLABS_API_KEY) return null;

  try {
    // Rachel — a warm, clear preset voice
    return await generateSpeech(text, "21m00Tcm4TlvDq8ikWAM");
  } catch (err) {
    console.error("ElevenLabs TTS fallback error:", err.message);
    return null;
  }
}

async function generateSpeech(text, voiceId) {
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
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
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

// ── Main endpoint ────────────────────────────────────────────────────
app.post(
  "/api/generate-affirmation",
  upload.single("voiceFile"),
  async (req, res) => {
    try {
      const goal = req.body.goal;
      if (!goal) {
        return res.status(400).json({ error: "Goal is required" });
      }

      // 1. Generate affirmation text
      const affirmationText = await generateAffirmation(goal);

      // 2. Generate audio (clone if voice file provided, else fallback TTS)
      let audioUrl = null;
      if (req.file) {
        audioUrl = await cloneVoiceAndSpeak(affirmationText, req.file.path);
        // Clean up uploaded file
        fs.unlink(req.file.path, () => {});
      } else {
        audioUrl = await textToSpeechFallback(affirmationText);
      }

      res.json({ affirmationText, audioUrl });
    } catch (err) {
      console.error("Error generating affirmation:", err);
      res.status(500).json({ error: "Failed to generate affirmation" });
    }
  }
);

// ── Health check ─────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    claude: !!process.env.ANTHROPIC_API_KEY,
    elevenlabs: !!ELEVENLABS_API_KEY,
  });
});

app.listen(PORT, () => {
  console.log(`InnerVoice server running on http://localhost:${PORT}`);
  console.log(
    `ElevenLabs: ${ELEVENLABS_API_KEY ? "enabled" : "disabled (text-only mode)"}`
  );
});
