'use strict';

const { loadConfig } = require('../src/config');

try {
  const config = loadConfig();
  process.stdout.write(`Configuration valid for ${config.nodeEnv}.\n`);
} catch (error) {
  process.stderr.write(`Configuration invalid: ${error.message}\n`);
  process.exit(1);
}
