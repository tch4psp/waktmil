'use strict';

const { RateLimitError } = require('../shared/errors');

class BoundedRateLimiter {
  constructor({ maxKeys = 10000, now = () => Date.now() } = {}) {
    this.maxKeys = maxKeys;
    this.now = now;
    this.entries = new Map();
  }

  consume(key, { limit, windowMs }) {
    const currentTime = this.now();
    this.#prune(currentTime);
    const current = this.entries.get(key);
    const entry = !current || current.resetAt <= currentTime ? { count: 0, resetAt: currentTime + windowMs } : current;
    entry.count += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (entry.count > limit) {
      throw new RateLimitError(Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000)));
    }
    return { remaining: limit - entry.count, resetAt: entry.resetAt };
  }

  #prune(currentTime) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= currentTime) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxKeys) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}

module.exports = { BoundedRateLimiter };
