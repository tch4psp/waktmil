'use strict';

const express = require('express');
const { Readable } = require('node:stream');
const { findActiveRecipient } = require('../../repositories/mailbox-repository');
const { claimIngestNonce } = require('../../repositories/email-ingest-repository');
const { parseAndVerifyEmailIngest } = require('../../security/email-ingest-auth');
const { ingestMessage } = require('../../services/ingestion-service');
const { ExpiredError, PolicyRejectedError, UnauthorizedError, ValidationError } = require('../../shared/errors');
const { getRuntimeSettings } = require('../../services/runtime-settings-service');
const { insertIngestEvent } = require('../../repositories/admin-repository');

function createEmailIngestRouter({ pool, config }) {
  const router = express.Router();
  router.post('/', express.raw({ type: ['message/rfc822', 'application/octet-stream'], limit: config.ingest.maxMessageBytes }), async (request, response, next) => {
    const startedAt = Date.now();
    let mailbox = null;
    let verified = null;
    const record = async (outcome, reasonCode) => {
      try { await insertIngestEvent(pool, { outcome, reasonCode, mailboxId: mailbox?.id, domainId: mailbox?.domain_id, durationMs: Date.now() - startedAt }); } catch { /* Observability must not change mail delivery. */ }
    };
    try {
      verified = parseAndVerifyEmailIngest(request, config);
      const claimed = await claimIngestNonce(pool, verified.nonce, verified.expiresAt);
      if (!claimed) {
        await record('duplicate', 'replayed_nonce');
        response.status(409).json({ status: 'replayed' });
        return;
      }
      mailbox = await findActiveRecipient(pool, verified.mailbox.domainName, verified.mailbox.localPart, new Date());
      if (!mailbox) {
        response.status(422).json({ status: 'mailbox_unavailable' });
        return;
      }
      const settings = await getRuntimeSettings({ pool, config });
      const result = await ingestMessage({
        pool,
        config,
        settings,
        mailboxId: mailbox.id,
        envelopeFrom: verified.sender || null,
        stream: Readable.from(request.body)
      });
      await record(result.duplicate ? 'duplicate' : 'accepted', result.duplicate ? 'message_duplicate' : 'accepted');
      response.status(result.duplicate ? 200 : 202).json({ status: result.duplicate ? 'duplicate' : 'accepted' });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        await record('unauthorized', 'invalid_signature');
        response.status(401).json({ status: 'unauthorized' });
        return;
      }
      if (error instanceof ExpiredError) {
        await record('rejected', 'mailbox_unavailable');
        response.status(422).json({ status: 'mailbox_unavailable' });
        return;
      }
      if (error instanceof ValidationError || error instanceof PolicyRejectedError) {
        await record('rejected', error instanceof PolicyRejectedError ? 'policy_rejected' : 'invalid_message');
        response.status(422).json({ status: 'rejected' });
        return;
      }
      await record('error', 'processing_error');
      next(error);
    }
  });
  return router;
}

module.exports = { createEmailIngestRouter };
