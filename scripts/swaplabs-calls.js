(() => {
  'use strict';

  if (window.SwapLabsCalls) return;

  const state = {
    csrf: '',
    user: null,
    call: null,
    polling: null,
    audio: null,
    shell: null
  };
  const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  const $ = (selector, root = document) => root.querySelector(selector);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (writeMethods.has(method) && !state.csrf) {
      const csrf = await fetch('/api/auth/csrf', {credentials: 'same-origin', cache: 'no-store'});
      if (!csrf.ok) throw new Error('Could not establish a secure session.');
      state.csrf = (await csrf.json()).csrf_token || '';
    }
    const headers = {...(options.headers || {})};
    if (writeMethods.has(method)) headers['X-CSRF-Token'] = state.csrf;
    if (options.body && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, {
      ...options,
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      mode: 'same-origin'
    });
    let payload = {};
    try { payload = await response.json(); } catch (_error) { payload = {error: 'The call service returned an unreadable response.'}; }
    if (!response.ok) {
      const error = new Error(payload.error || 'The call could not be completed.');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function memberName(member, fallback = 'SwapLabs member') {
    return member?.profile?.display_name || member?.display_name || member?.username || fallback;
  }

  function avatarMarkup(member) {
    const name = memberName(member);
    const source = String(member?.avatar_url || member?.profile?.avatar_url || '');
    return source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(name)}">` : `<span>${escapeHtml(name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'SL')}</span>`;
  }

  function ensureShell() {
    if (state.shell) return state.shell;
    document.body.insertAdjacentHTML('beforeend', `<div class="relay-call-layer" id="relayCallLayer" hidden>
      <section class="relay-call-card" role="dialog" aria-modal="true" aria-labelledby="relayCallTitle" aria-describedby="relayCallSubtitle">
        <span class="relay-call-pulse"><i class="bx bx-phone-call"></i></span>
        <div class="relay-call-avatar" id="relayCallAvatar"></div>
        <span class="relay-call-kicker" id="relayCallKicker">Incoming call</span>
        <h2 id="relayCallTitle">Someone is calling</h2>
        <p id="relayCallSubtitle">A SwapLabs call is waiting for you.</p>
        <div class="relay-call-actions"><button class="relay-call-decline" id="relayCallDecline" type="button"><i class="bx bx-phone-off"></i> Decline</button><button class="relay-call-accept" id="relayCallAccept" type="button"><i class="bx bx-phone"></i> Accept</button></div>
        <small class="relay-call-credit-note">Calls cost 1 credit for the person who starts them.</small>
      </section>
    </div>`);
    state.shell = $('#relayCallLayer');
    state.shell.addEventListener('pointerdown', () => {
      if (state.audio) state.audio.play().catch(() => {});
    });
    $('#relayCallAccept').addEventListener('click', acceptIncoming);
    $('#relayCallDecline').addEventListener('click', declineIncoming);
    state.audio = new Audio('audio/relayskills-ringback.ogg');
    state.audio.loop = true;
    state.audio.preload = 'auto';
    return state.shell;
  }

  function stopRingtone() {
    if (!state.audio) return;
    state.audio.pause();
    state.audio.currentTime = 0;
  }

  function hideIncoming() {
    stopRingtone();
    state.call = null;
    if (state.shell) state.shell.hidden = true;
  }

  function showIncoming(call) {
    ensureShell();
    state.call = call;
    const caller = call.caller || {};
    const video = call.mode === 'video';
    $('#relayCallAvatar').innerHTML = avatarMarkup(caller);
    $('#relayCallKicker').textContent = video ? 'Incoming video call' : 'Incoming voice call';
    $('#relayCallTitle').textContent = `${memberName(caller)} is calling`;
    $('#relayCallSubtitle').textContent = video ? 'Join with your camera and microphone, or decline.' : 'Join with your microphone, or decline.';
    state.shell.hidden = false;
    state.audio?.play().catch(() => {});
  }

  async function refreshIncoming() {
    try {
      const auth = await (window.SwapLabsAuth?.get?.() || Promise.resolve({authenticated: false}));
      if (!auth?.authenticated) {
        hideIncoming();
        return;
      }
      state.user = auth.user;
      state.csrf = auth.csrf_token || state.csrf;
      const result = await api('/api/calls/incoming');
      const next = result.calls?.[0] || null;
      if (!next) {
        if (state.call) hideIncoming();
        return;
      }
      if (state.call?.id !== next.id) showIncoming(next);
    } catch (error) {
      if (error.status === 401) hideIncoming();
    }
  }

  async function acceptIncoming() {
    if (!state.call) return;
    const call = state.call;
    const button = $('#relayCallAccept');
    button.disabled = true;
    try {
      const result = await api(`/api/calls/${encodeURIComponent(call.id)}`, {method: 'PATCH', body: {action: 'accept'}});
      hideIncoming();
      if (result.room?.id) location.href = `video-room.html?room=${encodeURIComponent(result.room.id)}&call=${encodeURIComponent(call.id)}`;
    } catch (error) {
      button.disabled = false;
      showCallNotice(error.message, 'error');
    }
  }

  async function declineIncoming() {
    if (!state.call) return;
    const call = state.call;
    const button = $('#relayCallDecline');
    button.disabled = true;
    try {
      await api(`/api/calls/${encodeURIComponent(call.id)}`, {method: 'PATCH', body: {action: 'decline'}});
      hideIncoming();
    } catch (error) {
      button.disabled = false;
      showCallNotice(error.message, 'error');
    }
  }

  function showCallNotice(message, type = 'success') {
    let notice = document.querySelector('.relay-call-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'relay-call-notice';
      document.body.appendChild(notice);
    }
    notice.className = `relay-call-notice ${type}`;
    notice.textContent = message;
    requestAnimationFrame(() => notice.classList.add('show'));
    clearTimeout(notice.hideTimer);
    notice.hideTimer = setTimeout(() => notice.classList.remove('show'), 4200);
  }

  async function start(targetUserId, mode = 'voice', conversationId = '') {
    try {
      const auth = await (window.SwapLabsAuth?.get?.() || Promise.resolve({authenticated: false}));
      if (!auth?.authenticated) {
        location.href = 'login.html';
        return;
      }
      state.csrf = auth.csrf_token || state.csrf;
      const result = await api('/api/calls', {method: 'POST', body: {target_user_id: targetUserId, mode: mode === 'video' ? 'video' : 'voice', conversation_id: conversationId}});
      if (result.room?.id) location.href = `video-room.html?room=${encodeURIComponent(result.room.id)}&call=${encodeURIComponent(result.call.id)}`;
    } catch (error) {
      showCallNotice(error.message, 'error');
    }
  }

  async function inviteParticipant(callId, currentIds = []) {
    try {
      const result = await api('/api/inbox');
      const choices = (result.contacts || []).filter(member => !currentIds.includes(member.id));
      if (!choices.length) {
        showCallNotice('No other active member is available to invite.', 'error');
        return null;
      }
      const labels = choices.map((member, index) => `${index + 1}. ${memberName(member)} (@${member.username})`).join('\n');
      const answer = window.prompt(`Invite someone to this call:\n\n${labels}\n\nEnter a number or username.`);
      if (!answer) return null;
      const normalized = answer.trim().toLowerCase();
      const index = Number(normalized) - 1;
      const target = Number.isInteger(index) && choices[index] ? choices[index] : choices.find(member => member.username.toLowerCase() === normalized || memberName(member).toLowerCase() === normalized);
      if (!target) {
        showCallNotice('Choose a listed member or username.', 'error');
        return null;
      }
      const response = await api(`/api/calls/${encodeURIComponent(callId)}/participants`, {method: 'POST', body: {user_id: target.id}});
      showCallNotice(`${memberName(target)} was invited to the call.`);
      return response;
    } catch (error) {
      showCallNotice(error.message, 'error');
      return null;
    }
  }

  window.SwapLabsCalls = {start, inviteParticipant, refreshIncoming};
  ensureShell();
  refreshIncoming();
  state.polling = window.setInterval(refreshIncoming, 3500);
})();
