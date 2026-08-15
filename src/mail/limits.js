'use strict';

const { Transform } = require('node:stream');
const { PolicyRejectedError } = require('../shared/errors');

function createByteLimitStream(maxBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new PolicyRejectedError('Message exceeds the allowed size.'));
        return;
      }
      callback(null, chunk);
    }
  });
}

function assertBodyLimit(value, maxBytes, label) {
  if (value && Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new PolicyRejectedError(`${label} exceeds the allowed size.`);
  }
}

module.exports = { createByteLimitStream, assertBodyLimit };
