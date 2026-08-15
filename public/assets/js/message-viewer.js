(function registerMessageViewer(global) {
  'use strict';

  const safeUrlPattern = /https?:\/\/[^\s<>()]+/g;

  function addMetadata(list, label, value) {
    if (!value) return;
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    list.append(term, description);
  }

  function appendPlainText(container, text) {
    let cursor = 0;
    for (const match of text.matchAll(safeUrlPattern)) {
      const url = match[0];
      container.append(document.createTextNode(text.slice(cursor, match.index)));
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          const link = document.createElement('a');
          link.href = parsed.toString();
          link.rel = 'noopener noreferrer';
          link.target = '_blank';
          link.textContent = url;
          container.append(link);
        } else {
          container.append(document.createTextNode(url));
        }
      } catch {
        container.append(document.createTextNode(url));
      }
      cursor = match.index + url.length;
    }
    container.append(document.createTextNode(text.slice(cursor)));
  }

  function displaySize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderBody(container, message, mode) {
    container.replaceChildren();
    if (mode === 'html' && message.htmlSanitized) {
      const frame = document.createElement('iframe');
      frame.className = 'email-frame';
      frame.title = 'Sanitized email content';
      frame.setAttribute('sandbox', '');
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:"></head><body>${message.htmlSanitized}</body></html>`;
      container.append(frame);
      return;
    }
    const text = document.createElement('pre');
    appendPlainText(text, message.textBody || '(This message has no plaintext body.)');
    container.append(text);
  }

  function renderAttachments(container, attachments, onDownload) {
    if (attachments.length === 0) return;
    const title = document.createElement('h3');
    const list = document.createElement('ul');
    title.textContent = 'Attachments';
    list.className = 'attachment-list';
    for (const attachment of attachments) {
      const item = document.createElement('li');
      const details = document.createElement('div');
      const filename = document.createElement('span');
      const status = document.createElement('small');
      details.className = 'attachment-details';
      filename.textContent = attachment.filename;
      status.textContent = attachment.available ? `${displaySize(attachment.sizeBytes)} - scanned` : 'Blocked after malware scan';
      details.append(filename, status);
      item.className = 'attachment-item';
      item.append(details);
      if (attachment.available) {
        const button = document.createElement('button');
        button.className = 'button button-secondary';
        button.type = 'button';
        button.textContent = 'Download';
        button.addEventListener('click', () => onDownload(attachment, button));
        item.append(button);
      }
      list.append(item);
    }
    container.append(title, list);
  }

  function render(container, message, onDownload, options = {}) {
    container.replaceChildren();
    const metadata = document.createElement('dl');
    const tabs = document.createElement('div');
    const textTab = document.createElement('button');
    const htmlTab = document.createElement('button');
    const body = document.createElement('div');
    metadata.className = 'message-meta';
    addMetadata(metadata, 'From', message.from?.name || message.from?.address);
    addMetadata(metadata, 'To', (message.to ?? []).map((recipient) => recipient.address || recipient.name).filter(Boolean).join(', '));
    addMetadata(metadata, 'Subject', message.subject || '(No subject)');
    addMetadata(metadata, 'Received', new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(message.receivedAt)));
    tabs.className = 'viewer-tabs';
    tabs.setAttribute('role', 'tablist');
    textTab.type = 'button';
    textTab.textContent = 'Text';
    textTab.setAttribute('role', 'tab');
    htmlTab.type = 'button';
    htmlTab.textContent = 'HTML';
    htmlTab.setAttribute('role', 'tab');
    textTab.disabled = options.textViewerEnabled === false;
    htmlTab.disabled = !message.htmlSanitized || options.htmlViewerEnabled === false;
    body.className = 'message-body';
    const selectMode = (mode) => {
      textTab.setAttribute('aria-selected', String(mode === 'text'));
      htmlTab.setAttribute('aria-selected', String(mode === 'html'));
      renderBody(body, message, mode);
    };
    textTab.addEventListener('click', () => selectMode('text'));
    htmlTab.addEventListener('click', () => selectMode('html'));
    tabs.append(textTab, htmlTab);
    container.className = 'message-content';
    container.append(metadata, tabs, body);
    renderAttachments(container, message.attachments, onDownload);
    if (textTab.disabled && htmlTab.disabled) {
      body.textContent = 'Message body display is temporarily disabled.';
    } else {
      selectMode(!textTab.disabled && message.textBody ? 'text' : 'html');
    }
  }

  global.TemporaryMailViewer = { render };
}(window));
