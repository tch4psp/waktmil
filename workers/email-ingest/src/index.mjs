const VERSION = '1';
const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();

function base64Url(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function canonicalPayload({ timestamp, nonce, recipient, sender, rawSize, bodySha256 }) {
  return [VERSION, timestamp, nonce, recipient, sender, rawSize, bodySha256].join('\n');
}

async function hmacSignature(secret, fields) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalPayload(fields)))));
}

function normalizeAddress(value, allowEmpty = false) {
  if (allowEmpty && value === '') return '';
  if (typeof value !== 'string' || value.length > 320 || /[\s<>\0]/.test(value)) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1 || value.indexOf('@') !== at) return null;
  return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
}

function configuredLimit(env) {
  const value = Number(env.EMAIL_INGEST_MAX_MESSAGE_BYTES ?? DEFAULT_MAX_MESSAGE_BYTES);
  return Number.isSafeInteger(value) && value >= 1024 && value <= DEFAULT_MAX_MESSAGE_BYTES ? value : DEFAULT_MAX_MESSAGE_BYTES;
}

function reject(message, reason) {
  message.setReject(reason);
}

async function withTimeout(url, options, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async email(message, env) {
    const recipient = normalizeAddress(message.to);
    const sender = normalizeAddress(message.from, true);
    const configuredDomain = typeof env.MAIL_DOMAIN === 'string' ? env.MAIL_DOMAIN.toLowerCase() : '';
    const maxMessageBytes = configuredLimit(env);
    if (!recipient || sender === null || !configuredDomain || !recipient.endsWith(`@${configuredDomain}`)) {
      reject(message, 'Recipient is unavailable.');
      return;
    }
    if (!env.BACKEND_INGEST_URL || !env.EMAIL_INGEST_SECRET || message.rawSize > maxMessageBytes) {
      reject(message, 'Message exceeds receiver policy.');
      return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    if (raw.byteLength !== message.rawSize || raw.byteLength > maxMessageBytes) {
      reject(message, 'Message exceeds receiver policy.');
      return;
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonceBytes = crypto.getRandomValues(new Uint8Array(24));
    const nonce = base64Url(nonceBytes);
    const bodySha256 = hex(await crypto.subtle.digest('SHA-256', raw));
    const fields = { timestamp, nonce, recipient, sender, rawSize: String(raw.byteLength), bodySha256 };
    const signature = await hmacSignature(env.EMAIL_INGEST_SECRET, fields);
    let response;
    try {
      response = await withTimeout(env.BACKEND_INGEST_URL, {
        method: 'POST',
        headers: {
          'content-type': 'message/rfc822',
          'x-email-ingest-version': VERSION,
          'x-email-ingest-timestamp': timestamp,
          'x-email-ingest-nonce': nonce,
          'x-email-ingest-recipient': recipient,
          'x-email-ingest-sender': sender,
          'x-email-ingest-size': fields.rawSize,
          'x-email-ingest-sha256': bodySha256,
          'x-email-ingest-signature': signature
        },
        body: raw
      });
    } catch {
      throw new Error('Secure email ingestion is unavailable.');
    }
    if (response.status === 200 || response.status === 202 || response.status === 409) return;
    if (response.status === 413 || response.status === 422) {
      reject(message, 'Message rejected by receiver policy.');
      return;
    }
    throw new Error('Secure email ingestion failed.');
  }
};

export { canonicalPayload, hmacSignature, normalizeAddress };
