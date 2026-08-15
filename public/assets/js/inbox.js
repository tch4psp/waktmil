(function registerInbox(global) {
  'use strict';

  function senderLabel(message) {
    return message.from?.name || message.from?.address || 'Unknown sender';
  }

  function formatTime(isoDate) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }).format(new Date(isoDate));
  }

  function render(list, messages, selectedId, onSelect) {
    list.replaceChildren();
    for (const message of messages) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const subject = document.createElement('span');
      const meta = document.createElement('span');
      const sender = document.createElement('span');
      const time = document.createElement('time');
      button.type = 'button';
      button.className = 'message-row';
      button.setAttribute('aria-current', String(message.id === selectedId));
      button.addEventListener('click', () => onSelect(message.id));
      subject.className = 'message-row-subject';
      subject.textContent = message.subject || '(No subject)';
      meta.className = 'message-row-meta';
      sender.textContent = senderLabel(message);
      time.dateTime = message.receivedAt;
      time.textContent = formatTime(message.receivedAt);
      meta.append(sender, time);
      if (message.attachmentCount > 0) {
        const attachment = document.createElement('span');
        attachment.textContent = `${message.attachmentCount} attachment${message.attachmentCount === 1 ? '' : 's'}`;
        meta.append(attachment);
      }
      button.append(subject, meta);
      item.append(button);
      list.append(item);
    }
  }

  global.TemporaryMailInbox = { render };
}(window));
