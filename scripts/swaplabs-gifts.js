(() => {
  const root = document.querySelector('[data-gifts-page]');
  if (!root) return;
  const $ = selector => root.querySelector(selector);
  const state = { csrf: '', user: null, lastCode: '' };
  const {escapeHtml} = window.RelayComponents;
  const formatCredits = value => `${Number(value || 0).toLocaleString()} credit${Number(value || 0) === 1 ? '' : 's'}`;
  const formatDate = value => {
    if (!value) return 'Date not available';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date not available' : date.toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
  };
  const setStatus = (message = '', type = '') => {
    const target = $('[data-gifts-status]');
    if (!target) return;
    target.textContent = message;
    target.className = `gifts-status${message ? ` show ${type}` : ''}`;
  };
  const ensureCsrf = async () => {
    if (state.csrf) return state.csrf;
    const response = await fetch('/api/auth/csrf', {credentials: 'same-origin', cache: 'no-store'});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.csrf_token) throw new Error('The secure session could not be prepared. Refresh and try again.');
    state.csrf = payload.csrf_token;
    return state.csrf;
  };
  const api = async (path, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    const request = {credentials: 'same-origin', cache: 'no-store', ...options, method, headers: {...(options.headers || {})}};
    if (request.body && typeof request.body !== 'string') {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(request.body);
    }
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) request.headers['X-CSRF-Token'] = await ensureCsrf();
    const response = await fetch(path, request);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || 'The request could not be completed.');
    return payload;
  };
  const setBalance = balance => {
    const target = $('#giftsBalance');
    if (target) target.textContent = state.user ? Number(balance || 0).toLocaleString() : 'Sign in to view';
  };
  const renderSignedOut = () => {
    $('[data-gifts-auth-gate]')?.removeAttribute('hidden');
    $('[data-gifts-app]')?.setAttribute('hidden', '');
    setBalance(0);
  };
  const renderVouchers = payload => {
    setBalance(payload.balance);
    const target = $('#voucherList');
    const items = Array.isArray(payload.vouchers) ? payload.vouchers : [];
    if (!items.length) {
      target.innerHTML = '<div class="gift-empty"><i class="bx bx-gift"></i><br>No vouchers yet. Create one when you are ready to share some credits.</div>';
      return;
    }
    target.innerHTML = items.map(item => {
      const redeemed = item.status === 'redeemed';
      const recipient = redeemed ? `Redeemed by ${escapeHtml(item.redeemer_display_name || item.redeemer_username || 'another member')} · ${formatDate(item.redeemed_at)}` : `Created ${formatDate(item.created_at)} · Code ${escapeHtml(item.code_preview || 'SL-GIFT-••••-••••')}`;
      return `<article class="voucher-row"><span class="voucher-row-icon"><i class="bx ${redeemed ? 'bx-check-circle' : 'bx-send'}"></i></span><div class="voucher-row-copy"><strong>${redeemed ? 'Voucher redeemed' : 'Voucher ready to share'}</strong><span>${recipient}</span><span class="voucher-status ${redeemed ? 'redeemed' : 'active'}">${redeemed ? 'Used once' : 'Active'}</span></div><span class="voucher-row-amount">${formatCredits(item.amount)}</span></article>`;
    }).join('');
  };
  const loadVouchers = async () => {
    const payload = await api('/api/gifts/vouchers');
    renderVouchers(payload);
  };
  const showCreatedVoucher = voucher => {
    state.lastCode = voucher.code || '';
    $('#createdVoucherCode').textContent = state.lastCode;
    $('#createdVoucherAmount').textContent = Number(voucher.amount || 0).toLocaleString();
    $('#createdVoucherPanel').removeAttribute('hidden');
    $('#createdVoucherPanel').scrollIntoView({behavior: 'smooth', block: 'center'});
  };
  const copyVoucher = async () => {
    if (!state.lastCode) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(state.lastCode);
      else {
        const helper = document.createElement('textarea'); helper.value = state.lastCode; helper.setAttribute('readonly', ''); helper.style.position = 'fixed'; helper.style.opacity = '0'; document.body.appendChild(helper); helper.select(); document.execCommand('copy'); helper.remove();
      }
      setStatus('Voucher code copied. Send it to the member you want to gift.', 'success');
    } catch (_error) { setStatus('The code is ready above. Copy it manually to share it.', 'error'); }
  };
  $('#createVoucherForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const amount = Number(new FormData(form).get('amount'));
    if (!Number.isInteger(amount) || amount < 1 || amount > 100000) { setStatus('Enter a whole-number amount between 1 and 100,000 credits.', 'error'); return; }
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; setStatus('Creating your secure one-time code…');
    try {
      const payload = await api('/api/gifts/vouchers', {method: 'POST', body: {amount}});
      showCreatedVoucher(payload.voucher);
      setBalance(payload.balance);
      setStatus('Voucher created. It has been deducted from your balance and is ready to share.', 'success');
      form.reset();
      await loadVouchers();
    } catch (error) { setStatus(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  $('#redeemVoucherForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const code = String(new FormData(form).get('code') || '').trim();
    if (!code) { setStatus('Enter the voucher code you received.', 'error'); return; }
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; setStatus('Checking the voucher and adding the credits…');
    try {
      const payload = await api('/api/gifts/vouchers/redeem', {method: 'POST', body: {code}});
      setBalance(payload.balance);
      setStatus(`${formatCredits(payload.amount)} were added to your account. This code is now permanently used.`, 'success');
      form.reset();
      await loadVouchers();
    } catch (error) { setStatus(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  $('[data-copy-voucher]')?.addEventListener('click', copyVoucher);
  (async () => {
    try {
      const auth = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me'));
      state.csrf = auth.csrf_token || '';
      state.user = auth.authenticated ? auth.user : null;
      if (!state.user) { renderSignedOut(); return; }
      $('[data-gifts-auth-gate]')?.setAttribute('hidden', '');
      $('[data-gifts-app]')?.removeAttribute('hidden');
      await loadVouchers();
    } catch (error) {
      state.user = null;
      renderSignedOut();
      setStatus(error.message, 'error');
    }
  })();
})();
