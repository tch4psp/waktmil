'use strict';

const fs = require('node:fs/promises');
const { DependencyUnavailableError } = require('../shared/errors');

async function diskUsage(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.statfs(directory);
  const totalBytes = Number(stats.blocks * stats.bsize);
  const availableBlocks = stats.bavail > 0 ? stats.bavail : stats.bfree;
  const freeBytes = Number(availableBlocks * stats.bsize);
  return { totalBytes, freeBytes, usedPercent: Math.round((1 - freeBytes / totalBytes) * 100) };
}

async function assertWritableCapacity(config) {
  if (!config.disk.enforced) return null;
  try {
    const usage = await diskUsage(config.storage.attachmentRoot);
    if (usage.usedPercent >= config.disk.protectPercent) throw new DependencyUnavailableError('Service temporarily unavailable.');
    return usage;
  } catch (error) {
    if (error instanceof DependencyUnavailableError) throw error;
    throw new DependencyUnavailableError('Service temporarily unavailable.', { cause: error });
  }
}

module.exports = { diskUsage, assertWritableCapacity };
