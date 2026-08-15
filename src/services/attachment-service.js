'use strict';

const fs = require('node:fs');
const { once } = require('node:events');
const { scanStream } = require('../storage/clamav-client');
const {
  generateStorageKey,
  safeDisplayFilename,
  ensureStorageRoots,
  writeAttachmentTemp,
  finalizeAttachment,
  removeFile
} = require('../storage/attachment-store');
const { DependencyUnavailableError, PolicyRejectedError } = require('../shared/errors');

function createAttachmentCollector(config, scanner = scanStream) {
  const attachments = [];
  let startedAttachments = 0;
  let totalBytes = 0;
  let closed = false;
  async function collect(part) {
    if (closed) throw new PolicyRejectedError('Attachment processing is closed.');
    if (startedAttachments >= config.limits.maxAttachments) throw new PolicyRejectedError('Message has too many attachments.');
    startedAttachments += 1;
    await ensureStorageRoots(config.storage.attachmentRoot, config.storage.tempRoot);
    const written = await writeAttachmentTemp(part.content, {
      tempRoot: config.storage.tempRoot,
      maxBytes: config.limits.maxAttachmentBytes
    });
    try {
      totalBytes += written.sizeBytes;
      if (totalBytes > config.limits.maxAttachmentTotalBytes) throw new PolicyRejectedError('Message attachments exceed the allowed size.');
      const scanInput = fs.createReadStream(written.tempPath);
      await Promise.race([
        once(scanInput, 'open'),
        once(scanInput, 'error').then(([error]) => Promise.reject(error))
      ]);
      const scan = await scanner(scanInput, config);
      if (!scan || !['clean', 'infected'].includes(scan.status)) throw new Error('Invalid attachment scanner result.');
      const storageKey = generateStorageKey();
      const attachment = {
        originalFilename: safeDisplayFilename(part.filename),
        storageKey,
        declaredContentType: typeof part.contentType === 'string' ? part.contentType.slice(0, 255) : null,
        detectedContentType: null,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
        scanStatus: scan.status,
        scanSignature: scan.signature,
        filePath: null
      };
      if (scan.status === 'clean') {
        attachment.filePath = await finalizeAttachment(written.tempPath, config.storage.attachmentRoot, storageKey);
      } else {
        await removeFile(written.tempPath);
      }
      attachments.push(attachment);
      return attachment;
    } catch (error) {
      totalBytes -= written.sizeBytes;
      await removeFile(written.tempPath);
      if (error instanceof DependencyUnavailableError || error instanceof PolicyRejectedError) throw error;
      throw new DependencyUnavailableError('Attachment scanner is temporarily unavailable.', { cause: error });
    }
  }
  async function cleanup() {
    closed = true;
    await Promise.all(attachments.map((attachment) => removeFile(attachment.filePath)));
  }
  return { collect, attachments, cleanup };
}

module.exports = { createAttachmentCollector };
