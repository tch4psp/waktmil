'use strict';

const assert = require('node:assert/strict');
const { Blob } = require('node:buffer');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const supertest = require('supertest');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/observability/logger');
const { applyMigrations } = require('../../src/repositories/migrations');
const { checkDatabase } = require('../../src/repositories/db');
const { createApp } = require('../../src/web/app');
const { signEmailIngest } = require('../../src/security/email-ingest-auth');

const enabled = process.env.TEST_POSTGRES === '1';
let pool;
let request;
let config;
let worker;

function rawMessage(mailboxAddress, messageId, body = 'Hello world') {
  return `From: Sender <sender@example.test>\r\nTo: Target <${mailboxAddress}>\r\nSubject: Ingest test\r\nMessage-ID: <${messageId}@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
}

function signedHeaders(body, overrides = {}) {
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? 'abcdefghijklmnopqrstuvwxyzABCDE';
  const recipient = overrides.recipient;
  const sender = overrides.sender ?? 'sender@example.test';
  const rawSize = String(Buffer.byteLength(body));
  const bodySha256 = require('node:crypto').createHash('sha256').update(body).digest('hex');
  const signature = signEmailIngest(overrides.secret ?? config.ingest.secret, { timestamp, nonce, recipient, sender, rawSize, bodySha256 });
  return {
    'content-type': 'message/rfc822',
    'x-email-ingest-version': '1',
    'x-email-ingest-timestamp': timestamp,
    'x-email-ingest-nonce': nonce,
    'x-email-ingest-recipient': recipient,
    'x-email-ingest-sender': sender,
    'x-email-ingest-size': rawSize,
    'x-email-ingest-sha256': bodySha256,
    'x-email-ingest-signature': signature
  };
}

async function workerDeliver(raw, recipient, options = {}) {
  let rejection;
  const previousFetch = global.fetch;
  global.fetch = async (_url, requestOptions) => {
    const response = await request.post('/internal/email-ingest')
      .set(requestOptions.headers)
      .send(Buffer.from(requestOptions.body));
    return { status: response.status };
  };
  try {
    await worker.default.email({
      from: options.from ?? 'sender@example.test',
      to: recipient,
      rawSize: Buffer.byteLength(raw),
      raw: new Blob([raw]).stream(),
      setReject(reason) { rejection = reason; }
    }, {
      MAIL_DOMAIN: 'example.test',
      BACKEND_INGEST_URL: 'http://local.test/internal/email-ingest',
      EMAIL_INGEST_SECRET: config.ingest.secret,
      EMAIL_INGEST_MAX_MESSAGE_BYTES: String(config.ingest.maxMessageBytes)
    });
  } finally {
    global.fetch = previousFetch;
  }
  return rejection;
}

test.before(async () => {
  if (!enabled) return;
  worker = await import('../../workers/email-ingest/src/index.mjs');
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
    DATABASE_USER: process.env.TEST_DATABASE_USER ?? 'tempmail_test',
    CLAMAV_PORT: process.env.TEST_CLAMAV_PORT ?? '53310',
    EMAIL_INGEST_SECRET: 'test-email-ingest-secret-which-is-at-least-32-bytes'
  });
  request = supertest(createApp({ config, logger: createLogger(config), pool, database: { check: () => checkDatabase(pool) } }));
});

test.after(async () => { if (pool) await pool.end(); });

test.beforeEach(async () => {
  if (!enabled) return;
  await pool.query('TRUNCATE domains CASCADE');
  await pool.query('TRUNCATE email_ingest_replays');
  await pool.query(`INSERT INTO domains (domain_name, mx_hostname, is_enabled, is_default)
    VALUES ('example.test', 'cloudflare-email-routing', true, true)`);
});

test('Cloudflare Worker delivers raw mail through signed Express ingestion and deduplicates retries', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const created = (await request.post('/api/v1/mailboxes').send({})).body;
  const raw = rawMessage(created.mailbox.address, 'worker-delivery');
  assert.equal(await workerDeliver(raw, created.mailbox.address), undefined);
  assert.equal(await workerDeliver(raw, created.mailbox.address), undefined);
  const inbox = await request.get(`/api/v1/mailboxes/${created.mailbox.id}/messages`).set('Authorization', `Bearer ${created.accessToken}`);
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.messages.length, 1);
});

test('ingest records a nonce once and rejects forged or expired authentication', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const created = (await request.post('/api/v1/mailboxes').send({})).body;
  const raw = rawMessage(created.mailbox.address, 'worker-security');
  const validHeaders = signedHeaders(raw, { recipient: created.mailbox.address });
  assert.equal((await request.post('/internal/email-ingest').set(validHeaders).send(raw)).status, 202);
  assert.equal((await request.post('/internal/email-ingest').set(validHeaders).send(raw)).status, 409);
  assert.equal((await request.post('/internal/email-ingest').set(signedHeaders(raw, { recipient: created.mailbox.address, nonce: 'abcdefghijklmnopqrstuvwxyzABCDF', secret: 'wrong-email-ingest-secret-which-is-at-least-32-bytes' })).send(raw)).status, 401);
  assert.equal((await request.post('/internal/email-ingest').set(signedHeaders(raw, { recipient: created.mailbox.address, nonce: 'abcdefghijklmnopqrstuvwxyzABCDG', timestamp: String(Math.floor(Date.now() / 1000) - 301) })).send(raw)).status, 401);
});

test('Worker rejects unavailable mailboxes and oversized messages before storing mail', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const created = (await request.post('/api/v1/mailboxes').send({})).body;
  const raw = rawMessage(created.mailbox.address, 'worker-unavailable');
  assert.equal(await workerDeliver(rawMessage('unknown@example.test', 'unknown'), 'unknown@example.test'), 'Message rejected by receiver policy.');
  await pool.query("UPDATE mailboxes SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1", [created.mailbox.id]);
  assert.equal(await workerDeliver(raw, created.mailbox.address), 'Message rejected by receiver policy.');
  const oversized = { from: 'sender@example.test', to: created.mailbox.address, rawSize: config.ingest.maxMessageBytes + 1, raw: new Blob(['x']).stream(), setReject(reason) { oversized.reason = reason; } };
  await worker.default.email(oversized, { MAIL_DOMAIN: 'example.test', BACKEND_INGEST_URL: 'http://local.test', EMAIL_INGEST_SECRET: config.ingest.secret });
  assert.equal(oversized.reason, 'Message exceeds receiver policy.');
});

test('signed ingestion commits concurrent messages to one active mailbox', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const created = (await request.post('/api/v1/mailboxes').send({})).body;
  const first = rawMessage(created.mailbox.address, 'worker-concurrent-one', 'First concurrent delivery');
  const second = rawMessage(created.mailbox.address, 'worker-concurrent-two', 'Second concurrent delivery');
  const deliveries = await Promise.all([
    request.post('/internal/email-ingest').set(signedHeaders(first, { recipient: created.mailbox.address, nonce: 'abcdefghijklmnopqrstuvwxyzABCDH' })).send(first),
    request.post('/internal/email-ingest').set(signedHeaders(second, { recipient: created.mailbox.address, nonce: 'abcdefghijklmnopqrstuvwxyzABCDI' })).send(second)
  ]);
  assert.deepEqual(deliveries.map((delivery) => delivery.status), [202, 202]);
  const inbox = await request.get(`/api/v1/mailboxes/${created.mailbox.id}/messages`).set('Authorization', `Bearer ${created.accessToken}`);
  assert.equal(inbox.body.messages.length, 2);
});

test('Worker fails its invocation when the backend is unavailable', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const raw = rawMessage('target@example.test', 'worker-backend-unavailable');
  const message = {
    from: 'sender@example.test',
    to: 'target@example.test',
    rawSize: Buffer.byteLength(raw),
    raw: new Blob([raw]).stream(),
    setReject() { throw new Error('The backend failure must not be converted into a permanent rejection.'); }
  };
  const previousFetch = global.fetch;
  global.fetch = async () => ({ status: 503 });
  try {
    await assert.rejects(() => worker.default.email(message, {
      MAIL_DOMAIN: 'example.test',
      BACKEND_INGEST_URL: 'http://local.test/internal/email-ingest',
      EMAIL_INGEST_SECRET: config.ingest.secret
    }), /Secure email ingestion failed/);
  } finally {
    global.fetch = previousFetch;
  }
});
