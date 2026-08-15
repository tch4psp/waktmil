'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const supertest = require('supertest');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/observability/logger');
const { checkDatabase } = require('../../src/repositories/db');
const { applyMigrations } = require('../../src/repositories/migrations');
const { hashPassword } = require('../../src/security/admin-passwords');
const { createMailbox } = require('../../src/services/mailbox-service');
const { createApp } = require('../../src/web/app');
const { clearRuntimeSettingsCache } = require('../../src/services/runtime-settings-service');

const enabled = process.env.TEST_POSTGRES === '1';
let pool;
let request;
let config;
const password = 'correct-horse-battery-staple';

test.before(async () => {
  if (!enabled) return;
  pool = new Pool({ host: process.env.TEST_DATABASE_HOST ?? '127.0.0.1', port: Number(process.env.TEST_DATABASE_PORT ?? 55432), database: process.env.TEST_DATABASE_NAME ?? 'tempmail_test', user: process.env.TEST_DATABASE_USER ?? 'tempmail_test' });
  await applyMigrations(pool, path.join(process.cwd(), 'migrations'));
  config = loadConfig({ NODE_ENV: 'test', DATABASE_HOST: process.env.TEST_DATABASE_HOST ?? '127.0.0.1', DATABASE_PORT: process.env.TEST_DATABASE_PORT ?? '55432', DATABASE_NAME: process.env.TEST_DATABASE_NAME ?? 'tempmail_test', DATABASE_USER: process.env.TEST_DATABASE_USER ?? 'tempmail_test' });
});

test.after(async () => {
  if (!pool) return;
  await pool.query('TRUNCATE domains, admins, system_config, email_ingest_events CASCADE');
  clearRuntimeSettingsCache();
  await pool.end();
});

test.beforeEach(async () => {
  if (!enabled) return;
  clearRuntimeSettingsCache();
  await pool.query('TRUNCATE domains, admins, system_config, email_ingest_events CASCADE');
  await pool.query(`INSERT INTO domains (domain_name, mx_hostname, is_enabled, is_default) VALUES ('example.test', 'mail.example.test', true, true)`);
  await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1,$2)', ['operator', await hashPassword(password)]);
  request = supertest(createApp({ config, logger: createLogger(config), pool, database: { check: () => checkDatabase(pool) } }));
});

test('admin session requires generic login, CSRF, and records safe domain changes', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const denied = await request.get('/api/v1/admin/overview');
  assert.equal(denied.status, 401);
  const bad = await request.post('/api/v1/admin/session').send({ username: 'operator', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  const login = await request.post('/api/v1/admin/session').send({ username: 'operator', password });
  assert.equal(login.status, 201);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  assert.match(login.headers['set-cookie'][0], /SameSite=Strict/);
  assert.equal(Object.hasOwn(login.body, 'csrfToken'), true);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const overview = await request.get('/api/v1/admin/overview').set('Cookie', cookie);
  assert.equal(overview.status, 200);
  assert.equal(Object.hasOwn(overview.body.overview, 'text_body'), false);
  const domain = (await request.get('/api/v1/admin/domains').set('Cookie', cookie)).body.domains[0];
  const missingCsrf = await request.patch(`/api/v1/admin/domains/${domain.id}`).set('Cookie', cookie).send({ isEnabled: false });
  assert.equal(missingCsrf.status, 401);
  const changed = await request.patch(`/api/v1/admin/domains/${domain.id}`).set('Cookie', cookie).set('X-CSRF-Token', login.body.csrfToken).send({ isEnabled: false });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.domain.is_enabled, false);
  const audit = await pool.query("SELECT action, details_json FROM admin_audit_events WHERE action = 'domain.update'");
  assert.equal(audit.rowCount, 1);
  assert.deepEqual(audit.rows[0].details_json, { isEnabled: false });
  const logout = await request.delete('/api/v1/admin/session').set('Cookie', cookie).set('X-CSRF-Token', login.body.csrfToken);
  assert.equal(logout.status, 204);
  assert.equal((await request.get('/api/v1/admin/overview').set('Cookie', cookie)).status, 401);
});

test('admin login throttles repeated failures without account disclosure', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await request.post('/api/v1/admin/session').send({ username: 'missing', password: 'wrong-password' })).status, 401);
  }
  const limited = await request.post('/api/v1/admin/session').send({ username: 'missing', password: 'wrong-password' });
  assert.equal(limited.status, 429);
});

