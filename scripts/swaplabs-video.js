(() => {
  'use strict';

  const root = document.querySelector('[data-video-page]');
  if (!root) return;

  const state = {
    csrf: '',
    user: null,
    room: null,
    inviteToken: '',
    invitePreview: null,
    guestSessionToken: '',
    isGuest: false,
    localStream: null,
    screenStream: null,
    peers: new Map(),
    seenSignals: new Set(),
    signalAfter: '',
    roomPoll: null,
    signalPoll: null,
    qualityPoll: null,
    timer: null,
    enteredAt: null,
    quality: null,
    leaving: false,
    callId: ''
  };

  const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const {escapeHtml, initials, profileColor, safeAvatarUrl} = window.RelayComponents;

  async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (writeMethods.has(method) && !state.csrf) {
      const tokenResponse = await fetch('/api/auth/csrf', {
        credentials: 'same-origin'
      });
      state.csrf = (await tokenResponse.json()).csrf_token;
    }
    const headers = {
      ...(options.headers || {})
    };
    if (writeMethods.has(method)) headers['X-CSRF-Token'] = state.csrf;
    if (state.guestSessionToken) headers['X-SwapLabs-Guest-Token'] = state.guestSessionToken;
    if (options.body && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, {
      ...options,
      method,
      headers,
      credentials: 'same-origin'
    });
    let payload;
    try {
      payload = await response.json();
    } catch (_error) {
      payload = {
        error: 'The video service returned an unreadable response.'
      };
    }
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    if (payload.moderation?.status === 'pending') {
      const error = new Error(payload.message || 'Your submission is pending administrator review and is hidden from the platform.');
      error.status = response.status;
      error.code = 'pending_moderation';
      throw error;
    }
    return payload;
  }

  function showOnly(id) {
    ['videoLoading', 'videoAuthGate', 'videoGuestGate', 'videoError', 'videoPreflight', 'videoWaiting', 'videoRoomApp'].forEach(
      elementId => {
        const element = document.getElementById(elementId);
        if (element) element.hidden = elementId !== id;
      });
  }

  function showError(message) {
    $('#videoErrorMessage').textContent = message;
    showOnly('videoError');
  }

  function setInlineStatus(message, type = '') {
    const host = $('#videoPreflightStatus');
    host.textContent = message;
    host.className = `video-inline-status ${type}`;
  }

  function avatarHtml(member) {
    const safeUrl = safeAvatarUrl(member);
    return `<span class="video-member-avatar ${escapeHtml(profileColor(member))}">${safeUrl ? `<img src="${escapeHtml(safeUrl)}" alt="">` : escapeHtml(initials(member))}</span>`;
  }

  function setLocalCameraAppearance(enabled) {
    const placeholder = $('#localVideoPlaceholder');
    const tile = $('#localVideoTile');
    if (!placeholder || !tile) return;
    const visibleVideo = enabled || Boolean(state.screenStream);
    tile.classList.toggle('camera-off', !visibleVideo);
    placeholder.hidden = visibleVideo;
    if (!visibleVideo) {
      const name = state.user?.profile?.display_name || state.user?.username || 'You';
      placeholder.innerHTML = `${avatarHtml(state.user)}<strong>${escapeHtml(name)}</strong><span>Camera off</span>`;
    }
  }

  function updateCheck(id, ready, text) {
    const card = document.getElementById(id);
    if (!card) return;
    card.classList.toggle('ready', ready);
    card.classList.toggle('failed', !ready);
    $('span', card).textContent = text;
    const icon = $('i', card);
    if (icon) icon.className = ready ? 'bx bx-check-circle' : 'bx bx-error-circle';
  }

  function networkSnapshot(extra = {}) {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const downlink = Number(connection?.downlink || 0);
    const rtt = Number(connection?.rtt || 0);
    let quality = 'good';
    if (connection?.saveData || connection?.effectiveType === '2g' || rtt > 500 || downlink && downlink < .5) {
      quality = 'poor';
    } else if (connection?.effectiveType === '3g' || rtt > 250 || downlink && downlink < 1.5) {
      quality = 'fair';
    } else if (rtt && rtt < 100 && (!downlink || downlink >= 5)) {
      quality = 'excellent';
    }
    return {
      quality,
      rtt_ms: extra.rtt_ms ?? (rtt || null),
      packet_loss_pct: extra.packet_loss_pct ?? null,
      downlink_mbps: downlink || null,
      effective_type: connection?.effectiveType || 'unknown',
      camera_ready: Boolean(state.localStream?.getVideoTracks().length),
      microphone_ready: Boolean(state.localStream?.getAudioTracks().length)
    };
  }

  function updateNetworkCheck(snapshot) {
    const ready = !['poor', 'unknown'].includes(snapshot.quality);
    const details = [snapshot.quality, snapshot.downlink_mbps ? `${snapshot.downlink_mbps} Mbps` : '', snapshot
      .rtt_ms ? `${Math.round(snapshot.rtt_ms)} ms` : ''].filter(Boolean).join(' · ');
    updateCheck('networkCheck', ready, details || 'Connection available');
  }

  async function populateDeviceChoices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const camera = $('#videoCameraSelect');
    const microphone = $('#videoMicrophoneSelect');
    const selectedCamera = camera.value;
    const selectedMicrophone = microphone.value;
    camera.innerHTML = '<option value="">Default camera</option>' + devices.filter(device => device.kind ===
      'videoinput').map((device, index) =>
      `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `Camera ${index + 1}`)}</option>`
    ).join('');
    microphone.innerHTML = '<option value="">Default microphone</option>' + devices.filter(device => device.kind ===
      'audioinput').map((device, index) =>
      `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `Microphone ${index + 1}`)}</option>`
    ).join('');
    if ([...camera.options].some(option => option.value === selectedCamera)) camera.value = selectedCamera;
    if ([...microphone.options].some(option => option.value === selectedMicrophone)) microphone.value =
      selectedMicrophone;
  }

  function stopLocalStream() {
    state.localStream?.getTracks().forEach(track => track.stop());
    state.localStream = null;
  }

  async function startPreview() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setInlineStatus('This browser does not support camera and microphone access.', 'error');
      $('#videoJoinButton').disabled = true;
      return;
    }
    const voiceCall = state.room?.video_enabled === false;
    setInlineStatus(voiceCall ? 'Requesting permission for your microphone.' : 'Requesting permission for your camera and microphone.');
    stopLocalStream();
    const cameraId = $('#videoCameraSelect').value;
    const microphoneId = $('#videoMicrophoneSelect').value;
    const videoConstraints = voiceCall ? false : cameraId ? {
      deviceId: {
        exact: cameraId
      },
      width: {
        ideal: 1280
      },
      height: {
        ideal: 720
      }
    } : {
      width: {
        ideal: 1280
      },
      height: {
        ideal: 720
      }
    };
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: microphoneId ? {
          deviceId: {
            exact: microphoneId
          },
          echoCancellation: true,
          noiseSuppression: true
        } : {
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      $('#videoPreview').srcObject = state.localStream;
      $('#videoPreviewPlaceholder').hidden = !voiceCall;
      if (voiceCall) $('#videoPreviewPlaceholder').innerHTML = '<i class="bx bx-phone-call"></i><strong>Voice call</strong><span>Your camera is not needed.</span>';
      updateCheck('cameraCheck', voiceCall || state.localStream.getVideoTracks().length > 0, voiceCall ? 'Not needed for voice call' : state.localStream.getVideoTracks().length ? 'Ready' : 'No camera track');
      updateCheck('microphoneCheck', state.localStream.getAudioTracks().length > 0, state.localStream.getAudioTracks()
        .length ? 'Ready' : 'No microphone track');
      updateNetworkCheck(networkSnapshot());
      await populateDeviceChoices();
      $('#videoJoinButton').disabled = false;
      setInlineStatus('Your devices are ready. You can now ask to join.', 'success');
    } catch (error) {
      $('#videoPreview').srcObject = null;
      $('#videoPreviewPlaceholder').hidden = false;
      updateCheck('cameraCheck', false, 'Permission or device unavailable');
      updateCheck('microphoneCheck', false, 'Permission or device unavailable');
      updateNetworkCheck(networkSnapshot());
      $('#videoJoinButton').disabled = true;
      setInlineStatus(
        error.name === 'NotAllowedError' ?
        voiceCall ? 'Microphone permission was denied. Allow access in the browser and test again.' : 'Camera or microphone permission was denied. Allow access in the browser and test again.' :
        `Device check failed: ${error.message}`, 'error');
    }
  }

  function roomAttendance(userId) {
    return state.room?.attendance?.find(record => record.user_id === userId) || null;
  }

  function admittedMemberIds() {
    return (state.room?.attendance || []).filter(record => ['admitted', 'in_call'].includes(record.state)).map(
      record => record.user_id);
  }

  function renderHostSettings() {
    if (!state.room?.viewer_is_host) return '';
    return `<div class="video-host-settings"><strong><i class="bx bx-slider-alt"></i> Host room controls</strong><label><input type="checkbox" data-room-setting="waiting_room_enabled" ${state.room.waiting_room_enabled ? 'checked' : ''}> Waiting room required</label><label><input type="checkbox" data-room-setting="screen_sharing_enabled" ${state.room.screen_sharing_enabled ? 'checked' : ''}> Screen sharing allowed</label></div>`;
  }

  function inviteLink() {
    if (!state.room?.invite_token) return '';
    const link = new URL('video-room.html', window.location.href);
    link.search = `?invite=${encodeURIComponent(state.room.invite_token)}`;
    return link.toString();
  }

  function renderInviteShare() {
    const share = $('#videoInviteShare');
    if (!share) return;
    const visible = Boolean(!state.callId && state.room?.invite_token && state.room?.viewer_is_host);
    share.hidden = !visible;
    if (!visible) return;
    const status = $('#videoInviteShareStatus');
    if (status) status.textContent = '';
  }

  async function copyInviteLink() {
    const link = inviteLink();
    if (!link) return;
    const status = $('#videoInviteShareStatus');
    const button = $('#copyVideoInviteLink');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        const input = document.createElement('input');
        input.value = link;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      if (status) status.textContent = 'Copied';
      if (button) button.innerHTML = '<i class="bx bx-check"></i> Copied';
      window.setTimeout(() => {
        if (status) status.textContent = '';
        if (button) button.innerHTML = '<i class="bx bx-link"></i> Copy invite link';
      }, 2200);
    } catch (_error) {
      if (status) status.textContent = 'Copy failed — select the link again.';
    }
  }

  function renderGuestInvite() {
    const invite = state.invitePreview;
    if (!invite) return;
    $('#videoGuestTitle').textContent = `${invite.host?.display_name || 'Someone'} invited you to a SwapLabs room.`;
    $('#videoGuestSummary').textContent = invite.starts_at ?
      `Enter your name to request access to “${invite.title}”. The meeting starts ${new Date(invite.starts_at).toLocaleString()}.` :
      `Enter your name to request access to “${invite.title}”. You do not need a SwapLabs account for this invite.`;
    $('#videoGuestName')?.focus();
  }

  async function joinInviteAsGuest(event) {
    event.preventDefault();
    const form = $('#videoGuestForm');
    const button = $('#videoGuestJoinButton');
    const status = $('#videoGuestStatus');
    const displayName = $('#videoGuestName').value.trim();
    if (displayName.length < 2) {
      status.textContent = 'Enter at least two characters for your name.';
      status.className = 'video-inline-status error';
      return;
    }
    button.disabled = true;
    button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Preparing meeting';
    status.textContent = '';
    try {
      const result = await api(`/api/video/invites/${encodeURIComponent(state.inviteToken)}/join`, {
        method: 'POST',
        body: {display_name: displayName}
      });
      state.guestSessionToken = result.guest_session_token;
      state.isGuest = true;
      state.user = {
        id: result.guest_id,
        username: `guest-${String(result.guest_id).slice(-8)}`,
        role: 'guest',
        profile: {display_name: result.guest_name, profile_color: 'blue', avatar_url: ''}
      };
      state.room = result.room;
      renderRoomData();
      showOnly('videoPreflight');
      await startPreview();
      startRoomPoll();
    } catch (error) {
      status.textContent = error.message;
      status.className = 'video-inline-status error';
      button.disabled = false;
      button.innerHTML = '<i class="bx bx-log-in-circle"></i> Continue to device check';
      form?.setAttribute('aria-invalid', 'true');
    }
  }

  function renderRoomData() {
    if (!state.room) return;
    const voiceCall = state.room.video_enabled === false || state.room.call_mode === 'voice';
    root.classList.toggle('relay-voice-room', voiceCall);
    $('#videoRoomTitle').textContent = state.room.title;
    const event = state.room.event;
    $('#videoRoomMeta').textContent = event ? `${new Date(event.starts_at).toLocaleString()} · ${event.timezone}` :
      voiceCall ? 'Direct voice call · 1 credit' : 'Member video room';
    $('#videoPageTitle').textContent = state.room.title;
    $('#videoPageSummary').textContent = voiceCall ?
      'A private SwapLabs voice call. You can add participants after the call connects.' : state.room.waiting_room_enabled ?
      'A protected SwapLabs room with host admission, attendance confirmation, and connection monitoring.' :
      'A SwapLabs live session with attendance confirmation and connection monitoring.';
    renderInviteShare();
    $('#cameraCheck').hidden = voiceCall;
    $('#videoCameraSelect').closest('label')?.toggleAttribute('hidden', voiceCall);
    $('#shareScreen').hidden = voiceCall;
    $('#toggleCamera').hidden = voiceCall;
    $('#confirmAttendance').hidden = Boolean(state.callId);
    const addParticipants = $('#videoCallAddParticipants');
    if (addParticipants) addParticipants.hidden = !state.callId || !state.room.viewer_is_participant;
    $('#shareScreen').disabled = voiceCall || !state.room.screen_sharing_enabled;
    $('#videoPeopleCount').textContent = `${state.room.participants?.length || 0} invited`;
    const attendanceByMember = new Map((state.room.attendance || []).map(record => [record.user_id, record]));
    $('#videoParticipantList').innerHTML = renderHostSettings() + (state.room.participants || []).map(member => {
      const record = attendanceByMember.get(member.id);
      const status = record?.state || 'invited';
      return `<article class="video-participant-row">${avatarHtml(member)}<div><strong>${escapeHtml(member.display_name)}${member.id === state.room.host_id ? ' <span class="host-label">Host</span>' : ''}</strong><span>${escapeHtml(status.replaceAll('_', ' '))}</span></div><i class="bx ${status === 'in_call' ? 'bx-video' : status === 'waiting' ? 'bx-time-five' : status === 'left' ? 'bx-log-out' : 'bx-user-check'}"></i></article>`;
    }).join('');

    const waiting = (state.room.attendance || []).filter(record => record.state === 'waiting');
    $('#hostWaitingRoom').hidden = !state.room.viewer_is_host;
    $('#videoWaitingList').innerHTML = waiting.length ? waiting.map(record =>
      `<article>${avatarHtml(record.member)}<div><strong>${escapeHtml(record.member?.display_name || 'Member')}</strong><span>Device check received</span></div><button class="admit" type="button" data-waiting-action="admit" data-member-id="${escapeHtml(record.user_id)}" title="Admit"><i class="bx bx-check"></i></button><button class="deny" type="button" data-waiting-action="deny" data-member-id="${escapeHtml(record.user_id)}" title="Deny"><i class="bx bx-x"></i></button></article>`
    ).join('') : '<div class="video-side-empty"><i class="bx bx-check-circle"></i><span>No one is waiting.</span></div>';

    const records = state.room.attendance || [];
    $('#videoAttendanceList').innerHTML = records.length ? records.map(record => {
      const confirmed = record.participant_confirmed && record.host_confirmed;
      const minutes = Math.max(0, Math.round(Number(record.duration_seconds || 0) / 60));
      const hostButton = state.room.viewer_is_host && record.user_id !== state.room.host_id && !record
        .host_confirmed ?
        `<button type="button" data-confirm-participant="${escapeHtml(record.user_id)}">Confirm attendance</button>` : '';
      return `<article class="video-attendance-row">${avatarHtml(record.member)}<div><strong>${escapeHtml(record.member?.display_name || 'Member')}</strong><span>${minutes} min · member ${record.participant_confirmed ? 'confirmed' : 'pending'} · host ${record.host_confirmed ? 'confirmed' : 'pending'}</span></div><span class="attendance-state ${confirmed ? 'complete' : ''}"><i class="bx ${confirmed ? 'bx-check-shield' : 'bx-time-five'}"></i>${confirmed ? 'Complete' : 'Pending'}</span>${hostButton}</article>`;
    }).join('') : '<div class="video-side-empty"><i class="bx bx-calendar-x"></i><span>No attendance records yet.</span></div>';

    const mine = roomAttendance(state.user.id);
    const confirmButton = $('#confirmAttendance');
    if (confirmButton) {
      confirmButton.classList.toggle('active', Boolean(mine?.participant_confirmed));
      $('span', confirmButton).textContent = mine?.participant_confirmed ? 'Confirmed' : 'Confirm';
    }
  }

  async function refreshRoom() {
    if (!state.room || state.leaving) return;
    try {
      const result = await api(`/api/video/rooms/${encodeURIComponent(state.room.id)}`);
      const previousState = roomAttendance(state.user.id)?.state;
      state.room = result.room;
      const callResult = state.callId ? await api(`/api/calls/${encodeURIComponent(state.callId)}`) : null;
      if (state.callId && ['ended', 'declined'].includes(callResult?.call?.status)) {
        stopCallResources();
        sessionStorage.setItem('swaplabs-video-notice', callResult.call.status === 'declined' ? 'The call was declined.' : 'The call ended.');
        location.href = 'notifications.html';
        return;
      }
      renderRoomData();
      const mine = roomAttendance(state.user.id);
      if (state.room.status === 'closed') {
        await leaveRoom('The host closed this video room.');
        return;
      }
      if (mine?.state === 'admitted' && previousState === 'waiting') await enterCall();
      if (['denied', 'removed'].includes(mine?.state)) {
        stopCallResources();
        showError(mine.state === 'denied' ? 'The host did not admit this request.' :
          'The host removed this account from the room.');
        return;
      }
      if (['admitted', 'in_call'].includes(mine?.state) && !$('#videoRoomApp').hidden) syncPeers();
    } catch (error) {
      if (![401, 403, 404].includes(error.status)) return;
      showError(error.message);
      stopCallResources();
    }
  }

  async function askToJoin() {
    const button = $('#videoJoinButton');
    button.disabled = true;
    button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Sending request';
    try {
      const result = await api(`/api/video/rooms/${encodeURIComponent(state.room.id)}/join`, {
        method: 'POST',
        body: {
          connection_check: networkSnapshot()
        }
      });
      state.room = result.room;
      renderRoomData();
      const mine = roomAttendance(state.user.id);
      if (['admitted', 'in_call'].includes(mine?.state)) {
        await enterCall();
      } else {
        $('#videoWaitingMessage').textContent = `The host of ${state.room.title} has been notified. Your device preview stays private while you wait.`;
        showOnly('videoWaiting');
      }
      startRoomPoll();
    } catch (error) {
      setInlineStatus(error.message, 'error');
      button.disabled = false;
      button.innerHTML = '<i class="bx bx-log-in-circle"></i> Ask to join room';
    }
  }

  function memberById(userId) {
    return state.room?.participants?.find(member => member.id === userId) || null;
  }

  function remoteTile(userId) {
    let tile = document.getElementById(`remote-${userId}`);
    const member = memberById(userId);
    const displayName = member?.display_name || member?.profile?.display_name || 'Participant';
    if (!tile) {
      tile = document.createElement('article');
      tile.className = 'video-tile remote connecting';
      tile.id = `remote-${userId}`;
      tile.innerHTML = `<video autoplay playsinline></video><div class="video-tile-placeholder">${avatarHtml(member)}<strong></strong><span>Connecting video</span></div><div class="video-tile-name"><span></span><i class="bx bx-wifi"></i></div>`;
      $('#videoGrid').appendChild(tile);
    }
    // Keep the participant card visible before WebRTC delivers its first
    // track, and refresh the identity if the room payload arrives later.
    $('.video-tile-placeholder strong', tile).textContent = displayName;
    $('.video-tile-name span', tile).textContent = displayName;
    const placeholderAvatar = $('.video-tile-placeholder .video-member-avatar', tile);
    if (!placeholderAvatar && member) {
      $('.video-tile-placeholder', tile).insertAdjacentHTML('afterbegin', avatarHtml(member));
    }
    return tile;
  }

  function remoteVideoReady(tile) {
    const stream = $('video', tile)?.srcObject;
    return Boolean(stream?.getVideoTracks?.().some(track => track.readyState !== 'ended'));
  }

  function updateRemoteTileAppearance(userId, connectingLabel = 'Connecting video') {
    const tile = remoteTile(userId);
    const peerState = state.peers.get(userId);
    const cameraEnabled = peerState?.videoEnabled !== false;
    const hasVideo = remoteVideoReady(tile);
    const placeholder = $('.video-tile-placeholder', tile);
    tile.classList.toggle('camera-off', !cameraEnabled || !hasVideo);
    tile.classList.toggle('connecting', !hasVideo);
    placeholder.hidden = cameraEnabled && hasVideo;
    if (!hasVideo) $('span', placeholder).textContent = cameraEnabled ? connectingLabel : 'Camera off';
    return tile;
  }

  async function sendSignal(targetId, type, payload) {
    await api(`/api/video/rooms/${encodeURIComponent(state.room.id)}/signals`, {
      method: 'POST',
      body: {
        target_id: targetId,
        type,
        payload
      }
    });
  }

  function sendMediaState(targetId) {
    const cameraTrack = state.localStream?.getVideoTracks()[0];
    return sendSignal(targetId, 'media-state', {
      video: Boolean(cameraTrack?.enabled),
      audio: Boolean(state.localStream?.getAudioTracks()[0]?.enabled),
      screen: Boolean(state.screenStream)
    });
  }

  function broadcastMediaState() {
    for (const peerState of state.peers.values()) sendMediaState(peerState.userId).catch(() => {});
  }

  async function makeOffer(peerState) {
    if (peerState.offered || peerState.pc.signalingState !== 'stable') return;
    peerState.makingOffer = true;
    try {
      const offer = await peerState.pc.createOffer();
      await peerState.pc.setLocalDescription(offer);
      peerState.offered = true;
      await sendSignal(peerState.userId, 'offer', peerState.pc.localDescription.toJSON());
    } finally {
      peerState.makingOffer = false;
    }
  }

  function ensurePeer(userId, initiate = false) {
    if (state.peers.has(userId)) return state.peers.get(userId);
    const pc = new RTCPeerConnection({
      iceServers: []
    });
    const peerState = {
      userId,
      pc,
      makingOffer: false,
      offered: false,
      videoEnabled: true,
      pendingIce: [],
      lastBytes: 0,
      lastMeasuredAt: Date.now()
    };
    state.localStream?.getTracks().forEach(track => pc.addTrack(track, state.localStream));
    pc.addEventListener('icecandidate', event => {
      if (event.candidate) sendSignal(userId, 'ice', event.candidate.toJSON()).catch(() => {});
    });
    pc.addEventListener('track', event => {
      const tile = remoteTile(userId);
      const video = $('video', tile);
      const stream = event.streams?.[0] || video.srcObject || new MediaStream();
      if (!event.streams?.[0] && event.track && !stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      if (video.srcObject !== stream) video.srcObject = stream;
      updateRemoteTileAppearance(userId);
      video.play?.().catch(() => {});
    });
    pc.addEventListener('connectionstatechange', () => {
      const tile = remoteTile(userId);
      tile.dataset.connection = pc.connectionState;
      const label = pc.connectionState === 'failed' ? 'Connection failed' : pc.connectionState === 'closed' ? 'Participant left' : 'Connecting video';
      updateRemoteTileAppearance(userId, label);
    });
    state.peers.set(userId, peerState);
    sendMediaState(userId).catch(() => {});
    if (initiate) setTimeout(() => makeOffer(peerState).catch(() => {}), 80);
    return peerState;
  }

  async function flushIce(peerState) {
    if (!peerState.pc.remoteDescription) return;
    const candidates = peerState.pendingIce.splice(0);
    for (const candidate of candidates) {
      try {
        await peerState.pc.addIceCandidate(candidate);
      } catch (_error) {
        // A stale candidate can be ignored when a participant reconnects.
      }
    }
  }

  async function handleSignal(signal) {
    const peerState = ensurePeer(signal.from_id, false);
    const pc = peerState.pc;
    if (signal.type === 'media-state') {
      peerState.videoEnabled = signal.payload?.video !== false || signal.payload?.screen === true;
      updateRemoteTileAppearance(signal.from_id);
      return;
    }
    if (signal.type === 'offer') {
      if (pc.signalingState !== 'stable') {
        try {
          await pc.setLocalDescription({
            type: 'rollback'
          });
        } catch (_error) {
          // The deterministic initiator normally prevents an offer collision.
        }
      }
      await pc.setRemoteDescription(signal.payload);
      await flushIce(peerState);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(signal.from_id, 'answer', pc.localDescription.toJSON());
    } else if (signal.type === 'answer') {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(signal.payload);
        await flushIce(peerState);
      }
    } else if (signal.type === 'ice') {
      if (pc.remoteDescription) {
        try {
          await pc.addIceCandidate(signal.payload);
        } catch (_error) {
          // Ignore an ICE candidate that belongs to a connection already replaced.
        }
      } else {
        peerState.pendingIce.push(signal.payload);
      }
    }
  }

  async function pollSignals() {
    if (!state.room || state.leaving) return;
    try {
      const query = state.signalAfter ? `?after=${encodeURIComponent(state.signalAfter)}` : '';
      const result = await api(`/api/video/rooms/${encodeURIComponent(state.room.id)}/signals${query}`);
      for (const signal of result.signals || []) {
        if (state.seenSignals.has(signal.id)) continue;
        state.seenSignals.add(signal.id);
        await handleSignal(signal);
      }
      state.signalAfter = result.server_time || new Date().toISOString();
      if (state.seenSignals.size > 1000) state.seenSignals = new Set([...state.seenSignals].slice(-500));
    } catch (error) {
      if ([401, 403, 404].includes(error.status)) clearInterval(state.signalPoll);
    }
  }

  function syncPeers() {
    const admitted = new Set(admittedMemberIds().filter(userId => userId !== state.user.id));
    admitted.forEach(userId => {
      // Render a stable remote tile immediately. The participant must remain
      // visible while ICE/SDP negotiation is still in progress or when their
      // camera is disabled; waiting for a `track` event made the grid collapse
      // to the local tile intermittently.
      remoteTile(userId);
      const shouldInitiate = state.user.id.localeCompare(userId) < 0;
      ensurePeer(userId, shouldInitiate);
    });
    for (const [userId, peerState] of state.peers) {
      if (admitted.has(userId)) continue;
      peerState.pc.close();
      state.peers.delete(userId);
      document.getElementById(`remote-${userId}`)?.remove();
    }
  }

  async function enterCall() {
    if (!state.localStream) await startPreview();
    if (!state.localStream) return;
    showOnly('videoRoomApp');
    $('#localVideo').srcObject = state.localStream;
    setLocalCameraAppearance(Boolean(state.localStream.getVideoTracks()[0]?.enabled));
    state.enteredAt = state.enteredAt || Date.now();
    state.signalAfter = state.room.created_at || new Date(Date.now() - 60_000).toISOString();
    try {
      const result = await api(`/api/video/rooms/${encodeURIComponent(state.room.id)}/attendance`, {
        method: 'POST',
        body: {
          action: 'joined'
        }
      });
      state.room = result.room;
    } catch (error) {
      showError(error.message);
      return;
    }
    renderRoomData();
    syncPeers();
    clearInterval(state.signalPoll);
    state.signalPoll = setInterval(pollSignals, 900);
    pollSignals();
    clearInterval(state.qualityPoll);
    state.qualityPoll = setInterval(measureConnectionQuality, 8000);
    measureConnectionQuality();
    clearInterval(state.timer);
    state.timer = setInterval(updateCallTimer, 1000);
    updateCallTimer();
  }

  function updateCallTimer() {
    const elapsed = Math.max(0, Math.round((Date.now() - (state.enteredAt || Date.now())) / 1000));
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor(elapsed % 3600 / 60);
    const seconds = elapsed % 60;
    $('#videoCallTimer').textContent = `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  async function measureConnectionQuality() {
    let totalPackets = 0;
    let lostPackets = 0;
    const rttValues = [];
    for (const peerState of state.peers.values()) {
      try {
        const reports = await peerState.pc.getStats();
        reports.forEach(report => {
          if (report.type === 'inbound-rtp' && !report.isRemote) {
            totalPackets += Number(report.packetsReceived || 0);
            lostPackets += Number(report.packetsLost || 0);
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
            rttValues.push(Number(report.currentRoundTripTime) * 1000);
          }
        });
      } catch (_error) {
        // A peer may close while stats are being gathered.
      }
    }
    const packetLoss = totalPackets + lostPackets > 0 ? lostPackets / (totalPackets + lostPackets) * 100 : 0;
    const rtt = rttValues.length ? rttValues.reduce((sum, value) => sum + value, 0) / rttValues.length : Number(
      networkSnapshot().rtt_ms || 0);
    let quality = 'excellent';
    if (packetLoss > 8 || rtt > 500) quality = 'poor';
    else if (packetLoss > 4 || rtt > 300) quality = 'fair';
    else if (packetLoss > 1.5 || rtt > 160) quality = 'good';
    const snapshot = networkSnapshot({
      quality,
      rtt_ms: rtt || null,
      packet_loss_pct: Number(packetLoss.toFixed(2))
    });
    snapshot.quality = quality;
    state.quality = snapshot;
    const pill = $('#videoQualityPill');
    pill.className = `connection-pill ${quality}`;
    pill.innerHTML = `<i class="bx bx-wifi"></i> ${quality[0].toUpperCase() + quality.slice(1)}${rtt ? ` · ${Math.round(rtt)} ms` : ''}${packetLoss ? ` · ${packetLoss.toFixed(1)}% loss` : ''}`;
    try {
      await api(`/api/video/rooms/${encodeURIComponent(state.room.id)}/attendance`, {
        method: 'POST',
        body: {
          action: 'quality',
          connection_check: snapshot
        }
      });
    } catch (_error) {
      // The next quality sample will retry if the room is still open.
    }
  }

  function startRoomPoll() {
    clearInterval(state.roomPoll);
    state.roomPoll = setInterval(refreshRoom, 1700);
  }

  function stopCallResources() {
    clearInterval(state.roomPoll);
    clearInterval(state.signalPoll);
    clearInterval(state.qualityPoll);
    clearInterval(state.timer);
    state.screenStream?.getTracks().forEach(track => track.stop());
    state.screenStream = null;
    for (const peerState of state.peers.values()) peerState.pc.close();
    state.peers.clear();
    stopLocalStream();
  }

  async function leaveRoom(message = '') {
    if (state.leaving) return;
    state.leaving = true;
    if (state.callId && !state.isGuest) {
      try {
        await api(`/api/calls/${encodeURIComponent(state.callId)}`, {
          method: 'PATCH',
          body: {action: 'end'}
        });
      } catch (_error) {
        // The call may already have been ended by the other participant.
      }
    }
    try {
      if (state.room && roomAttendance(state.user.id)) {
        await api(`/api/video/rooms/${encodeURIComponent(state.room.id)}/attendance`, {
          method: 'POST',
          body: {
            action: 'left'
          }
        });
      }
    } catch (_error) {
      // Local media still closes even if the attendance update cannot reach the server.
    }
    stopCallResources();
    if (message) sessionStorage.setItem('swaplabs-video-notice', message);
    location.href = state.isGuest ? 'index.html' : state.callId ? 'notifications.html' : 'calendar.html';
  }

  async function toggleScreenShare() {
    if (!state.room.screen_sharing_enabled) return;
    const button = $('#shareScreen');
    if (state.screenStream) {
      await stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      button.title = 'Screen sharing is not supported in this browser';
      return;
    }
    try {
      state.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });
      const screenTrack = state.screenStream.getVideoTracks()[0];
      for (const peerState of state.peers.values()) {
        const sender = peerState.pc.getSenders().find(item => item.track?.kind === 'video');
        if (sender) await sender.replaceTrack(screenTrack);
      }
      $('#localVideo').srcObject = state.screenStream;
      setLocalCameraAppearance(true);
      broadcastMediaState();
      button.classList.add('active');
      $('i', button).className = 'bx bx-stop-circle';
      $('span', button).textContent = 'Stop share';
      screenTrack.addEventListener('ended', stopScreenShare, {
        once: true
      });
    } catch (_error) {
      // Cancelling the browser's screen chooser requires no additional action.
    }
  }

  async function stopScreenShare() {
    if (!state.screenStream) return;
    const screenStream = state.screenStream;
    state.screenStream = null;
    screenStream.getTracks().forEach(track => track.stop());
    const cameraTrack = state.localStream?.getVideoTracks()[0] || null;
    for (const peerState of state.peers.values()) {
      const sender = peerState.pc.getSenders().find(item => item.track?.kind === 'video');
      if (sender) await sender.replaceTrack(cameraTrack);
    }
    $('#localVideo').srcObject = state.localStream;
    setLocalCameraAppearance(Boolean(cameraTrack?.enabled));
    broadcastMediaState();
    const button = $('#shareScreen');
    button.classList.remove('active');
    $('i', button).className = 'bx bx-desktop';
    $('span', button).textContent = 'Share';
  }

  function toggleTrack(kind) {
    const track = kind === 'audio' ? state.localStream?.getAudioTracks()[0] : state.localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const button = kind === 'audio' ? $('#toggleMicrophone') : $('#toggleCamera');
    button.classList.toggle('off', !track.enabled);
    $('i', button).className = kind === 'audio' ?
      `bx ${track.enabled ? 'bx-microphone' : 'bx-microphone-off'}` :
      `bx ${track.enabled ? 'bx-video' : 'bx-video-off'}`;
    $('span', button).textContent = kind === 'audio' ? (track.enabled ? 'Mute' : 'Unmute') : (track.enabled ?
      'Camera' : 'Start video');
    if (kind === 'audio') $('#localMicIndicator').className = `bx ${track.enabled ? 'bx-microphone' : 'bx-microphone-off'}`;
    if (kind === 'video') setLocalCameraAppearance(track.enabled);
    broadcastMediaState();
  }

  async function confirmAttendance(targetId = state.user.id) {
    try {
      const result = await api(`/api/video/rooms/${encodeURIComponent(state.room.id)}/attendance`, {
        method: 'POST',
        body: {
          action: 'confirm',
          target_id: targetId
        }
      });
      state.room = result.room;
      renderRoomData();
    } catch (error) {
      $('#videoRoomMeta').textContent = error.message;
    }
  }

  function bindRoomInteractions() {
    $('#videoRetryDevices').addEventListener('click', startPreview);
    $('#videoCameraSelect').addEventListener('change', startPreview);
    $('#videoMicrophoneSelect').addEventListener('change', startPreview);
    $('#videoJoinButton').addEventListener('click', askToJoin);
    $('#videoGuestForm')?.addEventListener('submit', joinInviteAsGuest);
    $('#copyVideoInviteLink')?.addEventListener('click', copyInviteLink);
    $('#videoCancelWaiting').addEventListener('click', () => leaveRoom());
    $('#toggleMicrophone').addEventListener('click', () => toggleTrack('audio'));
    $('#toggleCamera').addEventListener('click', () => toggleTrack('video'));
    $('#shareScreen').addEventListener('click', toggleScreenShare);
    $('#videoCallAddParticipants')?.addEventListener('click', async () => {
      if (!state.callId || !window.SwapLabsCalls?.inviteParticipant) return;
      const response = await window.SwapLabsCalls.inviteParticipant(state.callId, state.room?.participant_ids || []);
      if (response?.room) {
        state.room = response.room;
        renderRoomData();
      }
    });
    $('#confirmAttendance').addEventListener('click', () => confirmAttendance());
    $('#leaveVideoRoom').addEventListener('click', () => leaveRoom());
    $('.video-side-tabs').addEventListener('click', event => {
      const button = event.target.closest('[data-video-tab]');
      if (!button) return;
      $$('.video-side-tabs button').forEach(item => item.classList.toggle('active', item === button));
      $('#videoPeoplePanel').hidden = button.dataset.videoTab !== 'people';
      $('#videoAttendancePanel').hidden = button.dataset.videoTab !== 'attendance';
    });
    $('#videoParticipantList').addEventListener('change', async event => {
      const setting = event.target.dataset.roomSetting;
      if (!setting) return;
      try {
        const result = await api(`/api/video/rooms/${encodeURIComponent(state.room.id)}`, {
          method: 'PATCH',
          body: {
            [setting]: event.target.checked
          }
        });
        state.room = result.room;
        renderRoomData();
      } catch (error) {
        event.target.checked = !event.target.checked;
        $('#videoRoomMeta').textContent = error.message;
      }
    });
    $('#videoWaitingList').addEventListener('click', async event => {
      const button = event.target.closest('[data-waiting-action]');
      if (!button) return;
      button.disabled = true;
      try {
        const result = await api(
          `/api/video/rooms/${encodeURIComponent(state.room.id)}/participants/${encodeURIComponent(button.dataset.memberId)}`, {
            method: 'PATCH',
            body: {
              action: button.dataset.waitingAction
            }
          });
        state.room = result.room;
        renderRoomData();
        syncPeers();
      } catch (error) {
        $('#videoRoomMeta').textContent = error.message;
        button.disabled = false;
      }
    });
    $('#videoAttendanceList').addEventListener('click', event => {
      const button = event.target.closest('[data-confirm-participant]');
      if (button) confirmAttendance(button.dataset.confirmParticipant);
    });
    window.addEventListener('beforeunload', () => {
      if (!state.room || state.leaving || !roomAttendance(state.user?.id)) return;
      fetch(`/api/video/rooms/${encodeURIComponent(state.room.id)}/attendance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': state.csrf,
          ...(state.guestSessionToken ? {'X-SwapLabs-Guest-Token': state.guestSessionToken} : {})
        },
        body: JSON.stringify({
          action: 'left'
        }),
        credentials: 'same-origin',
        keepalive: true
      });
    });
  }

  async function resolveRoom() {
    const parameters = new URLSearchParams(location.search);
    const roomId = parameters.get('room');
    const eventId = parameters.get('event');
    if (!roomId && !eventId) throw new Error('Open a room from a SwapLabs calendar event.');
    if (roomId) return (await api(`/api/video/rooms/${encodeURIComponent(roomId)}`)).room;
    return (await api('/api/video/rooms', {
      method: 'POST',
      body: {
        event_id: eventId,
        waiting_room_enabled: true,
        screen_sharing_enabled: true
      }
    })).room;
  }

  async function initialize() {
    bindRoomInteractions();
    try {
      const parameters = new URLSearchParams(location.search);
      state.inviteToken = parameters.get('invite') || '';
      state.callId = parameters.get('call') || '';
      const auth = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me'));
      state.csrf = auth.csrf_token || state.csrf;
      if (state.inviteToken) {
        if (auth.authenticated) {
          state.user = auth.user;
          state.room = (await api(`/api/video/invites/${encodeURIComponent(state.inviteToken)}/join`, {
            method: 'POST',
            body: {}
          })).room;
          renderRoomData();
          showOnly('videoPreflight');
          await startPreview();
          startRoomPoll();
          return;
        }
        state.invitePreview = (await api(`/api/video/invites/${encodeURIComponent(state.inviteToken)}`)).invite;
        renderGuestInvite();
        showOnly('videoGuestGate');
        return;
      }
      if (!auth.authenticated) {
        showOnly('videoAuthGate');
        return;
      }
      state.user = auth.user;
      state.room = await resolveRoom();
      renderRoomData();
      showOnly('videoPreflight');
      await startPreview();
      if (state.callId) {
        await enterCall();
        startRoomPoll();
      } else startRoomPoll();
    } catch (error) {
      showError(error.message);
    }
  }

  initialize();
})();
