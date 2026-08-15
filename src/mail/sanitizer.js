'use strict';

const sanitizeHtml = require('sanitize-html');

const ALLOWED_TAGS = ['a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'hr', 'i', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'];
const ALLOWED_ATTRIBUTES = { a: ['href', 'title'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] };

function sanitizeEmailHtml(html) {
  return sanitizeHtml(html ?? '', {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
    allowProtocolRelative: false,
    parser: { lowerCaseTags: true, lowerCaseAttributeNames: true }
  });
}

module.exports = { sanitizeEmailHtml };
