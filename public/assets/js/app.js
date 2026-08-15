(function startTemporaryMailApp() {
  'use strict';

  const storageKey = 'dropmail.mailbox.v1';
  const state = { mailbox: null, messages: [], selectedMessageId: null, pollTimer: null, countdownTimer: null, loadingInbox: false, replaceAfterDelete: false, site: { htmlViewerEnabled: true, textViewerEnabled: true } };
  const elements = {
    createPanel: document.querySelector('#create-panel'),
    createMailbox: document.querySelector('#create-mailbox'),
    createAfterExpiry: document.querySelector('#create-after-expiry'),
    domainSelect: document.querySelector('#domain-select'),
    domainLabel: document.querySelector('#domain-label'),
    mailboxPanel: document.querySelector('#mailbox-panel'),
    mailboxAddress: document.querySelector('#mailbox-address'),
    expiry: document.querySelector('#expiry-copy'),
    expiredPanel: document.querySelector('#expired-panel'),
    inboxList: document.querySelector('#message-list'),
    inboxCount: document.querySelector('#inbox-count'),
    inboxState: document.querySelector('#inbox-state'),
    messageState: document.querySelector('#message-state'),
    messageContent: document.querySelector('#message-content'),
    deleteMessage: document.querySelector('#delete-message'),
    deleteMailbox: document.querySelector('#delete-mailbox'),
    newMailbox: document.querySelector('#new-mailbox'),
    refreshInbox: document.querySelector('#refresh-inbox'),
    copyAddress: document.querySelector('#copy-address'),
    connectionStatus: document.querySelector('#connection-status'),
    announcements: document.querySelector('#announcements'),
    mailboxConfirmation: document.querySelector('#mailbox-confirmation'),
    messageConfirmation: document.querySelector('#message-confirmation'),
    confirmMailboxDelete: document.querySelector('#confirm-mailbox-delete'),
    confirmMessageDelete: document.querySelector('#confirm-message-delete')
  };

  function announce(text) {
    elements.announcements.textContent = text;
  }

  function setStatus(text) {
    elements.connectionStatus.textContent = text;
  }

  function clearTimers() {
    window.clearTimeout(state.pollTimer);
    window.clearInterval(state.countdownTimer);
    state.pollTimer = null;
    state.countdownTimer = null;
  }

  function saveMailbox(mailbox) {
    state.mailbox = mailbox;
    sessionStorage.setItem(storageKey, JSON.stringify(mailbox));
  }

  function clearMailbox() {
    clearTimers();
    state.mailbox = null;
    state.messages = [];
    state.selectedMessageId = null;
    sessionStorage.removeItem(storageKey);
  }

  function restoreMailbox() {
    try {
      const mailbox = JSON.parse(sessionStorage.getItem(storageKey));
      if (mailbox && typeof mailbox.id === 'string' && typeof mailbox.address === 'string' && typeof mailbox.expiresAt === 'string' && typeof mailbox.accessToken === 'string') return mailbox;
    } catch {}
    sessionStorage.removeItem(storageKey);
    return null;
  }

  function showCreate() {
    elements.createPanel.hidden = false;
    elements.mailboxPanel.hidden = true;
    elements.expiredPanel.hidden = true;
    elements.messageContent.hidden = true;
    elements.messageState.hidden = false;
  }

  function showExpired() {
    clearMailbox();
    elements.createPanel.hidden = true;
    elements.mailboxPanel.hidden = true;
    elements.expiredPanel.hidden = false;
    setStatus('Inbox expired');
    announce('This temporary inbox has expired.');
  }

  function formatRemaining() {
    const milliseconds = new Date(state.mailbox.expiresAt).getTime() - Date.now();
    if (milliseconds <= 0) {
      showExpired();
      return;
    }
    const minutes = Math.ceil(milliseconds / 60000);
    const exactTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(state.mailbox.expiresAt));
    elements.expiry.textContent = `Expires in ${minutes} minute${minutes === 1 ? '' : 's'} at ${exactTime}.`;
  }

  function startCountdown() {
    window.clearInterval(state.countdownTimer);
    formatRemaining();
    state.countdownTimer = window.setInterval(formatRemaining, 1000);
  }

  function renderInbox() {
    elements.inboxCount.textContent = String(state.messages.length);
    elements.inboxState.hidden = state.messages.length > 0;
    elements.inboxState.textContent = state.messages.length === 0 ? 'Waiting for messages...' : '';
    globalThis.TemporaryMailInbox.render(elements.inboxList, state.messages, state.selectedMessageId, selectMessage);
  }

  function schedulePoll() {
    window.clearTimeout(state.pollTimer);
    if (!state.mailbox) return;
    const delay = document.hidden ? 30000 : 5000;
    state.pollTimer = window.setTimeout(() => { void refreshInbox(true); }, delay);
  }

  function handleError(error, context) {
    if (error.status === 401 || error.status === 410) {
      showExpired();
      return;
    }
    if (error.status === 429 && context === 'create') {
      setStatus('Please wait before creating another inbox.');
      announce('Please wait before trying again.');
      return;
    }
    setStatus('Service unavailable. Try again shortly.');
    announce('The service is temporarily unavailable.');
  }

  async function refreshInbox(isPoll = false) {
    if (!state.mailbox || state.loadingInbox) return;
    state.loadingInbox = true;
    if (!isPoll) setStatus('Refreshing inbox');
    try {
      const inbox = await globalThis.TemporaryMailApi.inbox(state.mailbox.id, state.mailbox.accessToken);
      state.messages = inbox.messages;
      if (!state.messages.some((message) => message.id === state.selectedMessageId)) {
        state.selectedMessageId = null;
        elements.messageContent.hidden = true;
        elements.messageState.hidden = false;
        elements.messageState.textContent = 'Choose a message to read it.';
        elements.deleteMessage.disabled = true;
      }
      renderInbox();
      setStatus('Inbox up to date');
    } catch (error) {
      handleError(error, 'inbox');
    } finally {
      state.loadingInbox = false;
      schedulePoll();
    }
  }

  async function selectMessage(messageId) {
    if (!state.mailbox) return;
    state.selectedMessageId = messageId;
    renderInbox();
    elements.messageState.hidden = false;
    elements.messageState.textContent = 'Loading message...';
    elements.messageContent.hidden = true;
    elements.deleteMessage.disabled = true;
    try {
      const response = await globalThis.TemporaryMailApi.message(messageId, state.mailbox.accessToken);
      if (state.selectedMessageId !== messageId) return;
      globalThis.TemporaryMailViewer.render(elements.messageContent, response.message, downloadAttachment, state.site);
      elements.messageState.hidden = true;
      elements.messageContent.hidden = false;
      elements.deleteMessage.disabled = false;
      setStatus('Message open');
    } catch (error) {
      handleError(error, 'message');
    }
  }

  async function downloadAttachment(attachment, button) {
    if (!state.mailbox) return;
    button.disabled = true;
    try {
      const blob = await globalThis.TemporaryMailApi.download(attachment.id, state.mailbox.accessToken);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.filename || 'attachment.bin';
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      announce('Attachment download started.');
    } catch (error) {
      handleError(error, 'download');
    } finally {
      button.disabled = false;
    }
  }

  async function copyAddress() {
    if (!state.mailbox) return;
    try {
      await navigator.clipboard.writeText(state.mailbox.address);
    } catch {
      const field = document.createElement('textarea');
      field.value = state.mailbox.address;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    setStatus('Address copied');
    announce('Temporary email address copied.');
  }

  async function createMailbox() {
    elements.createMailbox.disabled = true;
    elements.createAfterExpiry.disabled = true;
    setStatus('Creating inbox');
    try {
      const created = await globalThis.TemporaryMailApi.createMailbox(elements.domainSelect.value || undefined);
      saveMailbox({ ...created.mailbox, accessToken: created.accessToken });
      elements.createPanel.hidden = true;
      elements.expiredPanel.hidden = true;
      elements.mailboxPanel.hidden = false;
      elements.mailboxAddress.textContent = state.mailbox.address;
      startCountdown();
      renderInbox();
      await refreshInbox();
      announce('Temporary inbox created.');
    } catch (error) {
      handleError(error, 'create');
    } finally {
      elements.createMailbox.disabled = false;
      elements.createAfterExpiry.disabled = false;
    }
  }

  async function deleteMailbox() {
    if (!state.mailbox) return;
    const mailbox = state.mailbox;
    try {
      await globalThis.TemporaryMailApi.deleteMailbox(mailbox.id, mailbox.accessToken);
    } catch (error) {
      if (error.status !== 401 && error.status !== 410) handleError(error, 'delete-mailbox');
    }
    const replace = state.replaceAfterDelete;
    clearMailbox();
    showCreate();
    announce('Mailbox deleted.');
    if (replace) await createMailbox();
  }

  async function deleteSelectedMessage() {
    if (!state.mailbox || !state.selectedMessageId) return;
    try {
      await globalThis.TemporaryMailApi.deleteMessage(state.selectedMessageId, state.mailbox.accessToken);
      state.selectedMessageId = null;
      elements.messageContent.hidden = true;
      elements.messageState.hidden = false;
      elements.messageState.textContent = 'Message deleted.';
      elements.deleteMessage.disabled = true;
      await refreshInbox();
      announce('Message deleted.');
    } catch (error) {
      handleError(error, 'delete-message');
    }
  }

  async function loadDomains() {
    try {
      const response = await globalThis.TemporaryMailApi.listDomains();
      elements.domainSelect.replaceChildren();
      for (const domain of response.domains) {
        const option = document.createElement('option');
        option.value = domain.id;
        option.textContent = domain.name;
        elements.domainSelect.append(option);
      }
      const enabled = response.domains.length > 0;
      elements.domainSelect.disabled = !enabled;
      elements.createMailbox.disabled = !enabled;
      elements.domainLabel.hidden = response.domains.length <= 1;
      elements.domainSelect.hidden = response.domains.length <= 1;
      if (!enabled) setStatus('Mailbox creation is temporarily unavailable.');
    } catch (error) {
      elements.createMailbox.disabled = true;
      handleError(error, 'domains');
    }
  }

  async function loadSite() {
    try {
      const response = await globalThis.TemporaryMailApi.site();
      state.site = response.site;
      document.title = response.site.siteName;
      document.querySelector('.brand').textContent = response.site.siteName;
      document.querySelector('.brand').setAttribute('aria-label', `${response.site.siteName} home`);
      document.querySelector('#page-title').textContent = response.site.tagline || 'Receive email without keeping it.';
      const icon = document.querySelector('link[rel="icon"]');
      if (icon) icon.href = response.site.faviconPath;
      if (response.site.footerText) document.querySelector('.mailbox-footer .quiet-note').textContent = response.site.footerText;
    } catch {
      setStatus('Service configuration is unavailable.');
    }
  }

  function bindEvents() {
    elements.createMailbox.addEventListener('click', () => { void createMailbox(); });
    elements.createAfterExpiry.addEventListener('click', () => { void createMailbox(); });
    elements.copyAddress.addEventListener('click', () => { void copyAddress(); });
    elements.refreshInbox.addEventListener('click', () => { void refreshInbox(); });
    elements.deleteMailbox.addEventListener('click', () => {
      state.replaceAfterDelete = false;
      elements.mailboxConfirmation.showModal();
    });
    elements.newMailbox.addEventListener('click', () => {
      state.replaceAfterDelete = true;
      elements.mailboxConfirmation.showModal();
    });
    elements.deleteMessage.addEventListener('click', () => elements.messageConfirmation.showModal());
    elements.confirmMailboxDelete.addEventListener('click', (event) => {
      event.preventDefault();
      elements.mailboxConfirmation.close();
      void deleteMailbox();
    });
    elements.confirmMessageDelete.addEventListener('click', (event) => {
      event.preventDefault();
      elements.messageConfirmation.close();
      void deleteSelectedMessage();
    });
    document.addEventListener('visibilitychange', schedulePoll);
  }

  async function initialize() {
    bindEvents();
    await loadSite();
    await loadDomains();
    const mailbox = restoreMailbox();
    if (!mailbox) return;
    saveMailbox(mailbox);
    elements.createPanel.hidden = true;
    elements.mailboxPanel.hidden = false;
    elements.mailboxAddress.textContent = mailbox.address;
    startCountdown();
    await refreshInbox();
  }

  void initialize();
}());
