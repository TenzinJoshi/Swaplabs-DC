(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const escapeHtml = window.RelayComponents?.escapeHtml || (value => String(value ?? '')
    .replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character])));
  let csrf = '';

  async function api(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET' && !csrf) {
      const response = await fetch('/api/auth/csrf', {credentials: 'same-origin'});
      const body = await response.json().catch(() => ({}));
      csrf = body.csrf_token || '';
    }
    const request = {...options, method, credentials: 'same-origin', headers: {
      'Content-Type': 'application/json',
      ...(method !== 'GET' ? {'X-CSRF-Token': csrf} : {}),
      ...(options.headers || {})
    }};
    const response = await fetch(url, request);
    const raw = await response.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (_error) {
      body = {error: `The organisation service returned an invalid response (HTTP ${response.status}). Please try again shortly.`};
    }
    if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (HTTP ${response.status})`), {code: body.code});
    if (body.moderation?.status === 'pending') {
      throw Object.assign(new Error(body.message || 'Your submission is pending administrator review and is hidden from the platform.'), {code: 'pending_moderation'});
    }
    return body;
  }

  function showStatus(element, message, tone = 'info') {
    if (!element) return;
    element.textContent = message;
    element.className = `form-status show ${tone}`;
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
  }

  function showOrganisationGate(message, tone = 'info') {
    const gate = $('#orgGate');
    const panel = $('#orgPanel');
    if (panel) panel.hidden = true;
    if (!gate) return;
    gate.hidden = false;
    gate.className = `auth-card ${tone}`;
    gate.textContent = message;
  }

  function bindMemberPasswordReset() {
    document.querySelectorAll('[data-org-reset]').forEach(button => button.addEventListener('click', async () => {
      const memberName = button.dataset.orgMemberName || 'this member';
      if (!window.confirm(`Generate a temporary password for ${memberName}? Their current sessions will be signed out.`)) return;
      const output = button.nextElementSibling;
      button.disabled = true;
      button.dataset.originalLabel = button.innerHTML;
      button.textContent = 'Generating…';
      try {
        const result = await api(`/api/organizations/members/${encodeURIComponent(button.dataset.orgReset)}/password`, {method: 'POST'});
        output.hidden = false;
        output.className = 'form-status show success';
        output.textContent = `Temporary password (copy now): ${result.temporary_password}. It will not be shown again.`;
      } catch (error) {
        output.hidden = false;
        output.className = 'form-status show error';
        output.textContent = error.message;
      } finally {
        button.disabled = false;
        button.innerHTML = button.dataset.originalLabel || 'Reset password';
      }
    }));
  }

  async function load() {
    const panel = $('#orgPanel');
    if (!panel) return;
    try {
      const result = await api('/api/organizations/overview');
      if (!result.organization) {
        showOrganisationGate('No organisation is connected to this account yet. Create an organisation first, then return here to manage members and access rules.');
        return;
      }
      const organization = result.organization;
      const policy = result.policy || {};
      const members = Array.isArray(result.members) ? result.members : [];
      const activity = Array.isArray(result.activity) ? result.activity : [];
      $('#orgGate').hidden = true;
      panel.hidden = false;
      $('#orgName').textContent = organization.name || 'Organisation workspace';
      $('#allowExternal').checked = Boolean(policy.allow_external_access);
      $('#blockedCategories').value = (policy.blocked_categories || []).join(', ');
      $('#orgMembers').innerHTML = members.map(member => {
        const displayName = member.profile?.display_name || member.username || 'Member';
        const reset = member.organization_role === 'member'
          ? `<button class="btn btn-sm" type="button" data-org-reset="${escapeHtml(member.id)}" data-org-member-name="${escapeHtml(displayName)}">Reset password</button><small class="form-status" data-org-reset-output hidden></small>`
          : '<small>Organisation owner</small>';
        return `<div class="org-member-row"><p><strong>${escapeHtml(displayName)}</strong> · @${escapeHtml(member.username || 'member')}</p>${reset}</div>`;
      }).join('') || '<p>No members yet.</p>';
      $('#orgActivity').innerHTML = activity.map(item => `<p>${escapeHtml(item.action || 'Organisation activity')} · ${new Date(item.created_at).toLocaleString()}</p>`).join('') || '<p>No activity recorded yet.</p>';
      bindMemberPasswordReset();
    } catch (error) {
      showOrganisationGate(error.message || 'The organisation workspace is unavailable right now. Please try again shortly.', 'error');
    }
  }

  const organizationForm = $('#organizationForm');
  organizationForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('button[type="submit"]', organizationForm);
    const status = $('.form-status', organizationForm);
    const data = Object.fromEntries(new FormData(organizationForm));
    button.disabled = true;
    button.dataset.originalLabel = button.innerHTML;
    button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Creating organisation';
    showStatus(status, 'Creating your organisation…', 'info');
    try {
      await api('/api/organizations/register', {method: 'POST', body: JSON.stringify(data)});
      showStatus(status, 'Organisation created. Opening your admin workspace…', 'success');
      window.setTimeout(() => { location.href = 'organization-admin.html'; }, 350);
    } catch (error) {
      showStatus(status, error.message, error.code === 'pending_moderation' ? 'info' : 'error');
      button.disabled = false;
      button.innerHTML = button.dataset.originalLabel || 'Create organisation';
    }
  });

  $('#orgMemberForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    const status = form.nextElementSibling;
    const data = Object.fromEntries(new FormData(form));
    button.disabled = true;
    button.dataset.originalLabel = button.innerHTML;
    button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Creating account';
    showStatus(status, 'Creating the member account…', 'info');
    try {
      await api('/api/organizations/members', {method: 'POST', body: JSON.stringify(data)});
      form.reset();
      showStatus(status, 'Member account created.', 'success');
      await load();
    } catch (error) {
      if (error.code === 'pending_moderation') form.reset();
      showStatus(status, error.message, error.code === 'pending_moderation' ? 'info' : 'error');
    } finally {
      button.disabled = false;
      button.innerHTML = button.dataset.originalLabel || 'Create account';
    }
  });

  $('#savePolicy')?.addEventListener('click', async () => {
    const status = $('#policyStatus');
    try {
      await api('/api/organizations/policy', {method: 'PATCH', body: JSON.stringify({
        allow_external_access: $('#allowExternal').checked,
        blocked_categories: $('#blockedCategories').value.split(',').map(value => value.trim()).filter(Boolean)
      })});
      showStatus(status, 'Restrictions saved.', 'success');
    } catch (error) {
      showStatus(status, error.message, 'error');
    }
  });

  load();
})();
