'use strict';

const { findExpiredBatch, listAttachmentStorageKeys, deleteMailboxes } = require('../repositories/mailbox-repository');
const { findDeletedMessageBatch, listAttachmentStorageKeysForMessages, deleteMessages } = require('../repositories/message-repository');
const { removeStoredAttachment, sweepTempFiles } = require('../storage/attachment-store');
const { setSystemConfig } = require('../repositories/system-repository');
const { deleteExpiredIngestNonces } = require('../repositories/email-ingest-repository');

const CLEANUP_LOCK_ID = 748314503;

async function cleanupMailboxes(pool, config, now = new Date()) {
  const client = await pool.connect();
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [CLEANUP_LOCK_ID]);
    if (!lock.rows[0].acquired) return { skipped: true, deleted: 0 };
    try {
      await client.query('BEGIN');
      const candidates = await findExpiredBatch(client, now, config.cleanup.batchSize);
      const storageKeys = await listAttachmentStorageKeys(client, candidates.map((candidate) => candidate.id));
      for (const attachment of storageKeys) {
        await removeStoredAttachment(config.storage.attachmentRoot, attachment.storage_key);
      }
      const rows = await deleteMailboxes(client, candidates.map((candidate) => candidate.id));
      const messages = await findDeletedMessageBatch(client, now, config.cleanup.batchSize);
      const messageAttachments = await listAttachmentStorageKeysForMessages(client, messages.map((message) => message.id));
      for (const attachment of messageAttachments) {
        await removeStoredAttachment(config.storage.attachmentRoot, attachment.storage_key);
      }
      const deletedMessages = await deleteMessages(client, messages.map((message) => message.id));
      const expiredIngestNonces = await deleteExpiredIngestNonces(client, now, config.cleanup.batchSize);
      await client.query('COMMIT');
      const tempFilesRemoved = await sweepTempFiles(config.storage.tempRoot, new Date(now.getTime() - 15 * 60 * 1000));
      const result = { skipped: false, deleted: rows.length, deletedMessages: deletedMessages.length, expiredIngestNonces, tempFilesRemoved };
      await setSystemConfig(client, 'cleanup_health', { status: 'ok', completedAt: now.toISOString(), ...result });
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [CLEANUP_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

module.exports = { cleanupMailboxes };
