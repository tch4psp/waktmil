'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');
const { parseMessage } = require('../../src/mail/parser');

const limits = {
  maxRawMessageBytes: 1024 * 1024,
  maxTextBodyBytes: 1024 * 1024,
  maxHtmlBodyBytes: 1024 * 1024
};

test('parses plaintext without retaining raw RFC822 data', async () => {
  const result = await parseMessage(Readable.from('From: Sender <sender@example.test>\r\nTo: Target <target@example.test>\r\nSubject: Hello\r\nMessage-ID: <one@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello world'), limits);
  assert.equal(result.fromAddress, 'sender@example.test');
  assert.equal(result.subject, 'Hello');
  assert.equal(result.textBody, 'Hello world');
  assert.equal(result.htmlSanitized, null);
  assert.equal(result.rawSizeBytes > 0, true);
  assert.match(result.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result, 'raw'), false);
});

test('sanitizes hostile HTML and removes remote resources', async () => {
  const html = '<script>alert(1)</script><img src="https://tracker.example/pixel"><p onclick="alert(2)">Safe <a href="javascript:alert(3)">bad</a></p><iframe src="https://evil.example"></iframe>';
  const message = `From: sender@example.test\r\nTo: target@example.test\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;
  const result = await parseMessage(Readable.from(message), limits);
  assert.doesNotMatch(result.htmlSanitized, /script|img|onclick|javascript:|iframe|tracker\.example/i);
  assert.match(result.htmlSanitized, /Safe/);
});

test('streams attachments to the supplied handler without retaining raw RFC822 data', async () => {
  const message = 'From: sender@example.test\r\nTo: target@example.test\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nBody\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="file.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--x--';
  const attachments = [];
  const parsed = await parseMessage(Readable.from(message), limits, async (part) => {
    const chunks = [];
    for await (const chunk of part.content) chunks.push(chunk);
    attachments.push({ filename: part.filename, content: Buffer.concat(chunks).toString('utf8') });
  });
  assert.equal(parsed.textBody, 'Body');
  assert.deepEqual(attachments, [{ filename: 'file.txt', content: 'hello' }]);
});

test('rejects raw messages above the configured boundary', async () => {
  await assert.rejects(() => parseMessage(Readable.from(`From: a@example.test\r\n\r\n${'x'.repeat(1024)}`), { ...limits, maxRawMessageBytes: 100 }), { code: 'POLICY_REJECTED' });
});
