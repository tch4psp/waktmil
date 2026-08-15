'use strict';

async function findAdminByUsername(pool, username) {
  const result = await pool.query('SELECT id, username, password_hash, is_enabled FROM admins WHERE username = $1', [username]);
  return result.rows[0] ?? null;
}

async function insertSession(client, session) {
  await client.query(`INSERT INTO admin_sessions (admin_id, session_token_hash, csrf_secret_hash, expires_at, absolute_expires_at, ip_hash, user_agent_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [session.adminId, session.tokenHash, session.csrfHash, session.expiresAt, session.absoluteExpiresAt, session.ipHash, session.userAgentHash]);
}

async function findSession(pool, tokenHash, now) {
  const result = await pool.query(`SELECT s.id, s.admin_id, s.csrf_secret_hash, s.absolute_expires_at, a.username
    FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.session_token_hash = $1 AND s.expires_at > $2 AND s.absolute_expires_at > $2 AND a.is_enabled = true`, [tokenHash, now]);
  return result.rows[0] ?? null;
}

async function touchSession(client, sessionId, expiresAt) {
  await client.query('UPDATE admin_sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1', [sessionId, expiresAt]);
}

async function deleteSession(client, tokenHash) {
  await client.query('DELETE FROM admin_sessions WHERE session_token_hash = $1', [tokenHash]);
}

async function deleteSessionById(client, adminId, sessionId) {
  const result = await client.query('DELETE FROM admin_sessions WHERE id = $1 AND admin_id = $2 RETURNING id', [sessionId, adminId]);
  return result.rows[0] ?? null;
}

async function deleteOtherSessions(client, adminId, sessionId) {
  const result = await client.query('DELETE FROM admin_sessions WHERE admin_id = $1 AND id <> $2 RETURNING id', [adminId, sessionId]);
  return result.rowCount;
}

async function listSessions(pool, adminId) {
  const result = await pool.query(`SELECT id, created_at, last_seen_at, expires_at, absolute_expires_at,
    encode(ip_hash, 'hex') AS ip_hash_prefix
    FROM admin_sessions WHERE admin_id = $1 AND expires_at > now() AND absolute_expires_at > now()
    ORDER BY last_seen_at DESC`, [adminId]);
  return result.rows.map((row) => ({ ...row, ip_hash_prefix: row.ip_hash_prefix ? row.ip_hash_prefix.slice(0, 12) : null }));
}

async function updateAdminPassword(client, adminId, passwordHash) {
  await client.query('UPDATE admins SET password_hash = $2, password_changed_at = now() WHERE id = $1', [adminId, passwordHash]);
}

async function overview(pool) {
  const result = await pool.query(`SELECT
    (SELECT count(*) FROM mailboxes WHERE deleted_at IS NULL AND expires_at > now())::integer AS active_mailboxes,
    (SELECT count(*) FROM email_messages WHERE received_at > now() - interval '1 hour' AND deleted_at IS NULL)::integer AS recent_messages,
    (SELECT count(*) FROM domains WHERE is_enabled)::integer AS enabled_domains,
    (SELECT count(*) FROM abuse_events WHERE severity IN ('high', 'critical') AND created_at > now() - interval '1 hour')::integer AS high_abuse_events`);
  return result.rows[0];
}

async function listDomains(pool) {
  const result = await pool.query(`SELECT d.id, d.domain_name, d.display_name, d.mx_hostname, d.is_enabled, d.is_default, d.public_creation_enabled, d.updated_at,
    (SELECT count(*) FROM mailboxes m WHERE m.domain_id = d.id AND m.deleted_at IS NULL AND m.expires_at > now())::integer AS active_mailboxes,
    (SELECT count(*) FROM email_messages e JOIN mailboxes m ON m.id = e.mailbox_id WHERE m.domain_id = d.id AND e.deleted_at IS NULL AND e.received_at > now() - interval '24 hours')::integer AS messages_last_24h
    FROM domains d ORDER BY d.is_default DESC, d.domain_name`);
  return result.rows;
}

async function updateDomain(client, id, updates) {
  const result = await client.query(`UPDATE domains SET
    is_enabled = COALESCE($2, is_enabled),
    is_default = COALESCE($3, is_default),
    display_name = COALESCE($4, display_name),
    public_creation_enabled = COALESCE($5, public_creation_enabled),
    disabled_at = CASE WHEN COALESCE($2, is_enabled) THEN NULL ELSE now() END,
    updated_at = now()
    WHERE id = $1 RETURNING id, domain_name, display_name, mx_hostname, is_enabled, is_default, public_creation_enabled`, [id, updates.isEnabled, updates.isDefault, updates.displayName, updates.publicCreationEnabled]);
  return result.rows[0] ?? null;
}

async function createDomain(client, domain) {
  const result = await client.query(`INSERT INTO domains (domain_name, display_name, mx_hostname, is_enabled, is_default, public_creation_enabled)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, domain_name, display_name, mx_hostname, is_enabled, is_default, public_creation_enabled`,
  [domain.domainName, domain.displayName, domain.mxHostname, domain.isEnabled, domain.isDefault, domain.publicCreationEnabled]);
  return result.rows[0];
}

async function listBlocks(pool, limit) {
  const result = await pool.query(`SELECT id, scope, match_type, match_value, reason_code, created_at, expires_at
    FROM blocked_sources WHERE expires_at IS NULL OR expires_at > now() ORDER BY created_at DESC LIMIT $1`, [limit]);
  return result.rows;
}

async function insertBlock(client, block) {
  const result = await client.query(`INSERT INTO blocked_sources (scope, match_type, match_value, reason_code, expires_at, created_by_admin_id)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, scope, match_type, match_value, reason_code, created_at, expires_at`, [block.scope, block.matchType, block.matchValue, block.reasonCode, block.expiresAt, block.adminId]);
  return result.rows[0];
}

async function deleteBlock(client, id) {
  const result = await client.query('DELETE FROM blocked_sources WHERE id = $1 RETURNING id', [id]);
  return result.rows[0] ?? null;
}

async function listAbuseEvents(pool, limit) {
  const result = await pool.query(`SELECT event_type, severity, created_at, expires_at, details_json
    FROM abuse_events ORDER BY created_at DESC LIMIT $1`, [limit]);
  return result.rows;
}

async function listIngestEvents(pool, { limit, before }) {
  const result = await pool.query(`SELECT outcome, reason_code, duration_ms, created_at,
    (SELECT domain_name FROM domains WHERE id = e.domain_id) AS domain_name
    FROM email_ingest_events e
    WHERE ($2::timestamptz IS NULL OR created_at < $2)
    ORDER BY created_at DESC LIMIT $1`, [limit, before]);
  return result.rows;
}

async function ingestOverview(pool) {
  const result = await pool.query(`SELECT
    count(*) FILTER (WHERE outcome = 'accepted' AND created_at > now() - interval '24 hours')::integer AS accepted_24h,
    count(*) FILTER (WHERE outcome IN ('rejected', 'unauthorized', 'error') AND created_at > now() - interval '24 hours')::integer AS rejected_24h,
    max(created_at) FILTER (WHERE outcome IN ('accepted', 'duplicate')) AS last_success_at,
    max(created_at) FILTER (WHERE outcome IN ('rejected', 'unauthorized', 'error')) AS last_failure_at,
    avg(duration_ms) FILTER (WHERE outcome = 'accepted' AND created_at > now() - interval '24 hours')::integer AS average_duration_ms
    FROM email_ingest_events`);
  return result.rows[0];
}

async function insertIngestEvent(pool, event) {
  await pool.query(`INSERT INTO email_ingest_events (outcome, reason_code, mailbox_id, domain_id, duration_ms)
    VALUES ($1,$2,$3,$4,$5)`, [event.outcome, event.reasonCode, event.mailboxId ?? null, event.domainId ?? null, event.durationMs ?? null]);
}

async function deleteMailboxByAdmin(client, id) {
  const result = await client.query('UPDATE mailboxes SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id, address', [id]);
  return result.rows[0] ?? null;
}

async function findMailboxMetadata(pool, id) {
  const result = await pool.query(`SELECT m.id, m.address, m.created_at, m.expires_at, m.deleted_at,
    (SELECT count(*) FROM email_messages e WHERE e.mailbox_id = m.id AND e.deleted_at IS NULL)::integer AS message_count
    FROM mailboxes m WHERE m.id = $1`, [id]);
  return result.rows[0] ?? null;
}

async function listMailboxMetadata(pool, { query, limit, offset }) {
  const result = await pool.query(`SELECT m.id, m.address, m.created_at, m.expires_at, m.deleted_at, d.domain_name,
    (SELECT count(*) FROM email_messages e WHERE e.mailbox_id = m.id AND e.deleted_at IS NULL)::integer AS message_count
    FROM mailboxes m JOIN domains d ON d.id = m.domain_id
    WHERE ($1 = '' OR m.address ILIKE '%' || $1 || '%')
    ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`, [query, limit, offset]);
  return result.rows;
}

async function listMessageMetadata(pool, { query, limit, offset }) {
  const result = await pool.query(`SELECT e.id, e.mailbox_id, m.address AS mailbox_address, e.from_address, e.subject, e.received_at, e.expires_at, e.deleted_at, e.attachment_count, e.raw_size_bytes
    FROM email_messages e JOIN mailboxes m ON m.id = e.mailbox_id
    WHERE ($1 = '' OR m.address ILIKE '%' || $1 || '%' OR e.subject ILIKE '%' || $1 || '%')
    ORDER BY e.received_at DESC LIMIT $2 OFFSET $3`, [query, limit, offset]);
  return result.rows;
}

async function deleteMessageByAdmin(client, id) {
  const result = await client.query('UPDATE email_messages SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id, mailbox_id', [id]);
  return result.rows[0] ?? null;
}

async function expireMailboxByAdmin(client, id) {
  const result = await client.query('UPDATE mailboxes SET expires_at = now(), deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id, address', [id]);
  return result.rows[0] ?? null;
}

async function listAuditEvents(pool, { action, limit, offset }) {
  const result = await pool.query(`SELECT e.id, e.action, e.target_type, e.target_id, e.request_id, e.details_json, e.created_at, a.username
    FROM admin_audit_events e LEFT JOIN admins a ON a.id = e.admin_id
    WHERE ($1 = '' OR e.action = $1) ORDER BY e.created_at DESC LIMIT $2 OFFSET $3`, [action, limit, offset]);
  return result.rows;
}

async function insertAudit(client, event) {
  await client.query(`INSERT INTO admin_audit_events (admin_id, action, target_type, target_id, source_ip_hash, request_id, details_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [event.adminId, event.action, event.targetType, event.targetId, event.sourceIpHash, event.requestId, JSON.stringify(event.details ?? {})]);
}

module.exports = { findAdminByUsername, insertSession, findSession, touchSession, deleteSession, deleteSessionById, deleteOtherSessions, listSessions, updateAdminPassword, overview, listDomains, updateDomain, createDomain, listBlocks, insertBlock, deleteBlock, listAbuseEvents, listIngestEvents, ingestOverview, insertIngestEvent, deleteMailboxByAdmin, findMailboxMetadata, listMailboxMetadata, listMessageMetadata, deleteMessageByAdmin, expireMailboxByAdmin, listAuditEvents, insertAudit };
