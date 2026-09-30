'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alzo-audio-gate-'));
function decoderPath(name) {
  for (const prefix of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const candidate = path.join(prefix, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} unavailable: analyzer test cannot run`);
}
// Resolve the analyzer's optional static-binary dependencies to this host's
// installed decoders inside this isolated test process.
for (const [name, source] of [
  ['ffmpeg-static', `module.exports = ${JSON.stringify(decoderPath('ffmpeg'))};\n`],
  ['ffprobe-static', `module.exports = {path: ${JSON.stringify(decoderPath('ffprobe'))}};\n`],
]) {
  const moduleDir = path.join(root, 'node_modules', name);
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'index.js'), source);
}
process.env.NODE_PATH = [path.join(root, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

const analyzerPath = require.resolve('../backend/voice_validator');
const ffprobeModulePath = require.resolve('ffprobe-static');
const analyzeWithProbe = require(analyzerPath).analyzeFile;
const { measureAndValidateCaptures } = require('../lib/measured-capture-duration-gate');

// Exercise the actual analyzer's ffmpeg fallback by removing ffprobe from
// this process only. Neither production code nor installed binaries change.
fs.writeFileSync(path.join(root, 'node_modules', 'ffprobe-static', 'index.js'), 'module.exports = {path: null};\n');
delete require.cache[ffprobeModulePath];
delete require.cache[analyzerPath];
const analyzeWithoutProbe = require(analyzerPath).analyzeFile;

function makeWave(seconds, filename) {
  const rate = 16000;
  const sampleCount = Math.round(rate * seconds);
  const samples = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) samples.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 9000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  const file = path.join(root, filename);
  fs.writeFileSync(file, Buffer.concat([header, samples]));
  return file;
}

(async () => {
  const six = makeWave(6.9, 'below.wav');
  const justShort = makeWave(6.999, 'just-short.wav');
  const seven = makeWave(7, 'exact.wav');
  const eleven = makeWave(11, 'above.wav');
  const twenty = makeWave(20, 'long.wav');
  const nineteen = makeWave(19, 'nineteen.wav');
  for (const [name, analyzeFile] of [['ffprobe', analyzeWithProbe], ['ffmpeg fallback', analyzeWithoutProbe]]) {
    assert.strictEqual((await analyzeFile(justShort)).duration, 6.999, `${name} measures 6.999 seconds without rounding up`);
    assert.strictEqual((await analyzeFile(seven)).duration, 7, `${name} measures exact seven seconds`);
    const boundaryReject = await measureAndValidateCaptures([justShort, eleven, eleven, twenty], analyzeFile);
    assert.strictEqual(boundaryReject.ok, false, `${name} rejects 6.999 seconds before paid transcription`);
    assert.ok(boundaryReject.failures.some((failure) => failure.stage === 'goal' && failure.code === 'capture_duration_short'));
    const boundaryPass = await measureAndValidateCaptures([seven, eleven, eleven, twenty], analyzeFile);
    assert.strictEqual(boundaryPass.ok, true, `${name} accepts exact seven seconds`);
    const missingBoundary = await measureAndValidateCaptures([path.join(root, 'missing.wav'), eleven, eleven, twenty], analyzeFile);
    assert.strictEqual(missingBoundary.ok, false);
    assert.strictEqual(missingBoundary.failures[0].code, 'capture_duration_unverified');
    const corruptFile = path.join(root, `corrupt-${name.replace(/\s/g, '-')}.wav`);
    fs.writeFileSync(corruptFile, 'not audio');
    const corruptBoundary = await measureAndValidateCaptures([corruptFile, eleven, eleven, twenty], analyzeFile);
    assert.strictEqual(corruptBoundary.ok, false);
    assert.strictEqual(corruptBoundary.failures[0].code, 'capture_duration_unverified');
  }
  const analyzeFile = analyzeWithProbe;
  const pass = await measureAndValidateCaptures([eleven, eleven, eleven, twenty], analyzeFile);
  assert.strictEqual(pass.ok, true);
  assert.strictEqual((await measureAndValidateCaptures([seven, seven, seven, nineteen], analyzeFile)).ok, true);
  const short = await measureAndValidateCaptures([six, eleven, eleven, twenty], analyzeFile);
  assert.strictEqual(short.ok, false);
  assert.ok(short.failures.some((failure) => failure.stage === 'goal' && failure.code === 'capture_duration_short'));
  const aggregate = await measureAndValidateCaptures([seven, seven, seven, seven], analyzeFile);
  assert.strictEqual(aggregate.ok, false);
  assert.ok(aggregate.failures.some((failure) => failure.code === 'aggregate_duration_short'));
  const missing = await measureAndValidateCaptures([path.join(root, 'missing.wav'), eleven, eleven, twenty], analyzeFile);
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.failures[0].code, 'capture_duration_unverified');
  const corruptFile = path.join(root, 'corrupt.wav');
  fs.writeFileSync(corruptFile, 'not audio');
  const corrupt = await measureAndValidateCaptures([corruptFile, eleven, eleven, twenty], analyzeFile);
  assert.strictEqual(corrupt.ok, false);
  assert.strictEqual(corrupt.failures[0].code, 'capture_duration_unverified');
  const thrown = await measureAndValidateCaptures([seven, eleven, eleven, twenty], async () => { throw new Error('synthetic decoder failure'); });
  assert.strictEqual(thrown.ok, false);
  assert.strictEqual(thrown.failures[0].code, 'capture_duration_unverified');
  console.log('ALZO measured audio gate passed: real analyzer, synthetic WAV, no provider calls');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
