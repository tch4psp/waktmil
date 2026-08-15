'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sanitizeLogValue } = require('../../src/observability/logger');

test('redacts secrets and message content and removes log injection characters', () => {
  const result = sanitizeLogValue({
    authorization: 'Bearer secret',
    accessToken: 'mailbox-token',
    htmlBody: '<script>alert(1)</script>',
    subject: 'hello\r\nforged-entry'
  });
  assert.equal(result.authorization, '[REDACTED]');
  assert.equal(result.accessToken, '[REDACTED]');
  assert.equal(result.htmlBody, '[REDACTED]');
  assert.equal(result.subject, 'hello  forged-entry');
});
