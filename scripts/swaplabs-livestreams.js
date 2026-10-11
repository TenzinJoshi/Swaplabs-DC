(() => {
  const root = document.querySelector('[data-livestream-page]');
  if (!root) return;
  const $ = selector => root.querySelector(selector);
  const state = { csrf: '', user: null, streams: [], selected: null, poll: 0, media: null, peers: new Map(), signalAfter: '', seenSignals: new Set(), signalBusy: false, lastHeartbeat: 0 };
  // Host candidates connect local tabs and devices without contacting a
  // public STUN/TURN service. Signalling remains on the localhost API.
  const iceServers = [];
  const {escapeHtml, initials, profileColor, safeAvatarUrl} = window.RelayComponents;
  const formatDate = value => {
    if (!value) return 'Start time to be announced';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Start time to be announced' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  };
  const formatDuration = seconds => {
    const minutes = Math.max(0, Math.floor(Number(seconds || 0) / 60));
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  };
  const api = async (path, options = {}) => {
    const request = { credentials: 'same-origin', cache: 'no-store', ...options, headers: { ...(options.headers || {}) } };
    if (request.body && typeof request.body !== 'string') {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(request.body);
    }
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) request.headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, request);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || 'The request could not be completed.');
      error.code = payload.code || '';
      error.profile_completeness = payload.profile_completeness;
      error.required_profile_fields = payload.required_profile_fields;
      error.profile_url = payload.profile_url;
      error.return_to = payload.return_to;
      if (error.code === 'profile_incomplete') window.SwapLabsProfileGate?.open(error);
      throw error;
    }
    if (payload.moderation?.status === 'pending') {
      const error = new Error(payload.message || 'Your submission is pending administrator review and is hidden from the platform.');
      error.status = response.status;
      error.code = 'pending_moderation';
      throw error;
    }
    return payload;
  };
  const setStatus = (element, message, kind = '') => {
    if (!element) return;
    if (kind === 'error' && /pending (?:administrator )?review/i.test(String(message || ''))) kind = 'info';
    element.textContent = message;
    element.className = `form-status ${kind}`.trim();
  };
  const avatar = (member, className) => {
    const source = safeAvatarUrl(member);
    return `<span class="${className} ${profileColor(member)}">${source ? `<img src="${escapeHtml(source)}" alt="">` : escapeHtml(initials(member))}</span>`;
  };
  const hostName = stream => stream?.host?.profile?.display_name || stream?.host?.display_name || stream?.host?.username || 'SwapLabs host';

  function renderCard(stream) {
    const live = stream.status === 'live';
    const scheduled = stream.status === 'scheduled';
    const ended = stream.status === 'ended';
    const cancelled = stream.status === 'cancelled';
    const host = hostName(stream);
    const statusClass = live ? 'live' : scheduled ? 'scheduled' : cancelled ? 'cancelled' : 'ended';
    const statusLabel = live ? '<i class="bxs-circle"></i> Live now' : scheduled ? 'Coming up' : cancelled ? 'Cancelled' : 'Past broadcast';
    const action = live ? 'Watch live' : scheduled ? 'View scheduled broadcast' : cancelled ? 'View cancelled broadcast' : 'View replay details';
    const icon = live ? 'bx-broadcast' : scheduled ? 'bx-calendar-event' : cancelled ? 'bx-calendar-x' : 'bx-history';
    const timing = live ? formatDuration(stream.elapsed_seconds) : scheduled ? formatDate(stream.scheduled_at) : cancelled ? 'Broadcast cancelled' : formatDate(stream.ended_at);
    return `<article class="livestream-card ${live ? 'is-live' : ''} ${cancelled ? 'is-cancelled' : ''}" data-stream-card="${escapeHtml(stream.id)}">
      <button class="livestream-card-stage" type="button" data-watch-stream="${escapeHtml(stream.id)}" aria-label="${escapeHtml(action)}: ${escapeHtml(stream.title)}"><span class="stream-art"><i class="bx ${icon}"></i></span><span class="stream-status-pill ${statusClass}">${statusLabel}</span>${live ? `<span class="stream-card-viewers"><i class="bx bx-group"></i>${Number(stream.viewer_count || 0).toLocaleString()}</span>` : ''}</button>
      <div class="livestream-card-body"><div class="livestream-card-kicker"><span>${escapeHtml(stream.category || 'Community')}</span><span>${escapeHtml(timing)}</span></div><h3><button type="button" data-watch-stream="${escapeHtml(stream.id)}">${escapeHtml(stream.title)}</button></h3><p>${escapeHtml(stream.description || 'A SwapLabs community broadcast.')}</p><div class="livestream-card-footer"><span class="stream-host">${avatar(stream.host, 'stream-avatar')}${escapeHtml(host)}</span><span><i class="bx bx-coin-stack"></i>${Number(stream.credits_donated || 0).toLocaleString()}</span></div><div class="livestream-card-tags">${(stream.tags || []).slice(0, 3).map(tag => `<span>#${escapeHtml(tag)}</span>`).join('')}</div></div>
    </article>`;
  }

  function renderDirectory(payload) {
    state.streams = payload.livestreams || [];
    $('#livestreamStatLive').textContent = Number(payload.stats?.live || 0).toLocaleString();
    $('#livestreamStatViewers').textContent = Number(payload.stats?.viewers || 0).toLocaleString();
    $('#livestreamStatCredits').textContent = Number(payload.stats?.credits_donated || 0).toLocaleString();
    const categories = $('#livestreamCategory');
    const currentCategory = categories.value;
    categories.innerHTML = '<option value="">All categories</option>' + (payload.categories || []).map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    categories.value = currentCategory;
    $('#livestreamResultCount').textContent = `${state.streams.length} broadcast${state.streams.length === 1 ? '' : 's'}`;
    const groups = [
      { key: 'live', title: 'Happening now', emptyTitle: 'No rooms are live right now', copy: 'Join a room that is live and take part in the conversation.', icon: 'bx-broadcast' },
      { key: 'scheduled', title: 'Coming up', emptyTitle: 'No upcoming broadcasts', copy: 'Save a place for the next broadcast on the calendar.', icon: 'bx-calendar-event' },
      { key: 'ended', title: 'Past broadcasts', emptyTitle: 'No past broadcasts yet', copy: 'Review rooms that have already finished and see what they covered.', icon: 'bx-history' },
      { key: 'cancelled', title: 'Cancelled broadcasts', emptyTitle: 'No cancelled broadcasts', copy: 'These rooms were planned but will not go live.', icon: 'bx-calendar-x' },
    ];
    const selectedStatus = $('#livestreamStatus').value || 'all';
    const visibleGroups = selectedStatus === 'all' ? groups : groups.filter(group => group.key === selectedStatus);
    $('#livestreamGrid').innerHTML = visibleGroups.map(group => {
      const items = state.streams.filter(stream => stream.status === group.key);
      const empty = `<div class="livestream-row-empty"><i class="bx ${group.icon}"></i><div><strong>${group.emptyTitle}</strong><span>${group.copy}</span></div></div>`;
      return `<section class="livestream-status-row ${group.key}"><div class="livestream-status-row-head"><div><span class="platform-kicker"><i class="bx ${group.icon}"></i> ${group.title}</span><p>${group.copy}</p></div><strong>${items.length}</strong></div><div class="livestream-row-grid">${items.length ? items.map(renderCard).join('') : empty}</div></section>`;
    }).join('');
    renderMyStreams(payload.my_livestreams || []);
  }

  function renderMyStreams(streams) {
    const target = $('#myLivestreams');
    if (!state.user) return;
    if (!streams.length) {
      target.innerHTML = '<div class="feature-empty"><i class="bx bx-calendar-event"></i><h3>Your broadcasts will appear here.</h3><p>Create a schedule, then start your room from the card below.</p></div>';
      return;
    }
    target.innerHTML = `<div class="my-stream-list">${streams.map(stream => {
      const statusClass = stream.status === 'live' ? 'live' : stream.status === 'scheduled' ? 'scheduled' : stream.status === 'cancelled' ? 'cancelled' : 'ended';
      const statusLabel = stream.status === 'live' ? 'Live now' : stream.status === 'scheduled' ? 'Coming up' : stream.status === 'cancelled' ? 'Cancelled' : 'Past broadcast';
      const summary = stream.status === 'scheduled' ? formatDate(stream.scheduled_at) : stream.status === 'live' ? `${formatDuration(stream.elapsed_seconds)} elapsed` : stream.status === 'cancelled' ? 'Cancelled before broadcast' : `Earned ${Number(stream.reward_credits_awarded || 0).toLocaleString()} credits`;
      return `<article class="my-stream-row"><div><span class="stream-status-pill ${statusClass}">${statusLabel}</span><h3>${escapeHtml(stream.title)}</h3><p>${escapeHtml(summary)}</p></div><div class="my-stream-actions"><button class="btn" type="button" data-watch-stream="${escapeHtml(stream.id)}">Open</button>${stream.status === 'scheduled' ? `<button class="btn btn-primary" type="button" data-start-stream="${escapeHtml(stream.id)}"><i class="bx bx-play"></i> Start</button><button class="btn btn-danger" type="button" data-cancel-stream="${escapeHtml(stream.id)}"><i class="bx bx-x"></i> Cancel</button>` : ''}${stream.status === 'live' ? `<button class="btn btn-danger" type="button" data-end-stream="${escapeHtml(stream.id)}"><i class="bx bx-stop"></i> End</button>` : ''}</div></article>`;
    }).join('')}</div>`;
  }

  function renderChat(messages) {
    const target = $('#livestreamChat');
    if (!messages?.length) {
      target.innerHTML = '<div class="chat-empty"><i class="bx bx-message-square-dots"></i><p>Chat appears here when people join.</p></div>';
      return;
    }
    target.innerHTML = messages.map(message => `<div class="chat-message ${message.donation_credits ? 'has-donation' : ''}">${avatar(message.author, 'chat-avatar')}<div><div class="chat-message-meta"><strong>${escapeHtml(message.author?.profile?.display_name || message.author?.display_name || message.author?.username || 'Member')}</strong><time>${escapeHtml(new Date(message.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}))}</time>${message.donation_credits ? `<span class="chat-donation"><i class="bx bx-coin-stack"></i>${Number(message.donation_credits).toLocaleString()}</span>` : ''}</div><p>${escapeHtml(message.body)}</p></div></div>`).join('');
    target.scrollTop = target.scrollHeight;
  }

  async function sendSignal(targetId, type, payload) {
    if (!state.selected) return;
    await api(`/api/livestreams/${encodeURIComponent(state.selected.id)}/signals`, {
      method: 'POST', body: { target_id: targetId, type, payload }
    });
  }

  function closePeers() {
    for (const peer of state.peers.values()) peer.pc.close();
    state.peers.clear();
    state.signalAfter = '';
    state.seenSignals.clear();
    const remote = $('#remoteStream');
    if (remote) { remote.pause(); remote.srcObject = null; remote.hidden = true; remote.muted = true; }
    const audioButton = $('#enableLivestreamAudio');
    if (audioButton) audioButton.hidden = true;
  }

  async function makeOffer(peer) {
    if (!peer || peer.makingOffer || peer.offered || peer.pc.signalingState !== 'stable') return;
    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      peer.offered = true;
      await sendSignal(peer.userId, 'offer', peer.pc.localDescription.toJSON());
    } catch (_error) {
      peer.offered = false;
    } finally {
      peer.makingOffer = false;
    }
  }

  function ensurePeer(userId, initiate = false) {
    if (!userId || !state.selected || !window.RTCPeerConnection) return null;
    const existing = state.peers.get(userId);
    if (existing) {
      if (initiate) window.setTimeout(() => makeOffer(existing), 60);
      return existing;
    }
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { userId, pc, offered: false, makingOffer: false, pendingIce: [] };
    if (state.media && state.selected.is_host) state.media.getTracks().forEach(track => pc.addTrack(track, state.media));
    pc.addEventListener('icecandidate', event => {
      if (event.candidate) sendSignal(userId, 'ice', event.candidate.toJSON()).catch(() => {});
    });
    pc.addEventListener('track', event => {
      if (state.selected?.is_host) return;
      const remote = $('#remoteStream');
      if (!remote) return;
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      remote.srcObject = stream;
      // Autoplay policies allow muted media. Keep the video visible immediately
      // and let the viewer opt into sound with one click.
      remote.muted = true;
      remote.hidden = false;
      const placeholder = $('.stage-placeholder');
      if (placeholder) placeholder.hidden = true;
      remote.onloadedmetadata = () => remote.play().catch(() => {});
      remote.play().catch(() => {});
      const audioButton = $('#enableLivestreamAudio');
      if (audioButton) audioButton.hidden = false;
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') {
        const remote = $('#remoteStream');
        if (remote) remote.play().catch(() => {});
      }
      if (['failed', 'closed'].includes(pc.connectionState)) {
        pc.close();
        state.peers.delete(userId);
      }
    });
    pc.addEventListener('signalingstatechange', () => {
      // If a viewer joined while the host camera was still starting, the first
      // offer may have had no tracks. Renegotiate as soon as that offer settles.
      if (pc.signalingState === 'stable' && state.selected?.is_host && state.media && !peer.offered) {
        makeOffer(peer).catch(() => {});
      }
    });
    state.peers.set(userId, peer);
    if (initiate) window.setTimeout(() => makeOffer(peer), 80);
    return peer;
  }

  async function flushIce(peer) {
    if (!peer.pc.remoteDescription) return;
    const pending = peer.pendingIce.splice(0);
    for (const candidate of pending) {
      try { await peer.pc.addIceCandidate(candidate); } catch (_error) { /* stale ICE can be ignored */ }
    }
  }

  async function handleSignal(signal) {
    const peer = ensurePeer(signal.from_id, false);
    if (!peer) return;
    const pc = peer.pc;
    if (signal.type === 'offer') {
      if (pc.signalingState !== 'stable') {
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch (_error) { /* deterministic initiator wins */ }
      }
      await pc.setRemoteDescription(signal.payload);
      await flushIce(peer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(signal.from_id, 'answer', pc.localDescription.toJSON());
    } else if (signal.type === 'answer') {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(signal.payload);
        await flushIce(peer);
      }
    } else if (signal.type === 'ice') {
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(signal.payload); } catch (_error) { /* stale ICE can be ignored */ }
      } else peer.pendingIce.push(signal.payload);
    }
  }

  async function pollSignals() {
    if (!state.selected || state.selected.status !== 'live' || !state.user || state.signalBusy) return;
    state.signalBusy = true;
    try {
      if (state.selected.joined && Date.now() - state.lastHeartbeat > 30000) {
        await api(`/api/livestreams/${encodeURIComponent(state.selected.id)}/heartbeat`, { method: 'POST' });
        state.lastHeartbeat = Date.now();
      }
      const query = state.signalAfter ? `?after=${encodeURIComponent(state.signalAfter)}` : '';
      const result = await api(`/api/livestreams/${encodeURIComponent(state.selected.id)}/signals${query}`);
      for (const signal of result.signals || []) {
        if (state.seenSignals.has(signal.id)) continue;
        try {
          await handleSignal(signal);
          state.seenSignals.add(signal.id);
        } catch (_error) { /* one stale signal must not block the next one */ }
      }
      state.signalAfter = result.server_time || new Date().toISOString();
      if (state.seenSignals.size > 1000) state.seenSignals = new Set([...state.seenSignals].slice(-500));
    } catch (_error) {
      // Chat and room status remain useful when a browser cannot establish media.
    } finally {
      state.signalBusy = false;
    }
  }

  function syncPeers() {
    if (!state.selected || state.selected.status !== 'live' || !state.user || !window.RTCPeerConnection) {
      closePeers();
      return;
    }
    const desired = new Set();
    if (state.selected.is_host) {
      (state.selected.viewers || []).forEach(member => { if (member.id !== state.user.id) desired.add(member.id); });
      desired.forEach(userId => ensurePeer(userId, true));
    } else if (state.selected.joined && state.selected.host?.id && state.selected.host.id !== state.user.id) {
      desired.add(state.selected.host.id);
      ensurePeer(state.selected.host.id, false);
    }
    for (const [userId, peer] of state.peers) {
      if (!desired.has(userId)) { peer.pc.close(); state.peers.delete(userId); }
    }
  }

  function renderRoom(stream) {
    if (state.selected && state.selected.id !== stream.id) closePeers();
    state.selected = stream;
    $('#watchRoom').hidden = false;
    $('#watchRoomTitle').textContent = stream.title;
    $('#watchRoomMeta').textContent = `${hostName(stream)} · ${stream.category || 'Community'} · ${stream.status === 'live' ? `${formatDuration(stream.elapsed_seconds)} live` : formatDate(stream.scheduled_at || stream.ended_at)}`;
    $('#watchHostName').textContent = hostName(stream);
    $('#watchRoomCategory').textContent = stream.category || 'Community';
    $('#stageLiveBadge').textContent = stream.status === 'live' ? 'LIVE' : stream.status.toUpperCase();
    $('#stageLiveBadge').className = `stage-live-badge ${stream.status === 'live' ? 'is-live' : ''}`;
    $('#stageViewerCount').innerHTML = `<i class="bx bx-group"></i> ${Number(stream.viewer_count || 0).toLocaleString()} watching`;
    $('#joinLivestream').hidden = !state.user || stream.status !== 'live' || stream.joined;
    $('#leaveLivestream').hidden = !state.user || stream.status !== 'live' || !stream.joined;
    $('#endLivestream').hidden = !stream.can_manage || stream.status !== 'live';
    $('#livestreamChatForm').hidden = !state.user || stream.status !== 'live';
    $('#chatAudience').textContent = state.user ? (stream.status === 'live' ? 'Members can chat and donate' : 'Replay chat') : 'Sign in to join chat';
    if (stream.status !== 'live') $('#enableLivestreamAudio').hidden = true;
    renderChat(stream.chat || []);
    if (stream.status !== 'live' && state.media) stopPreview();
    syncPeers();
    window.requestAnimationFrame(() => $('#watchRoom').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async function loadDirectory() {
    const params = new URLSearchParams();
    if ($('#livestreamSearch').value.trim()) params.set('q', $('#livestreamSearch').value.trim());
    if ($('#livestreamStatus').value !== 'all') params.set('status', $('#livestreamStatus').value);
    if ($('#livestreamCategory').value) params.set('category', $('#livestreamCategory').value);
    try { renderDirectory(await api(`/api/livestreams?${params.toString()}`)); }
    catch (error) { $('#livestreamGrid').innerHTML = `<div class="feature-empty"><i class="bx bx-error-circle"></i><h3>Directory unavailable</h3><p>${escapeHtml(error.message)}</p></div>`; }
  }

  async function loadRoom() {
    if (!state.selected) return;
    try {
      const payload = await api(`/api/livestreams/${encodeURIComponent(state.selected.id)}`);
      renderRoom(payload.livestream);
    } catch (_error) { /* a closed room remains usable until the next refresh */ }
  }

  async function openRoom(id) {
    try { const payload = await api(`/api/livestreams/${encodeURIComponent(id)}`); renderRoom(payload.livestream); }
    catch (error) { if (error.code !== 'profile_incomplete') window.alert(error.message); }
  }

  async function startStream(id) {
    try {
      const payload = await api(`/api/livestreams/${encodeURIComponent(id)}/start`, { method: 'POST' });
      if (!state.selected || state.selected.id !== id) renderRoom(payload.livestream); else renderRoom(payload.livestream);
      await loadDirectory();
      await startPreview();
    } catch (error) { if (error.code !== 'profile_incomplete') window.alert(error.message); }
  }

  async function endStream(id) {
    if (!window.confirm('End this broadcast and settle the earned credit milestone?')) return;
    try { const payload = await api(`/api/livestreams/${encodeURIComponent(id)}/end`, { method: 'POST' }); renderRoom(payload.livestream); await loadDirectory(); stopPreview(); }
    catch (error) { if (error.code !== 'profile_incomplete') window.alert(error.message); }
  }

  async function cancelStream(id) {
    const stream = state.streams.find(item => item.id === id);
    if (!stream || !window.confirm(`Cancel “${stream.title}”? People will no longer see it as an upcoming broadcast.`)) return;
    try {
      await api(`/api/livestreams/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'cancelled' } });
      if (state.selected?.id === id) { closePeers(); stopPreview(); $('#watchRoom').hidden = true; state.selected = null; }
      await loadDirectory();
    } catch (error) { if (error.code !== 'profile_incomplete') window.alert(error.message); }
  }

  async function joinRoom() {
    if (!state.selected) return;
    try { renderRoom((await api(`/api/livestreams/${encodeURIComponent(state.selected.id)}/join`, { method: 'POST' })).livestream); state.lastHeartbeat = Date.now(); }
    catch (error) { if (error.code !== 'profile_incomplete') window.alert(error.message); }
  }

  async function leaveRoom() {
    if (!state.selected) return;
    try { renderRoom((await api(`/api/livestreams/${encodeURIComponent(state.selected.id)}/leave`, { method: 'POST' })).livestream); }
    catch (error) { if (error.code !== 'profile_incomplete') window.alert(error.message); }
  }

  async function startPreview() {
    if (!state.user || !state.selected?.is_host || state.selected.status !== 'live' || !navigator.mediaDevices?.getUserMedia) return;
    try {
      state.media = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const video = $('#hostPreview'); video.srcObject = state.media; video.hidden = false; $('.stage-placeholder').hidden = true;
      video.play().catch(() => {});
      for (const peer of state.peers.values()) {
        for (const track of state.media.getTracks()) {
          const alreadySending = peer.pc.getSenders().some(sender => sender.track?.kind === track.kind);
          if (!alreadySending) peer.pc.addTrack(track, state.media);
        }
        peer.offered = false;
        makeOffer(peer).catch(() => {});
      }
    } catch (_error) {
      setStatus($('#livestreamChatStatus'), 'Camera preview is unavailable, but the room and chat are still live.', 'error');
    }
  }
  function stopPreview() {
    state.media?.getTracks().forEach(track => track.stop()); state.media = null;
    const video = $('#hostPreview'); if (video) { video.srcObject = null; video.hidden = true; }
    const placeholder = $('.stage-placeholder'); if (placeholder) placeholder.hidden = false;
  }

  root.addEventListener('click', event => {
    const watch = event.target.closest('[data-watch-stream]');
    if (watch) openRoom(watch.dataset.watchStream);
    const start = event.target.closest('[data-start-stream]');
    if (start) startStream(start.dataset.startStream);
    const end = event.target.closest('[data-end-stream]');
    if (end) endStream(end.dataset.endStream);
    const cancel = event.target.closest('[data-cancel-stream]');
    if (cancel) cancelStream(cancel.dataset.cancelStream);
  });
  $('#livestreamRefresh').addEventListener('click', loadDirectory);
  ['livestreamSearch', 'livestreamStatus', 'livestreamCategory'].forEach(id => $( `#${id}`).addEventListener(id === 'livestreamSearch' ? 'input' : 'change', () => window.clearTimeout(state.searchTimer) || (state.searchTimer = window.setTimeout(loadDirectory, 180))));
  $('#closeWatchRoom').addEventListener('click', () => { closePeers(); stopPreview(); $('#watchRoom').hidden = true; state.selected = null; });
  $('#joinLivestream').addEventListener('click', joinRoom);
  $('#leaveLivestream').addEventListener('click', leaveRoom);
  $('#enableLivestreamAudio').addEventListener('click', () => {
    const remote = $('#remoteStream');
    if (!remote) return;
    remote.muted = false;
    remote.volume = 1;
    remote.play().catch(() => {});
    $('#enableLivestreamAudio').hidden = true;
  });
  $('#endLivestream').addEventListener('click', () => state.selected && endStream(state.selected.id));
  $('#livestreamChatForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.selected) return;
    const form = new FormData(event.currentTarget);
    try {
      const payload = await api(`/api/livestreams/${encodeURIComponent(state.selected.id)}/chat`, { method: 'POST', body: { body: form.get('body'), donation_credits: Number(form.get('donation_credits') || 0) } });
      $('#livestreamChatMessage').value = ''; $('#livestreamDonation').value = '0'; if (payload.moderation?.status === 'pending') { setStatus($('#livestreamChatStatus'), payload.message || 'Your message is pending administrator review and is hidden from the room.', 'info'); return; } setStatus($('#livestreamChatStatus'), payload.balance !== undefined ? `Sent. Your balance is ${Number(payload.balance).toLocaleString()} credits.` : 'Sent.', 'success'); await loadRoom();
    } catch (error) { setStatus($('#livestreamChatStatus'), error.message, 'error'); }
  });
  $('#livestreamScheduleForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const status = $('#livestreamScheduleStatus');
    const localScheduledAt = String(form.get('scheduled_at') || '').trim();
    const scheduledAt = localScheduledAt ? new Date(localScheduledAt) : null;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) { setStatus(status, 'Choose a valid start time.', 'error'); return; }
    try {
      const payload = await api('/api/livestreams', { method: 'POST', body: { title: form.get('title'), description: form.get('description'), category: form.get('category'), tags: form.get('tags'), scheduled_at: scheduledAt ? scheduledAt.toISOString() : null, duration_minutes: Number(form.get('duration_minutes')) } });
      if (payload.moderation?.status === 'pending') { event.currentTarget.reset(); setStatus(status, payload.message || 'Your broadcast is pending administrator review and is hidden from the platform.', 'info'); return; } event.currentTarget.reset(); setStatus(status, 'Broadcast created. Start it from your broadcast list when ready.', 'success'); await loadDirectory(); openRoom(payload.livestream.id);
    } catch (error) { setStatus(status, error.message, 'error'); }
  });

  (async () => {
    try {
      const auth = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me')); state.csrf = auth.csrf_token || ''; state.user = auth.authenticated ? auth.user : null;
      if (state.user) { $('#livestreamScheduleForm').hidden = false; $('#livestreamAuthStatus').hidden = true; }
      await loadDirectory();
      if (state.user && state.selected) await startPreview();
      state.poll = window.setInterval(() => { if (!document.hidden) { loadDirectory(); if (state.selected && !$('#watchRoom').hidden) loadRoom(); } }, 5000);
      window.setInterval(() => { if (!document.hidden) pollSignals(); }, 1000);
    } catch (_error) { setStatus($('#livestreamScheduleStatus'), 'Sign in again to use the livestream studio.', 'error'); }
  })();
  window.addEventListener('pagehide', () => { closePeers(); stopPreview(); });
})();
