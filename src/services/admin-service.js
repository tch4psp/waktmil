'use strict';

const crypto = require('node:crypto');
const { findAdminByUsername, insertSession, findSession, touchSession, deleteSession, deleteSessionById, deleteOtherSessions, listSessions, updateAdminPassword, overview, listDomains, updateDomain, createDomain, listBlocks, insertBlock, deleteBlock, listAbuseEvents, listIngestEvents, ingestOverview, deleteMailboxByAdmin, findMailboxMetadata, listMailboxMetadata, listMessageMetadata, deleteMessageByAdmin, expireMailboxByAdmin, listAuditEvents, insertAudit } = require('../repositories/admin-repository');
const { passwordsMatch, hashPassword, validatePassword } = require('../security/admin-passwords');
const { generateSessionSecret, hashSessionSecret } = require('../security/admin-sessions');
const { pseudonymizeIp } = require('../security/ip-pseudonym');
const { UnauthorizedError, NotFoundError, ValidationError } = require('../shared/errors');
const { validateBlock } = require('./block-service');
const { diskUsage } = require('../observability/disk');
const { getSystemConfig } = require('../repositories/system-repository');
const { getRuntimeSettings, saveRuntimeSettings, cacheRuntimeSettings, settingsSchema } = require('./runtime-settings-service');

function userAgentHash(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest();
}

async function login({ pool, config, username, password, sourceIp, userAgent, now = new Date() }) {
  if (typeof username !== 'string' || username.length < 1 || username.length > 128 || typeof password !== 'string') throw new UnauthorizedError();
  const admin = await findAdminByUsername(pool, username);
  if (!admin || !admin.is_enabled || !(await passwordsMatch(password, admin.password_hash))) throw new UnauthorizedError();
  const sessionToken = generateSessionSecret();
  const csrfToken = generateSessionSecret();
  const expiresAt = new Date(now.getTime() + config.admin.sessionIdleMinutes * 60 * 1000);
  const absoluteExpiresAt = new Date(now.getTime() + config.admin.sessionAbsoluteHours * 60 * 60 * 1000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertSession(client, { adminId: admin.id, tokenHash: hashSessionSecret(sessionToken), csrfHash: hashSessionSecret(csrfToken), expiresAt, absoluteExpiresAt, ipHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), userAgentHash: userAgentHash(userAgent) });
    await client.query('UPDATE admins SET last_login_at = $2 WHERE id = $1', [admin.id, now]);
    await insertAudit(client, { adminId: admin.id, action: 'admin.login', targetType: 'admin', targetId: admin.id, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey) });
    await client.query('COMMIT');
    return { sessionToken, csrfToken, username: admin.username };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function authorizeAdmin({ pool, config, sessionToken, now = new Date() }) {
  if (!sessionToken) throw new UnauthorizedError();
  const session = await findSession(pool, hashSessionSecret(sessionToken), now);
  if (!session) throw new UnauthorizedError();
  const client = await pool.connect();
  try {
    await touchSession(client, session.id, new Date(Math.min(session.absolute_expires_at.getTime(), now.getTime() + config.admin.sessionIdleMinutes * 60 * 1000)));
  } finally { client.release(); }
  return session;
}

function requireCsrf(session, token) {
  if (typeof token !== 'string' || !crypto.timingSafeEqual(hashSessionSecret(token), session.csrf_secret_hash)) throw new UnauthorizedError();
}

async function logout({ pool, sessionToken }) {
  const client = await pool.connect();
  try { await deleteSession(client, hashSessionSecret(sessionToken)); } finally { client.release(); }
}

function validateDomainName(value) {
  if (typeof value !== 'string' || value.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)) throw new ValidationError('Invalid domain name.');
  return value.toLowerCase();
}

function pagination(value, fallback = 50) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new ValidationError('Invalid pagination.');
  return parsed;
}

