'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/observability/logger');
const { createPool, closePool } = require('../src/repositories/db');

async function main() {
  const destination = process.argv[2];
  if (!destination || path.extname(destination).toLowerCase() !== '.json') throw new Error('Usage: node scripts/export-durable-config.js <destination.json>');
  const config = loadConfig();
  const pool = createPool(config, createLogger(config));
  try {
    const [domains, admins, blocks, systemConfig, migrations] = await Promise.all([
      pool.query('SELECT id, domain_name, mx_hostname, is_enabled, is_default, created_at, updated_at, disabled_at FROM domains ORDER BY domain_name'),
      pool.query('SELECT id, username, password_hash, is_enabled, created_at, password_changed_at, last_login_at FROM admins ORDER BY username'),
      pool.query('SELECT id, scope, match_type, match_value, reason_code, created_at, expires_at, created_by_admin_id FROM blocked_sources WHERE expires_at IS NULL OR expires_at > now() ORDER BY created_at'),
      pool.query('SELECT key, value_json, updated_at FROM system_config ORDER BY key'),
      pool.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')
    ]);
    const backup = { format: 'tempmail-durable-config-v1', exportedAt: new Date().toISOString(), domains: domains.rows, admins: admins.rows, blockedSources: blocks.rows, systemConfig: systemConfig.rows, migrations: migrations.rows };
    await fs.writeFile(destination, `${JSON.stringify(backup, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    process.stdout.write(`Durable configuration exported to ${destination}. Encrypt and move it off-host.\n`);
  } finally { await closePool(pool); }
}

main().catch((error) => { process.stderr.write(`Durable export failed: ${error.message}\n`); process.exit(1); });