test('admin blocks and deletes mailbox metadata without exposing message content', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const login = await request.post('/api/v1/admin/session').send({ username: 'operator', password });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = login.body.csrfToken;
  const created = await createMailbox({ pool, config, sourceIp: '127.0.0.1' });
  const added = await request.post('/api/v1/admin/blocks').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({ scope: 'both', matchType: 'cidr', matchValue: '203.0.113.0/24', reasonCode: 'abuse' });
  assert.equal(added.status, 201);
  assert.equal((await request.get('/api/v1/admin/blocks').set('Cookie', cookie)).body.blocks.length, 1);
  assert.equal((await request.delete(`/api/v1/admin/blocks/${added.body.block.id}`).set('Cookie', cookie).set('X-CSRF-Token', csrf)).status, 204);
  assert.equal((await request.delete(`/api/v1/admin/mailboxes/${created.mailbox.id}`).set('Cookie', cookie).set('X-CSRF-Token', csrf)).status, 204);
  const mailbox = await pool.query('SELECT deleted_at FROM mailboxes WHERE id = $1', [created.mailbox.id]);
  assert.notEqual(mailbox.rows[0].deleted_at, null);
  const audit = await pool.query('SELECT details_json::text FROM admin_audit_events ORDER BY created_at DESC');
  assert.equal(audit.rows.some((row) => /text_body|html_sanitized|access_token/i.test(row.details_json)), false);
});

test('active web CIDR blocks reject public API requests while keeping the admin route available', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const login = await request.post('/api/v1/admin/session').send({ username: 'operator', password });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = login.body.csrfToken;
  const block = await request.post('/api/v1/admin/blocks').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({ scope: 'web', matchType: 'cidr', matchValue: '127.0.0.0/24', reasonCode: 'test' });
  assert.equal(block.status, 201);
  assert.equal((await request.get('/api/v1/domains')).status, 422);
  assert.equal((await request.get('/api/v1/admin/overview').set('Cookie', cookie)).status, 200);
});

test('admin settings are typed, audited, and apply to mailbox creation without exposing mail content', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const login = await request.post('/api/v1/admin/session').send({ username: 'operator', password });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = login.body.csrfToken;
  const current = (await request.get('/api/v1/admin/settings').set('Cookie', cookie)).body.settings;
  const disabled = { ...current, mailbox: { ...current.mailbox, creationEnabled: false, ttlMinutes: 1 }, email: { ...current.email, maxMessageBytes: 4096 }, site: { ...current.site, siteName: 'Operations Test', maintenanceMode: false }, limits: { ...current.limits, mailboxCreatePerWindow: 3 } };
  const saved = await request.put('/api/v1/admin/settings').set('Cookie', cookie).set('X-CSRF-Token', csrf).send(disabled);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.mailbox.creationEnabled, false);
  assert.equal((await request.post('/api/v1/mailboxes').send({})).status, 503);
  const unknown = await request.put('/api/v1/admin/settings').set('Cookie', cookie).set('X-CSRF-Token', csrf).send({ ...disabled, extra: true });
  assert.equal(unknown.status, 400);
  const restored = { ...disabled, mailbox: { ...disabled.mailbox, creationEnabled: true } };
  assert.equal((await request.put('/api/v1/admin/settings').set('Cookie', cookie).set('X-CSRF-Token', csrf).send(restored)).status, 200);
  assert.equal((await request.post('/api/v1/mailboxes').send({})).status, 201);
  const audit = await request.get('/api/v1/admin/audit-events').set('Cookie', cookie);
  assert.equal(audit.status, 200);
  assert.equal(audit.body.events.some((event) => event.action === 'settings.update'), true);
  assert.equal(JSON.stringify(audit.body).includes('text_body'), false);
});

test('maintenance leaves admin, health, and the Cloudflare ingest boundary available', { skip: !enabled && 'Set TEST_POSTGRES=1 with compose.test.yaml running.' }, async () => {
  const login = await request.post('/api/v1/admin/session').send({ username: 'operator', password });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const settings = (await request.get('/api/v1/admin/settings').set('Cookie', cookie)).body.settings;
  settings.site.maintenanceMode = true;
  assert.equal((await request.put('/api/v1/admin/settings').set('Cookie', cookie).set('X-CSRF-Token', login.body.csrfToken).send(settings)).status, 200);
  assert.equal((await request.get('/')).status, 503);
  assert.equal((await request.get('/admin')).status, 200);
  assert.equal((await request.get('/health/live')).status, 200);
  assert.equal((await request.post('/internal/email-ingest')).status, 401);
});
