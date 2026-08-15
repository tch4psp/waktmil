'use strict';

async function claimIngestNonce(pool, nonce, expiresAt) {
  const result = await pool.query(`INSERT INTO email_ingest_replays (nonce, expires_at)
    VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING RETURNING nonce`, [nonce, expiresAt]);
  return result.rowCount === 1;
}

async function deleteExpiredIngestNonces(client, now, limit) {
  const result = await client.query(`DELETE FROM email_ingest_replays WHERE nonce IN (
    SELECT nonce FROM email_ingest_replays WHERE expires_at <= $1 ORDER BY expires_at ASC LIMIT $2
  )`, [now, limit]);
  return result.rowCount;
}

module.exports = { claimIngestNonce, deleteExpiredIngestNonces };
