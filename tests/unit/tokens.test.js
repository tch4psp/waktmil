'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { generateMailboxAlias, generateAccessToken, hashToken, tokensMatch } = require('../../src/security/tokens');

test('mailbox aliases use lowercase Base32 with at least 80 bits of source entropy', () => {
  const aliases = new Set(Array.from({ length: 500 }, () => generateMailboxAlias(10)));
  assert.equal(aliases.size, 500);
  for (const alias of aliases) assert.match(alias, /^[a-z2-7]{16}$/);
});

test('access tokens are independent 32-byte secrets and only compare as hashes', () => {
  const first = generateAccessToken(32);
  const second = generateAccessToken(32);
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(tokensMatch(hashToken(first), hashToken(first)), true);
  assert.equal(tokensMatch(hashToken(first), hashToken(second)), false);
});
