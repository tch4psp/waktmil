'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BoundedRateLimiter } = require('../../src/security/rate-limiter');

test('rate limiter rejects excess requests and remains bounded', () => {
  let now = 1000;
  const limiter = new BoundedRateLimiter({ maxKeys: 3, now: () => now });
  limiter.consume('one', { limit: 2, windowMs: 1000 });
  limiter.consume('one', { limit: 2, windowMs: 1000 });
  assert.throws(() => limiter.consume('one', { limit: 2, windowMs: 1000 }), { code: 'RATE_LIMITED' });
  limiter.consume('two', { limit: 1, windowMs: 1000 });
  limiter.consume('three', { limit: 1, windowMs: 1000 });
  limiter.consume('four', { limit: 1, windowMs: 1000 });
  assert.ok(limiter.entries.size <= 3);
  now += 1001;
  limiter.consume('five', { limit: 1, windowMs: 1000 });
  assert.equal(limiter.entries.size, 1);
});
