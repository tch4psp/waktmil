'use strict';

const express = require('express');
const { listEnabled } = require('../../repositories/domain-repository');
const { createMailbox, getMailbox, deleteMailbox } = require('../../services/mailbox-service');
const { getInbox, getMessage, openAttachmentDownload, deleteMessage } = require('../../services/message-service');
const { hashToken, readBearerToken } = require('../../security/tokens');
const { requireKnownFields, requireUuid } = require('../../shared/validation');
const { ValidationError } = require('../../shared/errors');
const { rejectBlockedSource } = require('../../services/block-service');
const { getRuntimeSettings } = require('../../services/runtime-settings-service');

function createMailboxRouter({ pool, config, rateLimiter }) {
  const router = express.Router();
  router.use(async (request, _response, next) => {
    try { await rejectBlockedSource({ pool, config, scope: 'web', sourceIp: request.ip }); next(); } catch (error) { next(error); }
  });
  router.use((request, _response, next) => {
    if (Object.keys(request.query).some((key) => /token|authorization/i.test(key))) {
      next(new ValidationError('Credentials are not accepted in URLs.'));
      return;
    }
    next();
  });
  router.get('/domains', async (request, response, next) => {
    try {
      rateLimiter.consume(`domains:${request.ip}`, { limit: 60, windowMs: 60 * 1000 });
      const domains = await listEnabled(pool);
      response.json({ domains: domains.map((domain) => ({ id: domain.id, name: domain.domain_name, isDefault: domain.is_default })) });
    } catch (error) { next(error); }
  });
  router.post('/mailboxes', async (request, response, next) => {
    try {
      const body = requireKnownFields(request.body, ['domainId']);
      const domainId = body.domainId === undefined ? undefined : requireUuid(body.domainId, 'domainId');
      const settings = await getRuntimeSettings({ pool, config });
      rateLimiter.consume(`mailbox-create:${request.ip}`, { limit: settings.limits.mailboxCreatePerWindow, windowMs: settings.limits.mailboxCreateWindowSeconds * 1000 });
      const result = await createMailbox({ pool, config, settings, domainId, sourceIp: request.ip });
      response.status(201).json(result);
    } catch (error) { next(error); }
  });
  router.get('/mailboxes/:mailboxId', async (request, response, next) => {
    try {
      const mailboxId = requireUuid(request.params.mailboxId, 'mailboxId');
      const accessToken = readBearerToken(request.get('authorization'));
      response.json({ mailbox: await getMailbox({ pool, mailboxId, accessToken }) });
    } catch (error) { next(error); }
  });
  router.delete('/mailboxes/:mailboxId', async (request, response, next) => {
    try {
      const mailboxId = requireUuid(request.params.mailboxId, 'mailboxId');
      const accessToken = readBearerToken(request.get('authorization'));
      rateLimiter.consume(`mailbox-delete:${hashToken(accessToken).toString('hex')}`, { limit: 10, windowMs: 60 * 1000 });
      await deleteMailbox({ pool, mailboxId, accessToken });
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.get('/mailboxes/:mailboxId/messages', async (request, response, next) => {
    try {
      const mailboxId = requireUuid(request.params.mailboxId, 'mailboxId');
      const accessToken = readBearerToken(request.get('authorization'));
      const requestedLimit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100 || request.query.before !== undefined) {
        throw new ValidationError('Invalid pagination.');
      }
      rateLimiter.consume(`mailbox-inbox:${hashToken(accessToken).toString('hex')}`, { limit: 30, windowMs: 60 * 1000 });
      response.json(await getInbox({ pool, mailboxId, accessToken, limit: requestedLimit }));
    } catch (error) { next(error); }
  });
  router.get('/messages/:messageId', async (request, response, next) => {
    try {
      const messageId = requireUuid(request.params.messageId, 'messageId');
      const accessToken = readBearerToken(request.get('authorization'));
      rateLimiter.consume(`mailbox-message:${hashToken(accessToken).toString('hex')}`, { limit: 60, windowMs: 60 * 1000 });
      response.json({ message: await getMessage({ pool, accessToken, messageId }) });
    } catch (error) { next(error); }
  });
  router.delete('/messages/:messageId', async (request, response, next) => {
    try {
      const messageId = requireUuid(request.params.messageId, 'messageId');
      const accessToken = readBearerToken(request.get('authorization'));
      rateLimiter.consume(`mailbox-message-delete:${hashToken(accessToken).toString('hex')}`, { limit: 10, windowMs: 60 * 1000 });
      await deleteMessage({ pool, messageId, accessToken });
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.get('/attachments/:attachmentId/download', async (request, response, next) => {
    try {
      const attachmentId = requireUuid(request.params.attachmentId, 'attachmentId');
      const accessToken = readBearerToken(request.get('authorization'));
      rateLimiter.consume(`mailbox-download:${hashToken(accessToken).toString('hex')}`, { limit: 20, windowMs: 10 * 60 * 1000 });
      const download = await openAttachmentDownload({ pool, config, attachmentId, accessToken });
      response.status(200);
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(download.filename)}`);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', 'private, no-store');
      download.stream.once('error', (error) => {
        if (response.headersSent) response.destroy(error);
        else next(error);
      });
      download.stream.pipe(response);
    } catch (error) { next(error); }
  });
  return router;
}

module.exports = { createMailboxRouter };
