'use strict';

const crypto = require('node:crypto');
const { UnauthorizedError } = require('../shared/errors');

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function generateMailboxAlias(byteLength) {
  return encodeBase32(crypto.randomBytes(byteLength));
}

function generateAccessToken(byteLength) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function tokensMatch(expectedHash, presentedHash) {
  return Buffer.isBuffer(expectedHash) && Buffer.isBuffer(presentedHash) && expectedHash.length === presentedHash.length && crypto.timingSafeEqual(expectedHash, presentedHash);
}

function readBearerToken(header) {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{40,200}$/.test(header)) {
    throw new UnauthorizedError();
  }
  return header.slice('Bearer '.length);
}

module.exports = { generateMailboxAlias, generateAccessToken, hashToken, tokensMatch, readBearerToken };
