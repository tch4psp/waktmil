'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const supertest = require('supertest');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/observability/logger');
const { createApp } = require('../../src/web/app');

function createTestApp(check) {
  const config = loadConfig({ NODE_ENV: 'test' });
  return createApp({ config, logger: createLogger(config), database: { check } });
}

test('live health does not depend on database readiness', async () => {
  const response = await supertest(createTestApp(async () => { throw new Error('db unavailable'); })).get('/health/live');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('ready health returns a safe dependency error when database fails', async () => {
  const response = await supertest(createTestApp(async () => { throw new Error('db unavailable'); })).get('/health/ready');
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(response.body.error.message, 'Service temporarily unavailable.');
  assert.ok(response.body.error.requestId);
});

test('ready health reports success after database check', async () => {
  const response = await supertest(createTestApp(async () => {})).get('/health/ready');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});
