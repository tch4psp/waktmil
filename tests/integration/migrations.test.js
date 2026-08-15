'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { applyMigrations } = require('../../src/repositories/migrations');

const enabled = process.env.TEST_POSTGRES === '1';

test('applies immutable migrations from an empty PostgreSQL database', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const pool = new Pool({
    host: process.env.TEST_DATABASE_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_DATABASE_PORT ?? 55432),
    database: process.env.TEST_DATABASE_NAME ?? 'tempmail_test',
    user: process.env.TEST_DATABASE_USER ?? 'tempmail_test'
  });
  try {
    await applyMigrations(pool, path.join(process.cwd(), 'migrations'));
    await applyMigrations(pool, path.join(process.cwd(), 'migrations'));
    const result = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    const names = result.rows.map((row) => row.tablename);
    for (const table of ['schema_migrations', 'domains', 'mailboxes', 'email_messages', 'attachments', 'admins', 'admin_sessions', 'email_ingest_replays']) {
      assert.ok(names.includes(table), `Expected ${table} table`);
    }
    const migration = await pool.query('SELECT version, checksum FROM schema_migrations WHERE version = $1', ['001']);
    assert.equal(migration.rowCount, 1);
    assert.match(migration.rows[0].checksum, /^[a-f0-9]{64}$/);
  } finally {
    await pool.end();
  }
});
