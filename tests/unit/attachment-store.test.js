'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const {
  ensureStorageRoots,
  finalizeAttachment,
  resolveStoragePath,
  safeDisplayFilename,
  sweepTempFiles,
  writeAttachmentTemp
} = require('../../src/storage/attachment-store');

test('attachment storage uses opaque paths and rejects traversal keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tempmail-storage-'));
  try {
    const attachmentRoot = path.join(root, 'attachments');
    const tempRoot = path.join(root, 'tmp');
    await ensureStorageRoots(attachmentRoot, tempRoot);
    const written = await writeAttachmentTemp(Readable.from('hello'), { tempRoot, maxBytes: 5 });
    const storageKey = '0123456789abcdef0123456789abcdef';
    const permanentPath = await finalizeAttachment(written.tempPath, attachmentRoot, storageKey);
    assert.equal(permanentPath, resolveStoragePath(attachmentRoot, storageKey));
    assert.equal(await fs.readFile(permanentPath, 'utf8'), 'hello');
    assert.throws(() => resolveStoragePath(attachmentRoot, '../outside'), { code: 'POLICY_REJECTED' });
    assert.equal(safeDisplayFilename('../../evil\r\n.txt'), '.._.._evil.txt');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('attachment temporary writes and sweeps obey strict byte and filename boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tempmail-temp-'));
  try {
    await assert.rejects(() => writeAttachmentTemp(Readable.from('hello'), { tempRoot: root, maxBytes: 4 }), { code: 'POLICY_REJECTED' });
    const stale = path.join(root, '0123456789abcdef0123456789abcdef.part');
    const current = path.join(root, 'fedcba9876543210fedcba9876543210.part');
    await fs.writeFile(stale, 'stale');
    await fs.writeFile(current, 'current');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(stale, old, old);
    assert.equal(await sweepTempFiles(root, new Date(Date.now() - 15 * 60 * 1000)), 1);
    await assert.rejects(() => fs.stat(stale), { code: 'ENOENT' });
    assert.equal(await fs.readFile(current, 'utf8'), 'current');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
