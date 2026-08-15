'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { Pool } = require('pg');
const supertest = require('supertest');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/observability/logger');
const { checkDatabase } = require('../../src/repositories/db');
const { applyMigrations } = require('../../src/repositories/migrations');
const { cleanupMailboxes } = require('../../src/services/cleanup-service');
const { ingestMessage } = require('../../src/services/ingestion-service');
const { createApp } = require('../../src/web/app');

const enabled = process.env.TEST_POSTGRES === '1';
let pool;
let request;
let config;
let dataRoot;

function attachmentMessage({ filename = 'note.txt', content = 'hello', extraAttachment = false }) {
  const second = extraAttachment ? `\r\n--boundary\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="second.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('second').toString('base64')}\r\n` : '';
  return `From: Sender <sender@example.test>\r\nTo: Target <target@example.test>\r\nSubject: Attachment\r\nMessage-ID: <attachment@example.test>\r\nContent-Type: multipart/mixed; boundary="boundary"\r\n\r\n--boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody\r\n--boundary\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(content).toString('base64')}${second}\r\n--boundary--`;
}

async function cleanScanner(stream) {
  for await (const chunk of stream) void chunk;
  return { status: 'clean', signature: null };
}

async function createMailbox() {
  return (await request.post('/api/v1/mailboxes').send({})).body;
}

test.before(async () => {
  if (!enabled) return;
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tempmail-attachments-'));
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
    ATTACHMENT_ROOT: path.join(dataRoot, 'attachments'),
    TEMP_ROOT: path.join(dataRoot, 'tmp')
  });
});

test.after(async () => {
  if (pool) await pool.end();
  if (dataRoot) await fs.rm(dataRoot, { recursive: true, force: true });
});

test.beforeEach(async () => {
  if (!enabled) return;
  await pool.query('TRUNCATE domains CASCADE');
  await pool.query(`INSERT INTO domains (domain_name, mx_hostname, is_enabled, is_default)
    VALUES ('example.test', 'mail.example.test', true, true)`);
  request = supertest(createApp({ config, logger: createLogger(config), pool, database: { check: () => checkDatabase(pool) } }));
});

