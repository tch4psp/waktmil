'use strict';

const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/observability/logger');
const { createPool, closePool } = require('../src/repositories/db');
const { applyMigrations } = require('../src/repositories/migrations');

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPool(config, logger);
  try {
    await applyMigrations(pool, path.join(process.cwd(), 'migrations'));
    logger.info({ event: 'migrations_complete' }, 'Migrations complete');
  } finally {
    await closePool(pool);
  }
}

main().catch((error) => {
  process.stderr.write(`Migration failed: ${error.message}\n`);
  process.exit(1);
});
