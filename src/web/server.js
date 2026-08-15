'use strict';

const http = require('node:http');
const { loadConfig, ensureRuntimeDirectories } = require('../config');
const { createLogger } = require('../observability/logger');
const { createPool, checkDatabase, closePool } = require('../repositories/db');
const { createApp } = require('./app');
const { createMetrics, startMetricsServer } = require('../observability/metrics');

function createServerRuntime({ config, logger, pool }) {
  const metrics = createMetrics();
  const app = createApp({ config, logger, pool, metrics, database: { check: () => checkDatabase(pool) } });
  const server = http.createServer(app);
  let metricsServer;
  return {
    app,
    server,
    listen() {
      return new Promise((resolve) => server.listen(config.http.port, config.http.host, () => {
        metricsServer = startMetricsServer(config, metrics, logger);
        resolve();
      }));
    },
    close() {
      return new Promise((resolve, reject) => {
      const closeMetrics = () => metricsServer ? new Promise((resolve) => metricsServer.close(resolve)) : Promise.resolve();
      server.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }
        closeMetrics().then(() => closePool(pool)).then(resolve, reject);
        });
      });
    }
  };
}

async function start() {
  const config = loadConfig();
  ensureRuntimeDirectories(config);
  const logger = createLogger(config);
  const pool = createPool(config, logger);
  const runtime = createServerRuntime({ config, logger, pool });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'shutdown_start', signal }, 'Shutting down');
    try {
      await runtime.close();
      logger.info({ event: 'shutdown_complete' }, 'Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ event: 'shutdown_error', err: error }, 'Shutdown failed');
      process.exit(1);
    }
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  await runtime.listen();
  logger.info({ event: 'web_started', host: config.http.host, port: config.http.port }, 'Web server started');
  return { ...runtime, pool, config };
}

if (require.main === module) {
  start().catch((error) => {
    process.stderr.write(`Startup failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { start, createServerRuntime };
