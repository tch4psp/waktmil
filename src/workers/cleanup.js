'use strict';

const { loadConfig } = require('../config');
const { createLogger } = require('../observability/logger');
const { createPool, closePool } = require('../repositories/db');
const { cleanupMailboxes } = require('../services/cleanup-service');
const { setSystemConfig } = require('../repositories/system-repository');

async function startCleanupWorker() {
  const config = loadConfig();
  const logger = createLogger({ ...config, logLevel: config.logLevel });
  const pool = createPool(config, logger);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await cleanupMailboxes(pool, config);
      logger.info({ event: 'cleanup_completed', deleted: result.deleted, skipped: result.skipped }, 'Cleanup completed');
    } catch (error) {
      const client = await pool.connect();
      try { await setSystemConfig(client, 'cleanup_health', { status: 'degraded', failedAt: new Date().toISOString() }); } finally { client.release(); }
      logger.error({ event: 'cleanup_failed', err: error }, 'Cleanup failed');
    } finally {
      running = false;
    }
  };
  await run();
  const timer = setInterval(() => void run(), config.cleanup.intervalSeconds * 1000);
  const shutdown = async () => {
    clearInterval(timer);
    await closePool(pool);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

if (require.main === module) {
  startCleanupWorker().catch((error) => {
    process.stderr.write(`Cleanup startup failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { startCleanupWorker };
