(function registerApi(global) {
  'use strict';

  async function parseResponse(response) {
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json') ? await response.json() : null;
    if (response.ok) return payload;
    const error = new Error(payload?.error?.message ?? 'Request failed.');
    error.status = response.status;
    error.code = payload?.error?.code ?? 'REQUEST_FAILED';
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }

  async function request(path, options = {}, accessToken) {
    const headers = new Headers(options.headers ?? {});
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    return parseResponse(response);
  }

  async function download(attachmentId, accessToken) {
    const response = await fetch(`/api/v1/attachments/${encodeURIComponent(attachmentId)}/download`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: 'same-origin'
    });
    if (!response.ok) await parseResponse(response);
    return response.blob();
  }

  global.TemporaryMailApi = {
    site: () => request('/api/v1/site'),
    listDomains: () => request('/api/v1/domains'),
    createMailbox: (domainId) => request('/api/v1/mailboxes', { method: 'POST', body: JSON.stringify(domainId ? { domainId } : {}) }),
    inbox: (mailboxId, accessToken) => request(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/messages`, {}, accessToken),
    message: (messageId, accessToken) => request(`/api/v1/messages/${encodeURIComponent(messageId)}`, {}, accessToken),
    deleteMailbox: (mailboxId, accessToken) => request(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}`, { method: 'DELETE' }, accessToken),
    deleteMessage: (messageId, accessToken) => request(`/api/v1/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' }, accessToken),
    download
  };
}(window));
