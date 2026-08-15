'use strict';

const { authorizeMailbox } = require('./mailbox-service');
const {
  listMessages,
  findOwnedMessage,
  findMessageMailboxId,
  listAttachmentsForMessage,
  findOwnedAttachment,
  markMessageDeleted
} = require('../repositories/message-repository');
const { createReadStream, safeDisplayFilename } = require('../storage/attachment-store');
const { NotFoundError, AttachmentUnavailableError } = require('../shared/errors');

function serializeMessageMetadata(message) {
  return {
    id: message.id,
    from: { address: message.from_address, name: message.from_name },
    subject: message.subject,
    receivedAt: new Date(message.received_at).toISOString(),
    attachmentCount: message.attachment_count
  };
}

async function getInbox({ pool, mailboxId, accessToken, limit = 50 }) {
  await authorizeMailbox(pool, mailboxId, accessToken);
  const messages = await listMessages(pool, mailboxId, Math.min(limit, 100));
  return { messages: messages.map(serializeMessageMetadata) };
}

async function getMessage({ pool, accessToken, messageId }) {
  const mailboxId = await findMessageMailboxId(pool, messageId);
  if (!mailboxId) throw new NotFoundError();
  await authorizeMailbox(pool, mailboxId, accessToken);
  const message = await findOwnedMessage(pool, mailboxId, messageId);
  if (!message) throw new NotFoundError();
  const attachments = await listAttachmentsForMessage(pool, message.id);
  return {
    ...serializeMessageMetadata(message),
    replyTo: message.reply_to,
    to: message.to_json,
    cc: message.cc_json,
    sentAt: message.sent_at?.toISOString() ?? null,
    textBody: message.text_body,
    htmlSanitized: message.html_sanitized,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.original_filename,
      sizeBytes: attachment.size_bytes,
      scanStatus: attachment.scan_status,
      available: attachment.scan_status === 'clean'
    }))
  };
}

async function openAttachmentDownload({ pool, config, attachmentId, accessToken }) {
  const attachment = await findOwnedAttachment(pool, attachmentId);
  if (!attachment) throw new NotFoundError();
  await authorizeMailbox(pool, attachment.mailbox_id, accessToken);
  if (attachment.scan_status !== 'clean') throw new AttachmentUnavailableError();
  return {
    stream: createReadStream(config.storage.attachmentRoot, attachment.storage_key),
    filename: safeDisplayFilename(attachment.original_filename)
  };
}

async function deleteMessage({ pool, messageId, accessToken, now = new Date() }) {
  const mailboxId = await findMessageMailboxId(pool, messageId);
  if (!mailboxId) throw new NotFoundError();
  await authorizeMailbox(pool, mailboxId, accessToken, now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const message = await markMessageDeleted(client, mailboxId, messageId, now);
    if (!message) throw new NotFoundError();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { getInbox, getMessage, openAttachmentDownload, deleteMessage };
