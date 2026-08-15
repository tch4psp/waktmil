'use strict';

const crypto = require('node:crypto');

function pseudonymizeIp(ip, hmacKey) {
  return crypto.createHmac('sha256', hmacKey).update(String(ip)).digest();
}

module.exports = { pseudonymizeIp };
