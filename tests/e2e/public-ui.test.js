'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { chromium } = require('@playwright/test');
const { Pool } = require('pg');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/observability/logger');
const { checkDatabase } = require('../../src/repositories/db');
const { applyMigrations } = require('../../src/repositories/migrations');
const { ingestMessage } = require('../../src/services/ingestion-service');
const { createApp } = require('../../src/web/app');

const enabled = process.env.TEST_BROWSER === '1';
const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let pool;
let browser;
let server;
let baseUrl;
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
  await pool.query('TRUNCATE domains CASCADE');
  await pool.query(`INSERT INTO domains (domain_name, mx_hostname, is_enabled, is_default)
    VALUES ('example.test', 'mail.example.test', true, true)`);
  config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_HOST: process.env.TEST_DATABASE_HOST ?? '127.0.0.1',
    DATABASE_PORT: process.env.TEST_DATABASE_PORT ?? '55432',
    DATABASE_NAME: process.env.TEST_DATABASE_NAME ?? 'tempmail_test',
    DATABASE_USER: process.env.TEST_DATABASE_USER ?? 'tempmail_test'
  });
  server = http.createServer(createApp({ config, logger: createLogger(config), pool, database: { check: () => checkDatabase(pool) } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (pool) await pool.end();
});

test('public UI keeps access tokens out of the page and isolates hostile email HTML', { skip: !enabled && 'Set TEST_BROWSER=1 with PostgreSQL and local Chrome available.', timeout: 60000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Create temporary email' }).click();
    await page.locator('#mailbox-address').waitFor();
    const mailbox = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dropmail.mailbox.v1')));
    assert.equal(new URL(page.url()).search, '');
    assert.equal((await page.content()).includes(mailbox.accessToken), false);
    const raw = `From: Sender <sender@example.test>\r\nTo: Target <${mailbox.address}>\r\nSubject: <img src=x onerror=alert(1)>\r\nMessage-ID: <ui-xss@example.test>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Safe body</p><img src="https://tracker.invalid/pixel"><script>alert(1)</script><iframe src="https://tracker.invalid/frame"></iframe><form action="https://tracker.invalid/submit"><input></form>`;
    const stored = await ingestMessage({ pool, config, mailboxId: mailbox.id, stream: Readable.from(raw) });
    await page.getByRole('button', { name: 'Refresh' }).click();
    const messageRow = page.getByRole('button', { name: /<img src=x onerror=alert\(1\)>/ });
    await messageRow.click();
    await page.getByRole('tab', { name: 'HTML' }).click();
    const frame = page.locator('iframe[title="Sanitized email content"]');
    await frame.waitFor();
    assert.equal(await frame.getAttribute('sandbox'), '');
    const emailFrame = await frame.contentFrame();
    assert.match(await emailFrame.locator('body').innerText(), /Safe body/);
    assert.equal(requests.some((url) => url.includes('tracker.invalid')), false);
    assert.equal(await page.locator('#message-content').isVisible(), true);
    assert.equal(await page.locator(`#message-list button[aria-current="true"]`).count(), 1);
    assert.equal(stored.duplicate, false);
  } finally {
    await context.close();
  }
});
