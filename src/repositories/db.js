'use strict';

const { Pool } = require('pg');
const { DependencyUnavailableError } = require('../shared/errors');

function createPool(config, logger) {
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    password: config.database.password,
    max: config.database.poolMaxWeb,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    ssl: config.database.sslMode === 'require' ? { rejectUnauthorized: true } : false
  });
  pool.on('error', (error) => logger.error({ err: error, event: 'database_pool_error' }, 'Database pool error'));
  return pool;
}

async function checkDatabase(pool) {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new DependencyUnavailableError('Service temporarily unavailable.', { cause: error });
  }
}

async function closePool(pool) {
  await pool.end();
}

module.exports = { createPool, checkDatabase, closePool };
