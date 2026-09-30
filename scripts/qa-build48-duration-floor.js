'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { VOICE_DURATION_RULE } = require('../lib/release-contract');
const { validateCaptureDurations } = require('../lib/alzo-r2-contracts');

assert.strictEqual(VOICE_DURATION_RULE.minimumPerCaptureSeconds, 7);
assert.strictEqual(VOICE_DURATION_RULE.minimumAggregateSeconds, 40);
assert.strictEqual(validateCaptureDurations([11000, 11000, 11000, 20000]).ok, true);
assert.strictEqual(validateCaptureDurations([7000, 7000, 7000, 19000]).ok, true);
const short = validateCaptureDurations([6999, 11000, 11000, 20000]);
assert.strictEqual(short.ok, false);
assert.deepStrictEqual(short.failures, [{ stage: 'goal', code: 'capture_duration_short', shortfallMs: 1 }]);
assert.strictEqual(validateCaptureDurations([7000, 7000, NaN, 20000]).failures[0].code, 'capture_duration_unverified');
assert.strictEqual(validateCaptureDurations([7000, 7000, 7000]).ok, false);

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = server.indexOf("const transcriptByStage = {};");
const check = server.indexOf('measureAndValidateCaptures(', start);
const paid = server.indexOf('await transcribeAudio(', start);
assert.ok(start >= 0 && check > start && paid > check, 'four file durations are checked before paid transcription');
console.log('ALZO backend seven-second capture gate passed');
