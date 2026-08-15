'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { PolicyRejectedError } = require('../shared/errors');

const STORAGE_KEY_PATTERN = /^[a-f0-9]{32}$/;

function generateStorageKey() {
  return crypto.randomBytes(16).toString('hex');
}

function safeDisplayFilename(value) {
  const normalized = String(value ?? 'attachment.bin')
    .replace(/[\\/]+/g, '_')
    .replace(/[\0-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 200);
  return normalized || 'attachment.bin';
}

function resolveStoragePath(root, storageKey) {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new PolicyRejectedError('Invalid attachment storage key.');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, storageKey.slice(0, 2), storageKey);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new PolicyRejectedError('Invalid attachment path.');
  return target;
}

async function ensureStorageRoots(root, tempRoot) {
  await Promise.all([
    fsp.mkdir(root, { recursive: true, mode: 0o700 }),
    fsp.mkdir(tempRoot, { recursive: true, mode: 0o700 })
  ]);
}

async function writeAttachmentTemp(stream, { tempRoot, maxBytes }) {
  const tempName = `${generateStorageKey()}.part`;
  const tempPath = path.resolve(tempRoot, tempName);
  const resolvedTempRoot = path.resolve(tempRoot);
  if (!tempPath.startsWith(`${resolvedTempRoot}${path.sep}`)) throw new PolicyRejectedError('Invalid temporary attachment path.');
  let bytes = 0;
  const digest = crypto.createHash('sha256');
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new PolicyRejectedError('Attachment exceeds the allowed size.'));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(stream, limiter, fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
    return { tempPath, sizeBytes: bytes, sha256: digest.digest('hex') };
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function finalizeAttachment(tempPath, attachmentRoot, storageKey) {
  const target = resolveStoragePath(attachmentRoot, storageKey);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.rename(tempPath, target);
  return target;
}

async function removeFile(filePath) {
  if (!filePath) return;
  await fsp.unlink(filePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function removeStoredAttachment(attachmentRoot, storageKey) {
  await removeFile(resolveStoragePath(attachmentRoot, storageKey));
}

async function sweepTempFiles(tempRoot, olderThan) {
  const resolvedRoot = path.resolve(tempRoot);
  const entries = await fsp.readdir(resolvedRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{32}\.part$/.test(entry.name)) continue;
    const filePath = path.resolve(resolvedRoot, entry.name);
    if (!filePath.startsWith(`${resolvedRoot}${path.sep}`)) continue;
    const stat = await fsp.stat(filePath);
    if (stat.mtime <= olderThan) {
      await removeFile(filePath);
      removed += 1;
    }
  }
  return removed;
}

function createReadStream(attachmentRoot, storageKey) {
  return fs.createReadStream(resolveStoragePath(attachmentRoot, storageKey), { flags: 'r' });
}

module.exports = {
  generateStorageKey,
  safeDisplayFilename,
  resolveStoragePath,
  ensureStorageRoots,
  writeAttachmentTemp,
  finalizeAttachment,
  removeFile,
  removeStoredAttachment,
  sweepTempFiles,
  createReadStream
};
