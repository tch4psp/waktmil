'use strict';

const { MailParser } = require('mailparser');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { createByteLimitStream, assertBodyLimit } = require('./limits');
const { sanitizeEmailHtml } = require('./sanitizer');
const { PolicyRejectedError } = require('../shared/errors');

function boundedHeader(value, maxLength = 998) {
  return typeof value === 'string' ? value.replace(/[\r\n\0]/g, ' ').slice(0, maxLength) : null;
}

function addressValue(value) {
  const item = value?.value?.[0];
  if (!item) return { address: null, name: null };
  return { address: boundedHeader(item.address, 320), name: boundedHeader(item.name, 512) };
}

function addressList(value) {
  return (value?.value ?? []).slice(0, 20).map((item) => ({ address: boundedHeader(item.address, 320), name: boundedHeader(item.name, 512) }));
}

function headerText(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return boundedHeader(value);
  if (typeof value?.text === 'string') return boundedHeader(value.text);
  if (typeof value?.value === 'string') return boundedHeader(value.value);
  return null;
}

function parseMessage(stream, limits, attachmentHandler) {
  return new Promise((resolve, reject) => {
    const parser = new MailParser({ skipImageLinks: true, maxHtmlLengthToParse: limits.maxHtmlBodyBytes });
    const limiter = createByteLimitStream(limits.maxRawMessageBytes);
    let rawSizeBytes = 0;
    const digestStream = new Transform({
      transform(chunk, _encoding, callback) {
        rawSizeBytes += chunk.length;
        callback(null, chunk);
      }
    });
    let textPart;
    let attachmentSeen = false;
    let attachmentError;
    const attachmentTasks = [];
    parser.on('data', (part) => {
      if (part.type === 'attachment') {
        attachmentSeen = true;
        if (!attachmentHandler) {
          part.content.resume();
          part.release();
          return;
        }
        attachmentTasks.push(Promise.resolve()
          .then(() => attachmentHandler(part))
          .catch((error) => { attachmentError ??= error; })
          .finally(() => part.release()));
        return;
      }
      if (part.type === 'text') textPart = part;
    });
    parser.once('error', () => reject(new PolicyRejectedError('Message cannot be parsed safely.')));
    limiter.once('error', (error) => {
      stream.destroy();
      reject(error);
    });
    parser.once('end', async () => {
      try {
        if (!textPart) throw new PolicyRejectedError('Message has no supported text body.');
        if (attachmentSeen && !attachmentHandler) throw new PolicyRejectedError('Attachments are temporarily unavailable.');
        await Promise.all(attachmentTasks);
        if (attachmentError) throw attachmentError;
        const textBody = textPart.text ? String(textPart.text) : null;
        const htmlSanitized = textPart.html ? sanitizeEmailHtml(String(textPart.html)) : null;
        assertBodyLimit(textBody, limits.maxTextBodyBytes, 'Text body');
        assertBodyLimit(htmlSanitized, limits.maxHtmlBodyBytes, 'HTML body');
        const headers = parser.headers ?? new Map();
        const from = addressValue(headers.get('from'));
        const contentSha256 = crypto.createHash('sha256').update(JSON.stringify({
          fromAddress: from.address,
          fromName: from.name,
          replyTo: addressValue(headers.get('reply-to')).address,
          to: addressList(headers.get('to')),
          cc: addressList(headers.get('cc')),
          subject: headerText(headers.get('subject')) ?? '',
          messageIdHeader: headerText(headers.get('message-id')),
          textBody,
          htmlSanitized
        })).digest('hex');
        resolve({
          fromAddress: from.address,
          fromName: from.name,
          replyTo: addressValue(headers.get('reply-to')).address,
          to: addressList(headers.get('to')),
          cc: addressList(headers.get('cc')),
          subject: headerText(headers.get('subject')) ?? '',
          messageIdHeader: headerText(headers.get('message-id')),
          sentAt: headers.get('date') instanceof Date && !Number.isNaN(headers.get('date').valueOf()) ? headers.get('date') : null,
          textBody,
          htmlSanitized,
          rawSizeBytes,
          contentSha256,
          headers: {
            from: headerText(headers.get('from')),
            to: headerText(headers.get('to')),
            cc: headerText(headers.get('cc')),
            replyTo: headerText(headers.get('reply-to')),
            subject: headerText(headers.get('subject')),
            date: headerText(headers.get('date')),
            messageId: headerText(headers.get('message-id')),
            contentType: headerText(headers.get('content-type'))
          }
        });
      } catch (error) {
        reject(error);
      }
    });
    stream.pipe(limiter).pipe(digestStream).pipe(parser);
  });
}

module.exports = { parseMessage };
