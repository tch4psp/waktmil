'use strict';

const net = require('node:net');
const { pseudonymizeIp } = require('../security/ip-pseudonym');
const { PolicyRejectedError, ValidationError } = require('../shared/errors');

function normalizeIp(value) {
  const ip = String(value ?? '').replace(/^::ffff:/i, '');
  return net.isIP(ip) ? ip : null;
}

function ipToInteger(ip) {
  const family = net.isIP(ip);
  if (family === 4) return ip.split('.').reduce((value, part) => (value << 8n) + BigInt(part), 0n);
  if (family !== 6) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const parts = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (parts.length !== 8) return null;
  return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part || '0'}`), 0n);
}

function parseCidr(value) {
  const [address, prefixText, ...extra] = String(value).split('/');
  const ip = normalizeIp(address);
  if (!ip || extra.length || !/^\d+$/.test(prefixText ?? '')) return null;
  const family = net.isIP(ip);
  const prefix = Number(prefixText);
  const bits = family === 4 ? 32 : 128;
  if (prefix < 0 || prefix > bits) return null;
  return { ip, prefix, bits };
}

function matchesCidr(sourceIp, value) {
  const source = normalizeIp(sourceIp);
  const cidr = parseCidr(value);
  if (!source || !cidr || net.isIP(source) !== net.isIP(cidr.ip)) return false;
  const shift = BigInt(cidr.bits - cidr.prefix);
  return (ipToInteger(source) >> shift) === (ipToInteger(cidr.ip) >> shift);
}

function validateBlock(block) {
  const validScope = ['web', 'ingest', 'both'];
  const validType = ['ip_hash', 'cidr'];
  if (!validScope.includes(block.scope) || !validType.includes(block.matchType) || !/^[\w.:/=-]{1,128}$/.test(block.matchValue) || !/^[\w.-]{1,64}$/.test(block.reasonCode)) {
    throw new ValidationError('Invalid block.');
  }
  if (block.matchType === 'cidr' && !parseCidr(block.matchValue)) throw new ValidationError('Invalid CIDR block.');
}

async function isBlocked({ pool, config, scope, sourceIp }) {
  const source = normalizeIp(sourceIp);
  if (!source) return false;
  const result = await pool.query(`SELECT match_type, match_value FROM blocked_sources
    WHERE scope IN ($1, 'both') AND (expires_at IS NULL OR expires_at > now())`, [scope]);
  const sourceHash = pseudonymizeIp(source, config.security.ipHmacKey).toString('base64url');
  return result.rows.some((block) => (block.match_type === 'ip_hash' && block.match_value === sourceHash)
    || (block.match_type === 'cidr' && matchesCidr(source, block.match_value)));
}

async function rejectBlockedSource(parameters) {
  if (await isBlocked(parameters)) throw new PolicyRejectedError('Request rejected by policy.');
}

module.exports = { isBlocked, rejectBlockedSource, validateBlock, parseCidr, matchesCidr };
