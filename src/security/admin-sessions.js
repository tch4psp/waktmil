'use strict';

const crypto = require('node:crypto');

function generateSessionSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function parseCookies(header) {
  const cookies = {};
  for (const entry of String(header ?? '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    try {
      const name = decodeURIComponent(entry.slice(0, separator).trim());
      const value = decodeURIComponent(entry.slice(separator + 1).trim());
      if (name) cookies[name] = value;
    } catch {
      // Malformed client cookies must not turn an unauthenticated request into a 500.
    }
  }
  return cookies;
}

function sessionCookie(config, token) {
  const attributes = [`${config.admin.cookieName}=${encodeURIComponent(token)}`, 'Path=/api/v1/admin', 'HttpOnly', 'SameSite=Strict', `Max-Age=${config.admin.sessionIdleMinutes * 60}`];
  if (config.production) attributes.push('Secure');
  return attributes.join('; ');
}

function expiredSessionCookie(config) {
  return `${config.admin.cookieName}=; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=0${config.production ? '; Secure' : ''}`;
}

module.exports = { generateSessionSecret, hashSessionSecret, parseCookies, sessionCookie, expiredSessionCookie };
