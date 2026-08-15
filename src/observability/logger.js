'use strict';

const pino = require('pino');

const SECRET_FIELD = /authorization|cookie|token|password|secret|csrf|access[_-]?key/i;
const CONTENT_FIELD = /body|html|attachment|raw|messageContent/i;
const MAX_LOG_VALUE_LENGTH = 512;

function cleanString(value) {
  return String(value)
    .replace(/[\r\n\t\0]/g, ' ')
    .slice(0, MAX_LOG_VALUE_LENGTH);
}

function sanitizeLogValue(value, key = '') {
  if (SECRET_FIELD.test(key) || CONTENT_FIELD.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return cleanString(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeLogValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([childKey, childValue]) => [childKey, sanitizeLogValue(childValue, childKey)]));
  }
  return value;
}

function createLogger(config, destination) {
  return pino({
    level: config.logLevel,
    base: { service: 'web' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'authorization', 'cookie'],
      censor: '[REDACTED]'
    },
    formatters: {
      log(object) {
        return sanitizeLogValue(object);
      }
    }
  }, destination);
}

module.exports = { createLogger, sanitizeLogValue };
