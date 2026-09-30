// backend/voice_validator.js
// Capa 1 (pre-clone) + Capa 2 (post-clone) audio quality detector for ALZO
// voice clone flow. See feature/voice-quality-detector.
//
// Capa 1: validate the user's recorded sample BEFORE sending to ElevenLabs.
//   - The R2 bundle route additionally enforces 7s per take and 40s total
//     from this analyzer's decoded duration before paid transcription.
//   - Reject if peak amplitude < MIN_PEAK_AMPLITUDE (0.05) → VOICE_AUDIO_SILENT
//
// Capa 2: validate ElevenLabs' first TTS render with the new voice_id.
//   - Require duration >= MIN_TTS_DURATION_S (4s) AND peak > MIN_PEAK_AMPLITUDE
//   - Otherwise the clone is glitched → VOICE_CLONE_GLITCHED (caller cleans up
//     the orphan voice on ElevenLabs)
//
// Decoder: ffmpeg-static counts decoded PCM samples and volumedetect measures
// peak dB. MP4 presentation duration caps AAC encoder padding. Container
// headers alone cannot certify truncated audio.
//
// The R2 upload gate fails closed when decoding cannot establish duration.

const { spawn } = require("child_process");
const fs = require("fs");

const MIN_INPUT_DURATION_S = 3.0;
const MIN_TTS_DURATION_S = 4.0;
const MIN_PEAK_AMPLITUDE = 0.05; // ~ -26 dBFS

let ffmpegPath = null;
try { ffmpegPath = require("ffmpeg-static"); } catch {}

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
  // Container headers can outlive truncated AAC data. ffmpeg progress also
  // includes encoder padding (6.999 s of speech can report 7.012 s). Count
  // decoded PCM samples instead: the decoder applies AAC edit-list trim and
  // discard padding. A failed or interrupted decode never supplies duration.
  if (!ffmpegPath) return null;
  const decodedDuration = await new Promise((resolve) => {
    let bytes = 0;
    let done = false;
    let child;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawn(ffmpegPath, [
        '-hide_banner', '-xerror', '-v', 'error', '-i', filePath,
        '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(null); }, 30000);
    child.stdout.on('data', (buffer) => { bytes += buffer.length; });
    // Drain diagnostics without retaining uploaded audio or provider data.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 && bytes > 0 && bytes % 2 === 0 ? bytes / 2 / 48000 : null));
  });
  if (decodedDuration == null) return null;
  const mp4Duration = readMp4PresentationDuration(filePath);
  // For M4A, an older ffmpeg may output AAC encoder padding as extra PCM.
  // The movie presentation duration trims it. Never trust that header alone:
  // the successful full decode above is required, and we take the lesser.
  if (mp4Duration.isMp4) return mp4Duration.duration == null ? null : Math.min(decodedDuration, mp4Duration.duration);
  return decodedDuration;
}

function readMp4PresentationDuration(filePath) {
  let data;
  try { data = fs.readFileSync(filePath); } catch (_) { return { isMp4: false, duration: null }; }
  if (data.length < 12 || data.toString('ascii', 4, 8) !== 'ftyp') return { isMp4: false, duration: null };
  function boxes(start, end) {
    const out = [];
    for (let pos = start; pos + 8 <= end;) {
      let size = data.readUInt32BE(pos);
      const type = data.toString('ascii', pos + 4, pos + 8);
      let header = 8;
      if (size === 1) {
        if (pos + 16 > end) return [];
        const wide = data.readBigUInt64BE(pos + 8);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return [];
        size = Number(wide);
        header = 16;
      } else if (size === 0) size = end - pos;
      if (size < header || pos + size > end) return [];
      out.push({ type, start: pos + header, end: pos + size });
      pos += size;
    }
    return out;
  }
  const moov = boxes(0, data.length).find((box) => box.type === 'moov');
  const mvhd = moov && boxes(moov.start, moov.end).find((box) => box.type === 'mvhd');
  if (!mvhd) return { isMp4: true, duration: null };
  const version = data[mvhd.start];
  const offset = mvhd.start + (version === 0 ? 12 : version === 1 ? 20 : 999);
  const length = version === 0 ? 8 : 12;
  if (offset + length > mvhd.end) return { isMp4: true, duration: null };
  const timescale = data.readUInt32BE(offset);
  const raw = version === 0 ? data.readUInt32BE(offset + 4) : Number(data.readBigUInt64BE(offset + 4));
  const duration = raw / timescale;
  return { isMp4: true, duration: timescale > 0 && Number.isSafeInteger(raw) && Number.isFinite(duration) && duration > 0 ? duration : null };
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
  if (duration == null) {
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
