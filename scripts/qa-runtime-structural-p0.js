'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const r2 = require('../lib/alzo-r2-contracts');
const storage = require('../lib/storageCapacity');

const context = {
  goal: 'finish my nursing degree at the community college',
  purpose: 'give my children financial stability and a safe home',
  reconnectionAnchor: 'call my sister Rosa when I lose momentum',
};

const generic = r2.validateFirstMessageGrounding('I choose this gift to give this part of my life.', context);
assert(!generic.ok);
assert.equal(generic.failureCodes.length, 3);
const partial = r2.validateFirstMessageGrounding('I finish my nursing degree because stability matters.', context);
assert(!partial.ok);
assert(partial.failureCodes.includes('first_message_reconnectionAnchor_not_recognizable'));
const grounded = r2.validateFirstMessageGrounding('I finish my nursing degree at the community college to give my children financial stability and a safe home, and I call my sister Rosa when I lose momentum.', context);
assert(grounded.ok);
assert(Object.values(grounded.matched).every((match) => match.recognizable));

const prompt = r2.buildFirstPrompt(context);
assert(prompt.messages[0].content.includes('recognize all three inputs'));
assert.deepStrictEqual(Object.keys(prompt.semanticContext).sort(), ['goal', 'purpose', 'reconnectionAnchor'].sort());

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alzo-storage-'));
fs.writeFileSync(path.join(dir, 'orphanmulterfile'), Buffer.alloc(1024));
const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
fs.utimesSync(path.join(dir, 'orphanmulterfile'), old, old);
fs.writeFileSync(path.join(dir, 'voice_manifest_keep.json'), '{}');
const cleanupReceipt = storage.cleanupUploadStorage(dir);
assert.equal(cleanupReceipt.deleted, 1);
assert(fs.existsSync(path.join(dir, 'voice_manifest_keep.json')));

const exhausted = storage.ensureUploadCapacity(dir, {
  minFreeBytes: 1024,
  cleanup: false,
  statfs: () => ({ bavail: 1, bsize: 100, blocks: 1000 }),
});
assert.equal(exhausted.ok, false);
assert.equal(exhausted.error, 'upload_storage_capacity_exhausted');
const healthy = storage.ensureUploadCapacity(dir, {
  minFreeBytes: 1024,
  cleanup: false,
  statfs: () => ({ bavail: 20, bsize: 100, blocks: 1000 }),
});
assert.equal(healthy.ok, true);

const observations = [];
let statusCode = null;
let responseBody = null;
storage.uploadCapacityMiddleware(dir, {
  minFreeBytes: 1024,
  cleanup: false,
  statfs: () => ({ bavail: 1, bsize: 100, blocks: 1000 }),
  observe: (stage, receipt) => observations.push({ stage, receipt }),
})({}, {
  status(code) { statusCode = code; return this; },
  json(body) { responseBody = body; return body; },
}, () => { throw new Error('exhausted middleware must not continue'); });
assert.equal(statusCode, 507);
assert.equal(responseBody.reasonCode, 'ENOSPC_PREVENTED');
assert.equal(observations[0].stage, 'exhausted');
fs.rmSync(dir, { recursive: true, force: true });

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
for (const value of ['_message.prompt.receipt', '_message.output.receipt', 'uploadCapacityMiddleware(UPLOAD_STORAGE_DIR', 'upload.storage.capacity.receipt', 'journey_transaction_id', 'account_lookup_hash']) assert(server.includes(value));

console.log(JSON.stringify({ ok: true, gate: 'runtime_structural_p0_backend' }));
