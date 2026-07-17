'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MIN_FREE_BYTES = Number(process.env.UPLOAD_MIN_FREE_BYTES || 256 * 1024 * 1024);
const EPHEMERAL_MAX_AGE_MS = Number(process.env.UPLOAD_EPHEMERAL_MAX_AGE_MS || 24 * 60 * 60 * 1000);

function stats(dir, { statfs = fs.statfsSync } = {}) {
  const value = statfs(dir);
  return {
    freeBytes: Number(value.bavail) * Number(value.bsize),
    totalBytes: Number(value.blocks) * Number(value.bsize),
  };
}

function isEphemeral(name) {
  return !path.extname(name)
    || /^voice_merge_.*\.txt$/.test(name)
    || /^voice_\d+_merged\.m4a$/.test(name)
    || /^voice_\d+_\d+\./.test(name);
}

function cleanupUploadStorage(dir, { now = Date.now(), maxAgeMs = EPHEMERAL_MAX_AGE_MS } = {}) {
  let deleted = 0;
  let bytesReclaimed = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (!stat.isFile() || !isEphemeral(name) || now - stat.mtimeMs < maxAgeMs) continue;
    try {
      fs.unlinkSync(full);
      deleted += 1;
      bytesReclaimed += stat.size;
    } catch (_) {}
  }
  return { deleted, bytesReclaimed };
}

function ensureUploadCapacity(dir, { minFreeBytes = DEFAULT_MIN_FREE_BYTES, cleanup = true, statfs = fs.statfsSync } = {}) {
  const before = stats(dir, { statfs });
  let cleanupReceipt = { deleted: 0, bytesReclaimed: 0 };
  if (cleanup && before.freeBytes < minFreeBytes) cleanupReceipt = cleanupUploadStorage(dir);
  const after = stats(dir, { statfs });
  const ok = after.freeBytes >= minFreeBytes;
  return {
    ok,
    minFreeBytes,
    before,
    after,
    cleanup: cleanupReceipt,
    error: ok ? null : 'upload_storage_capacity_exhausted',
  };
}

function uploadCapacityMiddleware(dir, options = {}) {
  const { observe = null, ...capacityOptions } = options;
  return (req, res, next) => {
    let receipt;
    try {
      receipt = ensureUploadCapacity(dir, capacityOptions);
    } catch (error) {
      const unavailable = { ok: false, error: 'upload_storage_health_unavailable', reasonCode: error.code || error.message };
      try { observe?.('unavailable', unavailable, req); } catch (_) {}
      return res.status(503).json(unavailable);
    }
    req.uploadCapacityReceipt = receipt;
    try { observe?.(receipt.ok ? 'healthy' : 'exhausted', receipt, req); } catch (_) {}
    if (!receipt.ok) {
      return res.status(507).json({
        error: receipt.error,
        reasonCode: 'ENOSPC_PREVENTED',
        storage: {
          freeBytes: receipt.after.freeBytes,
          minFreeBytes: receipt.minFreeBytes,
          bytesReclaimed: receipt.cleanup.bytesReclaimed,
        },
      });
    }
    return next();
  };
}

module.exports = {
  DEFAULT_MIN_FREE_BYTES,
  EPHEMERAL_MAX_AGE_MS,
  stats,
  isEphemeral,
  cleanupUploadStorage,
  ensureUploadCapacity,
  uploadCapacityMiddleware,
};
