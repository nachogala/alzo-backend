'use strict';

const { validateCaptureDurations, MIN_VALID_AUDIO_MS } = require('./alzo-r2-contracts');

// Only measured, decodable audio can pass. Analyzer failures are a closed
// validation result so no transcription job is reached.
async function measureAndValidateCaptures(files, analyzeFile) {
  const measured = await Promise.all(files.map(async (file) => {
    try {
      return await analyzeFile(file);
    } catch (_) {
      return { ok: false, reason: 'analyzer_failed', duration: null };
    }
  }));
  const durationsMs = measured.map((item) => item?.ok === true && Number.isFinite(item.duration)
    ? item.duration * 1000 : NaN);
  const gate = validateCaptureDurations(durationsMs);
  const aggregateDurationMs = durationsMs.every(Number.isFinite)
    ? durationsMs.reduce((sum, duration) => sum + duration, 0) : NaN;
  const failures = [...gate.failures];
  if (Number.isFinite(aggregateDurationMs) && aggregateDurationMs < MIN_VALID_AUDIO_MS) {
    failures.push({ stage: 'all', code: 'aggregate_duration_short', shortfallMs: Math.ceil(MIN_VALID_AUDIO_MS - aggregateDurationMs) });
  }
  return { ...gate, ok: gate.ok && failures.length === 0, failures, aggregateDurationMs, minimumAggregateMs: MIN_VALID_AUDIO_MS, measuredDurationsMs: durationsMs };
}

module.exports = { measureAndValidateCaptures };
