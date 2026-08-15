'use strict';

const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/observability/logger');
const { createPool, closePool } = require('../src/repositories/db');

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

async function main() {
  const [domainName, mxHostname] = process.argv.slice(2).map((value) => value?.toLowerCase());
  if (!DOMAIN_PATTERN.test(domainName ?? '') || !DOMAIN_PATTERN.test(mxHostname ?? '')) {
    throw new Error('Usage: node scripts/seed-domain.js <domain-name> <mx-hostname>');
  }
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPool(config, logger);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE domains SET is_default = false WHERE is_default = true');
    await client.query(`INSERT INTO domains (domain_name, mx_hostname, is_enabled, is_default)
      VALUES ($1, $2, true, true)
      ON CONFLICT (domain_name) DO UPDATE SET mx_hostname = EXCLUDED.mx_hostname,
      is_enabled = true, is_default = true, disabled_at = NULL, updated_at = now()`, [domainName, mxHostname]);
    await client.query('COMMIT');
    logger.info({ event: 'domain_seeded', domain: domainName }, 'Domain seeded');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await closePool(pool);
  }
}

main().catch((error) => {
  process.stderr.write(`Domain seed failed: ${error.message}\n`);
  process.exit(1);
});
