'use strict';

const net = require('node:net');
const { DependencyUnavailableError } = require('../shared/errors');

function scanStream(stream, config) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.clamav.host, port: config.clamav.port });
    let response = '';
    let settled = false;
    const timeout = setTimeout(() => socket.destroy(new Error('ClamAV scan timed out.')), config.clamav.scanTimeoutMs);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.destroy();
      socket.destroy();
      callback(value);
    };
    const fail = (error) => {
      finish(reject, new DependencyUnavailableError('Attachment scanner is temporarily unavailable.', { cause: error }));
    };
    socket.once('error', fail);
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
    socket.once('connect', () => {
      socket.write('zINSTREAM\0');
      stream.on('data', (chunk) => {
        const size = Buffer.allocUnsafe(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      });
      stream.once('error', fail);
      stream.once('end', () => {
        socket.write(Buffer.alloc(4));
      });
    });
    socket.once('end', () => {
      if (/\bOK\0?$/.test(response)) return finish(resolve, { status: 'clean', signature: null });
      const match = /: (.+) FOUND\0?$/.exec(response);
      if (match) return finish(resolve, { status: 'infected', signature: match[1].slice(0, 512) });
      fail(new Error('Unexpected ClamAV response.'));
    });
    socket.once('close', () => {
      if (!settled) fail(new Error('ClamAV closed the scan connection.'));
    });
  });
}

function createClamavScanner(config) {
  let active = 0;
  const queued = [];
  const runNext = () => {
    if (active >= config.clamav.maxConcurrency || queued.length === 0) return;
    active += 1;
    const { stream, resolve, reject } = queued.shift();
    scanStream(stream, config).then(resolve, reject).finally(() => {
      active -= 1;
      runNext();
    });
  };
  return (stream) => new Promise((resolve, reject) => {
    queued.push({ stream, resolve, reject });
    runNext();
  });
}

module.exports = { scanStream, createClamavScanner };
