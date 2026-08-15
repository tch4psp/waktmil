'use strict';

const { parseMessage } = require('../mail/parser');
const { lockActiveMailbox, findRetryDuplicate, countActiveMessages, insertMessage, insertAttachments } = require('../repositories/message-repository');
const { createAttachmentCollector } = require('./attachment-service');
const { assertWritableCapacity } = require('../observability/disk');
const { ExpiredError, PolicyRejectedError } = require('../shared/errors');

async function ingestMessage({ pool, config, settings, mailboxId, envelopeFrom, stream, now = new Date(), attachmentScanner }) {
  await assertWritableCapacity(config);
  const policy = settings?.email ?? { maxMessageBytes: config.ingest.maxMessageBytes, attachmentsEnabled: true };
  const mailboxPolicy = settings?.mailbox ?? { maxMessagesPerMailbox: config.limits.maxMessagesPerMailbox };
  if (!policy.attachmentsEnabled) attachmentScanner = async () => { throw new PolicyRejectedError('Attachments are currently disabled.'); };
  const collector = createAttachmentCollector(config, attachmentScanner);
  let parsed;
  try {
    parsed = await parseMessage(stream, {
    maxRawMessageBytes: policy.maxMessageBytes,
    maxTextBodyBytes: config.limits.maxTextBodyBytes,
    maxHtmlBodyBytes: config.limits.maxHtmlBodyBytes
    }, (part) => collector.collect(part));
  } catch (error) {
    await collector.cleanup();
    throw error;
  }
  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    inTransaction = true;
    const mailbox = await lockActiveMailbox(client, mailboxId, now);
    if (!mailbox) throw new ExpiredError();
    const message = {
      ...parsed,
      mailboxId,
      envelopeFrom: envelopeFrom ?? null,
      expiresAt: mailbox.expires_at,
      attachmentCount: collector.attachments.length
    };
    const duplicate = await findRetryDuplicate(client, mailboxId, message);
    if (duplicate) {
      await collector.cleanup();
      await client.query('COMMIT');
      inTransaction = false;
      return { id: duplicate.id, duplicate: true };
    }
    if (await countActiveMessages(client, mailboxId) >= mailboxPolicy.maxMessagesPerMailbox) throw new PolicyRejectedError('Mailbox message limit reached.');
    const persisted = await insertMessage(client, message);
    await insertAttachments(client, persisted.id, collector.attachments, mailbox.expires_at);
    await client.query('COMMIT');
    inTransaction = false;
    return { id: persisted.id, duplicate: false };
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    await collector.cleanup();
    throw error;
  } finally {
    client?.release();
  }
}

module.exports = { ingestMessage };
