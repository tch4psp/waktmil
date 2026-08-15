'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function loadMigrationFiles(migrationsDirectory) {
  const files = (await fs.readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
  return Promise.all(files.map(async (file) => ({
    version: file.split('_')[0],
    sql: await fs.readFile(path.join(migrationsDirectory, file), 'utf8'),
    file
  })));
}

async function applyMigrations(pool, migrationsDirectory) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(748314502)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version varchar(64) PRIMARY KEY,
      checksum varchar(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existing = await client.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(existing.rows.map((row) => [row.version, row.checksum]));
    const migrations = await loadMigrationFiles(migrationsDirectory);
    for (const migration of migrations) {
      const digest = checksum(migration.sql);
      if (applied.has(migration.version)) {
        if (applied.get(migration.version) !== digest) {
          throw new Error(`Migration checksum mismatch for ${migration.file}`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [migration.version, digest]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(748314502)');
    } finally {
      client.release();
    }
  }
}

module.exports = { applyMigrations, loadMigrationFiles, checksum };
