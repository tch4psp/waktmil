'use strict';

async function lockActiveMailbox(client, mailboxId, now) {
  const result = await client.query(`SELECT m.id, m.expires_at
    FROM mailboxes m JOIN domains d ON d.id = m.domain_id
    WHERE m.id = $1 AND m.deleted_at IS NULL AND m.expires_at > $2 AND d.is_enabled = true
    FOR UPDATE`, [mailboxId, now]);
  return result.rows[0] ?? null;
}

async function findRetryDuplicate(client, mailboxId, message) {
  if (!message.messageIdHeader) return null;
  const result = await client.query(`SELECT id FROM email_messages
    WHERE mailbox_id = $1 AND content_sha256 = $2 AND envelope_from IS NOT DISTINCT FROM $3
      AND message_id_header = $4 AND received_at > now() - interval '5 minutes' AND deleted_at IS NULL
    LIMIT 1`, [mailboxId, message.contentSha256, message.envelopeFrom, message.messageIdHeader]);
  return result.rows[0] ?? null;
}

async function countActiveMessages(client, mailboxId) {
  const result = await client.query('SELECT count(*)::integer AS count FROM email_messages WHERE mailbox_id = $1 AND deleted_at IS NULL AND expires_at > now()', [mailboxId]);
  return result.rows[0].count;
}

async function insertMessage(client, message) {
  const result = await client.query(`INSERT INTO email_messages (
    mailbox_id, envelope_from, from_address, from_name, reply_to, to_json, cc_json, subject,
    message_id_header, sent_at, expires_at, text_body, html_sanitized, headers_json,
    raw_size_bytes, content_sha256, parse_status, attachment_count
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'ok',$17)
  RETURNING id, received_at`, [
    message.mailboxId, message.envelopeFrom, message.fromAddress, message.fromName, message.replyTo,
    JSON.stringify(message.to), JSON.stringify(message.cc), message.subject, message.messageIdHeader,
    message.sentAt, message.expiresAt, message.textBody, message.htmlSanitized, JSON.stringify(message.headers),
    message.rawSizeBytes, message.contentSha256, message.attachmentCount
  ]);
  return result.rows[0];
}

async function insertAttachments(client, messageId, attachments, expiresAt) {
  for (const attachment of attachments) {
    await client.query(`INSERT INTO attachments (
      message_id, original_filename, storage_key, declared_content_type, detected_content_type,
      size_bytes, sha256, scan_status, scan_signature, expires_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      messageId,
      attachment.originalFilename,
      attachment.storageKey,
      attachment.declaredContentType,
      attachment.detectedContentType,
      attachment.sizeBytes,
      attachment.sha256,
      attachment.scanStatus,
      attachment.scanSignature,
      expiresAt
    ]);
  }
}

async function listMessages(pool, mailboxId, limit) {
  const result = await pool.query(`SELECT id, from_address, from_name, subject, received_at, attachment_count
    FROM email_messages WHERE mailbox_id = $1 AND deleted_at IS NULL AND expires_at > now()
    ORDER BY received_at DESC, id DESC LIMIT $2`, [mailboxId, limit]);
  return result.rows;
}

async function findOwnedMessage(pool, mailboxId, messageId) {
  const result = await pool.query(`SELECT id, from_address, from_name, reply_to, to_json, cc_json, subject,
    sent_at, received_at, text_body, html_sanitized, attachment_count
    FROM email_messages WHERE id = $1 AND mailbox_id = $2 AND deleted_at IS NULL AND expires_at > now()`, [messageId, mailboxId]);
  return result.rows[0] ?? null;
}

async function findMessageMailboxId(pool, messageId) {
  const result = await pool.query('SELECT mailbox_id FROM email_messages WHERE id = $1 AND deleted_at IS NULL AND expires_at > now()', [messageId]);
  return result.rows[0]?.mailbox_id ?? null;
}

async function listAttachmentsForMessage(pool, messageId) {
  const result = await pool.query(`SELECT id, original_filename, size_bytes, scan_status
    FROM attachments WHERE message_id = $1 AND expires_at > now() ORDER BY created_at ASC`, [messageId]);
  return result.rows;
}

async function findOwnedAttachment(pool, attachmentId) {
  const result = await pool.query(`SELECT a.id, a.original_filename, a.storage_key, a.scan_status, a.size_bytes,
    m.mailbox_id FROM attachments a JOIN email_messages m ON m.id = a.message_id
    WHERE a.id = $1 AND a.expires_at > now() AND m.deleted_at IS NULL AND m.expires_at > now()`, [attachmentId]);
  return result.rows[0] ?? null;
}

async function markMessageDeleted(client, mailboxId, messageId, now) {
  const result = await client.query(`UPDATE email_messages SET deleted_at = $3
    WHERE id = $1 AND mailbox_id = $2 AND deleted_at IS NULL AND expires_at > $3
    RETURNING id`, [messageId, mailboxId, now]);
  return result.rows[0] ?? null;
}

async function findDeletedMessageBatch(client, now, limit) {
  const result = await client.query(`SELECT id FROM email_messages
    WHERE deleted_at IS NOT NULL OR expires_at <= $1
    ORDER BY COALESCE(deleted_at, expires_at) ASC
    LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit]);
  return result.rows;
}

async function listAttachmentStorageKeysForMessages(client, messageIds) {
  if (messageIds.length === 0) return [];
  const result = await client.query('SELECT storage_key FROM attachments WHERE message_id = ANY($1::uuid[])', [messageIds]);
  return result.rows;
}

async function deleteMessages(client, messageIds) {
  if (messageIds.length === 0) return [];
  const result = await client.query('DELETE FROM email_messages WHERE id = ANY($1::uuid[]) RETURNING id', [messageIds]);
  return result.rows;
}

module.exports = {
  lockActiveMailbox,
  findRetryDuplicate,
  countActiveMessages,
  insertMessage,
  insertAttachments,
  listMessages,
  findOwnedMessage,
  findMessageMailboxId,
  listAttachmentsForMessage,
  findOwnedAttachment,
  markMessageDeleted,
  findDeletedMessageBatch,
  listAttachmentStorageKeysForMessages,
  deleteMessages
};