async function setDomain({ pool, session, id, updates, sourceIp, requestId, config }) {
  if (updates.isEnabled !== undefined && typeof updates.isEnabled !== 'boolean') throw new ValidationError('isEnabled must be boolean.');
  if (updates.isDefault !== undefined && typeof updates.isDefault !== 'boolean') throw new ValidationError('isDefault must be boolean.');
  if (updates.publicCreationEnabled !== undefined && typeof updates.publicCreationEnabled !== 'boolean') throw new ValidationError('publicCreationEnabled must be boolean.');
  if (updates.displayName !== undefined && (typeof updates.displayName !== 'string' || updates.displayName.trim().length > 120 || /[\u0000-\u001f]/.test(updates.displayName))) throw new ValidationError('Invalid displayName.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (updates.isDefault === true) await client.query('UPDATE domains SET is_default = false WHERE is_default = true');
    const domain = await updateDomain(client, id, { ...updates, displayName: updates.displayName?.trim() });
    if (!domain) throw new NotFoundError();
    await insertAudit(client, { adminId: session.admin_id, action: 'domain.update', targetType: 'domain', targetId: id, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), requestId, details: updates });
    await client.query('COMMIT');
    return domain;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function addDomain({ pool, session, domain, sourceIp, requestId, config }) {
  const payload = {
    domainName: validateDomainName(domain.domainName),
    displayName: domain.displayName?.trim() || null,
    mxHostname: validateDomainName(domain.mxHostname ?? `mail.${domain.domainName}`),
    isEnabled: domain.isEnabled !== false,
    isDefault: domain.isDefault === true,
    publicCreationEnabled: domain.publicCreationEnabled !== false
  };
  if (payload.displayName && (payload.displayName.length > 120 || /[\u0000-\u001f]/.test(payload.displayName))) throw new ValidationError('Invalid displayName.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (payload.isDefault) await client.query('UPDATE domains SET is_default = false WHERE is_default = true');
    const created = await createDomain(client, payload);
    await insertAudit(client, { adminId: session.admin_id, action: 'domain.create', targetType: 'domain', targetId: created.id, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), requestId, details: { domainName: created.domain_name, isDefault: created.is_default } });
    await client.query('COMMIT');
    return created;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function createBlock({ pool, session, block, sourceIp, requestId, config }) {
  validateBlock(block);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await insertBlock(client, { ...block, adminId: session.admin_id });
    await insertAudit(client, { adminId: session.admin_id, action: 'block.create', targetType: 'block', targetId: created.id, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), requestId, details: { scope: created.scope, matchType: created.match_type } });
    await client.query('COMMIT');
    return created;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function removeBlock({ pool, session, id, sourceIp, requestId, config }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!await deleteBlock(client, id)) throw new NotFoundError();
    await insertAudit(client, { adminId: session.admin_id, action: 'block.delete', targetType: 'block', targetId: id, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), requestId });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function removeMailbox({ pool, session, id, sourceIp, requestId, config }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mailbox = await deleteMailboxByAdmin(client, id);
    if (!mailbox) throw new NotFoundError();
    await insertAudit(client, { adminId: session.admin_id, action: 'mailbox.delete', targetType: 'mailbox', targetId: id, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), requestId });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function getMailboxMetadata({ pool, id }) {
  const mailbox = await findMailboxMetadata(pool, id);
  if (!mailbox) throw new NotFoundError();
  return mailbox;
}

async function getOverview({ pool, config }) {
  const [counts, cleanup, disk, ingest, settings] = await Promise.all([
    overview(pool),
    getSystemConfig(pool, 'cleanup_health'),
    diskUsage(config.storage.attachmentRoot).catch(() => null),
    ingestOverview(pool),
    getRuntimeSettings({ pool, config })
  ]);
  const completedAt = cleanup?.value_json?.completedAt;
  const cleanupFresh = completedAt && Date.now() - new Date(completedAt).getTime() <= config.cleanup.intervalSeconds * 3 * 1000;
  return {
    ...counts,
    disk_used_percent: disk?.usedPercent ?? null,
    cleanup_status: cleanupFresh ? 'ok' : 'degraded',
    scanner_status: 'available-on-delivery',
    ingest,
    maintenance_mode: settings.site.maintenanceMode
  };
}

async function getSettings({ pool, config }) { return getRuntimeSettings({ pool, config }); }

async function updateSettings({ pool, config, session, settings, sourceIp, requestId }) {
  const valid = settingsSchema(config, settings);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = await saveRuntimeSettings({ client, config, settings: valid });
    await insertAudit(client, { adminId: session.admin_id, action: 'settings.update', targetType: 'settings', targetId: null, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), requestId, details: { mailbox: saved.mailbox, email: saved.email, site: { maintenanceMode: saved.site.maintenanceMode, siteName: saved.site.siteName }, limits: saved.limits } });
    await client.query('COMMIT');
    cacheRuntimeSettings(saved);
    return saved;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function changePassword({ pool, config, session, currentPassword, newPassword, sourceIp, requestId }) {
  const admin = await findAdminByUsername(pool, session.username);
  if (!admin || !(await passwordsMatch(currentPassword, admin.password_hash))) throw new UnauthorizedError();
  validatePassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await updateAdminPassword(client, session.admin_id, await hashPassword(newPassword));
    const revoked = await deleteOtherSessions(client, session.admin_id, session.id);
    await insertAudit(client, { adminId: session.admin_id, action: 'admin.password.update', targetType: 'admin', targetId: session.admin_id, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), requestId, details: { revokedSessions: revoked } });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function revokeSession({ pool, config, session, id, sourceIp, requestId }) {
  if (id === session.id) throw new ValidationError('Use logout to end the current session.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!await deleteSessionById(client, session.admin_id, id)) throw new NotFoundError();
    await insertAudit(client, { adminId: session.admin_id, action: 'admin.session.revoke', targetType: 'admin_session', targetId: id, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), requestId });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function removeMessage({ pool, config, session, id, sourceIp, requestId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!await deleteMessageByAdmin(client, id)) throw new NotFoundError();
    await insertAudit(client, { adminId: session.admin_id, action: 'message.delete', targetType: 'message', targetId: id, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), requestId });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function expireMailbox({ pool, config, session, id, sourceIp, requestId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!await expireMailboxByAdmin(client, id)) throw new NotFoundError();
    await insertAudit(client, { adminId: session.admin_id, action: 'mailbox.expire', targetType: 'mailbox', targetId: id, sourceIpHash: pseudonymizeIp(sourceIp, config.security.ipHmacKey), requestId });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

module.exports = { login, authorizeAdmin, requireCsrf, logout, getOverview, getSettings, updateSettings, listDomains, setDomain, addDomain, listBlocks, listAbuseEvents, listIngestEvents, createBlock, removeBlock, removeMailbox, expireMailbox, getMailboxMetadata, listMailboxMetadata, listMessageMetadata, removeMessage, listAuditEvents, listSessions, changePassword, revokeSession, pagination };
