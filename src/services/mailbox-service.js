'use strict';

const { findEnabledById, findEnabledDefault } = require('../repositories/domain-repository');
const { insertMailbox, findById, markDeleted } = require('../repositories/mailbox-repository');
const { generateMailboxAlias, generateAccessToken, hashToken, tokensMatch } = require('../security/tokens');
const { pseudonymizeIp } = require('../security/ip-pseudonym');
const { assertWritableCapacity } = require('../observability/disk');
const { DependencyUnavailableError, ExpiredError, NotFoundError, UnauthorizedError } = require('../shared/errors');

function serializeMailbox(mailbox) {
  return {
    id: mailbox.id,
    address: mailbox.address,
    createdAt: new Date(mailbox.created_at).toISOString(),
    expiresAt: new Date(mailbox.expires_at).toISOString()
  };
}

function isActive(mailbox, now) {
  return mailbox && !mailbox.deleted_at && mailbox.domain_enabled && new Date(mailbox.expires_at) > now;
}

async function chooseDomain(pool, domainId) {
  const domain = domainId ? await findEnabledById(pool, domainId) : await findEnabledDefault(pool);
  if (!domain) throw new DependencyUnavailableError('Mailbox creation is temporarily unavailable.');
  return domain;
}

async function createMailbox({ pool, config, settings, domainId, sourceIp, now = new Date() }) {
  const policy = settings?.mailbox ?? config.mailbox;
  if (!policy.creationEnabled) {
    throw new DependencyUnavailableError('Mailbox creation is temporarily unavailable.');
  }
  await assertWritableCapacity(config);
  const domain = await chooseDomain(pool, domainId);
  if (!domain.public_creation_enabled) throw new DependencyUnavailableError('Mailbox creation is temporarily unavailable.');
  const expiresAt = new Date(now.getTime() + policy.ttlMinutes * 60 * 1000);
  const accessToken = generateAccessToken(config.mailbox.accessTokenBytes);
  const accessTokenHash = hashToken(accessToken);
  const createdIpHash = pseudonymizeIp(sourceIp, config.security.ipHmacKey);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const localPart = generateMailboxAlias(config.mailbox.aliasBytes);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mailbox = await insertMailbox(client, {
        domainId: domain.id,
        localPart,
        address: `${localPart}@${domain.domain_name}`,
        accessTokenHash,
        createdIpHash,
        expiresAt
      });
      await client.query('COMMIT');
      return { mailbox: serializeMailbox(mailbox), accessToken };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code !== '23505' || attempt === 2) throw error;
    } finally {
      client.release();
    }
  }
  throw new DependencyUnavailableError('Mailbox creation is temporarily unavailable.');
}

async function authorizeMailbox(pool, mailboxId, accessToken, now = new Date()) {
  const mailbox = await findById(pool, mailboxId);
  if (!mailbox || !tokensMatch(mailbox.access_token_hash, hashToken(accessToken))) {
    throw new UnauthorizedError();
  }
  if (!isActive(mailbox, now)) {
    throw new ExpiredError();
  }
  return mailbox;
}

async function getMailbox(parameters) {
  const mailbox = await authorizeMailbox(parameters.pool, parameters.mailboxId, parameters.accessToken, parameters.now);
  return serializeMailbox(mailbox);
}

async function deleteMailbox({ pool, mailboxId, accessToken, now = new Date() }) {
  await authorizeMailbox(pool, mailboxId, accessToken, now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await markDeleted(client, mailboxId, now);
    await client.query('COMMIT');
    if (!deleted) throw new NotFoundError();
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createMailbox, authorizeMailbox, getMailbox, deleteMailbox, serializeMailbox };
