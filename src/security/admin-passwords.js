'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { ValidationError } = require('../shared/errors');

const scrypt = promisify(crypto.scrypt);
const scryptParameters = { cost: 32768, blockSize: 8, parallelization: 1, keyLength: 32 };

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 1024) {
    throw new ValidationError('Password must be between 14 and 1024 characters.');
  }
}

async function hashPassword(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, scryptParameters.keyLength, {
    N: scryptParameters.cost,
    r: scryptParameters.blockSize,
    p: scryptParameters.parallelization,
    maxmem: 64 * 1024 * 1024
  });
  return ['scrypt', scryptParameters.cost, scryptParameters.blockSize, scryptParameters.parallelization, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

async function passwordsMatch(password, storedHash) {
  const [algorithm, cost, blockSize, parallelization, salt, expected] = String(storedHash).split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const expectedBuffer = Buffer.from(expected, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expectedBuffer.length, {
    N: Number(cost), r: Number(blockSize), p: Number(parallelization), maxmem: 64 * 1024 * 1024
  });
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

module.exports = { hashPassword, passwordsMatch, validatePassword, scryptParameters };
