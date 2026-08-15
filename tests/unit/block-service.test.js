'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { matchesCidr, parseCidr, validateBlock } = require('../../src/services/block-service');

test('matches IPv4 and IPv6 CIDRs without preserving raw source addresses', () => {
  assert.equal(matchesCidr('203.0.113.42', '203.0.113.0/24'), true);
  assert.equal(matchesCidr('203.0.114.42', '203.0.113.0/24'), false);
  assert.equal(matchesCidr('2001:db8::7', '2001:db8::/32'), true);
  assert.equal(matchesCidr('2001:db9::7', '2001:db8::/32'), false);
});

test('rejects malformed CIDR input', () => {
  assert.equal(parseCidr('203.0.113.0/99'), null);
  assert.throws(() => validateBlock({ scope: 'both', matchType: 'cidr', matchValue: 'not-a-cidr', reasonCode: 'abuse' }), /CIDR/);
});
