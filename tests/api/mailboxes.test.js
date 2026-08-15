'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const supertest = require('supertest');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/observability/logger');
const { applyMigrations } = require('../../src/repositories/migrations');
const { checkDatabase } = require('../../src/repositories/db');
const { cleanupMailboxes } = require('../../src/services/cleanup-service');
const { ingestMessage } = require('../../src/services/ingestion-service');
const { findActiveRecipient } = require('../../src/repositories/mailbox-repository');
const { createApp } = require('../../src/web/app');

const enabled = process.env.TEST_POSTGRES === '1';
let pool;
let request;
let config;

test.before(async () => {
  if (!enabled) return;
  pool = new Pool({
    host: process.env.TEST_DATABASE_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_DATABASE_PORT ?? 55432),
    database: process.env.TEST_DATABASE_NAME ?? 'tempmail_test',
    user: process.env.TEST_DATABASE_USER ?? 'tempmail_test'
  });
  await applyMigrations(pool, path.join(process.cwd(), 'migrations'));
  config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_HOST: process.env.TEST_DATABASE_HOST ?? '127.0.0.1',
    DATABASE_PORT: process.env.TEST_DATABASE_PORT ?? '55432',
    DATABASE_NAME: process.env.TEST_DATABASE_NAME ?? 'tempmail_test',
    DATABASE_USER: process.env.TEST_DATABASE_USER ?? 'tempmail_test'
  });
});

test.after(async () => { if (pool) await pool.end(); });

test.beforeEach(async () => {
  if (!enabled) return;
  await pool.query('TRUNCATE domains CASCADE');
  await pool.query(`INSERT INTO domains (domain_name, mx_hostname, is_enabled, is_default)
    VALUES ('example.test', 'mail.example.test', true, true)`);
  request = supertest(createApp({ config, logger: createLogger(config), pool, database: { check: () => checkDatabase(pool) } }));
});

test('lists enabled domains and creates a hash-only protected mailbox', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const domains = await request.get('/api/v1/domains');
  assert.equal(domains.status, 200);
  assert.equal(domains.body.domains.length, 1);
  const creation = await request.post('/api/v1/mailboxes').send({});
  assert.equal(creation.status, 201);
  assert.match(creation.body.mailbox.address, /^[a-z2-7]{16}@example\.test$/);
  assert.match(creation.body.accessToken, /^[A-Za-z0-9_-]{43}$/);
  const stored = await pool.query('SELECT address, access_token_hash FROM mailboxes WHERE id = $1', [creation.body.mailbox.id]);
  assert.equal(stored.rowCount, 1);
  assert.equal(Buffer.isBuffer(stored.rows[0].access_token_hash), true);
  assert.notEqual(stored.rows[0].access_token_hash.toString('utf8'), creation.body.accessToken);
  const read = await request.get(`/api/v1/mailboxes/${creation.body.mailbox.id}`).set('Authorization', `Bearer ${creation.body.accessToken}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.mailbox.address, creation.body.mailbox.address);
});

test('rejects other mailbox tokens, expiry, and unknown request fields without an oracle', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const first = (await request.post('/api/v1/mailboxes').send({})).body;
  const second = (await request.post('/api/v1/mailboxes').send({})).body;
  const wrongToken = await request.get(`/api/v1/mailboxes/${first.mailbox.id}`).set('Authorization', `Bearer ${second.accessToken}`);
  assert.equal(wrongToken.status, 401);
  await pool.query("UPDATE mailboxes SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1", [first.mailbox.id]);
  const expired = await request.get(`/api/v1/mailboxes/${first.mailbox.id}`).set('Authorization', `Bearer ${first.accessToken}`);
  assert.equal(expired.status, 410);
  const localPart = first.mailbox.address.split('@')[0];
  assert.equal(await findActiveRecipient(pool, 'example.test', localPart, new Date()), null);
  const tokenInUrl = await request.get(`/api/v1/mailboxes/${second.mailbox.id}?accessToken=${second.accessToken}`);
  assert.equal(tokenInUrl.status, 400);
  const injection = await request.post('/api/v1/mailboxes').send({ domainId: "' OR 1=1 --" });
  assert.equal(injection.status, 400);
  const extra = await request.post('/api/v1/mailboxes').send({ localPart: 'chosen' });
  assert.equal(extra.status, 400);
});

test('marks deletions inaccessible immediately and cleanup removes expired mailboxes', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const created = (await request.post('/api/v1/mailboxes').send({})).body;
  const deletion = await request.delete(`/api/v1/mailboxes/${created.mailbox.id}`).set('Authorization', `Bearer ${created.accessToken}`);
  assert.equal(deletion.status, 204);
  const inaccessible = await request.get(`/api/v1/mailboxes/${created.mailbox.id}`).set('Authorization', `Bearer ${created.accessToken}`);
  assert.equal(inaccessible.status, 410);
  const cleanup = await cleanupMailboxes(pool, config);
  assert.equal(cleanup.skipped, false);
  assert.equal(cleanup.deleted, 1);
  const rows = await pool.query('SELECT id FROM mailboxes WHERE id = $1', [created.mailbox.id]);
  assert.equal(rows.rowCount, 0);
});

test('limits mailbox creation without unbounded server state', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  for (let index = 0; index < 5; index += 1) {
    const response = await request.post('/api/v1/mailboxes').send({});
    assert.equal(response.status, 201);
  }
  const limited = await request.post('/api/v1/mailboxes').send({});
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
});

test('persists sanitized streamed MIME content and exposes it only to the owner', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const created = (await request.post('/api/v1/mailboxes').send({})).body;
  const raw = 'From: Sender <sender@example.test>\r\nTo: Recipient <recipient@example.test>\r\nSubject: <img src=x onerror=alert(1)>\r\nMessage-ID: <test-message@example.test>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello</p><img src="https://tracker.example/pixel"><script>alert(1)</script>';
  const first = await ingestMessage({ pool, config, mailboxId: created.mailbox.id, envelopeFrom: 'bounce@example.test', stream: Readable.from(raw) });
  const duplicate = await ingestMessage({ pool, config, mailboxId: created.mailbox.id, envelopeFrom: 'bounce@example.test', stream: Readable.from(raw) });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, first.id);
  const inbox = await request.get(`/api/v1/mailboxes/${created.mailbox.id}/messages`).set('Authorization', `Bearer ${created.accessToken}`);
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.messages.length, 1);
  const message = await request.get(`/api/v1/messages/${first.id}`).set('Authorization', `Bearer ${created.accessToken}`);
  assert.equal(message.status, 200);
  assert.match(message.body.message.htmlSanitized, /Hello/);
  assert.doesNotMatch(message.body.message.htmlSanitized, /script|img|tracker\.example/i);
  assert.equal(message.body.message.attachments.length, 0);
});
