(function startAdmin() {
  'use strict';

  let csrfToken;
  let pendingDomain;
  let mailboxQuery = '';
  let messageQuery = '';
  const login = document.querySelector('#admin-login');
  const dashboard = document.querySelector('#admin-dashboard');
  const dialog = document.querySelector('#domain-confirm');
  const status = document.querySelector('#admin-status');
  const request = async (path, options = {}) => {
    const headers = new Headers(options.headers ?? {});
    if (csrfToken && options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrfToken);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(`/api/v1/admin${path}`, { ...options, headers, credentials: 'same-origin' });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) { const error = new Error(data?.error?.message ?? 'Request failed.'); error.status = response.status; throw error; }
    return data;
  };
  const copy = (value) => { const node = document.createElement('p'); node.textContent = value; return node; };
  const button = (label, className, handler) => { const node = document.createElement('button'); node.type = 'button'; node.className = `button ${className}`; node.textContent = label; node.addEventListener('click', () => { void handler(); }); return node; };
  const date = (value) => value ? new Date(value).toLocaleString() : 'Never';
  function showStatus(value) { status.textContent = value; }

  function renderOverview(overview) {
    const root = document.querySelector('#overview'); root.replaceChildren();
    const values = [
      ['Active mailboxes', overview.active_mailboxes], ['Messages in one hour', overview.recent_messages], ['Enabled domains', overview.enabled_domains], ['High abuse events', overview.high_abuse_events],
      ['Accepted in 24 hours', overview.ingest?.accepted_24h ?? 0], ['Rejected in 24 hours', overview.ingest?.rejected_24h ?? 0], ['Last ingest success', date(overview.ingest?.last_success_at)], ['Maintenance', overview.maintenance_mode ? 'Enabled' : 'Off']
    ];
    for (const [label, value] of values) { const panel = document.createElement('div'); panel.className = 'inbox-panel'; panel.append(copy(label), copy(String(value ?? 'Unknown'))); root.append(panel); }
  }

  function renderSettings(settings) {
    const form = document.querySelector('#settings-form');
    const values = { ...settings.mailbox, ...settings.email, ...settings.site, ...settings.limits };
    for (const [name, value] of Object.entries(values)) { const field = form.elements.namedItem(name); if (!field) continue; if (field.type === 'checkbox') field.checked = value; else field.value = value; }
  }

  function renderDomains(domains) {
    const root = document.querySelector('#domain-list'); root.replaceChildren();
    for (const domain of domains) {
      const row = document.createElement('div'); row.className = 'admin-row';
      const summary = `${domain.domain_name}${domain.display_name ? ` (${domain.display_name})` : ''} | ${domain.is_enabled ? 'enabled' : 'disabled'} | ${domain.public_creation_enabled ? 'creation on' : 'creation off'} | ${domain.active_mailboxes} active | ${domain.messages_last_24h} messages / 24h`;
      row.append(copy(summary));
      row.append(button(domain.is_enabled ? 'Disable' : 'Enable', 'button-secondary', async () => { pendingDomain = domain; document.querySelector('#domain-confirm-copy').textContent = `${domain.is_enabled ? 'Disable' : 'Enable'} ${domain.domain_name}? Cloudflare DNS and routing remain unchanged.`; dialog.showModal(); }),
        button(domain.is_default ? 'Default' : 'Make default', 'button-secondary', async () => { await request(`/domains/${domain.id}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) }); await load(); }),
        button(domain.public_creation_enabled ? 'Close creation' : 'Open creation', 'button-secondary', async () => { await request(`/domains/${domain.id}`, { method: 'PATCH', body: JSON.stringify({ publicCreationEnabled: !domain.public_creation_enabled }) }); await load(); }));
      root.append(row);
    }
  }

  function renderBlocks(blocks) {
    const root = document.querySelector('#block-list'); root.replaceChildren();
    for (const block of blocks) { const row = document.createElement('div'); row.className = 'admin-row'; row.append(copy(`${block.scope}: ${block.match_value} (${block.reason_code}) until ${date(block.expires_at)}`), button('Remove', 'button-danger', async () => { await request(`/blocks/${block.id}`, { method: 'DELETE' }); await load(); })); root.append(row); }
  }

  function renderIngest(events) {
    const root = document.querySelector('#ingest-list'); root.replaceChildren();
    for (const event of events) root.append(copy(`${date(event.created_at)} | ${event.outcome} | ${event.reason_code}${event.domain_name ? ` | ${event.domain_name}` : ''}${event.duration_ms === null ? '' : ` | ${event.duration_ms} ms`}`));
  }

  function renderMailboxes(rows) {
    const root = document.querySelector('#mailbox-list'); root.replaceChildren();
    for (const mailbox of rows) { const row = document.createElement('div'); row.className = 'admin-row'; row.append(copy(`${mailbox.address} | ${mailbox.message_count} messages | expires ${date(mailbox.expires_at)} | ${mailbox.deleted_at ? 'deleted' : 'active'}`), button('Expire', 'button-danger', async () => { if (!window.confirm(`Expire ${mailbox.address} now?`)) return; await request(`/mailboxes/${mailbox.id}/expire`, { method: 'POST' }); await load(); }), button('Delete', 'button-danger', async () => { if (!window.confirm(`Delete ${mailbox.address}?`)) return; await request(`/mailboxes/${mailbox.id}`, { method: 'DELETE' }); await load(); })); root.append(row); }
  }

  function renderMessages(rows) {
    const root = document.querySelector('#message-list-admin'); root.replaceChildren();
    for (const message of rows) { const row = document.createElement('div'); row.className = 'admin-row'; row.append(copy(`${message.mailbox_address} | ${message.subject || '(No subject)'} | ${message.attachment_count} attachments | ${message.raw_size_bytes} bytes | ${date(message.received_at)}`), button('Delete', 'button-danger', async () => { if (!window.confirm('Delete this message metadata and content now?')) return; await request(`/messages/${message.id}`, { method: 'DELETE' }); await load(); })); root.append(row); }
  }

  function renderSessions(sessions, currentSessionId) {
    const root = document.querySelector('#session-list'); root.replaceChildren();
    for (const session of sessions) { const row = document.createElement('div'); row.className = 'admin-row'; row.append(copy(`${session.id === currentSessionId ? 'Current session' : 'Session'} | last seen ${date(session.last_seen_at)} | expires ${date(session.expires_at)}${session.ip_hash_prefix ? ` | IP hash ${session.ip_hash_prefix}` : ''}`)); if (session.id !== currentSessionId) row.append(button('Revoke', 'button-danger', async () => { await request(`/sessions/${session.id}`, { method: 'DELETE' }); await load(); })); root.append(row); }
  }

  function renderAudit(events) {
    const root = document.querySelector('#audit-list'); root.replaceChildren();
    for (const event of events) root.append(copy(`${date(event.created_at)} | ${event.username || 'system'} | ${event.action} | ${event.target_type || 'none'}`));
  }

  function renderAbuse(events) { const root = document.querySelector('#event-list'); root.replaceChildren(); for (const event of events) root.append(copy(`${date(event.created_at)} | ${event.severity}: ${event.event_type}`)); }

  async function load() {
    showStatus('Refreshing operations data...');
    const [overview, settings, domains, blocks, abuse, ingest, mailboxes, messages, sessions, audit] = await Promise.all([
      request('/overview'), request('/settings'), request('/domains'), request('/blocks'), request('/abuse-events'), request('/ingest-events'), request(`/mailboxes?q=${encodeURIComponent(mailboxQuery)}`), request(`/messages?q=${encodeURIComponent(messageQuery)}`), request('/sessions'), request('/audit-events')
    ]);
    renderOverview(overview.overview); renderSettings(settings.settings); renderDomains(domains.domains); renderBlocks(blocks.blocks); renderAbuse(abuse.events); renderIngest(ingest.events); renderMailboxes(mailboxes.mailboxes); renderMessages(messages.messages); renderSessions(sessions.sessions, sessions.currentSessionId); renderAudit(audit.events);
    showStatus('Operations data is current.');
  }

  function formSettings(form) {
    const number = (name) => Number(form.elements.namedItem(name).value);
    const checked = (name) => form.elements.namedItem(name).checked;
    const value = (name) => form.elements.namedItem(name).value;
    return { mailbox: { ttlMinutes: number('ttlMinutes'), creationEnabled: checked('creationEnabled'), maxMessagesPerMailbox: number('maxMessagesPerMailbox') }, email: { maxMessageBytes: number('maxMessageBytes'), attachmentsEnabled: checked('attachmentsEnabled'), htmlViewerEnabled: checked('htmlViewerEnabled'), textViewerEnabled: checked('textViewerEnabled') }, site: { siteName: value('siteName'), tagline: value('tagline'), supportEmail: value('supportEmail'), footerText: value('footerText'), faviconPath: value('faviconPath'), maintenanceMode: checked('maintenanceMode'), maintenanceMessage: value('maintenanceMessage') }, limits: { mailboxCreatePerWindow: number('mailboxCreatePerWindow'), mailboxCreateWindowSeconds: number('mailboxCreateWindowSeconds'), adminLoginPerWindow: number('adminLoginPerWindow'), adminLoginWindowSeconds: number('adminLoginWindowSeconds') } };
  }

  document.querySelector('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); const fields = new FormData(event.currentTarget); try { const result = await request('/session', { method: 'POST', body: JSON.stringify({ username: fields.get('username'), password: fields.get('password') }) }); csrfToken = result.csrfToken; login.hidden = true; dashboard.hidden = false; document.querySelector('#logout').hidden = false; await load(); } catch { document.querySelector('#login-error').textContent = 'Sign in failed.'; } });
  document.querySelector('#settings-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await request('/settings', { method: 'PUT', body: JSON.stringify(formSettings(event.currentTarget)) }); await load(); } catch (error) { showStatus(`Settings were not saved: ${error.message}`); } });
  document.querySelector('#domain-form').addEventListener('submit', async (event) => { event.preventDefault(); const fields = new FormData(event.currentTarget); try { await request('/domains', { method: 'POST', body: JSON.stringify({ domainName: fields.get('domainName'), displayName: fields.get('displayName'), mxHostname: fields.get('mxHostname') || undefined, isDefault: fields.get('isDefault') === 'on', publicCreationEnabled: fields.get('publicCreationEnabled') === 'on' }) }); event.currentTarget.reset(); await load(); } catch (error) { showStatus(`Domain was not added: ${error.message}`); } });
  document.querySelector('#block-form').addEventListener('submit', async (event) => { event.preventDefault(); const fields = new FormData(event.currentTarget); const expiry = fields.get('expiresAt'); try { await request('/blocks', { method: 'POST', body: JSON.stringify({ scope: fields.get('scope'), matchType: fields.get('matchType'), matchValue: fields.get('matchValue'), reasonCode: fields.get('reasonCode'), expiresAt: expiry ? new Date(expiry).toISOString() : null }) }); event.currentTarget.reset(); await load(); } catch (error) { showStatus(`Block was not created: ${error.message}`); } });
  document.querySelector('#mailbox-search').addEventListener('submit', async (event) => { event.preventDefault(); mailboxQuery = new FormData(event.currentTarget).get('q') || ''; await load(); });
  document.querySelector('#message-search').addEventListener('submit', async (event) => { event.preventDefault(); messageQuery = new FormData(event.currentTarget).get('q') || ''; await load(); });
  document.querySelector('#password-form').addEventListener('submit', async (event) => { event.preventDefault(); const fields = new FormData(event.currentTarget); try { await request('/password', { method: 'PUT', body: JSON.stringify({ currentPassword: fields.get('currentPassword'), newPassword: fields.get('newPassword') }) }); event.currentTarget.reset(); showStatus('Password changed. Other sessions were revoked.'); await load(); } catch (error) { showStatus(`Password was not changed: ${error.message}`); } });
  document.querySelector('#refresh-dashboard').addEventListener('click', () => { void load().catch((error) => showStatus(`Refresh failed: ${error.message}`)); });
  document.querySelector('#logout').addEventListener('click', async () => { await request('/session', { method: 'DELETE' }); csrfToken = undefined; login.hidden = false; dashboard.hidden = true; document.querySelector('#logout').hidden = true; });
  dialog.addEventListener('close', async () => { if (dialog.returnValue !== 'apply' || !pendingDomain) return; const domain = pendingDomain; pendingDomain = undefined; try { await request(`/domains/${domain.id}`, { method: 'PATCH', body: JSON.stringify({ isEnabled: !domain.is_enabled }) }); await load(); } catch (error) { showStatus(`Domain update failed: ${error.message}`); } });
}());
