'use strict';

const { ValidationError } = require('./errors');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value, fieldName) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`${fieldName} must be a UUID.`);
  }
  return value.toLowerCase();
}

function requireKnownFields(value, allowedFields) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new ValidationError('Request body must be a JSON object.');
  }
  for (const key of Object.keys(value)) {
    if (!allowedFields.includes(key)) {
      throw new ValidationError('Request contains an unsupported field.');
    }
  }
  return value;
}

module.exports = { requireUuid, requireKnownFields };
