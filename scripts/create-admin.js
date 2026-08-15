'use strict';

const fs = require('node:fs');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/observability/logger');
const { createPool, closePool } = require('../src/repositories/db');
const { hashPassword } = require('../src/security/admin-passwords');

async function main() {
  const username = process.env.ADMIN_BOOTSTRAP_USERNAME;
  const passwordFile = process.env.ADMIN_BOOTSTRAP_PASSWORD_FILE;
  if (!username || !passwordFile) throw new Error('Set ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD_FILE.');
  const password = fs.readFileSync(passwordFile, 'utf8').trim();
  const config = loadConfig();
  const pool = createPool(config, createLogger(config));
  try {
    await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1,$2)', [username, await hashPassword(password)]);
  } finally { await closePool(pool); }
}

main().catch((error) => { process.stderr.write(`Admin bootstrap failed: ${error.message}\n`); process.exit(1); });
