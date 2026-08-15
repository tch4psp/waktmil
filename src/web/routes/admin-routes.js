'use strict';

const express = require('express');
const { login, authorizeAdmin, requireCsrf, logout, getOverview, getSettings, updateSettings, listDomains, setDomain, addDomain, listBlocks, listAbuseEvents, listIngestEvents, createBlock, removeBlock, removeMailbox, expireMailbox, getMailboxMetadata, listMailboxMetadata, listMessageMetadata, removeMessage, listAuditEvents, listSessions, changePassword, revokeSession, pagination } = require('../../services/admin-service');
const { parseCookies, sessionCookie, expiredSessionCookie } = require('../../security/admin-sessions');
const { requireKnownFields, requireUuid } = require('../../shared/validation');
const { ValidationError } = require('../../shared/errors');
const { getRuntimeSettings } = require('../../services/runtime-settings-service');

function createAdminRouter({ pool, config, rateLimiter }) {
  const router = express.Router();
  router.post('/session', async (request, response, next) => {
    try {
      const body = requireKnownFields(request.body, ['username', 'password']);
      const username = typeof body.username === 'string' ? body.username : '';
      const settings = await getRuntimeSettings({ pool, config });
      rateLimiter.consume(`admin-login-ip:${request.ip}`, { limit: settings.limits.adminLoginPerWindow, windowMs: settings.limits.adminLoginWindowSeconds * 1000 });
      rateLimiter.consume(`admin-login-user:${username.toLowerCase()}`, { limit: settings.limits.adminLoginPerWindow, windowMs: settings.limits.adminLoginWindowSeconds * 1000 });
      const result = await login({ pool, config, username, password: body.password, sourceIp: request.ip, userAgent: request.get('user-agent') });
      response.setHeader('Set-Cookie', sessionCookie(config, result.sessionToken));
      response.status(201).json({ admin: { username: result.username }, csrfToken: result.csrfToken });
    } catch (error) { next(error); }
  });

  router.use(async (request, _response, next) => {
    try {
      request.adminSessionToken = parseCookies(request.get('cookie'))[config.admin.cookieName];
      request.admin = await authorizeAdmin({ pool, config, sessionToken: request.adminSessionToken });
      next();
    } catch (error) { next(error); }
  });

  router.use((request, _response, next) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) return next();
    const origin = request.get('origin');
    if (origin && origin !== config.appBaseUrl) return next(new ValidationError('Invalid request origin.'));
    try {
      requireCsrf(request.admin, request.get('x-csrf-token'));
      next();
    } catch (error) { next(error); }
  });

  router.delete('/session', async (request, response, next) => {
    try {
      await logout({ pool, sessionToken: request.adminSessionToken });
      response.setHeader('Set-Cookie', expiredSessionCookie(config));
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.get('/overview', async (_request, response, next) => {
    try { response.json({ overview: await getOverview({ pool, config }) }); } catch (error) { next(error); }
  });
  router.get('/settings', async (_request, response, next) => {
    try { response.json({ settings: await getSettings({ pool, config }) }); } catch (error) { next(error); }
  });
  router.put('/settings', async (request, response, next) => {
    try {
      const body = requireKnownFields(request.body, ['mailbox', 'email', 'site', 'limits']);
      for (const [section, fields] of Object.entries({ mailbox: ['ttlMinutes', 'creationEnabled', 'maxMessagesPerMailbox'], email: ['maxMessageBytes', 'attachmentsEnabled', 'htmlViewerEnabled', 'textViewerEnabled'], site: ['siteName', 'tagline', 'supportEmail', 'footerText', 'faviconPath', 'maintenanceMode', 'maintenanceMessage'], limits: ['mailboxCreatePerWindow', 'mailboxCreateWindowSeconds', 'adminLoginPerWindow', 'adminLoginWindowSeconds'] })) {
        if (!body[section] || typeof body[section] !== 'object' || Array.isArray(body[section])) throw new ValidationError(`Invalid ${section} settings.`);
        requireKnownFields(body[section], fields);
      }
      response.json({ settings: await updateSettings({ pool, config, session: request.admin, settings: body, sourceIp: request.ip, requestId: request.requestId }) });
    } catch (error) { next(error); }
  });
  router.get('/domains', async (_request, response, next) => {
    try { response.json({ domains: await listDomains(pool) }); } catch (error) { next(error); }
  });
  router.patch('/domains/:domainId', async (request, response, next) => {
    try {
      const body = requireKnownFields(request.body, ['isEnabled', 'isDefault', 'displayName', 'publicCreationEnabled']);
      const domain = await setDomain({ pool, session: request.admin, id: requireUuid(request.params.domainId, 'domainId'), updates: body, sourceIp: request.ip, requestId: request.requestId, config });
      response.json({ domain });
    } catch (error) { next(error); }
  });
  router.post('/domains', async (request, response, next) => {
    try {
      const body = requireKnownFields(request.body, ['domainName', 'displayName', 'mxHostname', 'isEnabled', 'isDefault', 'publicCreationEnabled']);
      response.status(201).json({ domain: await addDomain({ pool, session: request.admin, domain: body, sourceIp: request.ip, requestId: request.requestId, config }) });
    } catch (error) { next(error); }
  });
  router.get('/blocks', async (_request, response, next) => {
    try { response.json({ blocks: await listBlocks(pool, 100) }); } catch (error) { next(error); }
  });
  router.post('/blocks', async (request, response, next) => {
    try {
      const body = requireKnownFields(request.body, ['scope', 'matchType', 'matchValue', 'reasonCode', 'expiresAt']);
      const expiresAt = body.expiresAt === null || body.expiresAt === undefined ? null : new Date(body.expiresAt);
      if (expiresAt && Number.isNaN(expiresAt.valueOf())) throw new ValidationError('Invalid block expiry.');
      const block = await createBlock({ pool, session: request.admin, block: { scope: body.scope, matchType: body.matchType, matchValue: body.matchValue, reasonCode: body.reasonCode, expiresAt }, sourceIp: request.ip, requestId: request.requestId, config });
      response.status(201).json({ block });
    } catch (error) { next(error); }
  });
  router.delete('/blocks/:blockId', async (request, response, next) => {
    try {
      await removeBlock({ pool, session: request.admin, id: requireUuid(request.params.blockId, 'blockId'), sourceIp: request.ip, requestId: request.requestId, config });
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.get('/abuse-events', async (request, response, next) => {
    try { response.json({ events: await listAbuseEvents(pool, pagination(request.query.limit, 50)) }); } catch (error) { next(error); }
  });
  router.get('/ingest-events', async (request, response, next) => {
    try {
      const before = request.query.before === undefined ? null : new Date(String(request.query.before));
      if (before && Number.isNaN(before.valueOf())) throw new ValidationError('Invalid cursor.');
      response.json({ events: await listIngestEvents(pool, { limit: pagination(request.query.limit, 50), before }) });
    } catch (error) { next(error); }
  });
  router.delete('/mailboxes/:mailboxId', async (request, response, next) => {
    try {
      await removeMailbox({ pool, session: request.admin, id: requireUuid(request.params.mailboxId, 'mailboxId'), sourceIp: request.ip, requestId: request.requestId, config });
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.get('/mailboxes/:mailboxId', async (request, response, next) => {
    try { response.json({ mailbox: await getMailboxMetadata({ pool, id: requireUuid(request.params.mailboxId, 'mailboxId') }) }); } catch (error) { next(error); }
  });
  router.get('/mailboxes', async (request, response, next) => {
    try {
      const query = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 120) : '';
      const page = request.query.page === undefined ? 0 : Number(request.query.page);
      if (!Number.isInteger(page) || page < 0 || page > 10_000) throw new ValidationError('Invalid page.');
      response.json({ mailboxes: await listMailboxMetadata(pool, { query, limit: pagination(request.query.limit, 50), offset: page * pagination(request.query.limit, 50) }) });
    } catch (error) { next(error); }
  });
  router.post('/mailboxes/:mailboxId/expire', async (request, response, next) => {
    try {
      await expireMailbox({ pool, config, session: request.admin, id: requireUuid(request.params.mailboxId, 'mailboxId'), sourceIp: request.ip, requestId: request.requestId });
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.get('/messages', async (request, response, next) => {
    try {
      const query = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 120) : '';
      const page = request.query.page === undefined ? 0 : Number(request.query.page);
      if (!Number.isInteger(page) || page < 0 || page > 10_000) throw new ValidationError('Invalid page.');
      const limit = pagination(request.query.limit, 50);
      response.json({ messages: await listMessageMetadata(pool, { query, limit, offset: page * limit }) });
    } catch (error) { next(error); }
  });
  router.delete('/messages/:messageId', async (request, response, next) => {
    try {
      await removeMessage({ pool, config, session: request.admin, id: requireUuid(request.params.messageId, 'messageId'), sourceIp: request.ip, requestId: request.requestId });
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.get('/audit-events', async (request, response, next) => {
    try {
      const action = typeof request.query.action === 'string' ? request.query.action.trim().slice(0, 100) : '';
      const page = request.query.page === undefined ? 0 : Number(request.query.page);
      if (!Number.isInteger(page) || page < 0 || page > 10_000) throw new ValidationError('Invalid page.');
      const limit = pagination(request.query.limit, 50);
      response.json({ events: await listAuditEvents(pool, { action, limit, offset: page * limit }) });
    } catch (error) { next(error); }
  });
  router.get('/sessions', async (request, response, next) => {
    try { response.json({ sessions: await listSessions(pool, request.admin.admin_id), currentSessionId: request.admin.id }); } catch (error) { next(error); }
  });
  router.delete('/sessions/:sessionId', async (request, response, next) => {
    try {
      await revokeSession({ pool, config, session: request.admin, id: requireUuid(request.params.sessionId, 'sessionId'), sourceIp: request.ip, requestId: request.requestId });
      response.status(204).end();
    } catch (error) { next(error); }
  });
  router.put('/password', async (request, response, next) => {
    try {
      const body = requireKnownFields(request.body, ['currentPassword', 'newPassword']);
      await changePassword({ pool, config, session: request.admin, currentPassword: body.currentPassword, newPassword: body.newPassword, sourceIp: request.ip, requestId: request.requestId });
      response.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}

module.exports = { createAdminRouter };
