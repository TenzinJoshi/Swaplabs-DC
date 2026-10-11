(() => {
  'use strict';

  const root = document.querySelector('[data-study-page]');
  if (!root) return;

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const components = window.RelayComponents || {};
  const escapeHtml = components.escapeHtml || (value => String(value ?? '').replace(/[&<>'"]/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[character])));
  const displayName = components.displayName || (person => person?.display_name || person?.username || 'SwapLabs member');
  const avatar = components.avatar || (() => '');
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const weekdays = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']];
  const localPreview = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname);

  const state = {
    csrf: '',
    auth: null,
    user: null,
    overview: null,
    profile: null,
    matches: [],
    rooms: [],
    sessions: [],
    selectedMatch: null,
    session: null,
    messages: [],
    presence: {},
    timer: {phase: 'idle', ends_at: null, round: 0},
    windows: [],
    socket: null,
    sessionPoll: 0,
    timerTick: 0,
    connected: false,
    whiteboard: [],
    drawing: null
  };

  const setText = (selector, value) => {
    const element = $(selector);
    if (element) element.textContent = String(value ?? '');
  };

  const formatDateTime = value => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Time to be confirmed';
    return new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}).format(date);
  };

  const formatDate = value => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Date to be confirmed';
    return new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric'}).format(date);
  };

  const localDateTimeValue = (date = new Date(Date.now() + 60 * 60 * 1000)) => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  };

  const asList = value => (Array.isArray(value) ? value : String(value || '').split(','))
    .map(item => String(item).trim()).filter(item => item && item.toLowerCase() !== 'nothing for now');

  const uniqueList = value => [...new Set(asList(value))];

  const status = (target, message, error = false) => {
    const element = typeof target === 'string' ? $(target) : target;
    if (!element) return;
    element.textContent = message || '';
    const pending = /pending (?:administrator )?review/i.test(String(message || ''));
    element.classList.toggle('is-error', Boolean(error) && !pending);
  };

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = {...(options.headers || {})};
    if (writeMethods.has(method) && !state.csrf) {
      const csrfResponse = await fetch('/api/auth/csrf', {credentials: 'same-origin', cache: 'no-store'});
      const csrfPayload = await csrfResponse.json().catch(() => ({}));
      if (!csrfResponse.ok || !csrfPayload.csrf_token) throw new Error('Could not establish a secure session. Refresh and try again.');
      state.csrf = csrfPayload.csrf_token;
    }
    if (writeMethods.has(method)) headers['X-CSRF-Token'] = state.csrf;
    if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options = {...options, body: JSON.stringify(options.body)};
    }
    const response = await fetch(path, {...options, method, headers, credentials: 'same-origin', cache: 'no-store'});
    const payload = await response.json().catch(() => ({error: 'The server returned an unreadable response.'}));
    if (!response.ok) {
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
    if (payload.csrf_token) state.csrf = payload.csrf_token;
    return payload;
  }

  function showAuthGate() {
    $('[data-study-loading]').hidden = true;
    $('[data-study-content]').hidden = true;
    $('[data-study-auth-gate]').hidden = false;
  }

  function showContent() {
    $('[data-study-loading]').hidden = true;
    $('[data-study-auth-gate]').hidden = true;
    $('[data-study-content]').hidden = false;
  }

  function profileIsReady(profile) {
    return Boolean(profile && profile.subjects?.length && profile.current_goal);
  }

  function renderAvailability() {
    const host = $('[data-study-availability]');
    if (!host) return;
    if (!state.windows.length) {
      host.innerHTML = '<p class="study-field-help">No recurring windows yet. Add the times you normally sit down.</p>';
    } else {
      host.innerHTML = state.windows.map((window, index) => `<div class="study-availability-row" data-window-index="${index}">
        <select aria-label="Availability day" data-window-field="weekday">${weekdays.map(([value, label]) => `<option value="${value}"${Number(window.weekday) === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
        <input type="time" aria-label="Availability start" data-window-field="start" value="${escapeHtml(window.start || '18:00')}">
        <input type="time" aria-label="Availability end" data-window-field="end" value="${escapeHtml(window.end || '19:00')}">
        <button type="button" data-study-remove-window="${index}" aria-label="Remove availability"><i class="bx bx-x" aria-hidden="true"></i></button>
      </div>`).join('');
    }
    const summary = $('[data-study-window-summary]');
    if (summary) summary.textContent = state.windows.length ? `${state.windows.length} window${state.windows.length === 1 ? '' : 's'} saved` : 'No windows added yet';
  }

  function populateProfileForm(profile) {
    const form = $('[data-study-profile-form]');
    if (!form) return;
    const value = (name, fallback = '') => form.elements[name] ? form.elements[name].value = fallback : undefined;
    value('subjects', asList(profile?.subjects).join(', '));
    value('topics', asList(profile?.topics).join(', '));
    value('current_goal', profile?.current_goal || '');
    value('goals', asList(profile?.goals).join(', '));
    value('learning_level', profile?.learning_level || 'all_levels');
    value('age_band', profile?.age_band || 'any');
    value('session_duration_minutes', String(profile?.session_duration_minutes || 50));
    value('study_style', profile?.study_style || 'quiet_focus');
    value('languages', asList(profile?.languages || ['English']).join(', '));
    value('interests', asList(profile?.interests).join(', '));
    const timezoneField = form.elements.timezone;
    const detectedTimezone = profile?.timezone || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_error) { return 'UTC'; } })();
    if (timezoneField) timezoneField.value = [...timezoneField.options].some(option => option.value === detectedTimezone) ? detectedTimezone : 'UTC';
    $$('input[name="modes"]', form).forEach(input => { input.checked = (profile?.modes || ['focus']).includes(input.value); });
    const crossSubject = form.elements.cross_subject;
    if (crossSubject) crossSubject.checked = profile?.cross_subject !== false;
  }

  function showSetup(show) {
    const setup = $('[data-study-setup]');
    const dashboard = $('[data-study-dashboard]');
    if (setup) setup.hidden = !show;
    if (dashboard) dashboard.hidden = Boolean(show);
    if (show) {
      $('[data-study-session-workspace]').hidden = true;
      populateProfileForm(state.profile);
      renderAvailability();
      setup?.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
  }

  function renderStats(payload) {
    const stats = payload?.stats || {};
    setText('[data-study-stat="study_minutes"]', `${Number(stats.study_minutes || 0)}m`);
    setText('[data-study-stat="sessions_completed"]', Number(stats.sessions_completed || 0));
    setText('[data-study-stat="goals_completed"]', Number(stats.goals_completed || 0));
    setText('[data-study-profile-timezone]', state.profile?.timezone || 'UTC');
    const style = {quiet_focus: 'Quiet focus', occasional_chat: 'Occasional chat', discussion: 'Discussion welcome', accountability: 'Accountability', co_working: 'Co-working'}[state.profile?.study_style] || 'Quiet focus';
    setText('[data-study-profile-style]', style);
  }

  function renderUpcoming(sessions = []) {
    const host = $('[data-study-upcoming]');
    if (!host) return;
    host.innerHTML = sessions.length ? sessions.slice(0, 4).map(session => {
      const room = session.room || {};
      const others = (session.participants || []).filter(person => person.id !== state.user?.id);
      const label = others.length ? others.map(displayName).join(', ') : room.title || 'Your study room';
      return `<article class="study-list-item"><span class="study-stat-icon blue"><i class="bx bx-calendar-event" aria-hidden="true"></i></span><div class="study-list-item-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(formatDateTime(session.starts_at))} · ${Number(session.duration_minutes || 50)} minutes</span></div><div class="study-list-item-actions"><button class="btn btn-sm" type="button" data-study-calendar="${escapeHtml(session.id)}">Calendar</button><button class="btn btn-sm btn-primary" type="button" data-study-open-session="${escapeHtml(session.id)}">Open</button></div></article>`;
    }).join('') : '<div class="study-list-empty"><i class="bx bx-calendar" aria-hidden="true"></i><p>No sessions booked yet. Find someone or open a public room.</p></div>';
  }

  function renderInvitations(items = []) {
    const host = $('[data-study-invitations]');
    const count = $('[data-study-invitation-count]');
    const incoming = items.filter(item => item.is_incoming && ['pending', 'countered'].includes(item.status));
    if (count) count.textContent = incoming.length;
    if (!host) return;
    host.innerHTML = incoming.length ? incoming.slice(0, 4).map(item => {
      const sender = item.sender || {};
      const proposed = item.status === 'countered' && item.counter_start_utc ? item.counter_start_utc : item.proposed_start_utc;
      return `<article class="study-list-item"><span>${avatar(sender, 'avatar avatar-sm')}</span><div class="study-list-item-copy"><strong>${escapeHtml(displayName(sender))}</strong><span>${escapeHtml(formatDateTime(proposed))} · ${Number(item.counter_duration_minutes || item.duration_minutes || 50)} min</span></div><div class="study-list-item-actions"><button class="btn btn-sm btn-primary" type="button" data-study-accept-invitation="${escapeHtml(item.id)}" data-study-invitation-action="${item.status === 'countered' ? 'accept_counter' : 'accept'}">Accept</button><button class="btn btn-sm" type="button" data-study-decline-invitation="${escapeHtml(item.id)}">Decline</button></div></article>`;
    }).join('') : '<div class="study-list-empty"><i class="bx bx-inbox" aria-hidden="true"></i><p>No new study requests.</p></div>';
  }

  function matchCard(match) {
    const person = match.candidate || {};
    const subjects = asList(person.subjects).slice(0, 3);
    const reason = match.top_reasons?.[0] || 'Your time, pace, and study preferences are compatible.';
    const overlap = match.availability?.label || 'Availability not set';
    return `<article class="study-match-card" data-study-match-card="${escapeHtml(person.id)}">
      <div class="study-match-head">${avatar(person, 'avatar avatar-md')}<div class="study-match-person"><strong>${escapeHtml(displayName(person))}</strong><span>@${escapeHtml(person.username || 'member')} · ${escapeHtml(person.timezone_region || 'UTC')}</span></div><span class="study-match-score" style="--score:${Number(match.score || 0)}"><strong>${Number(match.score || 0)}%</strong></span></div>
      <div class="study-match-subjects">${subjects.length ? subjects.map(subject => `<span class="study-chip">${escapeHtml(subject)}</span>`).join('') : '<span class="study-chip">Open to discovery</span>'}</div>
      <p class="study-match-reason">${escapeHtml(reason)}</p>
      <div class="study-match-foot"><span><i class="bx bx-time-five" aria-hidden="true"></i> ${escapeHtml(overlap)}</span><div class="study-match-actions"><a class="btn btn-sm" href="member-profile.html?id=${encodeURIComponent(person.id)}">View profile</a><button class="btn btn-sm btn-primary" type="button" data-study-invite="${escapeHtml(person.id)}">Invite</button><button class="btn btn-sm" type="button" data-study-skip="${escapeHtml(person.id)}" aria-label="Skip match"><i class="bx bx-x" aria-hidden="true"></i></button><button class="btn btn-sm" type="button" data-study-report="${escapeHtml(person.id)}" aria-label="Report match"><i class="bx bx-flag" aria-hidden="true"></i></button><button class="btn btn-sm" type="button" data-study-favorite="${escapeHtml(person.id)}" aria-label="${match.saved ? 'Remove saved match' : 'Save match'}"><i class="bx ${match.saved ? 'bxs-star' : 'bx-star'}" aria-hidden="true"></i></button></div></div>
    </article>`;
  }

  function renderMatches(matches = state.matches) {
    const compact = matches.slice(0, 2);
    const overviewHost = $('[data-study-overview-matches]');
    const host = $('[data-study-matches]');
    const markup = matches.length ? matches.map(matchCard).join('') : '<div class="study-list-empty study-match-error"><i class="bx bx-radar" aria-hidden="true"></i><p>No compatible windows yet. Add recurring availability in your preferences, or start an open room.</p></div>';
    if (overviewHost) overviewHost.innerHTML = compact.length ? compact.map(matchCard).join('') : markup;
    if (host) host.innerHTML = markup;
  }

  function renderRooms(rooms = state.rooms) {
    const host = $('[data-study-lobby]');
    const empty = $('[data-study-lobby-empty]');
    if (!host) return;
    if (!rooms.length) {
      host.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    host.innerHTML = rooms.map(room => `<article class="study-room-card"><div class="study-kicker">${escapeHtml(room.visibility === 'public' ? 'Public room' : 'Your room')}</div><h3>${escapeHtml(room.title || 'Quiet study room')}</h3><p>${escapeHtml(room.description || room.subject || 'A shared focus block for any subject.')}</p><div class="study-room-meta"><span><i class="bx bx-time-five" aria-hidden="true"></i> ${escapeHtml(formatDateTime(room.starts_at))}</span><span><i class="bx bx-group" aria-hidden="true"></i> ${Number(room.participant_count || 0)}/${Number(room.max_participants || 4)}</span></div><div class="study-room-foot"><small>${escapeHtml((room.rules || []).slice(0, 1).join(' · ') || 'Focus first · media optional')}</small><button class="btn btn-sm btn-primary" type="button" data-study-join-room="${escapeHtml(room.id)}">Join room</button></div></article>`).join('');
  }

  function renderHistory(sessions = []) {
    const host = $('[data-study-history]');
    if (!host) return;
    const completed = sessions.filter(session => ['completed', 'active', 'scheduled'].includes(session.status));
    host.innerHTML = completed.length ? completed.map(session => {
      const others = (session.participants || []).filter(person => person.id !== state.user?.id);
      return `<article class="study-history-row"><div class="study-history-date"><strong>${escapeHtml(formatDate(session.starts_at))}</strong><span>${Number(session.duration_minutes || 50)} minutes</span></div><div class="study-history-title"><strong>${escapeHtml(session.room?.title || (others.length ? others.map(displayName).join(', ') : 'Study Together session'))}</strong><span>${escapeHtml(session.goal?.goal || session.goal?.subject || 'Shared focus session')}</span></div><span class="study-history-status">${escapeHtml(session.status === 'completed' ? 'Complete' : session.status === 'active' ? 'In progress' : 'Scheduled')}</span></article>`;
    }).join('') : '<div class="study-list-empty"><i class="bx bx-history" aria-hidden="true"></i><p>Your study history will appear here after your first session.</p></div>';
  }

  function renderOverview(payload) {
    state.profile = payload.profile;
    state.matches = Array.isArray(payload.matches) ? payload.matches : [];
    state.rooms = Array.isArray(payload.lobby) ? payload.lobby : [];
    renderStats(payload);
    renderUpcoming(payload.upcoming_sessions || []);
    renderInvitations(payload.invitations || []);
    renderMatches(state.matches);
    renderRooms(state.rooms);
    const liveCount = state.rooms.reduce((total, room) => total + Number(room.participant_count || 0), 0);
    $$('[data-study-live-count]').forEach(element => element.textContent = String(liveCount));
    const singular = liveCount === 1;
    $$('[data-study-live-label]').forEach(element => element.textContent = singular ? 'person studying now' : 'people studying now');
    $$('[data-study-live-copy]').forEach(element => element.textContent = singular ? 'person is studying now' : 'people are studying now');
  }

  async function loadHistory() {
    try {
      const payload = await api('/api/study/sessions');
      state.sessions = payload.sessions || [];
      renderHistory(state.sessions);
    } catch (_error) {
      renderHistory([]);
    }
  }

  async function loadStudy() {
    const payload = await api('/api/study');
    state.overview = payload;
    // Keep recurring windows in the editor after a refresh. Without this,
    // reopening the page rendered an empty editor and the next save could
    // accidentally erase the member's saved availability.
    state.windows = Array.isArray(payload.profile?.availability) ? payload.profile.availability.map(window => ({...window})) : [];
    renderOverview(payload);
    showContent();
    const ready = Boolean(payload.onboarding_complete || profileIsReady(payload.profile));
    showSetup(!ready);
    await loadHistory();
  }

  function activateTab(name) {
    $$('[data-study-tab]').forEach(button => {
      const active = button.dataset.studyTab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $$('[data-study-panel]').forEach(panel => {
      const active = panel.dataset.studyPanel === name;
      panel.hidden = !active;
      panel.classList.toggle('active', active);
    });
    if (name === 'history') loadHistory();
    if (name === 'discover') $('[data-study-match-search]')?.focus({preventScroll: true});
  }

  function setDialogDate(dialog, selector, offsetMinutes = 60) {
    const field = $(selector, dialog);
    if (field) field.value = localDateTimeValue(new Date(Date.now() + offsetMinutes * 60_000));
  }

  function openDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function openInvite(match) {
    if (!match) return;
    state.selectedMatch = match;
    const dialog = $('[data-study-invite-dialog]');
    const form = $('[data-study-invite-form]', dialog);
    if (!dialog || !form) return;
    form.elements.target_user_id.value = match.candidate.id;
    form.elements.duration_minutes.value = String(state.profile?.session_duration_minutes || 50);
    $('[data-study-invite-person]', dialog).textContent = `${displayName(match.candidate)} · ${match.top_reasons?.[0] || 'a compatible study rhythm'}`;
    setDialogDate(dialog, 'input[name="proposed_start_utc"]');
    status('[data-study-invite-status]', '');
    openDialog(dialog);
  }

  function openRoomDialog() {
    const dialog = $('[data-study-room-dialog]');
    const form = $('[data-study-room-form]', dialog);
    if (!dialog || !form) return;
    if (!form.querySelector('[data-study-room-advanced]')) {
      const titleField = form.elements.title?.closest('.study-field');
      titleField?.insertAdjacentHTML('afterend', '<label class="study-field" data-study-room-advanced><span>Description</span><textarea name="description" rows="2" maxlength="800" placeholder="A calm shared focus block for exam prep."></textarea></label>');
      const grid = form.querySelector('.study-form-grid.two');
      grid?.insertAdjacentHTML('beforeend', '<label class="study-field" data-study-room-advanced><span>Maximum people</span><select name="max_participants"><option value="2">2 people</option><option value="4" selected>4 people</option><option value="6">6 people</option><option value="8">8 people</option></select></label><label class="study-field" data-study-room-advanced><span>Study style</span><select name="study_style"><option value="quiet_focus">Quiet focus</option><option value="occasional_chat">Occasional conversation</option><option value="discussion">Discussion welcome</option><option value="accountability">Accountability check-ins</option><option value="co_working">Co-working</option></select></label><label class="study-field" data-study-room-advanced><span>Room mode</span><select name="room_mode"><option value="focus">Focus only</option><option value="pomodoro">Pomodoro focus and breaks</option><option value="audio">Audio optional</option><option value="video">Video optional</option></select></label>');
    }
    setDialogDate(dialog, 'input[name="starts_at"]', 10);
    form.elements.duration_minutes.value = String(state.profile?.session_duration_minutes || 50);
    if (form.elements.study_style) form.elements.study_style.value = state.profile?.study_style || 'quiet_focus';
    status('[data-study-room-status]', '');
    openDialog(dialog);
  }

  async function saveProfile(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const modes = $$('input[name="modes"]:checked', form).map(input => input.value);
    const body = {
      subjects: uniqueList(form.elements.subjects.value),
      topics: uniqueList(form.elements.topics.value),
      current_goal: String(form.elements.current_goal.value || '').trim(),
      goals: uniqueList(form.elements.goals.value),
      learning_level: form.elements.learning_level.value,
      age_band: form.elements.age_band.value,
      session_duration_minutes: Number(form.elements.session_duration_minutes.value),
      timezone: form.elements.timezone.value,
      study_style: form.elements.study_style.value,
      languages: uniqueList(form.elements.languages.value),
      interests: uniqueList(form.elements.interests.value),
      modes: modes.length ? modes : ['focus'],
      cross_subject: Boolean(form.elements.cross_subject.checked),
      availability: state.windows
    };
    status('[data-study-form-status]', 'Saving your study rhythm…');
    try {
      const saved = await api('/api/study/profile', {method: 'PUT', body});
      state.profile = saved.profile;
      const payload = await api('/api/study');
      state.overview = payload;
      renderOverview(payload);
      showSetup(false);
      activateTab('overview');
      status('[data-study-form-status]', 'Saved. Your matches are ready.');
    } catch (error) {
      status('[data-study-form-status]', error.message, true);
    }
  }

  async function sendInvitation(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const start = new Date(form.elements.proposed_start_utc.value);
    if (Number.isNaN(start.getTime())) return status('[data-study-invite-status]', 'Choose a valid start time.', true);
    status('[data-study-invite-status]', 'Sending invitation…');
    try {
      await api('/api/study/invitations', {method: 'POST', body: {target_user_id: form.elements.target_user_id.value, proposed_start_utc: start.toISOString(), duration_minutes: Number(form.elements.duration_minutes.value), mode: form.elements.mode.value, message: form.elements.message.value}});
      closeDialog($('[data-study-invite-dialog]'));
      const payload = await api('/api/study');
      state.overview = payload;
      renderOverview(payload);
    } catch (error) {
      status('[data-study-invite-status]', error.message, true);
    }
  }

  async function createRoom(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const starts = new Date(form.elements.starts_at.value);
    if (Number.isNaN(starts.getTime())) return status('[data-study-room-status]', 'Choose a valid room start.', true);
    status('[data-study-room-status]', 'Opening your room…');
    try {
      const roomMode = form.elements.room_mode?.value || 'focus';
      const payload = await api('/api/study/rooms', {method: 'POST', body: {title: form.elements.title.value, description: form.elements.description?.value || '', starts_at: starts.toISOString(), duration_minutes: Number(form.elements.duration_minutes.value), visibility: form.elements.visibility.value, max_participants: Number(form.elements.max_participants?.value || 4), subject: form.elements.subject.value, study_style: form.elements.study_style?.value || state.profile?.study_style || 'quiet_focus', goal: form.elements.goal.value, rules: form.elements.rules.value, modes: [roomMode]}});
      closeDialog($('[data-study-room-dialog]'));
      await openSession(payload.session);
    } catch (error) {
      status('[data-study-room-status]', error.message, true);
    }
  }

  function isHost() {
    return Boolean(state.session?.participants?.some(person => person.id === state.user?.id && person.role === 'host'));
  }

  function renderTimer() {
    const phase = state.timer?.phase || 'idle';
    const endsAt = state.timer?.ends_at ? new Date(state.timer.ends_at).getTime() : 0;
    const fallback = Number(state.session?.duration_minutes || state.session?.pomodoro?.focus || 50) * 60;
    const remaining = endsAt ? Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) : (phase === 'idle' ? fallback : 0);
    const minutes = Math.floor(remaining / 60).toString().padStart(2, '0');
    const seconds = (remaining % 60).toString().padStart(2, '0');
    setText('[data-study-timer]', `${minutes}:${seconds}`);
    setText('[data-study-timer-phase]', phase === 'focus' ? 'Focus time' : phase === 'break' ? 'Break time' : 'Ready');
    setText('[data-study-timer-round]', state.timer?.round ? `Round ${state.timer.round} · shared with the room` : 'Shared timer · focus first');
    const startButton = $('[data-study-timer-start]');
    const breakButton = $('[data-study-timer-break]');
    [startButton, breakButton].forEach(button => { if (button) button.disabled = !isHost() || (!state.connected && !localPreview); });
    if (endsAt && remaining === 0 && state.timer.phase !== 'idle') state.timer = {...state.timer, phase: 'idle', ends_at: null};
  }

  function renderPresence() {
    const host = $('[data-study-presence]');
    if (!host) return;
    const people = Object.values(state.presence || {});
    const fallback = state.session?.participants || [];
    const source = people.length ? people : fallback.map(person => ({...person, user_id: person.id, status: person.status === 'completed' ? 'complete' : 'ready'}));
    host.innerHTML = source.map(person => `<span class="study-presence-person"><i class="bx bxs-circle" aria-hidden="true"></i>${escapeHtml(person.user_id === state.user?.id ? 'You' : person.display_name || displayName(person))} · ${escapeHtml(person.status || 'ready')}</span>`).join('');
  }

  function renderParticipants() {
    const host = $('[data-study-session-participants]');
    if (!host) return;
    host.innerHTML = (state.session?.participants || []).map(person => `<article class="study-list-item"><span>${avatar(person, 'avatar avatar-sm')}</span><div class="study-list-item-copy"><strong>${escapeHtml(person.id === state.user?.id ? 'You' : displayName(person))}</strong><span>${escapeHtml(person.role === 'host' ? 'Room host' : 'Participant')} · ${escapeHtml(person.goal || 'Here for shared focus')}</span></div></article>`).join('') || '<div class="study-list-empty"><p>Waiting for participants.</p></div>';
  }

  function clockLabel(timezone, prefix) {
    let formatted = '—';
    try {
      formatted = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: timezone || undefined}).format(new Date());
    } catch (_error) { formatted = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'}).format(new Date()); }
    return `${prefix} · ${formatted}`;
  }

  function renderSessionClocks() {
    if (!state.session) return;
    const other = (state.session.participants || []).find(person => person.id !== state.user?.id);
    setText('[data-study-you-clock]', clockLabel(state.profile?.timezone, 'You'));
    setText('[data-study-partner-clock]', clockLabel(other?.timezone, other ? displayName(other) : 'Partner'));
  }

  function boardContext() {
    const canvas = $('[data-study-whiteboard]');
    return canvas ? canvas.getContext('2d') : null;
  }

  function drawBoardStroke(context, operation) {
    const points = Array.isArray(operation?.points) ? operation.points : [];
    if (!context || points.length < 2) return;
    context.save();
    context.strokeStyle = operation.color || '#3864ee';
    context.lineWidth = Math.max(1, Math.min(18, Number(operation.width || 4)));
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(Number(points[0][0]), Number(points[0][1]));
    points.slice(1).forEach(point => context.lineTo(Number(point[0]), Number(point[1])));
    context.stroke();
    context.restore();
  }

  function renderBoard(preview = null) {
    const canvas = $('[data-study-whiteboard]');
    const context = boardContext();
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = getComputedStyle(canvas).getPropertyValue('--board-paper').trim() || '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    (preview || state.whiteboard || []).filter(operation => operation?.action === 'stroke').forEach(operation => drawBoardStroke(context, operation));
  }

  function boardPoint(event) {
    const canvas = $('[data-study-whiteboard]');
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)), Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height))];
  }

  function sendBoardOperation(operation) {
    if (socketSend({type: 'whiteboard', operation})) {
      status('[data-study-board-status]', 'Live board · syncing');
      return true;
    }
    if (localPreview) {
      if (operation.action === 'clear') state.whiteboard = [];
      else if (operation.action === 'undo') {
        const index = [...state.whiteboard].map((item, itemIndex) => ({item, itemIndex})).reverse().find(entry => entry.item.action === 'stroke' && entry.item.user_id === state.user?.id)?.itemIndex;
        if (index !== undefined) state.whiteboard.splice(index, 1);
      } else state.whiteboard.push(operation);
      renderBoard();
      status('[data-study-board-status]', 'Local preview board');
      return true;
    }
    status('[data-study-board-status]', 'Reconnect to edit the shared board.', true);
    return false;
  }

  function bindBoard() {
    const canvas = $('[data-study-whiteboard]');
    if (!canvas || canvas.dataset.bound === 'true') return;
    canvas.dataset.bound = 'true';
    canvas.addEventListener('pointerdown', event => {
      if (!state.session) return;
      canvas.setPointerCapture?.(event.pointerId);
      state.drawing = {points: [boardPoint(event)], color: '#3864ee', width: 4};
      renderBoard(state.whiteboard.concat({action: 'stroke', ...state.drawing}));
    });
    canvas.addEventListener('pointermove', event => {
      if (!state.drawing) return;
      state.drawing.points.push(boardPoint(event));
      renderBoard(state.whiteboard.concat({action: 'stroke', ...state.drawing}));
    });
    const finishStroke = () => {
      if (!state.drawing) return;
      const operation = {action: 'stroke', ...state.drawing, points: state.drawing.points.slice(0, 240)};
      state.drawing = null;
      if (operation.points.length > 1) sendBoardOperation(operation);
      else renderBoard();
    };
    canvas.addEventListener('pointerup', finishStroke);
    canvas.addEventListener('pointercancel', finishStroke);
    renderBoard();
  }

  function calendarDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function downloadCalendar(session) {
    if (!session) return;
    const room = session.room || {};
    const title = room.title || 'SwapLabs Study Together session';
    const description = session.goal?.goal || session.goal?.subject || 'Shared focus session on SwapLabs.';
    const end = session.ends_at || new Date(new Date(session.starts_at).getTime() + Number(session.duration_minutes || 50) * 60_000).toISOString();
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SwapLabs//Study Together//EN', 'BEGIN:VEVENT', `UID:${session.id}@swaplabs.local`, `DTSTAMP:${calendarDate(new Date())}`, `DTSTART:${calendarDate(session.starts_at)}`, `DTEND:${calendarDate(end)}`, `SUMMARY:${title.replace(/[\\;,\n]/g, ' ')}`, `DESCRIPTION:${description.replace(/[\\;,\n]/g, ' ')}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], {type: 'text/calendar;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = 'swaplabs-study-session.ics'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('[data-study-form-status]', 'Calendar file downloaded.');
  }

  function renderChat() {
    const host = $('[data-study-chat-log]');
    if (!host) return;
    host.innerHTML = state.messages.length ? state.messages.slice(-80).map(message => `<article class="study-chat-message${message.user_id === state.user?.id ? ' mine' : ''}"><strong>${escapeHtml(message.user_id === state.user?.id ? 'You' : message.display_name || 'Member')}</strong><p>${escapeHtml(message.body)}</p><time>${escapeHtml(formatDateTime(message.created_at))}</time></article>`).join('') : '<div class="study-list-empty"><p>Say hello when everyone arrives.</p></div>';
    host.scrollTop = host.scrollHeight;
  }

  function renderSession() {
    const session = state.session;
    if (!session) return;
    const room = session.room || {};
    setText('[data-study-session-title]', room.title || 'Study Together');
    setText('[data-study-session-meta]', `${formatDateTime(session.starts_at)} · ${Number(session.duration_minutes || 50)} minutes`);
    setText('[data-study-session-goal]', session.goal?.goal || session.goal?.subject || 'Set a goal for this focus block.');
    const mediaChoice = $('.study-media-choice');
    if (mediaChoice && !mediaChoice.querySelector('[data-study-media-enable]')) mediaChoice.insertAdjacentHTML('beforeend', '<button class="btn btn-sm" type="button" data-study-media-enable>Enable optional media</button>');
    const mediaButton = $('[data-study-media-enable]');
    const videoLink = $('[data-study-video-link]');
    if (mediaButton) { mediaButton.hidden = Boolean(room.video_room_id); mediaButton.textContent = session.mode === 'audio' ? 'Enable optional audio' : 'Enable optional media'; }
    if (videoLink) { videoLink.hidden = !room.video_room_id; if (room.video_room_id) videoLink.href = `video-room.html?room=${encodeURIComponent(room.video_room_id)}`; }
    const connection = $('[data-study-connection]');
    if (connection) { connection.classList.toggle('is-connected', state.connected); connection.lastChild.textContent = state.connected ? ' Live sync' : ' Offline sync'; }
    renderSessionClocks();
    bindBoard();
    renderPresence();
    renderParticipants();
    renderChat();
    renderTimer();
  }

  function socketSend(packet) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
    state.socket.send(JSON.stringify(packet));
    return true;
  }

  async function loadSessionMessages() {
    if (!state.session?.id) return;
    try {
      const payload = await api(`/api/study/sessions/${encodeURIComponent(state.session.id)}/messages`);
      state.messages = payload.messages || [];
      renderChat();
    } catch (_error) { /* The room can still be used while chat catches up. */ }
  }

  function connectRoomSocket() {
    if (!state.session?.room?.id || !window.WebSocket) return;
    if (state.socket) state.socket.close();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/study/rooms/${encodeURIComponent(state.session.room.id)}/socket`);
    state.socket = socket;
    socket.addEventListener('open', () => { state.connected = true; renderSession(); socketSend({type: 'presence', status: 'ready'}); });
    socket.addEventListener('close', () => { state.connected = false; renderSession(); });
    socket.addEventListener('error', () => { state.connected = false; renderSession(); });
    socket.addEventListener('message', event => {
      let packet;
      try { packet = JSON.parse(event.data); } catch (_error) { return; }
      if (packet.type === 'state' || packet.type === 'presence') {
        state.presence = packet.state?.presence || packet.presence || state.presence;
        if (packet.state?.phase !== undefined) state.timer = {phase: packet.state.phase, ends_at: packet.state.ends_at, round: packet.state.round || 0};
        if (packet.state?.whiteboard) state.whiteboard = Array.isArray(packet.state.whiteboard) ? packet.state.whiteboard : [];
        renderSession();
      } else if (packet.type === 'timer') {
        state.timer = {phase: packet.phase, ends_at: packet.ends_at, round: packet.round || 0};
        renderTimer();
      } else if (packet.type === 'chat' && packet.message) {
        state.messages = [...state.messages, packet.message].slice(-100);
        renderChat();
      } else if (packet.type === 'moderation_pending') {
        status('[data-study-connection]', packet.message || 'Your message is pending administrator review and is hidden from the room.');
      } else if (packet.type === 'whiteboard' && packet.operation) {
        state.whiteboard = [...state.whiteboard, packet.operation].slice(-200);
        renderBoard();
      } else if (packet.type === 'whiteboard_reset') {
        state.whiteboard = Array.isArray(packet.whiteboard) ? packet.whiteboard : [];
        renderBoard();
      } else if (packet.type === 'error') {
        status('[data-study-connection]', packet.message || 'Room action unavailable.', true);
      }
    });
  }

  async function openSession(session) {
    if (!session?.id) return;
    if (state.socket) { state.socket.close(); state.socket = null; }
    state.session = session;
    state.messages = [];
    state.presence = {};
    state.whiteboard = [];
    state.drawing = null;
    state.timer = {phase: 'idle', ends_at: null, round: 0};
    $('[data-study-dashboard]').hidden = true;
    $('[data-study-setup]').hidden = true;
    $('[data-study-session-workspace]').hidden = false;
    renderSession();
    try {
      const payload = await api(`/api/study/sessions/${encodeURIComponent(session.id)}`);
      state.session = payload.session || state.session;
    } catch (_error) { /* The response used to create the room is enough to enter it. */ }
    await loadSessionMessages();
    connectRoomSocket();
    window.clearInterval(state.sessionPoll);
    state.sessionPoll = window.setInterval(async () => {
      if (!state.session || document.hidden) return;
      try {
        const payload = await api(`/api/study/sessions/${encodeURIComponent(state.session.id)}`);
        state.session = payload.session || state.session;
        renderSession();
        if (!state.connected) await loadSessionMessages();
      } catch (_error) { /* Keep the room visible through a temporary network gap. */ }
    }, 15_000);
  }

  function closeSession() {
    window.clearInterval(state.sessionPoll);
    if (state.socket) state.socket.close();
    state.socket = null;
    state.connected = false;
    state.session = null;
    $('[data-study-session-workspace]').hidden = true;
    $('[data-study-dashboard]').hidden = false;
    renderOverview(state.overview || {});
  }

  async function refreshOverview() {
    try {
      const payload = await api('/api/study');
      state.overview = payload;
      renderOverview(payload);
    } catch (error) {
      status('[data-study-form-status]', error.message, true);
    }
  }

  async function handleInvitation(id, action) {
    try {
      const payload = await api(`/api/study/invitations/${encodeURIComponent(id)}`, {method: 'PATCH', body: {action}});
      if (payload.session) await openSession(payload.session);
      else await refreshOverview();
    } catch (error) {
      status('[data-study-form-status]', error.message, true);
    }
  }

  async function handleRoomJoin(id) {
    try {
      await api(`/api/study/rooms/${encodeURIComponent(id)}/join`, {method: 'POST', body: {}});
      const payload = await api('/api/study/sessions');
      const session = (payload.sessions || []).find(item => item.room?.id === id) || (payload.sessions || []).find(item => item.status !== 'completed');
      if (session) await openSession(session);
      else await refreshOverview();
    } catch (error) {
      status('[data-study-form-status]', error.message, true);
    }
  }

  async function toggleFavorite(id, button) {
    const match = state.matches.find(item => item.candidate?.id === id);
    if (!match) return;
    const nextSaved = !match.saved;
    try {
      await api(`/api/study/favorites/${encodeURIComponent(id)}`, {method: nextSaved ? 'POST' : 'DELETE', body: {}});
      match.saved = nextSaved;
      if (button) { button.innerHTML = `<i class="bx ${nextSaved ? 'bxs-star' : 'bx-star'}" aria-hidden="true"></i>`; button.setAttribute('aria-label', nextSaved ? 'Remove saved match' : 'Save match'); }
    } catch (error) {
      status('[data-study-form-status]', error.message, true);
    }
  }

  function skipMatch(id) {
    state.matches = state.matches.filter(match => match.candidate?.id !== id);
    renderMatches(state.matches);
  }

  async function reportMatch(id) {
    const details = window.prompt('Tell us what feels unsafe or inappropriate. You can leave this blank to report the profile.');
    if (details === null) return;
    try {
      await api('/api/study/reports', {method: 'POST', body: {target_user_id: id, reason: 'other', details}});
      skipMatch(id);
      status('[data-study-form-status]', 'Thanks. The report is private and this match was removed.');
    } catch (error) {
      status('[data-study-form-status]', error.message, true);
    }
  }

  function handleQuickMatch() {
    if (!profileIsReady(state.profile)) return showSetup(true);
    activateTab('discover');
    const match = state.matches[0];
    if (match) window.setTimeout(() => openInvite(match), 120);
  }

  async function enableStudyMedia() {
    if (!state.session?.id) return;
    const wantsVideo = window.confirm('Open a protected video room? Choose Cancel to use audio only.');
    const mode = wantsVideo ? 'video' : 'audio';
    status('[data-study-connection]', `Preparing the private ${mode} room…`);
    try {
      const payload = await api(`/api/study/sessions/${encodeURIComponent(state.session.id)}/video-room`, {method: 'POST', body: {mode, title: state.session.room?.title || 'SwapLabs Study Together room'}});
      state.session = payload.session || state.session;
      renderSession();
      status('[data-study-connection]', `${mode === 'video' ? 'Video' : 'Audio'} room ready. Join only when you are comfortable.`);
    } catch (error) {
      status('[data-study-connection]', error.message, true);
    }
  }

  async function handleStudyClick(event) {
    const target = event.target.closest('button, a');
    if (!target || !root.contains(target)) return;
    if (target.matches('[data-study-tab], [data-study-tab-link]')) {
      event.preventDefault();
      activateTab(target.dataset.studyTab || target.dataset.studyTabLink);
      return;
    }
    if (target.matches('[data-study-quick-match]')) { event.preventDefault(); handleQuickMatch(); return; }
    if (target.matches('[data-study-start-room]')) { event.preventDefault(); openRoomDialog(); return; }
    if (target.matches('[data-study-edit-profile]')) { event.preventDefault(); showSetup(true); return; }
    if (target.matches('[data-study-add-window]')) {
      state.windows.push({kind: 'recurring', weekday: 1, start: '18:00', end: '19:00'}); renderAvailability(); return;
    }
    if (target.matches('[data-study-remove-window]')) {
      state.windows.splice(Number(target.dataset.studyRemoveWindow), 1); renderAvailability(); return;
    }
    if (target.matches('[data-study-refresh-matches]')) { event.preventDefault(); await refreshOverview(); return; }
    if (target.matches('[data-study-invite]')) { event.preventDefault(); openInvite(state.matches.find(item => item.candidate?.id === target.dataset.studyInvite)); return; }
    if (target.matches('[data-study-favorite]')) { event.preventDefault(); await toggleFavorite(target.dataset.studyFavorite, target); return; }
    if (target.matches('[data-study-skip]')) { event.preventDefault(); skipMatch(target.dataset.studySkip); return; }
    if (target.matches('[data-study-report]')) { event.preventDefault(); await reportMatch(target.dataset.studyReport); return; }
    if (target.matches('[data-study-accept-invitation]')) { event.preventDefault(); await handleInvitation(target.dataset.studyAcceptInvitation, target.dataset.studyInvitationAction || 'accept'); return; }
    if (target.matches('[data-study-decline-invitation]')) { event.preventDefault(); await handleInvitation(target.dataset.studyDeclineInvitation, 'decline'); return; }
    if (target.matches('[data-study-calendar]')) { event.preventDefault(); const session = (state.overview?.upcoming_sessions || []).find(item => item.id === target.dataset.studyCalendar) || state.sessions.find(item => item.id === target.dataset.studyCalendar) || state.session; downloadCalendar(session); return; }
    if (target.matches('[data-study-open-session]')) { event.preventDefault(); const session = (state.overview?.upcoming_sessions || []).find(item => item.id === target.dataset.studyOpenSession) || state.sessions.find(item => item.id === target.dataset.studyOpenSession); if (session) await openSession(session); return; }
    if (target.matches('[data-study-join-room]')) { event.preventDefault(); await handleRoomJoin(target.dataset.studyJoinRoom); return; }
    if (target.matches('[data-study-close-session]')) { event.preventDefault(); closeSession(); return; }
    if (target.matches('[data-study-focus-toggle]')) { event.preventDefault(); document.body.classList.toggle('study-focus-view'); target.classList.toggle('active'); return; }
    if (target.matches('[data-study-media-enable]')) { event.preventDefault(); await enableStudyMedia(); return; }
    if (target.matches('[data-study-board-toggle]')) { event.preventDefault(); const panel = $('[data-study-board-panel]'); if (panel) { panel.hidden = !panel.hidden; if (!panel.hidden) { bindBoard(); renderBoard(); panel.scrollIntoView({behavior: 'smooth', block: 'nearest'}); } } return; }
    if (target.matches('[data-study-board-clear]')) { event.preventDefault(); sendBoardOperation({action: 'clear'}); return; }
    if (target.matches('[data-study-board-undo]')) { event.preventDefault(); sendBoardOperation({action: 'undo'}); return; }
    if (target.matches('[data-study-checkin]')) {
      event.preventDefault();
      if (!state.session) return;
      const response = window.prompt('What are you working on right now?', state.session.goal?.goal || '');
      if (response === null || !response.trim()) return;
      const body = `Check-in: ${response.trim().slice(0, 500)}`;
      if (socketSend({type: 'chat', body})) { status('[data-study-connection]', 'Check-in shared with the room.'); return; }
      try { const payload = await api(`/api/study/sessions/${encodeURIComponent(state.session.id)}/messages`, {method: 'POST', body: {body, kind: 'check_in'}}); if (payload.moderation?.status === 'pending') { status('[data-study-connection]', payload.message || 'Your check-in is pending administrator review and is hidden from the room.'); return; } if (payload.message) { state.messages = [...state.messages, payload.message]; renderChat(); } } catch (error) { status('[data-study-connection]', error.message, true); }
      return;
    }
    if (target.matches('[data-study-timer-start], [data-study-timer-break]')) {
      event.preventDefault();
      if (!isHost()) return;
      const phase = target.matches('[data-study-timer-break]') ? 'break' : 'focus';
      const minutes = phase === 'break' ? Number(state.session?.pomodoro?.break || 10) : Number(state.session?.pomodoro?.focus || state.session?.duration_minutes || 50);
      const round = phase === 'focus' ? Number(state.timer?.round || 0) + 1 : Number(state.timer?.round || 1);
      const packet = {type: 'timer_set', phase, ends_at: new Date(Date.now() + minutes * 60_000).toISOString(), round};
      if (!socketSend(packet)) {
        if (localPreview) {
          state.timer = {phase, ends_at: packet.ends_at, round};
          renderTimer();
          status('[data-study-connection]', 'Local preview timer running');
        } else status('[data-study-connection]', 'Live sync is not connected yet. Reopen the room in a moment.', true);
      }
      return;
    }
    if (target.matches('[data-study-complete]')) {
      event.preventDefault();
      if (!state.session) return;
      const goalCompleted = window.confirm('Mark your goal complete for this session?');
      if (!goalCompleted) return;
      try { await api(`/api/study/sessions/${encodeURIComponent(state.session.id)}/complete`, {method: 'POST', body: {goal_completed: true}}); closeSession(); await refreshOverview(); } catch (error) { status('[data-study-form-status]', error.message, true); }
      return;
    }
    if (target.matches('[data-study-edit-goal]')) {
      event.preventDefault();
      const current = state.session?.goal?.goal || '';
      const goal = window.prompt('What is your goal for this session?', current);
      if (goal === null || !state.session) return;
      try { const payload = await api(`/api/study/sessions/${encodeURIComponent(state.session.id)}`, {method: 'PATCH', body: {goal}}); state.session = payload.session || state.session; renderSession(); } catch (error) { status('[data-study-connection]', error.message, true); }
    }
  }

  function handleAvailabilityInput(event) {
    const field = event.target.closest('[data-window-field]');
    const row = event.target.closest('[data-window-index]');
    if (!field || !row) return;
    const index = Number(row.dataset.windowIndex);
    const item = state.windows[index];
    if (!item) return;
    item[field.dataset.windowField] = field.dataset.windowField === 'weekday' ? Number(field.value) : field.value;
  }

  async function handleChat(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = String(form.elements.body.value || '').trim();
    if (!body || !state.session) return;
    form.elements.body.value = '';
    if (socketSend({type: 'chat', body})) return;
    try {
      const payload = await api(`/api/study/sessions/${encodeURIComponent(state.session.id)}/messages`, {method: 'POST', body: {body}});
      if (payload.moderation?.status === 'pending') { status('[data-study-connection]', payload.message || 'Your message is pending administrator review and is hidden from the room.'); return; }
      if (payload.message) { state.messages = [...state.messages, payload.message]; renderChat(); }
    } catch (error) {
      status('[data-study-connection]', error.message, true);
    }
  }

  function handleMatchFilter() {
    const search = String($('[data-study-match-search]')?.value || '').toLowerCase().trim();
    const duration = String($('[data-study-match-duration]')?.value || '');
    const filtered = state.matches.filter(match => {
      const person = match.candidate || {};
      const haystack = `${displayName(person)} ${person.username || ''} ${asList(person.subjects).join(' ')}`.toLowerCase();
      return (!search || haystack.includes(search)) && (!duration || Number(person.session_duration_minutes || 0) === Number(duration));
    });
    const host = $('[data-study-matches]');
    if (host) host.innerHTML = filtered.length ? filtered.map(matchCard).join('') : '<div class="study-list-empty study-match-error"><i class="bx bx-search-alt" aria-hidden="true"></i><p>No matches fit those filters.</p></div>';
  }

  function bind() {
    $$('[value="cancel"]', root).forEach(button => { button.formNoValidate = true; });
    root.addEventListener('click', event => { handleStudyClick(event).catch(error => status('[data-study-form-status]', error.message, true)); });
    root.addEventListener('input', handleAvailabilityInput);
    root.addEventListener('change', event => {
      if (event.target.matches('[data-study-match-search], [data-study-match-duration]')) handleMatchFilter();
      handleAvailabilityInput(event);
    });
    $('[data-study-profile-form]')?.addEventListener('submit', event => { saveProfile(event).catch(error => status('[data-study-form-status]', error.message, true)); });
    $('[data-study-invite-form]')?.addEventListener('submit', event => { sendInvitation(event).catch(error => status('[data-study-invite-status]', error.message, true)); });
    $('[data-study-room-form]')?.addEventListener('submit', event => { createRoom(event).catch(error => status('[data-study-room-status]', error.message, true)); });
    $('[data-study-chat-form]')?.addEventListener('submit', event => { handleChat(event).catch(error => status('[data-study-connection]', error.message, true)); });
    window.setInterval(renderTimer, 1000);
    window.setInterval(renderSessionClocks, 30_000);
    window.addEventListener('beforeunload', () => { if (state.socket) state.socket.close(); });
  }

  async function init() {
    bind();
    renderAvailability();
    try {
      state.auth = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me'));
      state.csrf = state.auth?.csrf_token || state.csrf;
      state.user = state.auth?.authenticated ? state.auth.user : null;
      if (!state.user) return showAuthGate();
      await loadStudy();
    } catch (error) {
      if (error.status === 401) return showAuthGate();
      $('[data-study-loading]').innerHTML = `<i class="bx bx-error-circle" aria-hidden="true"></i><span>${escapeHtml(error.message || 'Study Together is temporarily unavailable.')}</span>`;
    }
  }

  init();
})();
