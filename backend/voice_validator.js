// backend/voice_validator.js
// Capa 1 (pre-clone) + Capa 2 (post-clone) audio quality detector for ALZO
// voice clone flow. See feature/voice-quality-detector.
//
// Capa 1: validate the user's recorded sample BEFORE sending to ElevenLabs.
//   - Reject if duration < MIN_INPUT_DURATION_S (3s) → VOICE_AUDIO_TOO_SHORT
//   - Reject if peak amplitude < MIN_PEAK_AMPLITUDE (0.05) → VOICE_AUDIO_SILENT
//
// Capa 2: validate ElevenLabs' first TTS render with the new voice_id.
//   - Require duration >= MIN_TTS_DURATION_S (4s) AND peak > MIN_PEAK_AMPLITUDE
//   - Otherwise the clone is glitched → VOICE_CLONE_GLITCHED (caller cleans up
//     the orphan voice on ElevenLabs)
//
// Decoder: ffmpeg-static + ffprobe-static. ffprobe gives us the duration; we
// run ffmpeg with `-af volumedetect` to pull the peak dB and convert to a
// 0-1 linear amplitude. Works for M4A, MP3, WAV, WebM.
//
// Failure-soft: if the binaries are missing or fail to parse the file, we
// return { ok: true, reason: 'decoder_unavailable' } so the existing flow
// continues. Better some clones than none — capa 2 still catches glitches via
// the ElevenLabs response, capa 1 just becomes a no-op until ops add ffmpeg.

const { spawn } = require("child_process");
const fs = require("fs");

const MIN_INPUT_DURATION_S = 3.0;
const MIN_TTS_DURATION_S = 4.0;
const MIN_PEAK_AMPLITUDE = 0.05; // ~ -26 dBFS

let ffmpegPath = null;
let ffprobePath = null;
try { ffmpegPath = require("ffmpeg-static"); } catch {}
try { ffprobePath = require("ffprobe-static")?.path || null; } catch {}

function decoderAvailable() {
  return !!(ffmpegPath && fs.existsSync(ffmpegPath));
}

function run(cmd, args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      // Bad arch / missing binary / EACCES — fail-soft so the caller can
      // treat the decoder as unavailable instead of crashing.
      resolve({ code: -1, stdout: "", stderr: String(err.message || err) });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch {}
      resolve({ code: -1, stdout, stderr: stderr + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function probeDurationSec(filePath) {
  if (ffprobePath) {
    const r = await run(ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    if (r.code === 0) {
      const v = parseFloat(String(r.stdout).trim());
      if (Number.isFinite(v)) return v;
    }
  }
  // Some ffprobe-static releases have shipped an x86_64 binary inside the
  // darwin/arm64 path. Measure with ffmpeg's decoded input header instead of
  // trusting client metadata or weakening the 40-second valid-audio gate.
  if (!ffmpegPath) return null;
  const fallback = await run(ffmpegPath, [
    "-hide_banner", "-i", filePath,
    "-vn", "-sn", "-dn", "-f", "null", "-",
  ], { timeoutMs: 15000 });
  const match = String(fallback.stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : null;
}

async function probePeakAmplitude(filePath) {
  // ffmpeg `volumedetect` writes to stderr something like:
  //   [Parsed_volumedetect_0 @ 0x...] max_volume: -3.7 dB
  if (!ffmpegPath) return null;
  const r = await run(ffmpegPath, [
    "-hide_banner", "-nostats",
    "-i", filePath,
    "-af", "volumedetect",
    "-vn", "-sn", "-dn",
    "-f", "null", "-",
  ], { timeoutMs: 15000 });
  const m = String(r.stderr).match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  if (!m) return null;
  const dB = parseFloat(m[1]);
  if (!Number.isFinite(dB)) return null;
  // -inf would be silence; ffmpeg outputs "-91.0 dB" for near-silence so the
  // regex still matches. Convert dBFS → linear (0..1 nominal, can be >1 if
  // clipped; cap at 1 for our threshold logic).
  const linear = Math.pow(10, dB / 20);
  return Math.min(1, Math.max(0, linear));
}

async function analyzeFile(filePath) {
  if (!decoderAvailable()) {
    return { ok: false, reason: "decoder_unavailable", duration: null, peak: null };
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, reason: "file_missing", duration: null, peak: null };
  }
  const [duration, peak] = await Promise.all([
    probeDurationSec(filePath),
    probePeakAmplitude(filePath),
  ]);
  if (duration == null && peak == null) {
    return { ok: false, reason: "decode_failed", duration, peak };
  }
  return { ok: true, reason: null, duration, peak };
}

// Capa 1 — pre-clone validation. Returns { ok: true } or
// { ok: false, code, message, http: 400, duration, peak }.
async function validateInputSample(filePath) {
  const a = await analyzeFile(filePath);
  if (!a.ok) {
    // Failure-soft: don't block uploads when the decoder itself is broken.
    return { ok: true, soft: true, reason: a.reason, duration: a.duration, peak: a.peak };
  }
  if (a.duration != null && a.duration < MIN_INPUT_DURATION_S) {
    return {
      ok: false,
      http: 400,
      code: "VOICE_AUDIO_TOO_SHORT",
      message: "Tu grabacion fue demasiado corta. Necesitamos al menos 3 segundos de voz.",
      duration: a.duration,
      peak: a.peak,
    };
  }
  if (a.peak != null && a.peak < MIN_PEAK_AMPLITUDE) {
    return {
      ok: false,
      http: 400,
      code: "VOICE_AUDIO_SILENT",
      message: "No detectamos sonido en tu grabacion. Asegurate de hablar claramente.",
      duration: a.duration,
      peak: a.peak,
    };
  }
  return { ok: true, soft: false, duration: a.duration, peak: a.peak };
}

// Capa 2 — post-clone validation of the ElevenLabs TTS render. Returns
// { ok: true } or { ok: false, code, message, http: 502, ... }.
async function validateTtsRender(filePath) {
  const a = await analyzeFile(filePath);
  if (!a.ok) {
    return { ok: true, soft: true, reason: a.reason, duration: a.duration, peak: a.peak };
  }
  const tooShort = a.duration != null && a.duration < MIN_TTS_DURATION_S;
  const tooQuiet = a.peak != null && a.peak < MIN_PEAK_AMPLITUDE;
  if (tooShort || tooQuiet) {
    return {
      ok: false,
      http: 502,
      code: "VOICE_CLONE_GLITCHED",
      message: "El clone no funciono bien. Intenta de nuevo con una grabacion mas clara.",
      duration: a.duration,
      peak: a.peak,
      tooShort,
      tooQuiet,
    };
  }
  return { ok: true, soft: false, duration: a.duration, peak: a.peak };
}

module.exports = {
  analyzeFile,
  validateInputSample,
  validateTtsRender,
  decoderAvailable,
  THRESHOLDS: { MIN_INPUT_DURATION_S, MIN_TTS_DURATION_S, MIN_PEAK_AMPLITUDE },
};
