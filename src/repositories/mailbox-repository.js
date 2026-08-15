'use strict';

async function insertMailbox(client, mailbox) {
  const result = await client.query(`INSERT INTO mailboxes
    (domain_id, local_part, address, access_token_hash, created_ip_hash, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, address, created_at, expires_at`, [
    mailbox.domainId,
    mailbox.localPart,
    mailbox.address,
    mailbox.accessTokenHash,
    mailbox.createdIpHash,
    mailbox.expiresAt
  ]);
  return result.rows[0];
}

async function findById(pool, id) {
  const result = await pool.query(`SELECT m.id, m.address, m.access_token_hash, m.created_at, m.expires_at,
    m.deleted_at, d.is_enabled AS domain_enabled
    FROM mailboxes m JOIN domains d ON d.id = m.domain_id WHERE m.id = $1`, [id]);
  return result.rows[0] ?? null;
}

async function markDeleted(client, id, now) {
  const result = await client.query(`UPDATE mailboxes SET deleted_at = $2
    WHERE id = $1 AND deleted_at IS NULL AND expires_at > $2 RETURNING id`, [id, now]);
  return result.rowCount === 1;
}

async function findExpiredBatch(client, now, limit) {
  const result = await client.query(`SELECT id FROM mailboxes
      WHERE deleted_at IS NOT NULL OR expires_at <= $1
      ORDER BY COALESCE(deleted_at, expires_at) ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED`, [now, limit]);
  return result.rows;
}

async function listAttachmentStorageKeys(client, mailboxIds) {
  if (mailboxIds.length === 0) return [];
  const result = await client.query(`SELECT a.storage_key FROM attachments a
    JOIN email_messages m ON m.id = a.message_id
    WHERE m.mailbox_id = ANY($1::uuid[])`, [mailboxIds]);
  return result.rows;
}

async function deleteMailboxes(client, mailboxIds) {
  if (mailboxIds.length === 0) return [];
  const result = await client.query('DELETE FROM mailboxes WHERE id = ANY($1::uuid[]) RETURNING id', [mailboxIds]);
  return result.rows;
}

async function findActiveRecipient(pool, domainName, localPart, now) {
  const result = await pool.query(`SELECT m.id, m.address, m.expires_at, m.domain_id
    FROM mailboxes m JOIN domains d ON d.id = m.domain_id
    WHERE d.domain_name = $1 AND d.is_enabled = true AND m.local_part = $2
      AND m.deleted_at IS NULL AND m.expires_at > $3 LIMIT 1`, [domainName, localPart, now]);
  return result.rows[0] ?? null;
}

module.exports = { insertMailbox, findById, markDeleted, findExpiredBatch, listAttachmentStorageKeys, deleteMailboxes, findActiveRecipient };
