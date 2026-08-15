'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ValidationError } = require('../shared/errors');

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

function optionalString(env, name, fallback) {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function integer(env, name, fallback, min, max) {
  const raw = optionalString(env, name, String(fallback));
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(`${name} must be an integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function boolean(env, name, fallback) {
  const value = optionalString(env, name, String(fallback)).toLowerCase();
  if (value !== 'true' && value !== 'false') {
    throw new ValidationError(`${name} must be true or false.`);
  }
  return value === 'true';
}

function validateUrl(value, name, production) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`${name} must be a valid URL.`);
  }
  if (production && parsed.protocol !== 'https:') {
    throw new ValidationError(`${name} must use HTTPS in production.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function readSecret(env, name, required) {
  const directName = name.replace(/_FILE$/, '');
  if (env[name] && env[directName]) {
    throw new ValidationError(`Set only one of ${name} or ${directName}.`);
  }
  if (!env[name]) {
    if (required) {
      throw new ValidationError(`Missing required configuration: ${name}`);
    }
    return undefined;
  }
  let value;
  try {
    value = fs.readFileSync(env[name], 'utf8').trim();
  } catch {
    throw new ValidationError(`Unable to read configured secret file for ${name}.`);
  }
  if (value.length === 0) {
    throw new ValidationError(`Configured secret file for ${name} is empty.`);
  }
  return value;
}

function isProductionPlaceholder(value) {
  return /(^|\.)example\.(com|test)$/i.test(value) || value.includes('placeholder');
}

function loadConfig(env = process.env, options = {}) {
  const nodeEnv = optionalString(env, 'NODE_ENV', 'development');
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new ValidationError('NODE_ENV must be development, test, or production.');
  }
  const production = nodeEnv === 'production';
  const runtimeRole = optionalString(env, 'RUNTIME_ROLE', 'web');
  if (!['web', 'cleanup'].includes(runtimeRole)) throw new ValidationError('RUNTIME_ROLE must be web or cleanup.');
  const baseUrl = validateUrl(optionalString(env, 'APP_BASE_URL', 'http://localhost:3000'), 'APP_BASE_URL', production);

  const mailboxTtlMinutes = integer(env, 'MAILBOX_TTL_MINUTES', 60, 1, 60);
  const aliasBytes = integer(env, 'MAILBOX_ALIAS_BYTES', 10, 10, 64);
  const accessTokenBytes = integer(env, 'ACCESS_TOKEN_BYTES', 32, 32, 64);
  const ingestMaxMessageBytes = integer(env, 'EMAIL_INGEST_MAX_MESSAGE_BYTES', MAX_MESSAGE_BYTES, 1024, MAX_MESSAGE_BYTES);
  const maxAttachmentBytes = integer(env, 'MAX_ATTACHMENT_BYTES', MAX_ATTACHMENT_BYTES, 1, MAX_ATTACHMENT_BYTES);
  const maxAttachmentTotalBytes = integer(env, 'MAX_ATTACHMENTS_TOTAL_BYTES', MAX_ATTACHMENT_TOTAL_BYTES, 1, MAX_ATTACHMENT_TOTAL_BYTES);
  if (maxAttachmentTotalBytes < maxAttachmentBytes) {
    throw new ValidationError('MAX_ATTACHMENTS_TOTAL_BYTES cannot be below MAX_ATTACHMENT_BYTES.');
  }

  const config = {
    nodeEnv,
    production,
    runtimeRole,
    appBaseUrl: baseUrl,
    http: {
      host: optionalString(env, 'HTTP_HOST', '127.0.0.1'),
      port: integer(env, 'HTTP_PORT', 3000, 1, 65535),
      trustProxy: production ? 1 : false
    },
    logLevel: optionalString(env, 'LOG_LEVEL', 'info'),
    database: {
      host: optionalString(env, 'DATABASE_HOST', '127.0.0.1'),
      port: integer(env, 'DATABASE_PORT', 5432, 1, 65535),
      database: optionalString(env, 'DATABASE_NAME', 'tempmail'),
      user: optionalString(env, 'DATABASE_USER', 'tempmail_app'),
      password: readSecret(env, 'DATABASE_PASSWORD_FILE', production),
      sslMode: optionalString(env, 'DATABASE_SSL_MODE', 'disable'),
      poolMaxWeb: integer(env, 'DATABASE_POOL_MAX_WEB', 10, 1, 30)
    },
    mailbox: {
      ttlMinutes: mailboxTtlMinutes,
      aliasBytes,
      accessTokenBytes,
      creationEnabled: boolean(env, 'PUBLIC_MAILBOX_CREATION_ENABLED', true)
    },
    security: {
      ipHmacKey: readSecret(env, 'IP_HMAC_KEY_FILE', production) ?? crypto.randomBytes(32).toString('base64url')
    },
    ingest: {
      secret: optionalString(env, 'EMAIL_INGEST_SECRET', production ? '' : 'development-email-ingest-secret-which-is-at-least-32-bytes'),
      maxMessageBytes: ingestMaxMessageBytes,
      maxAgeSeconds: integer(env, 'EMAIL_INGEST_MAX_AGE_SECONDS', 300, 30, 900),
      maxFutureSkewSeconds: integer(env, 'EMAIL_INGEST_MAX_FUTURE_SKEW_SECONDS', 30, 0, 60)
    },
    limits: {
      maxTextBodyBytes: integer(env, 'MAX_TEXT_BODY_BYTES', 2 * 1024 * 1024, 1, 2 * 1024 * 1024),
      maxHtmlBodyBytes: integer(env, 'MAX_HTML_BODY_BYTES', 2 * 1024 * 1024, 1, 2 * 1024 * 1024),
      maxAttachments: integer(env, 'MAX_ATTACHMENTS_PER_MESSAGE', 5, 0, 5),
      maxAttachmentBytes,
      maxAttachmentTotalBytes,
      maxMessagesPerMailbox: integer(env, 'MAX_MESSAGES_PER_MAILBOX', 100, 1, 1000),
      maxMailboxAttachmentBytes: integer(env, 'MAX_MAILBOX_ATTACHMENT_BYTES', 100 * 1024 * 1024, 1, 1024 * 1024 * 1024)
    },
    storage: {
      attachmentRoot: path.resolve(options.cwd ?? process.cwd(), optionalString(env, 'ATTACHMENT_ROOT', './data/attachments')),
      tempRoot: path.resolve(options.cwd ?? process.cwd(), optionalString(env, 'TEMP_ROOT', './data/tmp'))
    },
    clamav: {
      host: optionalString(env, 'CLAMAV_HOST', '127.0.0.1'),
      port: integer(env, 'CLAMAV_PORT', 3310, 1, 65535),
      scanTimeoutMs: integer(env, 'CLAMAV_SCAN_TIMEOUT_MS', 30000, 1000, 120000),
      maxConcurrency: integer(env, 'CLAMAV_MAX_CONCURRENCY', 2, 1, 4)
    },
    admin: {
      cookieName: optionalString(env, 'ADMIN_SESSION_COOKIE_NAME', 'tm_admin'),
      sessionIdleMinutes: integer(env, 'ADMIN_SESSION_IDLE_MINUTES', 30, 5, 30),
      sessionAbsoluteHours: integer(env, 'ADMIN_SESSION_ABSOLUTE_HOURS', 8, 1, 8)
    },
    cleanup: {
      intervalSeconds: integer(env, 'CLEANUP_INTERVAL_SECONDS', 60, 10, 300),
      batchSize: integer(env, 'CLEANUP_BATCH_SIZE', 1000, 1, 2000)
    },
    metrics: {
      enabled: boolean(env, 'METRICS_ENABLED', true),
      host: optionalString(env, 'METRICS_HOST', '127.0.0.1'),
      port: integer(env, 'METRICS_PORT', 9464, 1, 65535)
    },
    disk: {
      enforced: nodeEnv !== 'test',
      warningPercent: integer(env, 'DISK_WARNING_PERCENT', 75, 1, 100),
      protectPercent: integer(env, 'DISK_PROTECT_PERCENT', 85, 1, 100),
      criticalPercent: integer(env, 'DISK_CRITICAL_PERCENT', 92, 1, 100)
    }
  };
  if (!(config.disk.warningPercent < config.disk.protectPercent && config.disk.protectPercent < config.disk.criticalPercent)) {
    throw new ValidationError('Disk thresholds must be ascending.');
  }
  if (production && (config.ingest.secret.length < 32 || isProductionPlaceholder(config.ingest.secret))) {
    throw new ValidationError('EMAIL_INGEST_SECRET must be a non-placeholder secret of at least 32 characters in production.');
  }
  return Object.freeze(config);
}

function ensureRuntimeDirectories(config) {
  for (const directory of [config.storage.attachmentRoot, config.storage.tempRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

module.exports = { loadConfig, ensureRuntimeDirectories };
