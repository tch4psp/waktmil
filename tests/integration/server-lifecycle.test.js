'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/observability/logger');
const { createServerRuntime } = require('../../src/web/server');

test('web runtime closes HTTP listener and database pool gracefully', async () => {
  const config = loadConfig({ NODE_ENV: 'test', HTTP_PORT: '32137' });
  let ended = false;
  const pool = {
    query: async () => ({ rows: [] }),
    end: async () => { ended = true; }
  };
  const runtime = createServerRuntime({ config, logger: createLogger(config), pool });
  await runtime.listen();
  assert.ok(runtime.server.listening);
  await runtime.close();
  assert.equal(runtime.server.listening, false);
  assert.equal(ended, true);
});
