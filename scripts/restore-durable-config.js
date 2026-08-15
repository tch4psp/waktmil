'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/observability/logger');
const { createPool, closePool } = require('../src/repositories/db');

async function main() {
  const source = process.argv[2];
  if (!source || path.extname(source).toLowerCase() !== '.json') throw new Error('Usage: node scripts/restore-durable-config.js <backup.json>');
  const config = loadConfig();
  if (config.production) throw new Error('Refuse direct production restore; use the reviewed restore runbook.');
  const backup = JSON.parse(await fs.readFile(source, 'utf8'));
  if (backup.format !== 'tempmail-durable-config-v1' || !Array.isArray(backup.domains) || !Array.isArray(backup.admins)) throw new Error('Unsupported durable backup.');
  const pool = createPool(config, createLogger(config));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const domain of backup.domains) await client.query(`INSERT INTO domains (id, domain_name, mx_hostname, is_enabled, is_default, created_at, updated_at, disabled_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET domain_name = EXCLUDED.domain_name, mx_hostname = EXCLUDED.mx_hostname, is_enabled = EXCLUDED.is_enabled, is_default = EXCLUDED.is_default, updated_at = EXCLUDED.updated_at, disabled_at = EXCLUDED.disabled_at`, [domain.id, domain.domain_name, domain.mx_hostname, domain.is_enabled, domain.is_default, domain.created_at, domain.updated_at, domain.disabled_at]);
    for (const admin of backup.admins) await client.query(`INSERT INTO admins (id, username, password_hash, is_enabled, created_at, password_changed_at, last_login_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash, is_enabled = EXCLUDED.is_enabled, password_changed_at = EXCLUDED.password_changed_at, last_login_at = EXCLUDED.last_login_at`, [admin.id, admin.username, admin.password_hash, admin.is_enabled, admin.created_at, admin.password_changed_at, admin.last_login_at]);
    for (const block of backup.blockedSources ?? []) await client.query(`INSERT INTO blocked_sources (id, scope, match_type, match_value, reason_code, created_at, expires_at, created_by_admin_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET scope = EXCLUDED.scope, match_type = EXCLUDED.match_type, match_value = EXCLUDED.match_value, reason_code = EXCLUDED.reason_code, expires_at = EXCLUDED.expires_at`, [block.id, block.scope, block.match_type, block.match_value, block.reason_code, block.created_at, block.expires_at, block.created_by_admin_id]);
    for (const item of backup.systemConfig ?? []) await client.query(`INSERT INTO system_config (key, value_json, updated_at) VALUES ($1,$2::jsonb,$3)
      ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`, [item.key, JSON.stringify(item.value_json), item.updated_at]);
    await client.query('COMMIT');
    process.stdout.write('Durable configuration restored. Temporary mail was not restored.\n');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); await closePool(pool); }
}

main().catch((error) => { process.stderr.write(`Durable restore failed: ${error.message}\n`); process.exit(1); });
