(() => {
  'use strict';

  const form = document.querySelector('#adminGateForm');
  if (!form) return;
  const code = form.elements.namedItem('code');
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('[data-admin-gate-status]');
  let csrf = '';

  const setStatus = (message, type = 'error') => {
    if (!status) return;
    status.textContent = message;
    status.className = `form-status show ${type}`;
  };

  const setBusy = busy => {
    button.disabled = busy;
    button.innerHTML = busy ? '<i class="bx bx-loader-alt bx-spin" aria-hidden="true"></i> Verifying' : '<i class="bx bx-lock-open-alt" aria-hidden="true"></i> Continue';
  };

  const pause = delay => new Promise(resolve => setTimeout(resolve, delay));

  async function fetchJson(url, options = {}, retries = 0) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...options,
          cache: 'no-store',
          credentials: 'same-origin'
        });
        const payload = await response.json().catch(() => ({}));
        return {response, payload};
      } catch (error) {
        lastError = error;
        if (attempt < retries) await pause(350);
      }
    }
    throw new Error('The secure access checkpoint could not be reached. Please refresh and try again.');
  }

  async function ensureCsrf() {
    if (csrf) return csrf;
    const {response, payload} = await fetchJson('/api/auth/csrf', {}, 2);
    if (!response.ok || !payload.csrf_token) throw new Error('The secure access checkpoint is unavailable. Please try again.');
    csrf = payload.csrf_token;
    return csrf;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!code.value.trim()) {
      setStatus('Enter the admin code to continue.');
      code.focus();
      return;
    }
    setBusy(true);
    setStatus('Verifying your administrator access…', 'info');
    try {
      const token = await ensureCsrf();
      const {response, payload} = await fetchJson('/api/auth/admin-gate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({code: code.value.trim()})
      }, 1);
      if (!response.ok) throw new Error(payload.error || 'The administrator code is incorrect.');
      window.location.replace('admin.html');
    } catch (error) {
      setStatus(error.message || 'The administrator code is incorrect.');
      setBusy(false);
      code.select();
    }
  });
})();
