'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../../src/config');

test('loads bounded safe development defaults', () => {
  const config = loadConfig({ NODE_ENV: 'test' }, { cwd: process.cwd() });
  assert.equal(config.mailbox.ttlMinutes, 60);
  assert.equal(config.mailbox.aliasBytes, 10);
  assert.equal(config.ingest.maxMessageBytes, 10 * 1024 * 1024);
  assert.equal(config.limits.maxAttachments, 5);
});

test('rejects security limit drift', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', EMAIL_INGEST_MAX_MESSAGE_BYTES: '10485761' }), /EMAIL_INGEST_MAX_MESSAGE_BYTES/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', DISK_WARNING_PERCENT: '90', DISK_PROTECT_PERCENT: '85' }), /Disk thresholds/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', MAILBOX_ALIAS_BYTES: '9' }), /MAILBOX_ALIAS_BYTES/);
});

test('production requires file-based database password and a strong ingest secret', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_BASE_URL: 'https://temp.example.com' }), /DATABASE_PASSWORD_FILE/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tempmail-config-'));
  const passwordFile = path.join(directory, 'db-password');
  fs.writeFileSync(passwordFile, 'generated-test-password');
  const config = loadConfig({
    NODE_ENV: 'production',
    APP_BASE_URL: 'https://temp.example.com',
    EMAIL_INGEST_SECRET: 'a-long-enough-production-email-ingest-secret',
    DATABASE_PASSWORD_FILE: passwordFile,
    IP_HMAC_KEY_FILE: passwordFile
  });
  assert.equal(config.ingest.secret, 'a-long-enough-production-email-ingest-secret');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('production requires a non-placeholder ingest secret', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tempmail-config-'));
  const passwordFile = path.join(directory, 'db-password');
  fs.writeFileSync(passwordFile, 'generated-test-password');
  assert.throws(() => loadConfig({
    NODE_ENV: 'production', APP_BASE_URL: 'https://temp.invalid', DATABASE_PASSWORD_FILE: passwordFile, IP_HMAC_KEY_FILE: passwordFile, EMAIL_INGEST_SECRET: 'placeholder'
  }), /EMAIL_INGEST_SECRET/);
  fs.rmSync(directory, { recursive: true, force: true });
});
