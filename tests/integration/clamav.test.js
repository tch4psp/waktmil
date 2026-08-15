'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');
const { loadConfig } = require('../../src/config');
const { scanStream } = require('../../src/storage/clamav-client');

const enabled = process.env.TEST_CLAMAV === '1';
const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    CLAMAV_HOST: process.env.TEST_CLAMAV_HOST ?? '127.0.0.1',
    CLAMAV_PORT: process.env.TEST_CLAMAV_PORT ?? '53310',
    CLAMAV_SCAN_TIMEOUT_MS: '30000'
  });
}

test('ClamAV INSTREAM marks EICAR infected and ordinary bytes clean', { skip: !enabled && 'Set TEST_CLAMAV=1 with compose.test.yaml clamav-test running.', timeout: 60000 }, async () => {
  const config = testConfig();
  const clean = await scanStream(Readable.from('ordinary attachment'), config);
  assert.deepEqual(clean, { status: 'clean', signature: null });
  const infected = await scanStream(Readable.from(eicar), config);
  assert.equal(infected.status, 'infected');
  assert.match(infected.signature, /Eicar/i);
});