test('stores clean attachments outside the web root and downloads only for the owner', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const owner = await createMailbox();
  const other = await createMailbox();
  const result = await ingestMessage({
    pool,
    config,
    mailboxId: owner.mailbox.id,
    envelopeFrom: 'bounce@example.test',
    stream: Readable.from(attachmentMessage({ filename: '../../evil\r\n.txt' })),
    attachmentScanner: cleanScanner
  });
  const attachment = (await pool.query('SELECT id, storage_key, original_filename FROM attachments')).rows[0];
  assert.match(attachment.storage_key, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(attachment.original_filename, /[\\/\r\n]/);
  const storedPath = path.join(config.storage.attachmentRoot, attachment.storage_key.slice(0, 2), attachment.storage_key);
  assert.equal(await fs.readFile(storedPath, 'utf8'), 'hello');
  const message = await request.get(`/api/v1/messages/${result.id}`).set('Authorization', `Bearer ${owner.accessToken}`);
  assert.equal(message.status, 200);
  assert.deepEqual(message.body.message.attachments.map((item) => item.available), [true]);
  const denied = await request.get(`/api/v1/attachments/${attachment.id}/download`).set('Authorization', `Bearer ${other.accessToken}`);
  assert.equal(denied.status, 401);
  const download = await request.get(`/api/v1/attachments/${attachment.id}/download`).set('Authorization', `Bearer ${owner.accessToken}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.match(download.headers['content-disposition'], /^attachment;/);
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.match(download.headers['cache-control'], /no-store/);
  assert.equal(download.body.toString('utf8'), 'hello');
});

test('persists infected metadata without bytes and rejects its download', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const owner = await createMailbox();
  const result = await ingestMessage({
    pool,
    config,
    mailboxId: owner.mailbox.id,
    stream: Readable.from(attachmentMessage({ filename: 'eicar.txt', content: 'EICAR' })),
    attachmentScanner: async () => ({ status: 'infected', signature: 'Eicar-Test-Signature' })
  });
  const attachment = (await pool.query('SELECT id, storage_key, scan_status FROM attachments')).rows[0];
  assert.equal(attachment.scan_status, 'infected');
  await assert.rejects(() => fs.stat(path.join(config.storage.attachmentRoot, attachment.storage_key.slice(0, 2), attachment.storage_key)), { code: 'ENOENT' });
  const message = await request.get(`/api/v1/messages/${result.id}`).set('Authorization', `Bearer ${owner.accessToken}`);
  assert.equal(message.body.message.attachments[0].available, false);
  const unavailable = await request.get(`/api/v1/attachments/${attachment.id}/download`).set('Authorization', `Bearer ${owner.accessToken}`);
  assert.equal(unavailable.status, 423);
});

test('rejects scanner failures and attachment count or size limits without accepting mail', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const owner = await createMailbox();
  await assert.rejects(() => ingestMessage({
    pool,
    config,
    mailboxId: owner.mailbox.id,
    stream: Readable.from(attachmentMessage({ content: 'scanner-outage' })),
    attachmentScanner: async () => { throw new Error('scanner unavailable'); }
  }), { code: 'DEPENDENCY_UNAVAILABLE' });
  assert.equal((await pool.query('SELECT id FROM email_messages WHERE mailbox_id = $1', [owner.mailbox.id])).rowCount, 0);
  const tinyConfig = {
    ...config,
    limits: { ...config.limits, maxAttachments: 1, maxAttachmentBytes: 4, maxAttachmentTotalBytes: 4 }
  };
  await assert.rejects(() => ingestMessage({
    pool,
    config: tinyConfig,
    mailboxId: owner.mailbox.id,
    stream: Readable.from(attachmentMessage({ content: 'hello' })),
    attachmentScanner: cleanScanner
  }), { code: 'POLICY_REJECTED' });
  await assert.rejects(() => ingestMessage({
    pool,
    config: tinyConfig,
    mailboxId: owner.mailbox.id,
    stream: Readable.from(attachmentMessage({ content: 'one', extraAttachment: true })),
    attachmentScanner: cleanScanner
  }), { code: 'POLICY_REJECTED' });
  assert.equal((await pool.query('SELECT id FROM email_messages WHERE mailbox_id = $1', [owner.mailbox.id])).rowCount, 0);
});

test('cleanup removes stored attachments before hard-deleting expired mailboxes', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const owner = await createMailbox();
  await ingestMessage({ pool, config, mailboxId: owner.mailbox.id, stream: Readable.from(attachmentMessage({ filename: 'cleanup.txt' })), attachmentScanner: cleanScanner });
  const attachment = (await pool.query('SELECT storage_key FROM attachments')).rows[0];
  const storedPath = path.join(config.storage.attachmentRoot, attachment.storage_key.slice(0, 2), attachment.storage_key);
  await pool.query('UPDATE mailboxes SET deleted_at = now() WHERE id = $1', [owner.mailbox.id]);
  const cleanup = await cleanupMailboxes(pool, config);
  assert.equal(cleanup.deleted, 1);
  await assert.rejects(() => fs.stat(storedPath), { code: 'ENOENT' });
  assert.equal((await pool.query('SELECT id FROM attachments')).rowCount, 0);
});

test('deleting one owned message revokes it immediately and cleanup removes its attachment', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const owner = await createMailbox();
  const other = await createMailbox();
  const result = await ingestMessage({ pool, config, mailboxId: owner.mailbox.id, stream: Readable.from(attachmentMessage({ filename: 'delete.txt' })), attachmentScanner: cleanScanner });
  const attachment = (await pool.query('SELECT storage_key FROM attachments WHERE message_id = $1', [result.id])).rows[0];
  const storedPath = path.join(config.storage.attachmentRoot, attachment.storage_key.slice(0, 2), attachment.storage_key);
  const denied = await request.delete(`/api/v1/messages/${result.id}`).set('Authorization', `Bearer ${other.accessToken}`);
  assert.equal(denied.status, 401);
  const deleted = await request.delete(`/api/v1/messages/${result.id}`).set('Authorization', `Bearer ${owner.accessToken}`);
  assert.equal(deleted.status, 204);
  const missing = await request.get(`/api/v1/messages/${result.id}`).set('Authorization', `Bearer ${owner.accessToken}`);
  assert.equal(missing.status, 404);
  const cleanup = await cleanupMailboxes(pool, config);
  assert.equal(cleanup.deletedMessages, 1);
  await assert.rejects(() => fs.stat(storedPath), { code: 'ENOENT' });
});
