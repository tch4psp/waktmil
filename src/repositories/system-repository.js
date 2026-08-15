'use strict';

async function setSystemConfig(client, key, value) {
  await client.query(`INSERT INTO system_config (key, value_json, updated_at) VALUES ($1, $2::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now()`, [key, JSON.stringify(value)]);
}

async function getSystemConfig(pool, key) {
  const result = await pool.query('SELECT value_json, updated_at FROM system_config WHERE key = $1', [key]);
  return result.rows[0] ?? null;
}

module.exports = { setSystemConfig, getSystemConfig };
