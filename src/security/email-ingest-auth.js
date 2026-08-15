'use strict';

const crypto = require('node:crypto');
const { UnauthorizedError, ValidationError } = require('../shared/errors');

const VERSION = '1';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,96}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ADDRESS_PATTERN = /^[^\s@<>]{1,64}@[^\s@<>]{1,253}$/;

function header(request, name) {
  const value = request.get(name);
  if (typeof value !== 'string' || value.length === 0 || value.length > 998 || /[\r\n\0]/.test(value)) {
    throw new UnauthorizedError();
  }
  return value;
}

function canonicalPayload({ timestamp, nonce, recipient, sender, rawSize, bodySha256 }) {
  return [VERSION, timestamp, nonce, recipient, sender, rawSize, bodySha256].join('\n');
}

function signEmailIngest(secret, fields) {
  return crypto.createHmac('sha256', secret).update(canonicalPayload(fields), 'utf8').digest('base64url');
}

function splitRecipient(value) {
  if (!ADDRESS_PATTERN.test(value)) throw new ValidationError('Invalid envelope recipient.');
  const at = value.lastIndexOf('@');
  return { localPart: value.slice(0, at), domainName: value.slice(at + 1).toLowerCase() };
}

function parseAndVerifyEmailIngest(request, config, now = Date.now()) {
  const version = header(request, 'x-email-ingest-version');
  const timestamp = header(request, 'x-email-ingest-timestamp');
  const nonce = header(request, 'x-email-ingest-nonce');
  const recipient = header(request, 'x-email-ingest-recipient');
  const sender = header(request, 'x-email-ingest-sender');
  const rawSize = header(request, 'x-email-ingest-size');
  const bodySha256 = header(request, 'x-email-ingest-sha256');
  const signature = header(request, 'x-email-ingest-signature');
  if (version !== VERSION || !/^\d{10}$/.test(timestamp) || !NONCE_PATTERN.test(nonce) || (sender !== '' && !ADDRESS_PATTERN.test(sender))
    || !/^\d{1,8}$/.test(rawSize) || !HASH_PATTERN.test(bodySha256) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    throw new UnauthorizedError();
  }
  const issuedAt = Number(timestamp) * 1000;
  const age = now - issuedAt;
  if (age > config.ingest.maxAgeSeconds * 1000 || age < -config.ingest.maxFutureSkewSeconds * 1000) throw new UnauthorizedError();
  if (!Buffer.isBuffer(request.body) || request.body.length !== Number(rawSize) || request.body.length > config.ingest.maxMessageBytes) {
    throw new ValidationError('Invalid email ingest payload.');
  }
  const actualHash = crypto.createHash('sha256').update(request.body).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(bodySha256))) throw new UnauthorizedError();
  const expected = signEmailIngest(config.ingest.secret, { timestamp, nonce, recipient, sender, rawSize, bodySha256 });
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw new UnauthorizedError();
  return { nonce, recipient, sender, mailbox: splitRecipient(recipient), expiresAt: new Date(issuedAt + config.ingest.maxAgeSeconds * 1000) };
}

module.exports = { VERSION, canonicalPayload, signEmailIngest, splitRecipient, parseAndVerifyEmailIngest };
