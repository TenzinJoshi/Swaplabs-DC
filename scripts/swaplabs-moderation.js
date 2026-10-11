(() => {
  'use strict';

  const root = document.querySelector('[data-admin-section="moderation"]');
  if (!root) return;
  const queueNode = root.querySelector('[data-moderation-queue]');
  const statusNode = root.querySelector('[data-moderation-status]');
  const countNode = root.querySelector('[data-moderation-queue-count]');
  const badgeNode = document.querySelector('[data-moderation-count]');
  const wordsNode = root.querySelector('[data-moderation-rule-list]');
  const auditNode = root.querySelector('[data-moderation-audit]');
  let csrfToken = '';
  let queueItems = [];

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const localDate = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? escapeHtml(value || 'Unknown') : escapeHtml(new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(date));
  };
  const setStatus = (message, kind = '') => {
    statusNode.textContent = message || '';
    statusNode.className = `moderation-status ${kind}`.trim();
  };

  async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      if (!csrfToken) {
        const csrfResponse = await fetch('/api/auth/csrf', {credentials: 'same-origin'});
        const csrfPayload = await csrfResponse.json().catch(() => ({}));
        if (!csrfResponse.ok || !csrfPayload.csrf_token) throw new Error(csrfPayload.error || 'Could not establish a secure admin session.');
        csrfToken = csrfPayload.csrf_token;
      }
      headers.set('X-CSRF-Token', csrfToken);
    }
    let body = options.body;
    if (body && typeof body !== 'string') {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }
    const response = await fetch(path, {method, headers, body, credentials: 'same-origin'});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'The moderation request failed.');
    if (payload.csrf_token) csrfToken = payload.csrf_token;
    return payload;
  }

  function renderQueue(items) {
    queueItems = Array.isArray(items) ? items : [];
    countNode.textContent = `${queueItems.length} pending`;
    if (badgeNode) {
      badgeNode.textContent = queueItems.length ? String(queueItems.length) : '';
      badgeNode.hidden = !queueItems.length;
    }
    if (!queueItems.length) {
      queueNode.innerHTML = '<div class="moderation-empty"><i class="bx bx-check-shield" aria-hidden="true"></i><strong>Nothing is waiting for review.</strong><span>New flagged submissions will appear here and stay private until approved.</span></div>';
      return;
    }
    queueNode.innerHTML = queueItems.map(item => {
      const submitter = item.submitter || {};
      const display = submitter.full_name || submitter.username || 'Unregistered visitor';
      const fields = Array.isArray(item.content?.fields) ? item.content.fields : [];
      const attachments = Array.isArray(item.attachments) ? item.attachments : [];
      const fieldMarkup = fields.length ? `<dl class="moderation-field-list">${fields.map(field => `<div><dt>${escapeHtml(field.field)}</dt><dd>${escapeHtml(field.value)}</dd></div>`).join('')}</dl>` : '<p class="moderation-no-text">No text fields were included.</p>';
      const fullSubmission = JSON.stringify(item.content?.submission ?? {}, null, 2);
      const attachmentMarkup = attachments.length ? `<div class="moderation-attachments"><strong>Private attachments</strong>${attachments.map(file => {
        const fileUrl = `/api/admin/moderation/pending/${encodeURIComponent(item.id)}/files/${Number(file.file_index)}`;
        return `<span><i class="bx bx-paperclip" aria-hidden="true"></i>${escapeHtml(file.name)} · ${escapeHtml(file.type)} · ${Number(file.size || 0).toLocaleString()} bytes <a href="${escapeHtml(fileUrl)}">Download securely for review</a></span>`;
      }).join('')}</div>` : '';
      const matchedRules = Array.isArray(item.triggered_rules) ? item.triggered_rules : [];
      const ruleMarkup = matchedRules.length ? matchedRules.map(rule => `<span class="moderation-trigger-chip">${escapeHtml(rule.phrase)} <small>in ${escapeHtml(rule.field)}</small></span>`).join('') : `<span class="moderation-trigger-chip">${escapeHtml(item.triggered_rule)}</span>`;
      return `<article class="moderation-item" data-moderation-item="${escapeHtml(item.id)}">
        <header class="moderation-item-head"><div><span class="moderation-type">${escapeHtml(item.content_type)}</span><h3>${escapeHtml(display)}</h3><span class="moderation-submitter">${escapeHtml(submitter.username ? `@${submitter.username}` : '')}${submitter.email ? ` · ${escapeHtml(submitter.email)}` : ''}</span></div><time datetime="${escapeHtml(item.submitted_at)}">${localDate(item.submitted_at)}</time></header>
        <div class="moderation-item-meta"><span><strong>Submitted at</strong> <code>${escapeHtml(item.source_path)}</code></span><span><strong>Triggered rule</strong> ${ruleMarkup}</span>${submitter.user_id ? `<span><strong>User ID</strong> <code>${escapeHtml(submitter.user_id)}</code></span>` : ''}</div>
        <section class="moderation-submitted-content"><h4>Submitted content</h4>${fieldMarkup}${attachmentMarkup}<details><summary>View complete saved submission</summary><pre>${escapeHtml(fullSubmission)}</pre></details></section>
        <footer class="moderation-item-actions"><button class="btn btn-primary" type="button" data-moderation-approve="${escapeHtml(item.id)}"><i class="bx bx-check" aria-hidden="true"></i> Approve</button><button class="btn moderation-delete" type="button" data-moderation-delete="${escapeHtml(item.id)}"><i class="bx bx-trash" aria-hidden="true"></i> Delete</button></footer>
      </article>`;
    }).join('');
  }

  function renderWords(items) {
    if (!Array.isArray(items) || !items.length) {
      wordsNode.innerHTML = '<p class="moderation-empty-small">No blocked words or phrases have been added.</p>';
      return;
    }
    wordsNode.innerHTML = items.map(word => `<div class="moderation-rule-row" data-word-id="${escapeHtml(word.id)}">
      <span class="moderation-rule-phrase">${escapeHtml(word.phrase)}</span>
      <label class="moderation-enabled-toggle"><input type="checkbox" data-word-toggle="${escapeHtml(word.id)}" ${word.enabled ? 'checked' : ''}><span>${word.enabled ? 'Enabled' : 'Disabled'}</span></label>
      <button class="btn btn-sm" type="button" data-word-edit="${escapeHtml(word.id)}">Edit</button><button class="btn btn-sm moderation-delete" type="button" data-word-delete="${escapeHtml(word.id)}">Delete</button>
    </div>`).join('');
  }

  function renderAudit(items) {
    if (!Array.isArray(items) || !items.length) {
      auditNode.innerHTML = '<p class="moderation-empty-small">No moderation actions have been recorded yet.</p>';
      return;
    }
    auditNode.innerHTML = items.map(item => `<article class="moderation-audit-row"><span class="moderation-audit-state state-${escapeHtml(item.new_status)}">${escapeHtml(item.new_status)}</span><div><strong>${escapeHtml(item.action.replaceAll('_', ' '))}</strong><p>Rule: ${escapeHtml(item.triggered_rule)} · Item: <code>${escapeHtml(item.content_id)}</code>${item.user_id ? ` · User: <code>${escapeHtml(item.user_id)}</code>` : ''}</p></div><time datetime="${escapeHtml(item.created_at)}">${localDate(item.created_at)}</time><small>${escapeHtml(item.admin_id ? `Admin ${item.admin_id}` : 'Automated moderation')}</small></article>`).join('');
  }

  async function loadQueue() {
    const result = await api('/api/admin/moderation/pending');
    renderQueue(result.items);
  }
  async function loadWords() {
    const result = await api('/api/admin/moderation/words');
    renderWords(result.items);
  }
  async function loadAudit() {
    const result = await api('/api/admin/moderation/audit');
    renderAudit(result.items);
  }
  async function refreshAll() {
    setStatus('Loading moderation records…');
    try {
      await Promise.all([loadQueue(), loadWords(), loadAudit()]);
      setStatus('Queue, private word list, and audit log are up to date.', 'is-ok');
    } catch (error) {
      setStatus(error.message || 'Could not load moderation records.', 'is-error');
    }
  }

  async function reviewItem(id, action) {
    const item = queueItems.find(record => record.id === id);
    if (!item) return;
    if (action === 'delete' && !window.confirm('Permanently delete this submission from the platform? The administrator audit entry will remain.')) return;
    const buttons = [...root.querySelectorAll(`[data-moderation-approve="${CSS.escape(id)}"], [data-moderation-delete="${CSS.escape(id)}"]`)];
    buttons.forEach(button => { button.disabled = true; });
    setStatus(action === 'approve' ? 'Approving and publishing…' : 'Deleting submission…');
    try {
      const result = await api(`/api/admin/moderation/pending/${encodeURIComponent(id)}`, {method: 'PATCH', body: {action}});
      setStatus(result.message || 'Moderation decision saved.', result.publication_error ? 'is-error' : 'is-ok');
      await Promise.all([loadQueue(), loadAudit()]);
    } catch (error) {
      setStatus(error.message || 'The review action could not be completed.', 'is-error');
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  root.addEventListener('click', async event => {
    const approve = event.target.closest('[data-moderation-approve]');
    const remove = event.target.closest('[data-moderation-delete]');
    const edit = event.target.closest('[data-word-edit]');
    const deleteWord = event.target.closest('[data-word-delete]');
    if (approve) return reviewItem(approve.dataset.moderationApprove, 'approve');
    if (remove) return reviewItem(remove.dataset.moderationDelete, 'delete');
    if (edit) {
      const row = edit.closest('[data-word-id]');
      const oldPhrase = row?.querySelector('.moderation-rule-phrase')?.textContent || '';
      const phrase = window.prompt('Edit the blocked word or phrase:', oldPhrase);
      if (phrase === null) return;
      try { await api(`/api/admin/moderation/words/${encodeURIComponent(edit.dataset.wordEdit)}`, {method: 'PATCH', body: {phrase}}); await loadWords(); setStatus('Blocked phrase updated for new submissions.', 'is-ok'); }
      catch (error) { setStatus(error.message, 'is-error'); }
    }
    if (deleteWord) {
      if (!window.confirm('Delete this blocked-word rule? Existing pending items will stay pending.')) return;
      try { await api(`/api/admin/moderation/words/${encodeURIComponent(deleteWord.dataset.wordDelete)}`, {method: 'DELETE'}); await loadWords(); setStatus('Blocked phrase deleted.', 'is-ok'); }
      catch (error) { setStatus(error.message, 'is-error'); }
    }
  });

  root.addEventListener('change', async event => {
    const toggle = event.target.closest('[data-word-toggle]');
    if (!toggle) return;
    toggle.disabled = true;
    try {
      await api(`/api/admin/moderation/words/${encodeURIComponent(toggle.dataset.wordToggle)}`, {method: 'PATCH', body: {enabled: toggle.checked}});
      await loadWords();
      setStatus(`Blocked phrase ${toggle.checked ? 'enabled' : 'disabled'}.`, 'is-ok');
    } catch (error) { setStatus(error.message, 'is-error'); toggle.disabled = false; }
  });

  root.querySelector('[data-moderation-rule-form]')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem('phrase');
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api('/api/admin/moderation/words', {method: 'POST', body: {phrase: input.value}});
      form.reset();
      await loadWords();
      setStatus('Blocked phrase added and active for new submissions.', 'is-ok');
    } catch (error) { setStatus(error.message, 'is-error'); }
    finally { submit.disabled = false; }
  });

  root.querySelector('[data-moderation-refresh]')?.addEventListener('click', refreshAll);
  root.querySelector('[data-moderation-audit-refresh]')?.addEventListener('click', () => loadAudit().then(() => setStatus('Audit log refreshed.', 'is-ok')).catch(error => setStatus(error.message, 'is-error')));
  document.querySelectorAll('[data-admin-section-target="moderation"]').forEach(button => button.addEventListener('click', refreshAll));
  if (new URLSearchParams(location.search).get('section') === 'moderation') setTimeout(refreshAll, 900);
  else setTimeout(() => api('/api/admin/moderation/pending').then(result => {
    countNode.textContent = `${result.count || 0} pending`;
    if (badgeNode) { badgeNode.textContent = result.count ? String(result.count) : ''; badgeNode.hidden = !result.count; }
  }).catch(() => {}), 1200);
})();
