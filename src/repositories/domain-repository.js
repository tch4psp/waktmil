'use strict';

async function listEnabled(pool) {
  const result = await pool.query(`SELECT id, domain_name, is_default
    FROM domains WHERE is_enabled = true ORDER BY is_default DESC, domain_name ASC`);
  return result.rows;
}

async function findEnabledById(pool, id) {
  const result = await pool.query(`SELECT id, domain_name, is_default, public_creation_enabled
    FROM domains WHERE id = $1 AND is_enabled = true`, [id]);
  return result.rows[0] ?? null;
}

async function findEnabledDefault(pool) {
  const result = await pool.query(`SELECT id, domain_name, is_default, public_creation_enabled
    FROM domains WHERE is_enabled = true AND is_default = true LIMIT 1`);
  return result.rows[0] ?? null;
}

module.exports = { listEnabled, findEnabledById, findEnabledDefault };
