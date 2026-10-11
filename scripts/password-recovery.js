(() => {
  'use strict';
  let csrf = '';
  let requestToken = '';
  const details = document.querySelector('#recoveryDetailsForm');
  const codeForm = document.querySelector('#recoveryCodeForm');
  const resetForm = document.querySelector('#recoveryResetForm');
  const availability = document.querySelector('[data-recovery-availability]');
  const status = (form, message, type = '') => {
    const node = form.querySelector('[data-status]');
    node.textContent = message;
    node.className = 'recovery-status' + (type ? ' is-' + type : '');
  };
  async function api(path, body) {
    if (body && !csrf) {
      const response = await fetch('/api/auth/csrf', {credentials: 'same-origin', cache: 'no-store'});
      if (!response.ok) throw new Error('The account service is unavailable. Please try again later.');
      csrf = (await response.json()).csrf_token;
    }
    const response = await fetch('/api/auth/recovery/' + path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: body ? {'Content-Type': 'application/json', 'X-CSRF-Token': csrf} : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 403) csrf = '';
      throw new Error(payload.error || 'Recovery is unavailable. Please try again later.');
    }
    return payload;
  }
  async function submit(form, work) {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status(form, 'Checking securely…');
    try { await work(); }
    catch (error) { status(form, error.message, 'error'); }
    finally { button.disabled = form.dataset.complete === 'true'; form.removeAttribute('aria-busy'); }
  }
  function step(index) {
    document.querySelectorAll('.recovery-steps li').forEach((item, i) => {
      if (i === index) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }
  if (details) {
    const birthday = details.elements.date_of_birth;
    const now = new Date();
    birthday.max = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    api('status').then(result => {
      availability.textContent = result.enabled ? 'Email verification is available. Complete your details to continue.' : result.message;
      availability.classList.toggle('is-ready', result.enabled);
    }).catch(() => { availability.textContent = 'Email verification is temporarily unavailable. Your password has not been changed. Please try later or contact support.'; });
    details.addEventListener('submit', event => {
      event.preventDefault();
      submit(details, async () => {
        const values = Object.fromEntries(new FormData(details));
        const contact = values.contact.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^\+?[\d\s().-]{7,32}$/.test(contact)) throw new Error('Enter your registered email or full phone number.');
        const result = await api('request', values);
        requestToken = result.request_token;
        details.reset(); // Personal details never go into browser storage or a URL.
        details.hidden = true;
        availability.hidden = true;
        codeForm.hidden = false;
        step(1);
        codeForm.querySelector('h2').focus();
        status(codeForm, result.message);
      });
    });
    codeForm.addEventListener('submit', event => {
      event.preventDefault();
      submit(codeForm, async () => {
        const result = await api('verify', {request_token: requestToken, code: codeForm.elements.code.value});
        requestToken = '';
        codeForm.reset();
        codeForm.hidden = true;
        const output = document.querySelector('#recoveryPasswordResult');
        output.hidden = false;
        document.querySelector('#temporaryPassword').value = result.temporary_password;
        step(2);
        output.querySelector('h2').focus();
      });
    });
    document.querySelector('[data-recovery-restart]').addEventListener('click', () => {
      requestToken = '';
      codeForm.reset(); codeForm.hidden = true;
      details.hidden = false; availability.hidden = false;
      status(details, 'Enter your details to request a new code.');
      step(0); details.elements.username.focus();
    });
  }
  if (resetForm) {
    resetForm.addEventListener('submit', event => {
      event.preventDefault();
      submit(resetForm, async () => {
        const fields = new FormData(resetForm);
        if (fields.get('new_password') !== fields.get('confirm_password')) throw new Error('The passwords do not match.');
        const result = await api('password', Object.fromEntries(fields));
        resetForm.dataset.complete = 'true';
        resetForm.reset();
        resetForm.querySelectorAll('input, button').forEach(node => { node.disabled = true; });
        status(resetForm, result.message, 'success');
        document.querySelector('#recoveryResetDone').hidden = false;
        document.querySelector('#recoveryResetDone').focus();
      });
    });
  }
  // Clear one-time secrets when leaving, including back/forward-cache restores.
  addEventListener('pagehide', () => {
    requestToken = ''; csrf = '';
    if (codeForm) codeForm.reset();
    const output = document.querySelector('#temporaryPassword');
    if (output) output.value = '';
  });
  addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();
