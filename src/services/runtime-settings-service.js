'use strict';

const { getSystemConfig, setSystemConfig } = require('../repositories/system-repository');
const { ValidationError } = require('../shared/errors');

const SETTINGS_KEY = 'admin_runtime_settings_v1';
const CACHE_MS = 5_000;
let cached = null;

function defaults(config) {
  return {
    mailbox: {
      ttlMinutes: config.mailbox.ttlMinutes,
      creationEnabled: config.mailbox.creationEnabled,
      maxMessagesPerMailbox: config.limits.maxMessagesPerMailbox
    },
    email: {
      maxMessageBytes: config.ingest.maxMessageBytes,
      attachmentsEnabled: true,
      htmlViewerEnabled: true,
      textViewerEnabled: true
    },
    site: {
      siteName: 'Dropmail',
      tagline: 'Temporary email, kept private.',
      supportEmail: '',
      footerText: '',
      faviconPath: '/favicon.ico',
      maintenanceMode: false,
      maintenanceMessage: 'Service is temporarily unavailable. Please try again shortly.'
    },
    limits: {
      mailboxCreatePerWindow: 5,
      mailboxCreateWindowSeconds: 600,
      adminLoginPerWindow: 5,
      adminLoginWindowSeconds: 900
    }
  };
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError(`${name} is outside its allowed range.`);
  return value;
}

function text(value, name, max) {
  if (typeof value !== 'string' || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidationError(`${name} is invalid.`);
  return value.trim();
}

function settingsSchema(config, candidate) {
  const fallback = defaults(config);
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const mailbox = source.mailbox && typeof source.mailbox === 'object' ? source.mailbox : {};
  const email = source.email && typeof source.email === 'object' ? source.email : {};
  const site = source.site && typeof source.site === 'object' ? source.site : {};
  const limits = source.limits && typeof source.limits === 'object' ? source.limits : {};
  const pick = (object, key, fallbackValue) => object[key] === undefined ? fallbackValue : object[key];
  const faviconPath = text(pick(site, 'faviconPath', fallback.site.faviconPath), 'site.faviconPath', 200);
  if (!/^\/assets\/[a-zA-Z0-9_./-]+$/.test(faviconPath) && faviconPath !== '/favicon.ico') throw new ValidationError('site.faviconPath must be a local public asset path.');
  const supportEmail = text(pick(site, 'supportEmail', fallback.site.supportEmail), 'site.supportEmail', 320);
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) throw new ValidationError('site.supportEmail is invalid.');
  const bool = (value, name) => {
    if (typeof value !== 'boolean') throw new ValidationError(`${name} must be boolean.`);
    return value;
  };
  return {
    mailbox: {
      ttlMinutes: integer(pick(mailbox, 'ttlMinutes', fallback.mailbox.ttlMinutes), 'mailbox.ttlMinutes', 1, config.mailbox.ttlMinutes),
      creationEnabled: bool(pick(mailbox, 'creationEnabled', fallback.mailbox.creationEnabled), 'mailbox.creationEnabled'),
      maxMessagesPerMailbox: integer(pick(mailbox, 'maxMessagesPerMailbox', fallback.mailbox.maxMessagesPerMailbox), 'mailbox.maxMessagesPerMailbox', 1, config.limits.maxMessagesPerMailbox)
    },
    email: {
      maxMessageBytes: integer(pick(email, 'maxMessageBytes', fallback.email.maxMessageBytes), 'email.maxMessageBytes', 1024, config.ingest.maxMessageBytes),
      attachmentsEnabled: bool(pick(email, 'attachmentsEnabled', fallback.email.attachmentsEnabled), 'email.attachmentsEnabled'),
      htmlViewerEnabled: bool(pick(email, 'htmlViewerEnabled', fallback.email.htmlViewerEnabled), 'email.htmlViewerEnabled'),
      textViewerEnabled: bool(pick(email, 'textViewerEnabled', fallback.email.textViewerEnabled), 'email.textViewerEnabled')
    },
    site: {
      siteName: text(pick(site, 'siteName', fallback.site.siteName), 'site.siteName', 80),
      tagline: text(pick(site, 'tagline', fallback.site.tagline), 'site.tagline', 180),
      supportEmail,
      footerText: text(pick(site, 'footerText', fallback.site.footerText), 'site.footerText', 180),
      faviconPath,
      maintenanceMode: bool(pick(site, 'maintenanceMode', fallback.site.maintenanceMode), 'site.maintenanceMode'),
      maintenanceMessage: text(pick(site, 'maintenanceMessage', fallback.site.maintenanceMessage), 'site.maintenanceMessage', 240)
    },
    limits: {
      mailboxCreatePerWindow: integer(pick(limits, 'mailboxCreatePerWindow', fallback.limits.mailboxCreatePerWindow), 'limits.mailboxCreatePerWindow', 1, 30),
      mailboxCreateWindowSeconds: integer(pick(limits, 'mailboxCreateWindowSeconds', fallback.limits.mailboxCreateWindowSeconds), 'limits.mailboxCreateWindowSeconds', 60, 3600),
      adminLoginPerWindow: integer(pick(limits, 'adminLoginPerWindow', fallback.limits.adminLoginPerWindow), 'limits.adminLoginPerWindow', 3, 10),
      adminLoginWindowSeconds: integer(pick(limits, 'adminLoginWindowSeconds', fallback.limits.adminLoginWindowSeconds), 'limits.adminLoginWindowSeconds', 60, 3600)
    }
  };
}

async function getRuntimeSettings({ pool, config, fresh = false }) {
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const stored = await getSystemConfig(pool, SETTINGS_KEY);
  const value = settingsSchema(config, stored?.value_json);
  cached = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

async function saveRuntimeSettings({ client, config, settings }) {
  const value = settingsSchema(config, settings);
  await setSystemConfig(client, SETTINGS_KEY, value);
  return value;
}

function cacheRuntimeSettings(value) {
  cached = { value, expiresAt: Date.now() + CACHE_MS };
}

function clearRuntimeSettingsCache() { cached = null; }

function publicSiteSettings(settings) {
  return { siteName: settings.site.siteName, tagline: settings.site.tagline, supportEmail: settings.site.supportEmail, footerText: settings.site.footerText, faviconPath: settings.site.faviconPath, maintenanceMode: settings.site.maintenanceMode, maintenanceMessage: settings.site.maintenanceMessage, htmlViewerEnabled: settings.email.htmlViewerEnabled, textViewerEnabled: settings.email.textViewerEnabled };
}

module.exports = { getRuntimeSettings, saveRuntimeSettings, cacheRuntimeSettings, clearRuntimeSettingsCache, settingsSchema, publicSiteSettings };
