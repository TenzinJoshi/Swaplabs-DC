(() => {
  'use strict';

  const state = {
    csrf: '',
    user: null,
    serverAvailable: true,
    adminUsers: [],
    audit: [],
    newsletterSubscribers: [],
    adminOperations: null,
    adminAnalytics: null,
    adminContent: null,
    adminPresence: [],
    adminPresenceCheckedAt: '',
    adminPresenceToday: [],
    adminPresenceTodayCheckedAt: '',
    adminSupportSelection: '',
    adminWorkSelection: {},
    adminWorkLoading: {},
    profileSaveState: null,
    selectedUserId: null,
    selectedMessageRecipientId: null,
    selectedAdminUserIds: new Set(),
    communityUsers: [],
    communityRelevance: new Map(),
    notifications: null,
    notificationRequest: null,
    notificationReadAllPromise: null,
    inboxReadGeneration: 0,
    notificationPanelOpen: false,
    accessWatch: null,
    communityPreviewTrigger: null
  };

  const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  const PRESENCE_HEARTBEAT_MS = 30_000;
  const PRESENCE_FOCUS_THROTTLE_MS = 10_000;
  let presenceTimer = null;
  let presenceLastSentAt = 0;
  let presenceListenersInstalled = false;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const formField = (form, name) => form?.elements?.namedItem(name);
  const {profileColor, escapeHtml, initials, safeAvatarUrl} = window.RelayComponents;
  const avatarHtml = (user, className = 'auth-avatar') => {
    const url = safeAvatarUrl(user);
    const color = escapeHtml(profileColor(user));
    const content = url ?
      `<img src="${escapeHtml(url)}" alt="${escapeHtml(user?.profile?.display_name || user?.username || 'Member')} profile photo">` :
      `<span class="avatar-fallback" aria-label="${escapeHtml(user?.profile?.display_name || user?.username || 'Member')} initials">${escapeHtml(initials(user))}</span>`;
    return `<span class="${className} ${color}">${content}</span>`;
  };
  const setAvatar = (element, user, className = 'profile-avatar-xl') => {
    if (!element) return;
    const url = safeAvatarUrl(user);
    element.className = `${className} ${profileColor(user)}`;
    element.innerHTML = url ?
      `<img src="${escapeHtml(url)}" alt="${escapeHtml(user?.profile?.display_name || 'Member')} profile photo">` :
      `<span class="avatar-fallback" aria-label="${escapeHtml(user?.profile?.display_name || user?.username || 'Member')} initials">${escapeHtml(initials(user))}</span>`;
  };
  const list = value => (Array.isArray(value) ? value : String(value || '').split(',').map(item => item.trim()).filter(
    Boolean)).filter(item => String(item).trim().toLowerCase() !== 'nothing for now');
  const formatDate = value => {
    if (!value) return 'Never';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(parsed);
  };
  const rawCurrentPage = location.pathname.split('/').pop() || 'index.html';
  const currentPage = rawCurrentPage.includes('.') ? rawCurrentPage : `${rawCurrentPage}.html`;
  // The former pre-registration routes now redirect to the live account flow.
  // Keep this compatibility predicate false so old form branches cannot be
  // activated by a stale page copy.
  const isPreRegistrationPage = () => false;
  const automaticTimezone = country => {
    const detected = window.SwapLabsOptions?.timezoneForCountry?.(country);
    if (detected) return detected;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_error) { return 'UTC'; }
  };
  const safeLocalDestination = value => {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('//') || raw.includes('://')) return '';
    try {
      const target = new URL(raw, location.href);
      if (target.origin !== location.origin || !/\.html$/i.test(target.pathname)) return '';
      return `${target.pathname.replace(/^\//, '')}${target.search}${target.hash}`;
    } catch (_error) {
      return '';
    }
  };
  async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (writeMethods.has(method) && !state.csrf) {
      const response = await fetch('/api/auth/csrf', {
        credentials: 'same-origin'
      });
      if (!response.ok) throw new Error('Could not establish a secure session.');
      state.csrf = (await response.json()).csrf_token;
    }
    const headers = {
      ...(options.headers || {})
    };
    if (writeMethods.has(method)) headers['X-CSRF-Token'] = state.csrf;
    if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
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
        error: 'The server returned an unreadable response.'
      };
    }
    if (!response.ok) {
      if (payload.access_status === 'suspended' && currentPage !== 'login.html' && !isPreRegistrationPage()) {
        sessionStorage.setItem('swaplabs-access-notice', payload.error || 'This account is temporarily suspended.');
        setTimeout(() => location.replace('login.html?access=suspended'), 50);
      }
      const error = new Error(payload.error || 'Something went wrong.');
      error.status = response.status;
      error.code = payload.code || '';
      error.profile_completeness = payload.profile_completeness;
      error.required_profile_fields = payload.required_profile_fields;
      error.profile_url = payload.profile_url;
      error.return_to = payload.return_to;
      throw error;
    }
    if (payload.moderation?.status === 'pending') {
      const error = new Error(payload.message || 'Your submission is pending administrator review. It will stay hidden until approved.');
      error.status = response.status;
      error.code = 'pending_moderation';
      error.moderation = payload.moderation;
      throw error;
    }
    if (payload.csrf_token) state.csrf = payload.csrf_token;
    return payload;
  }

  function stopPresenceHeartbeat() {
    if (presenceTimer) window.clearInterval(presenceTimer);
    presenceTimer = null;
  }

  function sendPresenceHeartbeat(force = false) {
    if (!state.user || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - presenceLastSentAt < PRESENCE_FOCUS_THROTTLE_MS) return;
    if (!force && now - presenceLastSentAt < PRESENCE_FOCUS_THROTTLE_MS) return;
    presenceLastSentAt = now;
    api('/api/presence/heartbeat', {
      method: 'POST',
      body: {page: currentPage}
    }).catch(error => {
      if (error.status === 401 || error.status === 403) stopPresenceHeartbeat();
    });
  }

  function startPresenceHeartbeat() {
    if (!state.user) return;
    stopPresenceHeartbeat();
    sendPresenceHeartbeat(true);
    presenceTimer = window.setInterval(() => sendPresenceHeartbeat(), PRESENCE_HEARTBEAT_MS);
    if (presenceListenersInstalled) return;
    presenceListenersInstalled = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sendPresenceHeartbeat(true);
    });
    window.addEventListener('focus', () => sendPresenceHeartbeat(true));
  }

  function setStatus(form, message, type = 'error') {
    const box = $('[data-status]', form);
    if (!box) return;
    box.textContent = message;
    box.className = `form-status show ${type}`;
  }

  function clearStatus(form) {
    const box = $('[data-status]', form);
    if (!box) return;
    box.textContent = '';
    box.className = 'form-status';
  }

  const NAME_FORMAT_MESSAGE = 'Use letters and spaces only, with at least a first and last name (for example, Tenzin Joshi).';
  const FULL_NAME_PATTERN = /^\p{L}+(?:\s+\p{L}+)+$/u;
  const NAME_PART_PATTERN = /^\p{L}+$/u;
  const validName = (value, fieldName = 'full_name') => fieldName === 'full_name' || fieldName === 'display_name' ? FULL_NAME_PATTERN.test(String(value || '').trim()) : NAME_PART_PATTERN.test(String(value || '').trim());
  const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,30}$/;
  const USERNAME_FORMAT_MESSAGE = 'Use 3–30 letters, numbers, dots, dashes, or underscores.';
  const USERNAME_TAKEN_MESSAGE = 'That username is already taken. Try another username.';
  const USERNAME_CHECKING_MESSAGE = 'Checking username availability…';
  const USERNAME_CHECK_FAILED_MESSAGE = 'We could not check this username yet. Try again.';
  const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{6,}$/;
  const PASSWORD_POLICY_MESSAGE = 'Use at least 6 characters with uppercase, lowercase, a number, and a symbol.';

  function registrationFieldMessage(field) {
    const value = String(field?.value || '').trim();
    if (['full_name', 'first_name', 'last_name', 'display_name'].includes(field?.name) && value && !validName(value, field.name)) {
      return NAME_FORMAT_MESSAGE;
    }
    if (field?.name === 'full_name') {
      if (!value) return 'Enter your full name.';
    }
    if (field?.name === 'username') {
      if (!value) return 'Choose a username.';
      if (field.dataset.usernameState === 'taken') return USERNAME_TAKEN_MESSAGE;
      if (field.dataset.usernameState === 'checking') return USERNAME_CHECKING_MESSAGE;
      if (!USERNAME_PATTERN.test(value)) return USERNAME_FORMAT_MESSAGE;
    }
    if (field?.name === 'contact') {
      if (!value) return 'Enter an email address or phone number.';
      const email = /^\S+@\S+\.\S+$/.test(value);
      const phoneDigits = value.replace(/\D/g, '');
      if (!email && (phoneDigits.length < 7 || phoneDigits.length > 15)) return 'Enter a valid email address or phone number.';
    }
    if (field?.name === 'password') {
      const password = String(field?.value || '');
      if (!password) return 'Create a password.';
      if (!PASSWORD_PATTERN.test(password)) return PASSWORD_POLICY_MESSAGE;
    }
    if (field?.name === 'confirm_password' && !value) return 'Confirm your password.';
    if (field?.name === 'date_of_birth') return field.validationMessage || 'Enter your date of birth.';
    if (field?.name === 'guardian_name') return 'Enter the guardian name.';
    if (field?.name === 'guardian_email') return 'Enter the guardian email.';
    if (field?.name === 'guardian_relationship') return 'Choose the guardian relationship.';
    if (field?.name === 'terms') return 'Agree to the Terms and Privacy Policy to create your account.';
    if (field?.name === 'guardian_consent_declared') return 'The named guardian must confirm consent.';
    return field?.validationMessage || 'Complete this field.';
  }

  function syncRegistrationFieldError(field, reveal = false) {
    if (!field || field.type === 'hidden' || field.disabled) return false;
    const wrapper = field.closest('.field, .terms-row');
    if (!wrapper) return false;
    const invalid = !field.checkValidity();
    const usernameFeedback = field.name === 'username' ? wrapper.querySelector('[data-username-feedback]') : null;
    if (usernameFeedback) {
      const state = field.dataset.usernameState || '';
      const shouldShow = invalid && (reveal || wrapper.classList.contains('has-error'));
      const liveState = ['available', 'checking'].includes(state) || (state && shouldShow);
      wrapper.classList.toggle('has-error', Boolean(shouldShow || state === 'taken' || state === 'invalid' || state === 'error'));
      field.setAttribute('aria-invalid', String(invalid));
      usernameFeedback.hidden = !liveState;
      if (shouldShow && !usernameFeedback.textContent) usernameFeedback.textContent = registrationFieldMessage(field);
      const describedBy = new Set(String(field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
      if (liveState) describedBy.add(usernameFeedback.id);
      else describedBy.delete(usernameFeedback.id);
      if (describedBy.size) field.setAttribute('aria-describedby', [...describedBy].join(' '));
      else field.removeAttribute('aria-describedby');
      return invalid;
    }
    let error = wrapper.querySelector('[data-age-error], [data-field-error]');
    if (invalid && !error) {
      error = document.createElement('small');
      error.className = 'field-error';
      error.dataset.fieldError = 'true';
      error.id = `${field.id || field.name}-error`;
      error.setAttribute('role', 'alert');
      wrapper.appendChild(error);
    }
    const shouldShow = invalid && (reveal || wrapper.classList.contains('has-error'));
    wrapper.classList.toggle('has-error', shouldShow);
    field.setAttribute('aria-invalid', String(invalid));
    if (error) {
      error.textContent = invalid ? registrationFieldMessage(field) : '';
      error.hidden = !shouldShow;
      const describedBy = new Set(String(field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
      if (shouldShow) describedBy.add(error.id);
      else if (error.dataset.fieldError) describedBy.delete(error.id);
      if (describedBy.size) field.setAttribute('aria-describedby', [...describedBy].join(' '));
      else field.removeAttribute('aria-describedby');
    }
    return invalid;
  }

  function showRegistrationValidation(form) {
    let firstInvalid = null;
    [...form.elements].forEach(field => {
      if (!field || field.type === 'hidden' || field.disabled || ['button', 'submit', 'reset'].includes(field.type)) return;
      const invalid = syncRegistrationFieldError(field, true);
      if (invalid && !firstInvalid) firstInvalid = field;
    });
    return firstInvalid;
  }

  function loading(button, active, label) {
    if (!button) return;
    if (active) {
      button.dataset.originalHtml = button.innerHTML;
      button.classList.add('button-loading');
      button.disabled = true;
      button.innerHTML = `<i class="bx bx-loader-alt"></i> ${escapeHtml(label || 'Working')}`;
    } else {
      button.classList.remove('button-loading');
      button.disabled = false;
      if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
    }
  }

  function toast(message, type = 'success') {
    let element = $('.auth-toast');
    if (!element) {
      element = document.createElement('div');
      element.className = 'auth-toast';
      document.body.appendChild(element);
    }
    element.className = `auth-toast ${type}`;
    const actionLink = window.SwapLabsNotice?.actionLink(message, type) || '';
    element.classList.toggle('has-action-link', Boolean(actionLink));
    element.innerHTML =
      `<i class="bx ${type === 'error' ? 'bx-error-circle' : 'bx-check-circle'}"></i><div class="toast-copy"><span>${escapeHtml(message)}</span>${actionLink}</div>`;
    requestAnimationFrame(() => element.classList.add('show'));
    clearTimeout(element.hideTimer);
    element.hideTimer = setTimeout(() => element.classList.remove('show'), 3600);
  }

  function showServerRequired() {
    $$('[data-server-required]').forEach(element => element.classList.add('show'));
  }

  function renderAccountNavigation() {
    const host = $('[data-auth-nav]');
    if (!host) return;
    if (!state.user) {
      host.innerHTML =
        '<a class="btn auth-login-button" href="login.html" aria-label="Log in" title="Log in"><i class="bx bx-log-in" aria-hidden="true"></i><span class="auth-login-label">Log in</span></a><a class="btn btn-primary" href="register.html"><i class="bx bx-user-plus" aria-hidden="true"></i> Create account</a>';
      return;
    }
    const user = state.user;
    // Keep the main workspace destinations visible without turning the header
    // into a second dashboard. The labels stay in tooltips so the controls
    // remain compact and recognizable at a glance.
    host.innerHTML =
      `<span class="streak-nav-shell" data-streak-nav-shell><span class="streak-nav-trigger"><a class="streak-nav-link" data-streak-nav href="dashboard.html" aria-haspopup="dialog" aria-expanded="false" aria-label="Learning streak loading" title="Learning streak"><span class="streak-nav-flame" aria-hidden="true"><i class="bx bxs-hot"></i></span><span class="streak-nav-copy"><small>Streak</small><strong data-streak-nav-value>0</strong></span></a><button class="streak-nav-toggle" data-streak-nav-toggle type="button" aria-label="Show learning streak details" aria-expanded="false"><i class="bx bx-chevron-down" aria-hidden="true"></i></button></span><div class="streak-nav-panel" data-streak-nav-panel role="dialog" aria-label="Learning streak details" aria-hidden="true"><div class="streak-nav-panel-head"><div><span class="streak-panel-kicker"><i class="bx bxs-hot" aria-hidden="true"></i> Learning habit</span><strong data-streak-panel-title>0 day streak</strong></div><span class="streak-panel-best"><i class="bx bx-trophy" aria-hidden="true"></i><b data-streak-panel-best>0 best</b></span></div><p class="streak-panel-message" data-streak-panel-message>Complete one learning session today to start your streak.</p><div class="streak-nav-summary"><span><i class="bx bx-snowflake" aria-hidden="true"></i><b data-streak-panel-freezes>3</b><small>freezes left</small></span><span><i class="bx bx-trophy" aria-hidden="true"></i><b data-streak-panel-next>7 days</b><small>next milestone</small></span></div><div class="streak-nav-week" data-streak-nav-week role="list" aria-label="Your last seven learning days"></div><div class="streak-nav-milestones" data-streak-nav-milestones aria-label="Streak milestones"></div><div class="streak-nav-panel-actions"><a href="dashboard.html"><i class="bx bx-grid-alt" aria-hidden="true"></i> Dashboard</a><a href="calendar.html"><i class="bx bx-calendar" aria-hidden="true"></i> Sessions</a></div></div></span><span class="notification-nav-shell" data-notification-nav-shell><span class="notification-nav-trigger"><button class="notification-nav-link" data-notification-nav type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Notifications loading" title="Notifications"><span class="notification-nav-bell" aria-hidden="true"><i class="bx bx-bell"></i><span class="notification-nav-count" data-notification-nav-count hidden>0</span></span><span class="notification-nav-copy"><small>Updates</small><strong data-notification-nav-value>0</strong></span></button><button class="notification-nav-toggle" data-notification-nav-toggle type="button" aria-label="Show notifications" aria-expanded="false"><i class="bx bx-chevron-down" aria-hidden="true"></i></button></span><div class="notification-nav-panel" data-notification-nav-panel role="dialog" aria-label="Notifications and reminders" aria-hidden="true"><div class="notification-nav-panel-head"><div><span class="notification-panel-kicker"><i class="bx bx-bell" aria-hidden="true"></i> Your updates</span><strong data-notification-nav-title>Nothing new right now</strong></div><a href="notifications.html">See all</a></div><div class="notification-nav-list" data-notification-nav-list><div class="notification-nav-loading"><i class="bx bx-loader-alt bx-spin"></i> Loading updates…</div></div><div class="notification-nav-reminders" data-notification-nav-reminders></div><div class="notification-nav-panel-actions"><a href="notifications.html"><i class="bx bx-bell" aria-hidden="true"></i> Notifications</a><a href="calendar.html"><i class="bx bx-calendar" aria-hidden="true"></i> Schedule</a><a href="portfolio.html#portfolioConnections"><i class="bx bx-group" aria-hidden="true"></i> Profile</a></div></div></span><span class="auth-utility-group" role="group" aria-label="Your SwapLabs space"><a class="btn auth-icon-btn auth-utility-link" href="calendar.html" aria-label="Open calendar" title="Calendar"><i class="bx bx-calendar"></i></a><a class="btn auth-icon-btn auth-utility-link notification-nav-link" href="notifications.html" aria-label="Open inbox" title="Inbox"><i class="bx bx-message-square-dots"></i><span class="notification-badge" data-notification-badge hidden>0</span></a></span><a class="btn auth-user-button" href="portfolio.html" aria-label="Open ${escapeHtml(user.profile.display_name)} portfolio" title="My portfolio">${avatarHtml(user)}</a>`;
    setupStreakNavigation();
    setupNotificationNavigation();
  }

  function setupStreakNavigation() {
    const shell = $('[data-streak-nav-shell]');
    const toggle = $('[data-streak-nav-toggle]', shell || document);
    const panel = $('[data-streak-nav-panel]', shell || document);
    if (!shell || !toggle || !panel || shell.dataset.streakReady) return;
    shell.dataset.streakReady = 'true';
    const setOpen = open => {
      shell.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      $('[data-streak-nav]', shell)?.setAttribute('aria-expanded', String(open));
      panel.setAttribute('aria-hidden', String(!open));
    };
    toggle.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      setOpen(!shell.classList.contains('is-open'));
    });
    shell.addEventListener('focusin', () => setOpen(true));
    shell.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.focus();
      }
    });
    shell.addEventListener('focusout', event => {
      if (!shell.contains(event.relatedTarget)) setOpen(false);
    });
    if (!document.documentElement.dataset.streakDismissBound) {
      document.documentElement.dataset.streakDismissBound = 'true';
      document.addEventListener('pointerdown', event => {
        const activeShell = document.querySelector('[data-streak-nav-shell]');
        if (!activeShell || activeShell.contains(event.target)) return;
        activeShell.classList.remove('is-open');
        $('[data-streak-nav-toggle]', activeShell)?.setAttribute('aria-expanded', 'false');
        $('[data-streak-nav]', activeShell)?.setAttribute('aria-expanded', 'false');
        $('[data-streak-nav-panel]', activeShell)?.setAttribute('aria-hidden', 'true');
      });
    }
  }

  function setupNotificationNavigation() {
    const shell = $('[data-notification-nav-shell]');
    const trigger = $('[data-notification-nav]', shell || document);
    const toggle = $('[data-notification-nav-toggle]', shell || document);
    const panel = $('[data-notification-nav-panel]', shell || document);
    if (!shell || !trigger || !toggle || !panel || shell.dataset.notificationReady) return;
    shell.dataset.notificationReady = 'true';
    const setOpen = open => {
      state.notificationPanelOpen = open;
      shell.classList.toggle('is-open', open);
      trigger.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-expanded', String(open));
      panel.setAttribute('aria-hidden', String(!open));
      if (open) {
        const load = state.notifications ? Promise.resolve(state.notifications) : fetchNotifications().then(result => {
          state.notifications = result;
          renderNotificationNavigation(result);
          return result;
        });
        load.then(() => markNotificationsSeen()).catch(() => {});
      }
    };
    trigger.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      setOpen(!shell.classList.contains('is-open'));
    });
    toggle.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      setOpen(!shell.classList.contains('is-open'));
    });
    shell.addEventListener('mouseenter', () => setOpen(true));
    shell.addEventListener('mouseleave', () => setOpen(false));
    shell.addEventListener('focusin', () => setOpen(true));
    shell.addEventListener('focusout', event => {
      if (!shell.contains(event.relatedTarget)) setOpen(false);
    });
    shell.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.focus();
      }
    });
    if (!document.documentElement.dataset.notificationDismissBound) {
      document.documentElement.dataset.notificationDismissBound = 'true';
      document.addEventListener('pointerdown', event => {
        const activeShell = document.querySelector('[data-notification-nav-shell]');
        if (!activeShell || activeShell.contains(event.target)) return;
        state.notificationPanelOpen = false;
        activeShell.classList.remove('is-open');
        $('[data-notification-nav]', activeShell)?.setAttribute('aria-expanded', 'false');
        $('[data-notification-nav-toggle]', activeShell)?.setAttribute('aria-expanded', 'false');
        $('[data-notification-nav-panel]', activeShell)?.setAttribute('aria-hidden', 'true');
      });
    }
  }

  function applyNotificationsReadState() {
    if (!state.notifications) return;
    state.notifications = {
      ...state.notifications,
      notifications: (state.notifications.notifications || []).map(item => ({...item, read: true})),
      notification_unread_count: 0
    };
    renderNotificationNavigation(state.notifications);
    if ($('#notificationFeed')) renderNotificationCenter(state.notifications);
  }

  async function markNotificationsSeen() {
    const unread = Number(state.notifications?.notification_unread_count || 0);
    if (!unread && state.notifications) return;
    if (state.notificationReadAllPromise) return state.notificationReadAllPromise;
    state.notificationReadAllPromise = api('/api/notifications/read-all', {method: 'POST'})
      .then(result => {
        applyNotificationsReadState();
        return result;
      })
      .finally(() => {
        state.notificationReadAllPromise = null;
      });
    return state.notificationReadAllPromise;
  }

  function notificationLabel(type) {
    return {
      follow_request: 'Follow request',
      follow_accepted: 'Follow accepted',
      follow_declined: 'Follow update',
      new_follower: 'New follower',
      admin_announcement: 'SwapLabs announcement',
      follower_removed: 'Follower update',
      message: 'New message',
      study_invitation: 'Study invitation',
      study_invitation_accepted: 'Study session confirmed',
      study_invitation_declined: 'Study invitation update',
      study_invitation_countered: 'Study time suggestion',
      study_room_joined: 'Study room update',
      study_message: 'Study room message',
      study_session_completed: 'Study session complete',
      session_progress_report: 'Session update',
      session_credit_reward: 'Credit reward',
      session_credits_settled: 'Exchange update',
      streak_milestone_reward: 'Streak reward'
    }[type] || String(type || 'Update').replaceAll('_', ' ');
  }

  function notificationNavActionMarkup(item) {
    if (!item?.actor || item.type !== 'new_follower' || item.actor.follows_viewer === false) return '';
    const actorId = escapeHtml(item.actor.id);
    const relationship = item.actor.relationship || 'none';
    const followBack = ['following', 'requested', 'self'].includes(relationship) ? '' : `<button class="notification-nav-action notification-nav-follow" type="button" data-notification-follow-back="${actorId}"><i class="bx bx-user-plus"></i> Follow back</button>`;
    return `<div class="notification-nav-actions">${followBack}<button class="notification-nav-action notification-nav-remove" type="button" data-notification-remove-follower="${actorId}"><i class="bx bx-user-x"></i> Remove</button></div>`;
  }

  function renderNotificationNavigation(result = {}) {
    const shell = $('[data-notification-nav-shell]');
    if (!shell) return;
    const notifications = Array.isArray(result.notifications) ? result.notifications : [];
    const followingActivity = Array.isArray(result.following_activity) ? result.following_activity : [];
    const reminders = Array.isArray(result.reminders) ? result.reminders : [];
    const unread = Number(result.notification_unread_count || 0);
    const value = $('[data-notification-nav-value]', shell);
    const count = $('[data-notification-nav-count]', shell);
    const title = $('[data-notification-nav-title]', shell);
    const trigger = $('[data-notification-nav]', shell);
    if (value) value.textContent = unread > 99 ? '99+' : String(unread);
    if (count) {
      count.textContent = unread > 99 ? '99+' : String(unread);
      count.hidden = unread === 0;
    }
    if (trigger) {
      trigger.setAttribute('aria-label', unread ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'No unread notifications');
      trigger.title = unread ? `${unread} unread update${unread === 1 ? '' : 's'}` : 'Notifications';
      trigger.classList.toggle('has-unread', unread > 0);
    }
    if (title) title.textContent = unread ? `${unread} update${unread === 1 ? '' : 's'} to review` : 'Nothing new right now';
    const listHost = $('[data-notification-nav-list]', shell);
    if (listHost) {
      const items = notifications.slice(0, 4);
      listHost.innerHTML = items.length ? items.map(item => `<article class="notification-nav-item${item.read ? '' : ' is-unread'}"><span class="notification-nav-item-icon">${item.actor ? avatarHtml(item.actor) : `<i class="bx ${notificationIcon(item.type)}"></i>`}</span><div class="notification-nav-item-copy"><strong>${escapeHtml(item.title || item.actor?.profile?.display_name || notificationLabel(item.type))}</strong><p>${escapeHtml(item.message || notificationLabel(item.type))}</p><time>${escapeHtml(formatDate(item.created_at))}</time>${notificationNavActionMarkup(item)}</div>${item.read ? '' : `<button class="notification-nav-read" type="button" data-notification-nav-read="${escapeHtml(item.id)}" aria-label="Mark notification as read"><i class="bx bx-check"></i></button>`}</article>`).join('') : '<div class="notification-nav-empty"><i class="bx bx-check-shield"></i><span>You are all caught up.</span></div>';
      if (followingActivity.length) listHost.innerHTML += `<div class="notification-nav-following"><span><i class="bx bx-user-check"></i> You recently followed</span><div>${followingActivity.slice(0, 3).map(person => `<a href="member-profile.html?user=${encodeURIComponent(person.id)}">${avatarHtml(person)}<b>${escapeHtml(person.profile?.display_name || person.username)}</b></a>`).join('')}</div></div>`;
    }
    const reminderHost = $('[data-notification-nav-reminders]', shell);
    if (reminderHost) {
      reminderHost.innerHTML = reminders.length ? `<div class="notification-nav-reminder-head"><span><i class="bx bx-time-five"></i> Coming up</span><a href="calendar.html">Schedule</a></div>${reminders.slice(0, 3).map(item => `<a class="notification-nav-reminder" href="${escapeHtml(item.href || 'calendar.html')}"><span class="notification-nav-reminder-icon"><i class="bx ${item.kind === 'workshop' ? 'bx-chalkboard' : 'bx-calendar-event'}"></i></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(formatDate(item.starts_at))}${item.kind === 'workshop' ? ' · Workshop' : ' · Session'}</small></span><i class="bx bx-chevron-right"></i></a>`).join('')}` : '';
    }
    bindNotificationNavigationActions(shell);
  }

  function bindNotificationNavigationActions(shell) {
    $$('[data-notification-nav-read]', shell).forEach(button => button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      await markNotificationQuick(button.dataset.notificationNavRead, button);
    }));
    $$('[data-notification-follow-back]', shell).forEach(button => button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      await notificationFollowBack(button.dataset.notificationFollowBack, button);
    }));
    $$('[data-notification-remove-follower]', shell).forEach(button => button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      await notificationRemoveFollower(button.dataset.notificationRemoveFollower, button);
    }));
  }

  async function markNotificationQuick(notificationId, button) {
    loading(button, true, '');
    try {
      await api(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {method: 'PATCH'});
      await refreshNotificationBadge();
    } catch (error) {
      toast(error.message, 'error');
      loading(button, false);
    }
  }

  async function notificationFollowBack(userId, button) {
    loading(button, true, '');
    try {
      const result = await api(`/api/community/users/${encodeURIComponent(userId)}/follow`, {method: 'POST'});
      toast(result.message);
      await refreshNotificationBadge();
      window.dispatchEvent(new CustomEvent('relayskills:connections-updated'));
    } catch (error) {
      toast(error.message, 'error');
      loading(button, false);
    }
  }

  async function notificationRemoveFollower(userId, button) {
    if (!confirm('Remove this person from your followers?')) return;
    loading(button, true, '');
    try {
      const result = await api(`/api/community/followers/${encodeURIComponent(userId)}`, {method: 'DELETE'});
      toast(result.message);
      await refreshNotificationBadge();
      window.dispatchEvent(new CustomEvent('relayskills:connections-updated'));
    } catch (error) {
      toast(error.message, 'error');
      loading(button, false);
    }
  }

  function renderStreakNavigation(streak = {}) {
    const shell = $('[data-streak-nav-shell]');
    const link = $('[data-streak-nav]', shell || document);
    if (!shell || !link) return;
    const current = Math.max(0, Number(streak.current_streak || 0));
    const longest = Math.max(current, Number(streak.longest_streak || 0));
    const freezes = Math.max(0, Number(streak.streak_freezes || 0));
    const value = $('[data-streak-nav-value]', link);
    if (value) value.textContent = current.toLocaleString();
    const label = current === 1 ? '1 day learning streak' : `${current} day learning streak`;
    link.setAttribute('aria-label', `${label}. ${freezes} streak ${freezes === 1 ? 'freeze' : 'freezes'} left.`);
    link.title = `${label} · ${freezes} ${freezes === 1 ? 'freeze' : 'freezes'} left`;
    link.classList.toggle('is-active', current > 0);
    link.classList.toggle('is-at-risk', current > 0 && !streak.today_complete);
    const milestones = Array.isArray(streak.milestones) && streak.milestones.length ? streak.milestones : [
      {target: 7, reward_credits: 25}, {target: 30, reward_credits: 100},
      {target: 100, reward_credits: 400}, {target: 365, reward_credits: 1000}
    ].map(item => ({...item, earned: longest >= item.target}));
    const next = milestones.find(item => !item.earned);
    const title = $('[data-streak-panel-title]', shell);
    const best = $('[data-streak-panel-best]', shell);
    const message = $('[data-streak-panel-message]', shell);
    const freezesNode = $('[data-streak-panel-freezes]', shell);
    const nextNode = $('[data-streak-panel-next]', shell);
    const week = $('[data-streak-nav-week]', shell);
    const milestonesNode = $('[data-streak-nav-milestones]', shell);
    if (title) title.textContent = `${current.toLocaleString()} day streak`;
    if (best) best.textContent = `${longest.toLocaleString()} best`;
    if (message) message.textContent = streak.today_complete ?
      'Today is in the book. Come back tomorrow to keep the rhythm going.' :
      current > 0 ? 'Complete one learning session today to extend your streak.' : 'Complete one learning session today to start your streak.';
    if (freezesNode) freezesNode.textContent = freezes.toLocaleString();
    if (nextNode) nextNode.textContent = next ? `${Number(next.target)} days · +${Number(next.reward_credits || 0)} credits` : 'All earned';
    if (milestonesNode) milestonesNode.innerHTML = milestones.map(item => `<span class="streak-nav-milestone${item.earned ? ' is-earned' : Number(item.target) === Number(next?.target) ? ' is-next' : ''}"><i class="bx ${item.earned ? 'bx-check' : 'bx-lock-alt'}" aria-hidden="true"></i><b>${Number(item.target)}</b><small>days · +${Number(item.reward_credits || 0)}</small></span>`).join('');
    if (week) {
      const days = Array.isArray(streak.recent_days) ? streak.recent_days : [];
      week.innerHTML = days.map(day => {
        const status = ['complete', 'freeze', 'today', 'missed'].includes(day.status) ? day.status : 'missed';
        const icon = status === 'complete' ? 'bx-check' : status === 'freeze' ? 'bx-snowflake' : status === 'today' ? 'bxs-hot' : 'bx-minus';
        const description = status === 'complete' ? 'Learning session completed' : status === 'freeze' ? 'Protected by a streak freeze' : status === 'today' ? 'Today' : 'No session recorded';
        return `<span class="streak-nav-day is-${status}" role="listitem" title="${escapeHtml(`${day.date}: ${description}`)}"${status === 'today' ? ' aria-current="date"' : ''}><b>${escapeHtml(day.label || '')}</b><i class="bx ${icon}" aria-hidden="true"></i></span>`;
      }).join('');
    }
  }

  async function refreshStreakNavigation() {
    if (!state.user) return;
    try {
      const result = await api('/api/streak');
      renderStreakNavigation(result.streak || {});
      window.dispatchEvent(new CustomEvent('relayskills:streak-updated', {detail: {streak: result.streak || {}}}));
    } catch (_error) {
      // A temporary streak read failure must not make the global navigation unusable.
    }
  }

  async function refreshNotificationBadge({force = false, generation = state.inboxReadGeneration} = {}) {
    if (!state.user) return;
    try {
      const result = await fetchNotifications({force});
      // A badge response started before a chat was opened may still contain
      // the old unread count. Never let that stale response repaint the badge.
      if (generation !== state.inboxReadGeneration) return;
      state.notifications = result;
      renderNotificationNavigation(result);
      if (state.notificationPanelOpen) markNotificationsSeen().catch(() => {});
      const badge = $('[data-notification-badge]');
      if (badge) {
        // This control opens Chats, so it must represent unread chat messages
        // only. General notifications and follow requests have their own
        // surfaces and must not leave a stale number on the chat icon.
        const count = Number(result.inbox_unread_count || 0);
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = count === 0;
      }
    } catch (_error) {
      // The global header remains usable if notifications cannot be refreshed.
    }
  }

  window.addEventListener('swaplabs:inbox-read', event => {
    const generation = ++state.inboxReadGeneration;
    const badge = $('[data-notification-badge]');
    if (badge) {
      badge.textContent = '0';
      badge.hidden = true;
    }
    // Optimistic events make the UI instant; the confirmed event is emitted
    // after the conversation endpoint commits the read watermark.
    if (!event.detail?.confirmed) return;
    refreshNotificationBadge({force: true, generation});
  });
  window.addEventListener('swaplabs:profile-updated', () => refreshStreakNavigation());

  async function logout() {
    const pendingProfile = state.profileSaveState;
    if ((pendingProfile?.isDirty() || pendingProfile?.isSaving()) &&
        !confirm('You have unsaved profile changes. Log out without saving?')) return;
    stopPresenceHeartbeat();
    try {
      await api('/api/auth/logout', {
        method: 'POST'
      });
      state.user = null;
      window.SwapLabsAuth?.remember?.(null);
      window.SwapLabsAuth?.reset?.();
      pendingProfile?.allowDeparture();
      location.href = 'index.html';
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  // Workspace pages keep their own toolbar, while the public navigation now
  // sends members to Settings for sign-out. Expose the same protected action
  // so admin/workspace controls still invalidate the server session.
  window.SwapLabsAuth = {...window.SwapLabsAuth, logout};

  function setupPasswordToggles() {
    $$('[data-password-toggle]').forEach(button => button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      button.innerHTML = `<i class="bx ${input.type === 'password' ? 'bx-show' : 'bx-hide'}"></i>`;
      button.setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
    }));
  }

  function setupAdminShortcut(form) {
    if (!form) return;
    const login = form.elements.namedItem('login');
    const password = form.elements.namedItem('password');
    if (!login || !password) return;
    form.addEventListener('submit', event => {
      if (password.value) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      submitAdminCode(form, String(login.value || '').trim());
    }, true);
  }

  async function submitAdminCode(form, code) {
    clearStatus(form);
    const login = form.elements.namedItem('login');
    const submit = $('button[type="submit"]', form);
    if (!code) {
      setStatus(form, 'Enter your administrator code in the username field.');
      login?.focus();
      return;
    }
    loading(submit, true, 'Verifying code');
    try {
      await api('/api/auth/admin-gate', {method: 'POST', body: {code}});
      location.replace('admin.html');
    } catch (error) {
      setStatus(form, error.message || 'The administrator code was not accepted.');
      loading(submit, false);
      login?.select();
    }
  }

  async function submitLogin(form, mode, destination) {
    clearStatus(form);
    const submit = $('button[type="submit"]', form);
    const fields = new FormData(form);
    const payload = mode === 'admin' ?
      {
        mode,
        admin_id: fields.get('admin_id'),
        password: fields.get('password')
      } :
      {
        mode,
        login: fields.get('login'),
        password: fields.get('password')
      };
    loading(submit, true, 'Verifying');
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: payload
      });
      if (result.password_change_required) {
        window.SwapLabsAuth?.reset?.();
        setStatus(form, 'Temporary password verified. Choose your permanent password next.', 'success');
        location.href = 'reset-password.html';
        return;
      }
      state.user = result.user;
      window.SwapLabsAuth?.remember?.(result.user);
      window.SwapLabsAuth?.reset?.();
      window.SwapLabsPreferences?.apply(result.user.preferences || {});
      setStatus(form, `Welcome back, ${result.user.profile.display_name}.`, 'success');
      const landingPages = {
        dashboard: 'dashboard.html',
        home: 'index.html',
        profile: 'profile.html',
        inbox: 'notifications.html',
        calendar: 'calendar.html',
        community: 'community.html'
      };
      const requestedDestination = safeLocalDestination(new URLSearchParams(location.search).get('next'));
      const accountDestination = requestedDestination || landingPages[result.user.preferences?.default_landing] || destination;
      setTimeout(() => {
        location.href = accountDestination;
      }, 380);
    } catch (error) {
      setStatus(form, error.message, 'error');
      loading(submit, false);
    }
  }

  function setupGoogleLogin(form) {
    const link = $('[data-google-login-link]');
    const note = $('[data-google-auth-note]');
    if (!link) return;
    const params = new URLSearchParams(location.search);
    const googleError = params.get('google_error');
    if (googleError && form) setStatus(form, googleError, 'error');
    let unavailableMessage = 'Google sign-in is not configured on the published site yet.';
    const disable = message => {
      link.classList.add('is-disabled');
      link.setAttribute('aria-disabled', 'true');
      link.href = '#google-sign-in';
      if (note) note.textContent = message || unavailableMessage;
      link.onclick = event => {
        event.preventDefault();
        if (form) setStatus(form, message || unavailableMessage, 'error');
      };
    };
    const enable = () => {
      link.classList.remove('is-disabled');
      link.removeAttribute('aria-disabled');
      link.href = '/api/auth/google/start?flow=login&return_to=dashboard.html';
      link.onclick = null;
      if (note) note.textContent = 'Use Google after you link it from your profile.';
    };
    api('/api/auth/google/status').then(result => {
      if (result.enabled) enable();
      else disable(unavailableMessage);
    }).catch(() => disable('Google sign-in is temporarily unavailable. You can still use your SwapLabs password.'));
  }

  function setupLoginPage() {
    const memberForm = $('#memberLoginForm');
    setupAdminShortcut(memberForm);
    const googleSignedIn = new URLSearchParams(location.search).get('google') === 'signed_in';
    if (googleSignedIn && state.user && state.user.role !== 'admin') {
      location.replace('dashboard.html');
      return;
    }
    memberForm?.addEventListener('submit', event => {
      event.preventDefault();
      submitLogin(memberForm, 'auto', 'dashboard.html');
    });
    const accessNotice = sessionStorage.getItem('swaplabs-access-notice');
    if (accessNotice && memberForm) {
      setStatus(memberForm, accessNotice, 'error');
      sessionStorage.removeItem('swaplabs-access-notice');
    }
    if (state.user) {
      const banner = $('[data-current-session]');
      if (banner) {
        banner.hidden = false;
        banner.innerHTML = state.user.role === 'admin' ?
          '<div><strong>Administrator session already active.</strong><span>Enter your administrator code in the sign-in field to open the protected workspace.</span></div>' :
          `<div><strong>You are already signed in as ${escapeHtml(state.user.profile.display_name)}.</strong><span>Continue to your member profile.</span></div><a class="btn btn-sm" href="profile.html">Continue <i class="bx bx-right-arrow-alt"></i></a>`;
      }
    }
    setupGoogleLogin(memberForm);
  }

  function registrationPayload(form) {
    const fields = new FormData(form);
    const text = name => String(fields.get(name) || '').trim();
    // Registration pages do not show the member-settings checkbox. New
    // members should therefore be discoverable by default; the profile page
    // remains the explicit place to turn matching off later.
    const matchVisibilityField = form.elements.match_visibility;
    const fullName = text('full_name') || text('display_name') || [text('first_name'), text('last_name')].filter(Boolean).join(' ');
    const nameParts = fullName.split(/\s+/).filter(Boolean);
    const firstName = text('first_name') || nameParts.shift() || '';
    const lastName = text('last_name') || nameParts.join(' ');
    const contact = text('contact') || text('email');
    const emailContact = /^\S+@\S+\.\S+$/.test(contact) ? contact.toLowerCase() : '';
    const phoneContact = emailContact ? text('phone_number') : contact;
    const dateOfBirth = text('date_of_birth');
    const calculatedAge = ageFromDateOfBirth(dateOfBirth);
    const derivedAge = calculatedAge !== null && calculatedAge >= 3 && calculatedAge <= 120 ? String(calculatedAge) : text('age');
    const derivedAccountType = calculatedAge !== null && calculatedAge >= 3 && calculatedAge < 13 ? 'child' : 'adult';
    return {
      username: text('username'),
      contact,
      email: emailContact,
      registration_source: form.dataset.earlyProfileFlow === 'true' ? 'early_registration' :
        isPreRegistrationPage() ? 'pre_registration' : text('registration_source') || 'standard',
      password: String(fields.get('password') || ''),
      accepted_terms: fields.get('terms') === 'on',
      profile: {
        first_name: firstName,
        last_name: lastName,
        display_name: fullName,
        phone_number: phoneContact,
        pronouns: text('pronouns'),
        gender: text('gender'),
        date_of_birth: dateOfBirth,
        age: derivedAge,
        country: text('country'),
        city: text('city'),
        timezone: text('timezone') || automaticTimezone(text('country')),
        primary_language: text('primary_language') || 'English',
        additional_languages: text('additional_languages'),
        languages_to_learn: text('languages_to_learn'),
        occupation: text('occupation'),
        professional_role: text('professional_role'),
        organization: text('organization'),
        headline: text('headline'),
        bio: text('bio'),
        website: text('website'),
        availability: text('availability'),
        preferred_format: text('preferred_format'),
        teaching_style: text('teaching_style'),
        experience_level: text('experience_level'),
        learning_goal: text('learning_goal'),
        skills_to_teach: text('skills_to_teach'),
        skills_to_learn: text('skills_to_learn'),
        skill_details: text('skill_details'),
        interests: text('interests'),
        profile_color: text('profile_color')
      },
      preferences: {
        match_visibility: matchVisibilityField ? fields.get('match_visibility') === 'on' : true,
        show_location: fields.get('show_location') === 'on',
        email_notifications: fields.get('email_notifications') === 'on',
        weekly_digest: fields.get('weekly_digest') === 'on',
        profile_visibility: text('profile_visibility') || 'public'
      },
      safety: {
        account_type: derivedAccountType,
        guardian_name: text('guardian_name'),
        guardian_email: text('guardian_email'),
        guardian_relationship: text('guardian_relationship'),
        guardian_consent_declared: fields.get('guardian_consent_declared') === 'on'
      }
    };
  }

  function ageFromDateOfBirth(value) {
    const birthDate = new Date(`${value}T12:00:00`);
    if (Number.isNaN(birthDate.getTime())) return null;
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const beforeBirthday = today.getMonth() < birthDate.getMonth() ||
      today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate();
    if (beforeBirthday) age -= 1;
    return age;
  }

  function setupRegistrationInterests(form) {
    const root = form.querySelector('[data-registration-interests]');
    if (!root || root.dataset.interestsReady) return;
    root.dataset.interestsReady = 'true';
    const standalonePreRegistration = isPreRegistrationPage();

    // These are deliberately addressed by id. The options enhancer also
    // decorates the two skill inputs with its own data attributes, so using
    // namedItem() here can accidentally bind the selector state to a stale
    // field reference when the form is hydrated more than once.
    const hidden = {
      teach: form.querySelector('#registrationSkillsTeach'),
      learn: form.querySelector('#registrationSkillsLearn'),
      interests: form.querySelector('#registrationInterests'),
      details: form.querySelector('#registrationSkillDetails')
    };
    // Keep the first registration choice calm and approachable. The detailed
    // step still expands every selected field into 100+ specifics, so this
    // list is intentionally limited to 50 broad starting points.
    const catalogFields = [
      'News and current affairs', 'Sports', 'Business and finance', 'Technology', 'Programming',
      'Web development', 'Mobile app development', 'Data science and AI', 'Cybersecurity',
      'Digital literacy', 'Mathematics', 'Science', 'Engineering and robotics', 'Design',
      'Photography', 'Video and film', 'Art and illustration', 'Writing and storytelling',
      'Public speaking and communication', 'Languages', 'Teaching and tutoring', 'Research', 'Music',
      'Dance and theatre', 'Cooking', 'Baking and food', 'Health and wellbeing', 'Fitness',
      'Travel and adventure', 'Gardening and sustainability', 'DIY and home repair', 'Crafts and making',
      'Fashion and beauty', 'History and culture', 'Psychology and sociology', 'Politics and civic life',
      'Law and legal literacy', 'Games and esports', 'Movies and television', 'Reading and literature',
      'Parenting and caregiving', 'Pets and animal care', 'Personal finance', 'Marketing and sales',
      'Entrepreneurship', 'Project and product management', 'Career development', 'Community building',
      'Environment and climate', 'Accessibility and inclusion'
    ];
    const normalize = value => String(value || '').toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const fieldIcon = field => {
      const key = normalize(field);
      if (/cook|food|bake|hospitality|nutrition/.test(key)) return 'bx-restaurant';
      if (/sport|fitness|yoga|run|cycle|swim|outdoor|dance|martial/.test(key)) return 'bx-run';
      if (/music|guitar|piano|drum|sing|audio|theatre/.test(key)) return 'bx-music';
      if (/photo|video|film|media|animation|illustration|design|fashion|art|craft/.test(key)) return 'bx-palette';
      if (/program|web|tech|data|computer|cyber|cloud|database|robot|digital|ai|software/.test(key)) return 'bx-code-alt';
      if (/language|writing|journal|speak|teach|tutor|research|history|philosophy/.test(key)) return 'bx-book-open';
      if (/business|finance|market|sales|career|leadership|project|entrepreneur/.test(key)) return 'bx-briefcase';
      if (/health|wellbeing|first aid|mental|parent|pet|animal/.test(key)) return 'bx-heart';
      return 'bx-bulb';
    };
    const specialtyLibrary = [
      {match: /cook|food|cuisine|bake|hospitality/, values: ['French cuisine', 'Italian cuisine', 'Indian cuisine', 'Nepali cuisine', 'Mexican cuisine', 'Chinese cuisine', 'Japanese cuisine', 'Thai cuisine', 'Korean cuisine', 'Middle Eastern cuisine', 'Mediterranean cuisine', 'Vegetarian cooking', 'Vegan cooking', 'Baking', 'Bread baking', 'Sourdough', 'Pastry', 'Cake decorating', 'Chocolate making', 'Pasta making', 'Pizza making', 'Knife skills', 'Meal planning', 'Sauce making', 'Spice blending', 'Fermentation', 'Pickling', 'Food preservation', 'Barbecue', 'Seafood cooking', 'Coffee brewing', 'Tea preparation', 'Food styling', 'Food safety', 'Menu planning']},
      {match: /program|web|software|technology|mobile|app|code|computer|it support/, values: ['HTML and CSS', 'JavaScript', 'TypeScript', 'Python', 'Java', 'C# and .NET', 'C++', 'Rust', 'Go', 'SQL', 'React', 'Vue', 'Node.js', 'Django', 'API design', 'Authentication', 'Testing', 'Git and GitHub', 'Accessibility', 'Performance', 'Mobile app design', 'Android apps', 'iOS apps', 'Flutter', 'React Native', 'Linux', 'Shell scripting', 'Networking', 'Cloud deployment', 'System architecture', 'Open-source contribution', 'Code review', 'Debugging', 'Technical documentation', 'Prompt engineering']},
      {match: /data|artificial intelligence|machine learning|statistics|analytics/, values: ['Data cleaning', 'Data visualization', 'Data storytelling', 'Statistics', 'Probability', 'SQL analytics', 'Excel analysis', 'Python data science', 'R programming', 'Jupyter notebooks', 'Machine learning', 'Deep learning', 'Natural language processing', 'Computer vision', 'Predictive modeling', 'Time series analysis', 'A/B testing', 'Survey design', 'Research methods', 'Data ethics', 'Power BI', 'Tableau', 'Looker Studio', 'Data engineering', 'ETL pipelines', 'Data modeling', 'Recommender systems', 'Scikit-learn', 'TensorFlow', 'PyTorch']},
      {match: /photo|video|film|media|animation|3d|cinema/, values: ['Portrait photography', 'Street photography', 'Landscape photography', 'Wildlife photography', 'Product photography', 'Food photography', 'Sports photography', 'Travel photography', 'Smartphone photography', 'Photo editing', 'Adobe Lightroom', 'Adobe Photoshop', 'Photo retouching', 'Videography', 'Cinematography', 'Directing', 'Screenwriting', 'Video editing', 'Color grading', 'Motion graphics', 'Stop motion', 'Documentary making', 'Interview production', 'Lighting', 'Storyboarding', 'Livestream production', 'Short-form video', 'Drone photography', 'Aerial mapping', 'Captioning']},
      {match: /design|fashion|art|draw|paint|illustr|craft|calligraphy|jewellery/, values: ['UI design', 'UX research', 'Interaction design', 'Visual design', 'Graphic design', 'Brand identity', 'Typography', 'Color theory', 'Design systems', 'Prototyping', 'Figma', 'Wireframing', 'User testing', 'Information architecture', 'Service design', 'Design thinking', 'Motion design', 'Illustration', 'Character design', 'Digital illustration', 'Drawing', 'Sketching', 'Watercolor painting', 'Acrylic painting', 'Oil painting', 'Calligraphy', 'Hand lettering', 'Pattern making', 'Tailoring', 'Jewellery making', 'Printmaking', 'Screen printing', 'Origami', 'Mosaic art', 'Cosplay design']},
      {match: /music|guitar|piano|drum|sing|audio|song|voice/, values: ['Guitar chords', 'Acoustic guitar', 'Electric guitar', 'Fingerstyle guitar', 'Piano basics', 'Keyboard', 'Drums', 'Percussion', 'Violin', 'Flute', 'Singing technique', 'Vocal health', 'Choir singing', 'Songwriting', 'Music theory', 'Ear training', 'Sight reading', 'Improvisation', 'Jazz improvisation', 'Music production', 'Audio engineering', 'Mixing', 'Mastering', 'Recording', 'Ableton Live', 'Logic Pro', 'FL Studio', 'Sound design', 'Podcast production', 'Voice acting', 'Narration', 'Live sound', 'Music arrangement', 'Composition', 'MIDI sequencing']},
      {match: /language|translation|sign language/, values: ['English conversation', 'Spanish conversation', 'French conversation', 'German conversation', 'Italian conversation', 'Portuguese conversation', 'Hindi conversation', 'Bengali conversation', 'Nepali conversation', 'Mandarin conversation', 'Japanese conversation', 'Korean conversation', 'Arabic conversation', 'Russian conversation', 'Pronunciation', 'Grammar', 'Vocabulary', 'Reading comprehension', 'Writing practice', 'Conversation confidence', 'Public speaking in another language', 'Translation', 'Interpretation', 'American Sign Language', 'British Sign Language', 'International Sign']},
      {match: /business|finance|market|sales|career|leadership|project|entrepreneur|econom|marketing/, values: ['Entrepreneurship', 'Business planning', 'Market research', 'Competitive analysis', 'Product management', 'Product strategy', 'Project management', 'Agile project management', 'Scrum', 'Leadership', 'Team management', 'Career coaching', 'Career planning', 'Personal branding', 'Sales', 'Negotiation', 'Customer support', 'Event planning', 'Operations management', 'Financial planning', 'Budgeting', 'Bookkeeping', 'Accounting basics', 'Investing basics', 'Stock analysis', 'Personal finance', 'Marketing strategy', 'Digital marketing', 'SEO', 'Content marketing', 'Public relations', 'Fundraising', 'Grant writing', 'Business presentations']},
      {match: /fitness|sport|yoga|meditation|wellbeing|health|mental|mindfulness/, values: ['Yoga', 'Meditation', 'Mindfulness', 'Breathwork', 'Strength training', 'Weightlifting', 'Calisthenics', 'Running', 'Marathon training', 'Walking', 'Cycling', 'Swimming', 'Surfing', 'Hiking', 'Backpacking', 'Rock climbing', 'Tennis', 'Badminton', 'Basketball', 'Football', 'Cricket', 'Boxing', 'Kickboxing', 'Karate', 'Brazilian jiu-jitsu', 'Dance fitness', 'Pilates', 'Barre', 'Personal training', 'Sports nutrition', 'Sleep hygiene', 'Stress management', 'First aid', 'CPR', 'Emergency preparedness']},
      {match: /teach|tutor|education|study|research|writing|journal|speak|history|psychology/, values: ['Lesson planning', 'Tutoring', 'Exam preparation', 'Study skills', 'Note-taking', 'Time management', 'Memory techniques', 'Reading comprehension', 'Research methods', 'Academic writing', 'Creative writing', 'Technical writing', 'Copywriting', 'Editing', 'Proofreading', 'Storytelling', 'Scriptwriting', 'Poetry', 'Public speaking', 'Presentation skills', 'Debate', 'Active listening', 'Interviewing', 'Negotiation', 'Facilitation', 'Workshop teaching', 'Online teaching', 'Instructional design', 'Course creation', 'Peer mentoring', 'Critical thinking', 'Logic', 'Media literacy']},
      {match: /garden|wood|sew|knit|pottery|repair|diy|home|maker|robot|electronics/, values: ['Woodworking', 'Carpentry', 'Furniture making', 'Cabinetry', 'Joinery', 'Welding', 'Plumbing basics', 'Electrical basics', 'Home wiring', 'Painting walls', 'Tiling', 'Home renovation', 'Interior decorating', 'Sewing', 'Embroidery', 'Knitting', 'Crochet', 'Quilting', 'Leatherworking', 'Pottery', 'Ceramics', '3D printing', 'Laser cutting', 'CNC machining', 'Arduino', 'Raspberry Pi', 'Soldering', 'Robotics', 'Bicycle repair', 'Car maintenance', 'Gardening', 'Vegetable gardening', 'Composting', 'Hydroponics', 'Tool safety']},
      {match: /travel|outdoor|adventure|geography|map|camp|nature|sustainability|climate/, values: ['Travel planning', 'Trip planning', 'Packing efficiently', 'Map navigation', 'Public transit navigation', 'Road safety', 'Car camping', 'Hiking', 'Backpacking', 'Camping', 'Orienteering', 'Map reading', 'Fishing', 'Birdwatching', 'Nature observation', 'Trail safety', 'Outdoor survival', 'Sustainable travel', 'Local history', 'Cultural etiquette', 'Language for travel', 'First aid outdoors', 'Climate action', 'Waste reduction', 'Recycling', 'Urban gardening', 'Rainwater harvesting', 'Renewable energy basics']}
    ];
    const detailFormats = ['Foundations', 'Beginner practice', 'Intermediate practice', 'Advanced practice', 'Principles and theory', 'Vocabulary and concepts', 'Tools and setup', 'Guided exercises', 'Independent projects', 'Real-world projects', 'Problem solving', 'Troubleshooting', 'Quality and review', 'Creative variations', 'Collaboration', 'Accessibility', 'Sustainable practice', 'Teaching others', 'Portfolio projects', 'Capstone challenge'];
    const detailContexts = ['at home', 'for work', 'with a mentor', 'for community projects', 'for independent practice'];
    const detailCache = new Map();
    const detailOptionsFor = field => {
      if (detailCache.has(field)) return detailCache.get(field);
      const key = normalize(field);
      const library = specialtyLibrary.find(entry => entry.match.test(key))?.values || [];
      const generated = [];
      detailFormats.forEach(format => detailContexts.forEach(context => generated.push(`${field} · ${format} · ${context}`)));
      const options = [...new Set([...library, ...generated])];
      detailCache.set(field, options);
      return options;
    };
    const state = {
      step: 'fields',
      child: false,
      selections: {teach: new Set(), learn: new Set()},
      details: {teach: new Map(), learn: new Map()},
      activeDetail: {mode: 'teach', field: ''}
    };
    const readList = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    readList(hidden.teach?.value).forEach(value => state.selections.teach.add(value));
    readList(hidden.learn?.value).forEach(value => state.selections.learn.add(value));
    try {
      const saved = JSON.parse(hidden.details?.value || '{}');
      ['teach', 'learn'].forEach(mode => Object.entries(saved?.[mode] || {}).forEach(([field, values]) => {
        state.details[mode].set(field, new Set(Array.isArray(values) ? values : []));
      }));
    } catch (_error) { /* Empty detail selections are the normal first visit. */ }

    const statusNode = root.querySelector('[data-interest-status]');
    const detailStatusNode = root.querySelector('[data-interest-detail-status]');
    const setStatus = (node, message, error = false) => {
      if (!node) return;
      node.textContent = message || '';
      node.classList.toggle('is-error', Boolean(error));
    };
    const setSubmitLabel = () => {
      const button = form.querySelector('[data-registration-submit]');
      if (!button) return;
      button.innerHTML = state.child || state.step === 'details' ?
        '<i class="bx bx-user-plus" aria-hidden="true"></i> Create account' :
        '<i class="bx bx-list-check" aria-hidden="true"></i> Continue to specifics';
    };
    const writeHidden = (input, value) => {
      if (!input) return;
      const normalized = String(value ?? '');
      input.value = normalized;
      input.defaultValue = normalized;
      input.setAttribute('value', normalized);
    };
    const updateHidden = () => {
      const teach = [...state.selections.teach];
      const learn = [...state.selections.learn];
      writeHidden(hidden.teach, state.child ? '' : teach.join(', '));
      writeHidden(hidden.learn, state.child ? '' : learn.join(', '));
      writeHidden(hidden.interests, state.child ? '' : [...new Set([...teach, ...learn])].join(', '));
      if (hidden.details) {
        const value = {teach: {}, learn: {}};
        if (!state.child) ['teach', 'learn'].forEach(mode => {
          state.details[mode].forEach((items, field) => {
            if (state.selections[mode].has(field) && items.size) value[mode][field] = [...items];
          });
        });
        writeHidden(hidden.details, JSON.stringify(value));
      }
    };
    const selectedCount = () => state.selections.teach.size + state.selections.learn.size;
    const updateProgressButton = () => {
      const detailsButton = root.querySelector('[data-interest-step="details"]');
      if (detailsButton) detailsButton.disabled = selectedCount() === 0 || state.child;
    };
    const renderMode = mode => {
      const search = root.querySelector(`[data-interest-search="${mode}"]`);
      const optionsHost = root.querySelector(`[data-interest-options="${mode}"]`);
      const empty = root.querySelector(`[data-interest-empty="${mode}"]`);
      const meta = root.querySelector(`[data-interest-list-meta="${mode}"]`);
      const count = root.querySelector(`[data-interest-count="${mode}"]`);
      if (!optionsHost) return;
      const term = normalize(search?.value || '');
      const matches = catalogFields.filter(field => !term || normalize(field).includes(term));
      optionsHost.innerHTML = matches.map(field => {
        const selected = state.selections[mode].has(field);
        return `<button type="button" class="registration-interest-option${selected ? ' is-selected' : ''}" data-interest-field="${escapeHtml(field)}" aria-pressed="${selected}"><i class="bx ${fieldIcon(field)}" aria-hidden="true"></i><span>${escapeHtml(field)}</span><i class="bx bx-check" aria-hidden="true"></i></button>`;
      }).join('');
      optionsHost.querySelectorAll('[data-interest-field]').forEach(button => button.addEventListener('click', () => {
        const field = button.dataset.interestField;
        const selection = state.selections[mode];
        if (selection.has(field)) {
          selection.delete(field);
          state.details[mode].delete(field);
        } else selection.add(field);
        updateHidden();
        setStatus(statusNode, '');
        renderMode(mode);
        updateProgressButton();
      }));
      if (count) count.textContent = `${state.selections[mode].size} selected`;
      if (meta) meta.textContent = `${matches.length} of ${catalogFields.length} fields shown`;
      if (empty) empty.hidden = matches.length > 0;
    };
    const renderDetailOptions = card => {
      const mode = card.dataset.interestDetailMode;
      const field = card.dataset.interestDetailField;
      const selected = state.details[mode].get(field) || new Set();
      state.details[mode].set(field, selected);
      const search = card.querySelector('[data-interest-detail-search]');
      const host = card.querySelector('[data-interest-detail-options]');
      const empty = card.querySelector('[data-interest-detail-empty]');
      const count = card.querySelector('[data-interest-detail-count]');
      const selectionHelp = card.querySelector('[data-interest-detail-selection-help]');
      const more = card.querySelector('[data-interest-detail-more]');
      const term = normalize(search?.value || '');
      const matches = detailOptionsFor(field).filter(option => !term || normalize(option).includes(term));
      const expanded = card.dataset.interestExpanded === 'true';
      const initialLimit = 18;
      const visibleMatches = !term && !expanded ? matches.slice(0, initialLimit) : matches;
      host.innerHTML = visibleMatches.map(option => {
        const active = selected.has(option);
        return `<button type="button" class="registration-interest-detail-option${active ? ' is-selected' : ''}" data-interest-detail-option="${escapeHtml(option)}" aria-pressed="${active}">${escapeHtml(option)}</button>`;
      }).join('');
      host.querySelectorAll('[data-interest-detail-option]').forEach(button => button.addEventListener('click', () => {
        const option = button.dataset.interestDetailOption;
        if (selected.has(option)) selected.delete(option); else selected.add(option);
        updateHidden();
        setStatus(detailStatusNode, '');
        renderDetailOptions(card);
      }));
      if (count) count.textContent = `${selected.size} selected`;
      if (selectionHelp) selectionHelp.textContent = selected.size ? 'You can add more or continue.' : 'Select at least one specific option for this topic.';
      if (empty) empty.hidden = matches.length > 0;
      if (more) {
        const canExpand = !term && matches.length > initialLimit;
        more.hidden = !canExpand;
        more.textContent = expanded ? 'Show fewer options' : `Show ${matches.length - initialLimit} more options`;
      }
    };
    const renderDetails = () => {
      const host = root.querySelector('[data-interest-detail-groups]');
      if (!host) return;
      const activeModes = ['teach', 'learn'].filter(mode => state.selections[mode].size);
      const currentActive = activeModes.includes(state.activeDetail.mode) && state.selections[state.activeDetail.mode].has(state.activeDetail.field) ? state.activeDetail : null;
      const activeMode = currentActive?.mode || activeModes[0];
      const activeField = currentActive?.field || [...state.selections[activeMode]][0];
      state.activeDetail = {mode: activeMode, field: activeField};
      const label = mode => mode === 'teach' ? 'Teach' : 'Learn';
      const fieldTabs = activeModes.flatMap(mode => [...state.selections[mode]].map(field => {
        const selected = state.activeDetail.mode === mode && state.activeDetail.field === field;
        const count = state.details[mode].get(field)?.size || 0;
        return `<div class="registration-interest-field-chip${selected ? ' is-active' : ''}"><button type="button" class="registration-interest-field-tab" data-interest-field-tab data-interest-detail-mode="${mode}" data-interest-detail-field="${escapeHtml(field)}" aria-pressed="${selected}"><span>${label(mode)}</span><strong>${escapeHtml(field)}</strong><small>${count} specific${count === 1 ? '' : 's'}</small></button><button type="button" class="registration-interest-field-remove" data-interest-remove-field data-interest-remove-field-mode="${mode}" data-interest-remove-field-name="${escapeHtml(field)}" aria-label="Remove ${escapeHtml(field)}"><i class="bx bx-x" aria-hidden="true"></i><span class="sr-only">Remove ${escapeHtml(field)}</span></button></div>`;
      })).join('');
      host.innerHTML = `<div class="registration-interest-selected-fields"><div class="registration-interest-selected-fields-head"><strong>Your topics</strong><span>Choose a topic below, or remove one.</span></div><div class="registration-interest-field-tabs">${fieldTabs}</div></div><article class="registration-interest-detail-card registration-interest-detail-card-active" data-interest-detail-card data-interest-detail-mode="${activeMode}" data-interest-detail-field="${escapeHtml(activeField)}"><header><div><span class="registration-interest-label${activeMode === 'learn' ? ' is-learning' : ''}"><i class="bx ${activeMode === 'teach' ? 'bx-chalkboard' : 'bx-book-reader'}" aria-hidden="true"></i> ${label(activeMode)}</span><strong>${escapeHtml(activeField)}</strong></div><button type="button" class="registration-interest-remove-field" data-interest-remove-field data-interest-remove-field-mode="${activeMode}" data-interest-remove-field-name="${escapeHtml(activeField)}"><i class="bx bx-trash-alt" aria-hidden="true"></i> Remove topic</button></header><label class="registration-interest-detail-search"><i class="bx bx-search" aria-hidden="true"></i><span class="sr-only">Search specifics for ${escapeHtml(activeField)}</span><input type="search" data-interest-detail-search placeholder="Search specifics…" autocomplete="off"></label><div class="registration-interest-detail-options" data-interest-detail-options></div><button type="button" class="registration-interest-detail-more" data-interest-detail-more hidden>Show more options</button><p class="registration-interest-detail-empty" data-interest-detail-empty hidden>No specifics match that search.</p><div class="registration-interest-detail-selection-note"><span data-interest-detail-count>0 selected</span><small data-interest-detail-selection-help>Select at least one specific option for this topic.</small></div></article>`;
      const activeCard = host.querySelector('[data-interest-detail-card]');
      activeCard?.querySelector('[data-interest-detail-search]')?.addEventListener('input', () => renderDetailOptions(activeCard));
      activeCard?.querySelector('[data-interest-detail-more]')?.addEventListener('click', () => {
        activeCard.dataset.interestExpanded = activeCard.dataset.interestExpanded !== 'true' ? 'true' : 'false';
        renderDetailOptions(activeCard);
      });
      host.querySelectorAll('[data-interest-field-tab]').forEach(button => button.addEventListener('click', () => {
        state.activeDetail = {mode: button.dataset.interestDetailMode, field: button.dataset.interestDetailField};
        renderDetails();
      }));
      host.querySelectorAll('[data-interest-remove-field]').forEach(button => button.addEventListener('click', () => {
        const mode = button.dataset.interestRemoveFieldMode;
        const field = button.dataset.interestRemoveFieldName;
        state.selections[mode].delete(field);
        state.details[mode].delete(field);
        updateHidden();
        renderMode(mode);
        updateProgressButton();
        if (selectedCount()) renderDetails();
        else showStep('fields');
      }));
      renderDetailOptions(activeCard);
    };
    const validateFields = () => {
      if (state.child) return true;
      if (standalonePreRegistration && (!state.selections.teach.size || !state.selections.learn.size)) {
        setStatus(statusNode, 'Choose at least one field you can teach and at least one field you want to learn.', true);
        root.querySelector(`[data-interest-search="${state.selections.teach.size ? 'learn' : 'teach'}"]`)?.focus({preventScroll: true});
        return false;
      }
      if (selectedCount()) return true;
      setStatus(statusNode, 'Choose at least one field to teach or learn, or continue with the adult account setup.', true);
      root.querySelector('[data-interest-search="teach"]')?.focus({preventScroll: true});
      return false;
    };
    const validateDetails = () => {
      if (state.child) return true;
      const missing = ['teach', 'learn'].flatMap(mode => [...state.selections[mode]]
        .filter(field => !(state.details[mode].get(field)?.size))
        .map(field => ({mode, field})));
      if (!missing.length) return true;
      const first = missing[0];
      state.activeDetail = first;
      renderDetails();
      setStatus(detailStatusNode, `Choose at least one specific option for ${first.field} before continuing.`, true);
      root.querySelector('[data-interest-detail-card] [data-interest-detail-search]')?.focus({preventScroll: true});
      root.querySelector('[data-interest-detail-card]')?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
      return false;
    };
    const showStep = step => {
      state.step = step;
      root.querySelectorAll('[data-interest-panel]').forEach(panel => {
        panel.hidden = panel.dataset.interestPanel !== step;
      });
      root.querySelectorAll('[data-interest-step]').forEach(button => {
        const active = button.dataset.interestStep === step;
        button.classList.toggle('is-active', active);
        button.classList.toggle('is-complete', step === 'details' && button.dataset.interestStep === 'fields');
        button.setAttribute('aria-current', active ? 'step' : 'false');
      });
      if (step === 'details') renderDetails();
      setStatus(statusNode, '');
      setStatus(detailStatusNode, '');
      setSubmitLabel();
    };
    const setChildMode = isChild => {
      state.child = Boolean(isChild);
      if (state.child) {
        state.step = 'fields';
        state.selections.teach.clear();
        state.selections.learn.clear();
        state.details.teach.clear();
        state.details.learn.clear();
        updateHidden();
      }
      root.hidden = state.child;
      root.querySelector('[data-interest-child-note]')?.toggleAttribute('hidden', !state.child);
      updateProgressButton();
      setSubmitLabel();
    };
    form.__setRegistrationChildMode = setChildMode;
    root.querySelectorAll('[data-interest-search]').forEach(input => input.addEventListener('input', () => renderMode(input.dataset.interestSearch)));
    root.querySelectorAll('[data-interest-clear]').forEach(button => button.addEventListener('click', () => {
      const mode = button.dataset.interestClear;
      state.selections[mode].clear();
      state.details[mode].clear();
      updateHidden();
      setStatus(statusNode, '');
      renderMode(mode);
      updateProgressButton();
    }));
    root.querySelector('[data-interest-next]')?.addEventListener('click', () => {
      if (validateFields()) showStep('details');
    });
    root.querySelector('[data-interest-back]')?.addEventListener('click', () => showStep('fields'));
    root.querySelector('[data-interest-finish]')?.addEventListener('click', () => {
      if (!validateDetails()) return;
      setStatus(detailStatusNode, 'Your choices are ready. Complete the final checkbox below to create your account.');
      form.dispatchEvent(new CustomEvent('swaplabs:registration-interests-complete'));
      form.querySelector('[data-registration-submit]')?.focus({preventScroll: true});
    });
    root.querySelectorAll('[data-interest-step]').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.interestStep === 'fields') showStep('fields');
      else if (validateFields()) showStep('details');
    }));
    form.addEventListener('submit', event => {
      if (standalonePreRegistration && !form.querySelector('[data-pre-account-step]')?.hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        form.querySelector('[data-pre-step-next]')?.click();
        return;
      }
      if (standalonePreRegistration && state.step === 'details' && form.querySelector('[data-pre-final-step]')?.hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        root.querySelector('[data-interest-finish]')?.click();
        return;
      }
      if (state.child || state.step === 'details') {
        if (!state.child && !validateDetails()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (validateFields()) showStep('details');
    }, true);
    renderMode('teach');
    renderMode('learn');
    updateHidden();
    updateProgressButton();
    showStep('fields');
  }

  function setupStudentSafetyFields(form, existingSafety = null) {
    const dateInput = formField(form, 'date_of_birth');
    const ageInput = formField(form, 'age');
    const section = form.querySelector('.student-safety-section');
    if (!dateInput || !ageInput || !section) return;
    const guardianFields = ['guardian_name', 'guardian_email', 'guardian_relationship'];
    const accountTypeInput = form.querySelector('[data-account-type-value]') || formField(form, 'account_type');
    const accountTypeSummary = form.querySelector('[data-account-type-summary]');
    const accountTypeLabel = form.querySelector('[data-account-type-label]');
    const accountTypeDescription = form.querySelector('[data-account-type-description]');
    const accountTypeNote = form.querySelector('[data-account-type-note]');
    const ageDisplay = form.querySelector('[data-account-age-display]');
    const ageError = form.querySelector('[data-age-error]');
    const dateField = dateInput.closest('.field');
    const setDerivedValue = (input, value) => {
      if (!input) return;
      if ('value' in input) {
        input.value = value;
        input.defaultValue = value;
        input.setAttribute('value', value);
      } else {
        input.textContent = value || '—';
      }
    };
    const ageLabel = form.querySelector('[data-account-age-label]');
    const ageDescription = form.querySelector('[data-account-age-description]');
    const childHandoff = form.querySelector('[data-child-registration-handoff]');
    const heroTitle = document.querySelector('[data-registration-hero-title]');
    const heroCopy = document.querySelector('[data-registration-hero-copy]');
    const heroCardTitle = document.querySelector('[data-registration-hero-card-title]');
    const heroCardCopy = document.querySelector('[data-registration-hero-card-copy]');
    const formTitle = form.querySelector('[data-registration-form-title]');
    const formCopy = form.querySelector('[data-registration-form-copy]');
    const basicsTitle = form.querySelector('[data-registration-basics-title]');
    const basicsCopy = form.querySelector('[data-registration-basics-copy]');
    const fullNameLabel = form.querySelector('[data-registration-full-name-label]');
    const childSkillFields = [...form.querySelectorAll('[data-child-optional-skill]')];
    const childSkillNote = form.querySelector('[data-child-skill-note]');
    const contactLabel = form.querySelector('[data-registration-contact-label]');
    const contactHelp = form.querySelector('[data-registration-contact-help]');
    const passwordLabel = form.querySelector('[data-registration-password-label]');
    const passwordHelp = form.querySelector('[data-registration-password-help]');
    const confirmLabel = form.querySelector('[data-registration-confirm-label]');
    const guardianHeading = form.querySelector('[data-guardian-heading]');
    const guardianDescription = form.querySelector('[data-guardian-description]');
    const termsCopy = form.querySelector('[data-registration-terms-copy]');
    const setDateBounds = () => {
      const today = new Date();
      const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const youngest = new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
      const oldest = new Date(today.getFullYear() - 120, today.getMonth(), today.getDate());
      dateInput.min = iso(oldest);
      dateInput.max = iso(youngest);
    };
    const update = () => {
      const calculatedAge = ageFromDateOfBirth(dateInput.value);
      const hasValidAge = calculatedAge !== null && calculatedAge >= 3 && calculatedAge <= 120;
      const ageMessage = !dateInput.value ? '' : calculatedAge === null ?
        'Enter a valid date of birth.' : calculatedAge < 3 ?
          'You must be at least 3 years old to create an account.' : calculatedAge > 120 ?
            'You must be 120 or younger to create an account.' : '';
      dateInput.setCustomValidity(ageMessage);
      dateInput.setAttribute('aria-invalid', String(Boolean(ageMessage)));
      dateField?.classList.toggle('has-error', Boolean(ageMessage));
      if (ageError) {
        ageError.textContent = ageMessage ? `${ageMessage} SwapLabs accepts ages 3–120.` : '';
        ageError.hidden = !ageMessage;
      }
      if (hasValidAge) {
        setDerivedValue(ageInput, String(calculatedAge));
      } else {
        setDerivedValue(ageInput, '');
      }
      const age = hasValidAge ? calculatedAge : null;
      const isChild = age !== null && age >= 3 && age < 13;
      const accountType = isChild ? 'child' : 'adult';
      setDerivedValue(accountTypeInput, accountType);
      setDerivedValue(ageDisplay, age === null ? '' : String(age));
      if (ageLabel) ageLabel.textContent = ageMessage ? 'Date of birth is not eligible' : age === null ? 'Age is calculated automatically' : `Age ${age} · eligible to join`;
      if (ageDescription) ageDescription.textContent = ageMessage ? `${ageMessage} SwapLabs accepts ages 3–120.` : age === null ? 'Enter your date of birth to check eligibility.' : (isChild ? 'Guardian consent will appear below because this account is for ages 3–12.' : 'Your member account uses the standard safety settings.');
      if (accountTypeSummary) accountTypeSummary.dataset.accountType = age === null ? 'unknown' : accountType;
      if (accountTypeLabel) accountTypeLabel.textContent = age === null ?
        'Set automatically from your date of birth' : `${isChild ? 'Child' : 'Adult'} account — set automatically`;
      if (accountTypeDescription) accountTypeDescription.textContent = age === null ?
        'Enter your date of birth and SwapLabs will set your age, account type, and safety controls for you.' :
        (isChild ? 'A parent or guardian must finish this form and approve the child safety settings.' : 'You are 13 or older, so SwapLabs uses the standard member account.');
      if (accountTypeNote) accountTypeNote.textContent = age === null ?
        'Your account type follows your date of birth and cannot be changed manually. Ages 3–12 use a child account; ages 13 and older use an adult account.' :
        `Age ${age} detected. Your account type follows your date of birth and cannot be changed manually.`;
      section.hidden = !isChild;
      section.dataset.safetyVisible = String(isChild);
      form.classList.toggle('is-child-registration', isChild);
      if (childHandoff) {
        childHandoff.hidden = !isChild;
        childHandoff.setAttribute('aria-hidden', String(!isChild));
      }
      const directRegistration = form.dataset.registrationMode === 'direct';
      const standalonePreRegistration = isPreRegistrationPage();
      const earlyProfileFlow = standalonePreRegistration && form.dataset.earlyProfileFlow === 'true';
      if (heroTitle) heroTitle.textContent = isChild ? 'Parent or guardian: set up the child account.' : standalonePreRegistration ? 'Be ready before the doors open.' : directRegistration ? 'Create your account, then finish your profile.' : 'Join SwapLabs without the paperwork.';
      if (heroCopy) heroCopy.textContent = isChild ? 'The child can choose interests later. An adult completes the safe account setup here.' : earlyProfileFlow ? 'Create your account first, then complete your full SwapLabs profile—including skills and learning goals. Early accounts receive 30 free credits for launch on 4 October 2026.' : standalonePreRegistration ? 'Complete the same account details and learning choices as the usual registration. Your live SwapLabs account starts with 30 free credits, ready for launch at midnight on 4 October 2026.' : directRegistration ? 'Enter the essentials once. After your account is created, SwapLabs takes you straight to the short profile step for your location, skills, and learning goal.' : 'Start with the few details we actually need. Your profile, skills, and preferences can be added whenever you are ready.';
      if (heroCardTitle) heroCardTitle.textContent = isChild ? 'Adult setup required.' : standalonePreRegistration ? 'Account first. Profile next.' : directRegistration ? 'Account first. Profile next.' : 'We ask for less now.';
      if (heroCardCopy) heroCardCopy.textContent = isChild ? 'An adult must manage the contact details, password, consent, and safety choices for this child account.' : earlyProfileFlow ? 'Create the account without an extra skills step. Then fill in your complete profile on SwapLabs and save it to finish.' : standalonePreRegistration ? 'Registration opens at midnight on 1 October. Complete the full flow, including what you can teach and want to learn, then arrive on launch day with 30 free credits.' : directRegistration ? 'We only ask for identity, a sign-in contact, a password, and your date of birth here. Your next screen is a focused profile checklist.' : 'Only identity, a way to sign in, a password, and your date of birth for safety. You can finish the rest inside your account.';
      if (formTitle) formTitle.textContent = isChild ? 'Parent/guardian setup' : 'Let’s get you in.';
      if (formCopy) formCopy.textContent = isChild ? 'Please complete this short adult setup. The child profile can be finished later.' : earlyProfileFlow ? 'Create your account first. Next, fill in all the usual profile and learning details on the main SwapLabs website.' : standalonePreRegistration ? 'Start with your account essentials. Then choose what you can teach and want to learn before you create the account.' : directRegistration ? 'Create your account now. We will guide you immediately through the few profile details that make matching useful.' : 'These are the only details needed to create your member account.';
      if (basicsTitle) basicsTitle.textContent = isChild ? 'Child’s basic details' : 'Your basics';
      if (basicsCopy) basicsCopy.textContent = isChild ? 'Enter the child’s name and the username they will use.' : 'Use the name you want connected to your account.';
      if (fullNameLabel) fullNameLabel.textContent = isChild ? 'Child’s full name' : 'Full name';
      childSkillFields.forEach(field => { field.hidden = isChild; });
      if (childSkillNote) childSkillNote.hidden = !isChild;
      form.__setRegistrationChildMode?.(isChild);
      if (contactLabel) contactLabel.textContent = isChild ? 'Parent or guardian email/phone' : 'Email or phone number';
      if (contactHelp) contactHelp.textContent = isChild ? 'Use the adult contact that will manage this account and receive safety notices.' : 'Use either one. It becomes your sign-in contact.';
      if (formField(form, 'contact')) formField(form, 'contact').placeholder = isChild ? 'Parent email or phone number' : 'you@example.com or +91 98765 43210';
      if (passwordLabel) passwordLabel.textContent = isChild ? 'Parent or guardian password' : 'Password';
      if (passwordHelp) passwordHelp.textContent = isChild ? 'The adult should create and keep this password private.' : 'At least 6 characters with uppercase, lowercase, a number, and a symbol.';
      if (confirmLabel) confirmLabel.textContent = isChild ? 'Repeat the adult password' : 'Confirm password';
      if (guardianHeading) guardianHeading.textContent = isChild ? 'Parent or guardian consent' : 'Guardian consent';
      if (guardianDescription) guardianDescription.textContent = isChild ? 'The adult listed here must confirm that they understand and approve this child account.' : 'Members aged 3–12 need a parent or guardian to confirm this account. These fields only appear when they are needed.';
      if (termsCopy) {
        const standaloneTerms = isPreRegistrationPage();
        termsCopy.innerHTML = standaloneTerms ? isChild ?
          'I am the named parent or guardian, and I agree to the Terms and Privacy Policy for this child account.' :
          'I agree to the Terms and understand the Privacy Policy.' : isChild ?
          'I am the parent or guardian, and I agree to the <a href="terms.html">Terms</a> and <a href="privacy.html">Privacy Policy</a> for this child account.' :
          'I agree to the <a href="terms.html">Terms</a> and understand the <a href="privacy.html">Privacy Policy</a>.';
      }
      guardianFields.forEach(name => {
        const guardianField = formField(form, name);
        if (guardianField) guardianField.required = isChild;
      });
      const consentField = formField(form, 'guardian_consent_declared');
      if (consentField) consentField.required = isChild;
      const privateOption = form.querySelector('[name="profile_visibility"][value="private"]');
      const publicOption = form.querySelector('[name="profile_visibility"][value="public"]');
      if (privateOption) privateOption.disabled = false;
      if (publicOption) publicOption.disabled = false;
      const locationField = formField(form, 'show_location');
      if (locationField && isChild) {
        locationField.checked = false;
        locationField.disabled = true;
      } else if (locationField) locationField.disabled = false;
    };
    setDateBounds();
    if (existingSafety) {
      Object.entries(existingSafety).forEach(([name, value]) => setFormValue(form, name, value));
    }
    dateInput.addEventListener('input', update);
    dateInput.addEventListener('change', update);
    update();
  }

  const usernameAdjectives = [
    'bright', 'bold', 'breezy', 'clever', 'cosmic', 'curious', 'electric', 'fearless', 'fresh', 'funky',
    'glowing', 'golden', 'happy', 'kind', 'lively', 'lucky', 'mellow', 'mighty', 'neon', 'playful',
    'radiant', 'restless', 'sharp', 'silver', 'sonic', 'stellar', 'sunny', 'swift', 'vivid', 'witty',
    'wonder', 'zen', 'zesty'
  ];
  const usernameNouns = [
    'atlas', 'beacon', 'brain', 'builder', 'byte', 'comet', 'craft', 'dreamer', 'fox', 'groove', 'hacker',
    'journey', 'jolt', 'maker', 'mentor', 'moon', 'muse', 'ninja', 'nova', 'orbit', 'owl', 'pixel', 'quest',
    'rocket', 'sage', 'spark', 'starlight', 'studio', 'swapper', 'trail', 'wave', 'whiz', 'wizard', 'wonder'
  ];
  const usernameVerbs = ['builds', 'creates', 'explores', 'learns', 'makes', 'moves', 'shares', 'swaps', 'teaches'];
  const usernameSuffixes = ['club', 'collective', 'corner', 'crew', 'lab', 'loop', 'mode', 'room', 'society', 'space'];
  const randomIndex = length => {
    if (globalThis.crypto?.getRandomValues) {
      const value = new Uint32Array(1);
      globalThis.crypto.getRandomValues(value);
      return value[0] % length;
    }
    return Math.floor(Math.random() * length);
  };
  const randomItem = values => values[randomIndex(values.length)];

  function localUsernameSuggestions(form, seen = new Set()) {
    const clean = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30);
    const compact = value => clean(value).replace(/[.\-_]/g, '').slice(0, 12);
    const first = compact(formField(form, 'first_name')?.value);
    const last = compact(formField(form, 'last_name')?.value);
    const display = compact(formField(form, 'display_name')?.value);
    const name = clean([first, last].filter(Boolean).join('.')) || display || first || last || 'swap';
    const surname = last || first || 'labs';
    const subject = first || display || last || 'swap';
    const factories = [
      () => `${randomItem(usernameAdjectives)}.${name}`,
      () => `${name}.${randomItem(usernameNouns)}`,
      () => `${randomItem(usernameAdjectives)}.${randomItem(usernameNouns)}`,
      () => `${subject}${randomItem(usernameNouns)}`,
      () => `${randomItem(usernameNouns)}.${surname}`,
      () => `${randomItem(usernameAdjectives)}${subject}${randomItem(usernameNouns)}`,
      () => `${name}.${randomItem(usernameSuffixes)}`,
      () => `the${subject}${randomItem(usernameNouns)}`,
      () => `${subject}.${randomItem(usernameVerbs)}`,
      () => `${randomItem(usernameAdjectives)}.${subject}${10 + randomIndex(990)}`,
      () => `${randomItem(usernameNouns)}${subject}${10 + randomIndex(990)}`
    ];
    const suggestions = [];
    const add = value => {
      const candidate = clean(value);
      if (candidate.length >= 3 && candidate.length <= 30 && !seen.has(candidate) && !suggestions.includes(candidate)) {
        seen.add(candidate);
        suggestions.push(candidate);
      }
    };
    for (let attempt = 0; attempt < 240 && suggestions.length < 3; attempt += 1) add(randomItem(factories)());
    while (suggestions.length < 3) {
      add(`swaplabs.${randomItem(usernameNouns)}${Date.now().toString(36).slice(-4)}${randomIndex(90) + 10}`);
    }
    return suggestions;
  }

  function renderUsernameSuggestions(host, form, suggestions) {
    const validSuggestions = (Array.isArray(suggestions) ? suggestions : []).map(value => String(value || '').trim())
      .filter(value => /^[A-Za-z0-9._-]{3,30}$/.test(value)).filter((value, index, values) => values.indexOf(value) === index);
    if (!host || !validSuggestions.length) return;
    host.hidden = false;
    host.setAttribute('aria-live', 'polite');
    host.innerHTML = validSuggestions.map(value => `<button type="button" data-username-choice="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('');
    setUsernameField(form, validSuggestions[0]);
  }

  function setUsernameField(form, value) {
    const usernameField = formField(form, 'username');
    if (!usernameField || !value) return;
    usernameField.value = value;
    usernameField.dispatchEvent(new Event('input', {bubbles: true}));
    usernameField.dispatchEvent(new Event('change', {bubbles: true}));
  }

  function setupRegistrationProgress(form) {
    const progress = $('[data-registration-progress]');
    if (!progress || form.dataset.registrationProgressReady) return;
    form.dataset.registrationProgressReady = 'true';
    const sections = $$(':scope > section[data-registration-section]', form);
    const stages = [
      {key: 'identity', label: 'Account', next: 'Continue to next'},
      {key: 'basics', label: 'Basics', next: 'Continue to next'},
      {key: 'exchange', label: 'Exchange', next: 'Continue to next'},
      {key: 'optional', label: 'Optional profile', next: 'Continue to next'},
      {key: 'secure', label: 'Secure account', next: 'Create member account'}
    ];
    const label = $('[data-registration-progress-label]', progress);
    const bar = $('[data-registration-progress-bar]', progress);
    const steps = $$('[data-registration-step]', progress);
    const back = $('[data-registration-back]', progress);
    const next = $('[data-registration-next]', progress);
    const skip = $('[data-registration-skip]', progress);
    let current = 0;
    const fieldsForCurrentStage = () => sections.filter(section => section.dataset.registrationSection === stages[current].key)
      .flatMap(section => $$('input, select, textarea', section));
    const validateCurrentStage = () => {
      const invalid = fieldsForCurrentStage().find(field => !field.disabled && !field.checkValidity());
      if (!invalid) return true;
      invalid.reportValidity();
      invalid.focus({preventScroll: true});
      return false;
    };
    const showStage = (index, {scroll = true} = {}) => {
      current = Math.max(0, Math.min(stages.length - 1, index));
      const stage = stages[current];
      sections.forEach(section => {
        const safetySection = section.classList.contains('student-safety-section');
        const visible = section.dataset.registrationSection === stage.key &&
          (!safetySection || section.dataset.safetyVisible === 'true');
        section.hidden = !visible;
        section.setAttribute('aria-hidden', String(!visible));
      });
      if (label) label.textContent = `Step ${current + 1} of ${stages.length} · ${stage.label}`;
      if (bar) bar.style.width = `${((current + 1) / stages.length) * 100}%`;
      steps.forEach((step, index) => {
        step.classList.toggle('is-active', index === current);
        step.classList.toggle('is-complete', index < current);
        step.setAttribute('aria-current', index === current ? 'step' : 'false');
      });
      if (back) back.disabled = current === 0;
      if (next) next.textContent = stage.next;
      if (skip) skip.hidden = stage.key !== 'optional';
      if (scroll) progress.scrollIntoView({behavior: 'smooth', block: 'start'});
    };
    next?.addEventListener('click', () => {
      if (current === stages.length - 1) {
        form.requestSubmit();
        return;
      }
      if (validateCurrentStage()) showStage(current + 1);
    });
    skip?.addEventListener('click', () => showStage(current + 1));
    back?.addEventListener('click', () => showStage(current - 1));
    steps.forEach((step, index) => step.addEventListener('click', () => {
      if (index < current) showStage(index);
    }));
    form.addEventListener('submit', event => {
      if (current === stages.length - 1) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (validateCurrentStage()) showStage(current + 1);
    }, true);
    showStage(0, {scroll: false});
  }

  function setupRegistrationPage() {
    const form = $('#registrationForm');
    if (!form) return;
    const standalonePreRegistration = isPreRegistrationPage();
    const earlyProfileFlow = standalonePreRegistration && form.dataset.earlyProfileFlow === 'true';
    const directRegistration = form.dataset.registrationMode === 'direct';
    const preRegistrationFlow = standalonePreRegistration && form.dataset.registrationMode === 'pre';
    const funkyHistory = new Set();
    // Account creation is intentionally one short step. The full interest
    // picker remains available to the older pre-registration route, while a
    // normal member is taken directly to the focused profile checklist after
    // the account is durable.
    if (directRegistration) form.querySelector('[data-registration-interests]')?.setAttribute('hidden', '');
    else setupRegistrationInterests(form);
    setupStudentSafetyFields(form);
    setupRegistrationProgress(form);
    const fullNameField = formField(form, 'full_name');
    const usernameField = formField(form, 'username');
    const contactField = formField(form, 'contact');
    const passwordField = formField(form, 'password');
    const confirmPasswordField = formField(form, 'confirm_password');
    let usernameTimer = null;
    let usernameRequestId = 0;
    const setUsernameLiveState = (stateName, message = '') => {
      if (!usernameField) return;
      const wrapper = usernameField.closest('.field');
      const feedback = wrapper?.querySelector('[data-username-feedback]');
      usernameField.dataset.usernameState = stateName;
      if (wrapper) wrapper.dataset.usernameState = stateName;
      usernameField.setAttribute('aria-busy', String(stateName === 'checking'));
      if (stateName === 'taken') usernameField.setCustomValidity(USERNAME_TAKEN_MESSAGE);
      else if (stateName === 'invalid' || stateName === 'error') usernameField.setCustomValidity(message);
      else usernameField.setCustomValidity('');
      if (feedback) {
        feedback.className = `username-live-feedback is-${stateName}`;
        feedback.textContent = message;
        feedback.hidden = !message;
      }
      syncRegistrationFieldError(usernameField, Boolean(message && !['available', 'checking'].includes(stateName)));
    };
    const validateUsername = (reveal = false) => {
      if (!usernameField) return Promise.resolve(true);
      const value = String(usernameField.value || '').trim();
      usernameField.value = value;
      usernameRequestId += 1;
      const requestId = usernameRequestId;
      if (usernameTimer) clearTimeout(usernameTimer);
      if (!value) {
        setUsernameLiveState(reveal ? 'invalid' : 'empty', reveal ? 'Choose a username.' : '');
        return Promise.resolve(!reveal);
      }
      if (!USERNAME_PATTERN.test(value)) {
        setUsernameLiveState('invalid', USERNAME_FORMAT_MESSAGE);
        return Promise.resolve(false);
      }
      setUsernameLiveState('checking', USERNAME_CHECKING_MESSAGE);
      return new Promise(resolve => {
        usernameTimer = setTimeout(async () => {
          try {
            const result = await api(`/api/auth/username-availability?username=${encodeURIComponent(value)}`, {method: 'GET'});
            if (requestId !== usernameRequestId || String(usernameField.value || '').trim() !== value) {
              resolve(false);
              return;
            }
            if (result.available) {
              setUsernameLiveState('available', 'Username is available.');
              resolve(true);
            } else {
              setUsernameLiveState('taken', USERNAME_TAKEN_MESSAGE);
              resolve(false);
            }
          } catch (_error) {
            if (requestId !== usernameRequestId || String(usernameField.value || '').trim() !== value) {
              resolve(false);
              return;
            }
            setUsernameLiveState('error', USERNAME_CHECK_FAILED_MESSAGE);
            resolve(false);
          }
        }, 280);
      });
    };
    const validateFullName = () => {
      const value = String(fullNameField?.value || '').trim();
      const message = value && !validName(value, 'full_name') ? NAME_FORMAT_MESSAGE : '';
      fullNameField?.setCustomValidity(message);
      syncRegistrationFieldError(fullNameField, Boolean(value && message));
    };
    const validateContact = () => {
      const value = String(contactField?.value || '').trim();
      const email = /^\S+@\S+\.\S+$/.test(value);
      const phoneDigits = value.replace(/\D/g, '');
      const message = value && !email && (phoneDigits.length < 7 || phoneDigits.length > 15) ? 'Enter a valid email address or phone number.' : '';
      contactField?.setCustomValidity(message);
      syncRegistrationFieldError(contactField, Boolean(value && message));
    };
    const validatePassword = () => {
      const value = String(passwordField?.value || '');
      const message = value && !PASSWORD_PATTERN.test(value) ? PASSWORD_POLICY_MESSAGE : '';
      passwordField?.setCustomValidity(message);
      syncRegistrationFieldError(passwordField, Boolean(value && message));
    };
    const validatePasswordMatch = () => {
      const password = String(passwordField?.value || '');
      const confirmation = String(confirmPasswordField?.value || '');
      const message = confirmation && password !== confirmation ? 'The password confirmation does not match.' : '';
      confirmPasswordField?.setCustomValidity(message);
      syncRegistrationFieldError(confirmPasswordField, Boolean(message));
      // Clear a stale submit message as soon as the user corrects the field.
      // Otherwise the form can still display “does not match” even though the
      // two visible values now agree.
      const status = $('[data-status]', form);
      if (!message && status?.textContent === 'The password confirmation does not match.') clearStatus(form);
    };
    const preAccountStep = form.querySelector('[data-pre-account-step]');
    const preInterestStep = form.querySelector('[data-pre-interest-step]');
    const preFinalStep = form.querySelector('[data-pre-final-step]');
    const preNextButton = form.querySelector('[data-pre-step-next]');
    const preBackButton = form.querySelector('[data-pre-step-back]');
    const preTermsField = formField(form, 'terms');
    const preSourceField = formField(form, 'registration_source');
    const preFlowSteps = [...form.querySelectorAll('[data-pre-flow-step]')];
    const updatePreFlowProgress = (stage, complete = false) => {
      preFlowSteps.forEach(step => {
        const active = step.dataset.preFlowStep === stage;
        const finished = step.dataset.preFlowStep === 'account' && stage === 'interests';
        step.classList.toggle('is-active', active);
        step.classList.toggle('is-complete', finished || (complete && active));
      });
    };
    const showPreAccountStep = () => {
      if (!preRegistrationFlow) return;
      if (preAccountStep) preAccountStep.hidden = false;
      if (preInterestStep) preInterestStep.hidden = true;
      if (preFinalStep) preFinalStep.hidden = true;
      if (preTermsField) preTermsField.disabled = true;
      updatePreFlowProgress('account');
    };
    const showPreInterestStep = () => {
      if (!preRegistrationFlow) return;
      if (preAccountStep) preAccountStep.hidden = true;
      if (preInterestStep) preInterestStep.hidden = false;
      if (preFinalStep) preFinalStep.hidden = true;
      if (preTermsField) preTermsField.disabled = true;
      updatePreFlowProgress('interests');
      preInterestStep?.scrollIntoView({behavior: 'smooth', block: 'start'});
      preInterestStep?.querySelector('[data-interest-search="teach"]')?.focus({preventScroll: true});
    };
    const showPreFinalStep = () => {
      if (!preRegistrationFlow) return;
      if (preAccountStep) preAccountStep.hidden = true;
      if (preInterestStep) preInterestStep.hidden = true;
      if (preFinalStep) preFinalStep.hidden = false;
      if (preTermsField) preTermsField.disabled = false;
      updatePreFlowProgress('interests', true);
      preFinalStep?.scrollIntoView({behavior: 'smooth', block: 'start'});
      preTermsField?.focus({preventScroll: true});
    };
    const revealInvalidRegistrationField = field => {
      if (!field) return;
      if (preRegistrationFlow && preAccountStep?.contains(field)) {
        showPreAccountStep();
        preAccountStep?.scrollIntoView({behavior: 'smooth', block: 'start'});
      }
      syncRegistrationFieldError(field, true);
      field.reportValidity();
      field.focus({preventScroll: true});
    };
    const validatePreAccountStep = async () => {
      clearStatus(form);
      await validateUsername(true);
      validateFullName();
      validateContact();
      validatePassword();
      validatePasswordMatch();
      const invalid = showRegistrationValidation(form);
      if (!invalid) return true;
      setStatus(form, registrationFieldMessage(invalid) || 'Complete your account details before continuing.', 'error');
      revealInvalidRegistrationField(invalid);
      return false;
    };
    if (preRegistrationFlow) {
      if (preSourceField) preSourceField.value = 'pre_registration';
      showPreAccountStep();
      preNextButton?.addEventListener('click', async () => {
        if (!await validatePreAccountStep()) return;
        if (form.classList.contains('is-child-registration')) showPreFinalStep();
        else showPreInterestStep();
      });
      preBackButton?.addEventListener('click', () => {
        if (form.classList.contains('is-child-registration')) showPreAccountStep();
        else showPreInterestStep();
      });
      form.addEventListener('swaplabs:registration-interests-complete', showPreFinalStep);
    }
    fullNameField?.addEventListener('input', validateFullName);
    usernameField?.addEventListener('input', () => { void validateUsername(); });
    contactField?.addEventListener('input', validateContact);
    passwordField?.addEventListener('input', () => { validatePassword(); validatePasswordMatch(); });
    confirmPasswordField?.addEventListener('input', validatePasswordMatch);
    validateFullName();
    void validateUsername();
    validateContact();
    validatePassword();
    validatePasswordMatch();
    if (new URLSearchParams(location.search).get('intent') === 'swap') {
      $('[data-registration-intent]')?.removeAttribute('hidden');
    }
    $('#generateUsername')?.addEventListener('click', () => {
      const button = $('#generateUsername');
      const host = $('#usernameSuggestions');
      button.disabled = true;
      button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Mixing';
      try {
        renderUsernameSuggestions(host, form, localUsernameSuggestions(form, funkyHistory));
      } finally {
        button.disabled = false;
        button.innerHTML = '<i class="bx bx-dice-5"></i> Funkify';
      }
    });
    $('#usernameSuggestions')?.addEventListener('click', event => {
      const choice = event.target.closest('[data-username-choice]');
      if (!choice) return;
      setUsernameField(form, choice.dataset.usernameChoice);
      $$('[data-username-choice]', $('#usernameSuggestions')).forEach(item => item.classList.toggle('active', item === choice));
    });
    form.addEventListener('invalid', event => {
      const field = event.target;
      if (!field || field.form !== form) return;
      syncRegistrationFieldError(field, true);
      setStatus(form, registrationFieldMessage(field), 'error');
    }, true);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(form);
      await validateUsername(true);
      validateFullName();
      validateContact();
      validatePassword();
      validatePasswordMatch();
      const invalid = showRegistrationValidation(form);
      if (invalid) {
        setStatus(form, registrationFieldMessage(invalid) || 'Please correct the highlighted fields before creating your account.', 'error');
        revealInvalidRegistrationField(invalid);
        return;
      }
      const fields = new FormData(form);
      if (fields.get('password') !== fields.get('confirm_password')) {
        setStatus(form, 'The password confirmation does not match.', 'error');
        $('#registrationConfirm')?.focus();
        return;
      }
      const submit = $('button[type="submit"]', form);
      loading(submit, true, 'Creating account');
      try {
        const result = await api('/api/auth/register', {
          method: 'POST',
          body: registrationPayload(form)
        });
        state.user = result.user;
        window.dispatchEvent(new CustomEvent('swaplabs:registration-created', {
          detail: {user: state.user}
        }));
        if (standalonePreRegistration && !earlyProfileFlow) {
          const section = form.closest('.pre-registration-section');
          const success = document.querySelector('[data-pre-success]');
          section?.querySelector('.pre-registration-heading')?.setAttribute('hidden', '');
          section?.querySelector('.pre-account-note')?.setAttribute('hidden', '');
          section?.querySelector('.pre-form-layout')?.setAttribute('hidden', '');
          section?.classList.add('is-complete');
          if (success) {
            success.hidden = false;
            requestAnimationFrame(() => success.classList.add('is-visible'));
            success.focus({preventScroll: true});
          }
          loading(submit, false);
          return;
        }
        const requestedDestination = safeLocalDestination(new URLSearchParams(location.search).get('return_to'));
        const profileDestination = earlyProfileFlow ?
          'profile.html?complete=1&welcome=1#identity' :
          requestedDestination ?
            `profile.html?complete=1&welcome=1&return_to=${encodeURIComponent(requestedDestination)}#identity` :
            'profile.html?complete=1&welcome=1#identity';
        setStatus(form, earlyProfileFlow ? 'Your account is ready. Next, complete your SwapLabs profile.' : 'Your account is ready. Next, finish the four profile essentials.', 'success');
        setTimeout(() => {
          location.href = profileDestination;
        }, 520);
      } catch (error) {
        if (error.code === 'pending_moderation') {
          setStatus(form, error.message, 'success');
          if (standalonePreRegistration) {
            const section = form.closest('.pre-registration-section');
            const success = document.querySelector('[data-pre-success]');
            section?.querySelector('.pre-registration-heading')?.setAttribute('hidden', '');
            section?.querySelector('.pre-account-note')?.setAttribute('hidden', '');
            section?.querySelector('.pre-form-layout')?.setAttribute('hidden', '');
            section?.classList.add('is-complete');
            form.hidden = true;
            if (success) {
              const mark = success.querySelector('.pre-success-mark i');
              const eyebrow = success.querySelector('.pre-success-eyebrow');
              const heading = success.querySelector('h2');
              const copy = success.querySelector('p');
              if (mark) mark.className = 'bx bx-time-five';
              if (eyebrow) eyebrow.textContent = 'Pending administrator review';
              if (heading) heading.textContent = 'Your registration is being reviewed.';
              if (copy) copy.textContent = error.message;
              success.hidden = false;
              success.classList.add('is-visible');
              success.focus({preventScroll: true});
            }
          }
          loading(submit, false);
          return;
        }
        setStatus(form, error.message, 'error');
        if (preRegistrationFlow && /password|username|email|phone|name|date of birth/i.test(String(error.message || ''))) {
          const message = String(error.message || '');
          const target = /confirm|match/i.test(message) ? confirmPasswordField :
            /password/i.test(message) ? passwordField :
              /username/i.test(message) ? usernameField :
                /date of birth|age/i.test(message) ? formField(form, 'date_of_birth') :
                  contactField;
          if (target) {
            if (target === passwordField || target === confirmPasswordField) target.setCustomValidity(message);
            revealInvalidRegistrationField(target);
          }
        }
        loading(submit, false);
      }
    });
  }

  function setFormValue(form, name, value) {
    const input = form.elements[name];
    if (!input) return;
    if (typeof RadioNodeList !== 'undefined' && input instanceof RadioNodeList) {
      [...input].forEach(option => {
        option.checked = option.value === String(value);
      });
    } else if (input.type === 'checkbox') input.checked = Boolean(value);
    else {
      const nextValue = Array.isArray(value) ? value.join(', ') : (value ?? '');
      input.value = nextValue;
      // Options are loaded independently from auth. Preserve a profile value
      // if a select is still empty when the authenticated profile arrives.
      if (input.tagName === 'SELECT' && nextValue && input.value !== String(nextValue)) {
        input.dataset.pendingValue = String(nextValue);
      }
    }
  }

  function profilePayload(form) {
    const data = new FormData(form);
    const text = name => String(data.get(name) || '').trim();
    const dateOfBirth = text('date_of_birth');
    const calculatedAge = ageFromDateOfBirth(dateOfBirth);
    const derivedAge = calculatedAge !== null && calculatedAge >= 3 && calculatedAge <= 120 ? String(calculatedAge) : text('age');
    const derivedAccountType = calculatedAge !== null && calculatedAge >= 3 && calculatedAge < 13 ? 'child' : 'adult';
    return {
      profile: {
        first_name: text('first_name'),
        last_name: text('last_name'),
        display_name: text('display_name') || [text('first_name'), text('last_name')].filter(Boolean).join(' '),
        pronouns: text('pronouns'),
        gender: text('gender'),
        date_of_birth: dateOfBirth,
        age: derivedAge,
        country: text('country'),
        city: text('city'),
        timezone: text('timezone') || automaticTimezone(text('country')),
        primary_language: text('primary_language'),
        additional_languages: text('additional_languages'),
        languages_to_learn: text('languages_to_learn'),
        occupation: text('occupation'),
        professional_role: text('professional_role'),
        organization: text('organization'),
        headline: text('headline'),
        bio: text('bio'),
        website: text('website'),
        availability: text('availability'),
        preferred_format: text('preferred_format'),
        teaching_style: text('teaching_style'),
        experience_level: text('experience_level'),
        learning_goal: text('learning_goal'),
        skills_to_teach: text('skills_to_teach'),
        skills_to_learn: text('skills_to_learn'),
        interests: text('interests'),
        profile_color: text('profile_color')
      },
      preferences: {
        match_visibility: form.elements.match_visibility.checked,
        show_location: form.elements.show_location.checked,
        email_notifications: form.elements.email_notifications.checked,
        weekly_digest: form.elements.weekly_digest.checked,
        profile_visibility: text('profile_visibility') || 'public',
        theme: text('theme') || 'light',
        font_scale: text('font_scale') || 'default',
        content_density: text('content_density') || 'comfortable',
        navigation_style: text('navigation_style') || 'expanded',
        default_landing: text('default_landing') || 'dashboard',
        high_contrast: Boolean(form.elements.high_contrast?.checked),
        reduced_motion: Boolean(form.elements.reduced_motion?.checked),
        link_underlines: Boolean(form.elements.link_underlines?.checked),
        focus_mode: Boolean(form.elements.focus_mode?.checked),
        show_ai_assistant: form.elements.show_ai_assistant?.checked !== false,
        auto_play_testimonials: form.elements.auto_play_testimonials?.checked !== false
      },
      safety: {
        account_type: derivedAccountType,
        guardian_name: text('guardian_name'),
        guardian_email: text('guardian_email'),
        guardian_relationship: text('guardian_relationship'),
        guardian_consent_declared: Boolean(form.elements.guardian_consent_declared?.checked)
      }
    };
  }

  function renderProfileSummary(user) {
    const avatar = $('[data-profile-avatar]');
    setAvatar(avatar, user);
    $('[data-profile-name]').textContent = user.profile.display_name;
    $('[data-profile-handle]').textContent = `@${user.username} · ${user.profile.country}`;
    $('[data-profile-role]').textContent = user.role;
    $('[data-profile-credits]').textContent = user.time_credits ?? 0;
    $('[data-profile-skills]').textContent = list(user.profile.skills_to_teach).length + list(user.profile
      .skills_to_learn).length;
  }

  function setupSettingsSearch(root) {
    const search = $('[data-settings-search]', root);
    const navigation = $('.profile-nav', root);
    if (!search || !navigation) return;
    const links = $$('a[href^="#"]', navigation);
    const labels = $$('.settings-nav-label', navigation);
    const refresh = () => {
      const query = String(search.value || '').trim().toLowerCase();
      links.forEach(link => {
        link.hidden = Boolean(query) && !link.textContent.toLowerCase().includes(query);
      });
      labels.forEach(label => {
        let next = label.nextElementSibling;
        let visibleLink = false;
        while (next && !next.classList.contains('settings-nav-label')) {
          if (next.matches('a') && !next.hidden) visibleLink = true;
          next = next.nextElementSibling;
        }
        label.hidden = Boolean(query) && !visibleLink;
      });
    };
    search.addEventListener('input', refresh);
    search.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      const first = links.find(link => !link.hidden);
      if (first) {
        event.preventDefault();
        first.click();
      }
    });
  }

  function renderPrivacyData(payload) {
    const form = $('#privacyDataForm');
    if (!form) return;
    Object.entries(payload.preferences || {}).forEach(([name, value]) => setFormValue(form, name, value));
    const counts = payload.counts || {};
    const values = [
      [counts.messages || 0, 'Messages'],
      [counts.calendar_events || 0, 'Sessions'],
      [counts.ledger_entries || 0, 'Ledger records'],
      [counts.ideas || 0, 'Ideas']
    ];
    const countHost = $('#privacyDataCounts');
    if (countHost) countHost.innerHTML = values.map(([value, label]) =>
      `<div><strong>${Number(value).toLocaleString()}</strong><span>${escapeHtml(label)}</span></div>`).join('');
    const schedule = payload.schedule || {};
    const messageCutoff = schedule.messages_cleanup_before ? formatDate(schedule.messages_cleanup_before) :
      'kept until account deletion';
    const sessionCutoff = schedule.session_history_cleanup_before ? formatDate(schedule
      .session_history_cleanup_before) : 'kept until account deletion';
    const note = $('#privacyRetentionNote');
    if (note) note.innerHTML =
      `<i class="bx bx-info-circle"></i><span>Message cutoff: <strong>${escapeHtml(messageCutoff)}</strong>. Session cutoff: <strong>${escapeHtml(sessionCutoff)}</strong>. Ledger and essential safety records are retained or pseudonymized where required.</span>`;
  }

  async function loadPrivacyData() {
    const result = await api('/api/account/privacy');
    renderPrivacyData(result);
    return result;
  }

  function setupPrivacyDataControls() {
    const form = $('#privacyDataForm');
    if (!form) return;
    loadPrivacyData().catch(error => setStatus(form, error.message, 'error'));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(form);
      const fields = new FormData(form);
      const button = $('button[type="submit"]', form);
      loading(button, true, 'Saving privacy');
      try {
        const result = await api('/api/account/privacy', {
          method: 'PATCH',
          body: {
            data_retention: fields.get('data_retention'),
            message_retention: fields.get('message_retention'),
            session_history_retention: fields.get('session_history_retention'),
            allow_research_analytics: fields.get('allow_research_analytics') === 'on'
          }
        });
        state.user.preferences = result.preferences;
        await loadPrivacyData();
        setStatus(form, 'Privacy and retention choices saved to your account.', 'success');
        toast('Privacy controls saved.');
      } catch (error) {
        setStatus(form, error.message, 'error');
      } finally {
        loading(button, false);
      }
    });
    $('#privacyCleanupButton')?.addEventListener('click', async event => {
      if (!confirm('Apply your saved retention rules now? Eligible old activity cannot be restored.')) return;
      const button = event.currentTarget;
      loading(button, true, 'Cleaning up');
      clearStatus(form);
      try {
        const result = await api('/api/account/privacy/cleanup', {
          method: 'POST'
        });
        await loadPrivacyData();
        const total = Object.values(result.removed || {}).reduce((sum, value) => sum + Number(value || 0), 0);
        setStatus(form, `${total} eligible record${total === 1 ? '' : 's'} cleaned up under your retention settings.`,
          'success');
      } catch (error) {
        setStatus(form, error.message, 'error');
      } finally {
        loading(button, false);
      }
    });

    const deletionForm = $('#accountDeletionForm');
    if (!deletionForm) return;
    if (state.user.role === 'admin') {
      deletionForm.hidden = true;
      return;
    }
    const expected = `DELETE ${state.user.username}`;
    $('#accountDeletionPrompt').textContent = `Confirmation phrase: ${expected}`;
    $('#accountDeletionConfirmation').placeholder = expected;
    deletionForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (!confirm('Permanently delete your SwapLabs account? This cannot be undone.')) return;
      clearStatus(deletionForm);
      const fields = new FormData(deletionForm);
      const button = $('button[type="submit"]', deletionForm);
      loading(button, true, 'Deleting account');
      try {
        const result = await api('/api/account', {
          method: 'DELETE',
          body: {
            password: fields.get('password'),
            confirmation: fields.get('confirmation')
          }
        });
        sessionStorage.setItem('swaplabs-access-notice', result.message);
        location.replace('index.html');
      } catch (error) {
        setStatus(deletionForm, error.message, 'error');
        loading(button, false);
      }
    });
  }

  function setupProfileSaveState(form) {
    const snapshot = () => JSON.stringify(profilePayload(form));
    let savedSnapshot = snapshot();
    let saving = false;
    let saveFailed = false;
    let departureAllowed = false;
    const isDirty = () => snapshot() !== savedSnapshot;
    const render = () => {
      const dirty = isDirty();
      form.dataset.dirty = String(dirty);
      $$('[data-profile-save-state]', form).forEach(label => {
        label.textContent = saving ? 'Saving…' : saveFailed ? 'Save failed — your changes are still here' :
          dirty ? 'Unsaved changes' : 'All changes saved';
        label.dataset.state = saving ? 'saving' : saveFailed ? 'error' : dirty ? 'dirty' : 'saved';
      });
    };
    form.addEventListener('input', render);
    form.addEventListener('change', render);
    window.addEventListener('beforeunload', event => {
      if (departureAllowed) return;
      if (!isDirty() && !saving) return;
      event.preventDefault();
      event.returnValue = '';
    });
    render();
    return {
      isSaving: () => saving,
      isDirty,
      allowDeparture() { departureAllowed = true; },
      start() { saving = true; saveFailed = false; render(); return snapshot(); },
      saved(submittedSnapshot) { savedSnapshot = submittedSnapshot; saving = false; saveFailed = false; render(); },
      failed() { saving = false; saveFailed = true; render(); }
    };
  }

  function setupAutomaticTimezone(form) {
    const countryInput = formField(form, 'country');
    const timezoneInput = formField(form, 'timezone');
    const status = form.querySelector('[data-auto-timezone]');
    const choice = form.querySelector('[data-timezone-choice]');
    const choiceNote = form.querySelector('[data-timezone-choice-note]');
    const automaticCard = form.querySelector('[data-auto-timezone-card]');
    if (!timezoneInput) return () => {};
    const update = () => {
      const country = String(countryInput?.dataset.pendingValue || countryInput?.value || '').trim();
      const optionsApi = window.SwapLabsOptions;
      const optionsReady = typeof optionsApi?.timezonesForCountry === 'function';
      const zones = optionsReady ? optionsApi.timezonesForCountry(country) || [] : [];
      const savedTimezone = timezoneInput.dataset.pendingValue || timezoneInput.value || '';
      const fallbackTimezone = automaticTimezone(country);
      const availableZones = zones.length ? zones : [fallbackTimezone];
      const selectedTimezone = optionsReady ?
        (zones.includes(savedTimezone) ? savedTimezone : availableZones[0]) :
        (savedTimezone || availableZones[0]);
      if (timezoneInput.tagName === 'SELECT') {
        timezoneInput.innerHTML = availableZones.map(zone => {
          const label = optionsApi?.timezoneLabel?.(zone) || String(zone).replaceAll('_', ' ');
          return `<option value="${escapeHtml(zone)}">${escapeHtml(label)}</option>`;
        }).join('');
      }
      timezoneInput.value = selectedTimezone;
      timezoneInput.defaultValue = selectedTimezone;
      timezoneInput.setAttribute('value', selectedTimezone);
      if (optionsReady) delete timezoneInput.dataset.pendingValue;
      const hasChoice = Boolean(country && zones.length > 1);
      if (choice) choice.hidden = !hasChoice;
      if (automaticCard) automaticCard.hidden = hasChoice;
      if (choiceNote) {
        choiceNote.textContent = hasChoice ?
          `${country} has ${zones.length} time zones. Choose the one where you live.` :
          'Your timezone is selected automatically from your country.';
      }
      if (status) {
        status.textContent = country ? `Set automatically from ${country}: ${selectedTimezone}.` : `Choose your country and SwapLabs will set the best timezone automatically (${selectedTimezone} on this device for now).`;
      }
    };
    countryInput?.addEventListener('input', update);
    countryInput?.addEventListener('change', update);
    window.addEventListener('swaplabs:options-ready', update, {once: true});
    update();
    return update;
  }

  function setupGoogleLinkCard(form, completionMode, saveState) {
    const card = $('[data-google-link-card]');
    const button = $('[data-google-link-button]', card || document);
    const copy = $('[data-google-link-copy]', card || document);
    const status = $('[data-google-link-status]', card || document);
    if (!card || !button) return null;
    card.hidden = false;
    let google = {enabled: false, linked: false, provider_email: ''};
    const skillsReady = () => Boolean(
      String(formField(form, 'skills_to_teach')?.value || '').trim() &&
      String(formField(form, 'skills_to_learn')?.value || '').trim()
    );
    const render = () => {
      const ready = skillsReady();
      const dirty = saveState?.isDirty?.() || false;
      const saving = saveState?.isSaving?.() || false;
      const isAdmin = state.user?.role === 'admin';
      button.disabled = !google.enabled || google.linked || !ready || dirty || saving || isAdmin;
      if (google.linked) {
        if (copy) copy.textContent = 'Google is linked. Use Continue with Google on the login page next time.';
        if (status) status.textContent = google.provider_email ? `Linked to ${google.provider_email}.` : 'Google account linked.';
        button.textContent = 'Google linked';
        return;
      }
      button.textContent = isAdmin ? 'Admin checkpoint required' : 'Continue with Google';
      if (!google.enabled) {
        if (copy) copy.textContent = 'Google sign-in is not configured on the published site yet. Your SwapLabs password remains available.';
        if (status) status.textContent = 'Google linking is waiting for the site connection to be configured.';
      } else if (isAdmin) {
        if (copy) copy.textContent = 'Google linking is available for member accounts. Administrator access stays protected by the administrator checkpoint.';
        if (status) status.textContent = 'Use the administrator access checkpoint for this account.';
      } else if (!ready) {
        if (copy) copy.textContent = 'Choose at least one skill you can teach and one skill you want to learn, then save your profile.';
        if (status) status.textContent = 'Save both skill lists to enable Google linking.';
      } else if (dirty || saving) {
        if (copy) copy.textContent = 'Your skill choices have changed. Save the profile before connecting Google.';
        if (status) status.textContent = saving ? 'Saving your profile…' : 'Unsaved changes need to be saved first.';
      } else {
        if (copy) copy.textContent = completionMode ? 'Your essentials are saved. Connect Google to make future sign-ins one tap.' : 'Your teaching and learning skills are saved. Connect Google for faster sign-in next time.';
        if (status) status.textContent = 'Ready to connect.';
      }
    };
    button.addEventListener('click', () => {
      if (button.disabled) {
        if (!google.enabled) setStatus(form, 'Google sign-in is not configured on the published site yet.', 'error');
        else if (!skillsReady()) setStatus(form, 'Save at least one teaching skill and one learning skill before linking Google.', 'error');
        else setStatus(form, 'Save your current profile changes before linking Google.', 'error');
        return;
      }
      const returnTo = completionMode ? 'profile.html?complete=1&welcome=1#learning' : 'profile.html#learning';
      location.href = `/api/auth/google/start?flow=link&return_to=${encodeURIComponent(returnTo)}`;
    });
    form.addEventListener('input', render);
    form.addEventListener('change', render);
    const refresh = () => render();
    api('/api/auth/google/status').then(result => {
      google = {...google, ...result};
      render();
    }).catch(() => {
      google = {...google, enabled: false};
      render();
    });
    render();
    return {refresh};
  }

  function setupProfilePage() {
    const loadingPanel = $('#profileLoading');
    const locked = $('#profileLocked');
    const panel = $('#profilePanel');
    if (!loadingPanel) return;
    const profileParams = new URLSearchParams(location.search);
    const completionMode = profileParams.get('complete') === '1';
    const profilePage = $('[data-auth-page="profile"]');
    if (completionMode) {
      profilePage?.setAttribute('data-profile-mode', 'completion');
      const heroTitle = $('.account-hero h1', profilePage);
      const heroCopy = $('.account-hero p', profilePage);
      if (heroTitle) heroTitle.textContent = 'Finish the essentials in one clear step.';
      if (heroCopy) heroCopy.textContent = 'Your account is ready. Add your location and language, the skills you can teach and learn, and one learning goal. Optional details can wait.';
    }
    loadingPanel.hidden = true;
    if (!state.user) {
      locked.hidden = false;
      return;
    }
    panel.hidden = false;
    $('[data-settings-logout]', panel)?.addEventListener('click', logout);
    setupSettingsSearch(panel);
    if (location.hash) {
      const anchor = document.getElementById(location.hash.slice(1));
      if (anchor) requestAnimationFrame(() => setTimeout(() => anchor.scrollIntoView({
        block: 'start'
      }), 40));
    }
    const form = $('#profileForm');
    setFormValue(form, 'username', state.user.username);
    setFormValue(form, 'email', state.user.email);
    Object.entries(state.user.profile).forEach(([name, value]) => setFormValue(form, name, value));
    Object.entries(state.user.preferences).forEach(([name, value]) => setFormValue(form, name, value));
    window.SwapLabsOptions?.refreshPickers?.(form);
    const profileNameFields = ['first_name', 'last_name', 'display_name']
      .map(name => formField(form, name)).filter(Boolean);
    const validateProfileNames = (reveal = false) => {
      let firstInvalid = null;
      profileNameFields.forEach(field => {
        const value = String(field.value || '').trim();
        const message = value && !validName(value, field.name) ? NAME_FORMAT_MESSAGE : '';
        field.setCustomValidity(message);
        syncRegistrationFieldError(field, reveal && Boolean(message));
        if (message && !firstInvalid) firstInvalid = field;
      });
      return firstInvalid;
    };
    profileNameFields.forEach(field => field.addEventListener('input', () => validateProfileNames(true)));
    validateProfileNames();
    const syncAutomaticTimezone = setupAutomaticTimezone(form);
    setupStudentSafetyFields(form, state.user.safety || {});
    const safetySection = $('#student-safety');
    const isMinor = Boolean(state.user.safety?.is_minor);
    if (safetySection) safetySection.hidden = !isMinor;
    const safetyLink = $('.profile-nav a[href="#student-safety"]');
    if (safetyLink) safetyLink.hidden = !isMinor;
    const consentStatus = $('#guardianConsentStatus');
    if (consentStatus && isMinor) {
      const status = state.user.safety?.guardian_consent_status || 'pending';
      consentStatus.textContent = `Guardian consent: ${status.replaceAll('_', ' ')}`;
      consentStatus.className = `guardian-status ${status}`;
    }
    const previewPreferences = () => window.SwapLabsPreferences?.apply(profilePayload(form).preferences);
    ['theme', 'font_scale', 'content_density', 'navigation_style', 'high_contrast', 'reduced_motion',
      'link_underlines', 'focus_mode', 'show_ai_assistant', 'auto_play_testimonials'
    ].forEach(name => {
      const field = form.elements[name];
      if (typeof RadioNodeList !== 'undefined' && field instanceof RadioNodeList)[...field].forEach(option =>
        option.addEventListener('change', previewPreferences));
      else field?.addEventListener('change', previewPreferences);
    });
    renderProfileSummary(state.user);
    setupPrivacyDataControls();
    const saveState = setupProfileSaveState(form);
    state.profileSaveState = saveState;
    const googleLinkCard = setupGoogleLinkCard(form, completionMode, saveState);
    const googleParams = new URLSearchParams(location.search);
    if (googleParams.get('google') === 'linked') setStatus(form, 'Google is now linked. You can use it to sign in next time.', 'success');
    if (googleParams.get('google_error')) setStatus(form, googleParams.get('google_error'), 'error');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saveState.isSaving()) return;
      clearStatus(form);
      const invalidName = validateProfileNames(true);
      if (invalidName) {
        setStatus(form, NAME_FORMAT_MESSAGE, 'error');
        invalidName.reportValidity();
        invalidName.focus({preventScroll: true});
        return;
      }
      const missingSkillField = [...form.querySelectorAll('[data-skill-picker-required]')]
        .find(field => !String(field.value || '').trim());
      if (missingSkillField) {
        const wantsToLearn = missingSkillField.name === 'skills_to_learn';
        setStatus(form, `Add at least one skill ${wantsToLearn ? 'you want to learn' : 'you can teach'} before saving.`, 'error');
        window.SwapLabsOptions?.focusPicker?.(missingSkillField.name, form);
        return;
      }
      syncAutomaticTimezone();
      const submittedPayload = profilePayload(form);
      const submittedSnapshot = saveState.start();
      const submitButtons = $$('button[type="submit"]', form);
      submitButtons.forEach(button => loading(button, true, 'Saving profile'));
      try {
        const result = await api('/api/profile', {
          method: 'PATCH',
          body: submittedPayload
        });
        state.user = result.user;
        window.SwapLabsAuth?.remember?.(state.user);
        window.SwapLabsAuth?.reset?.();
        window.dispatchEvent(new CustomEvent('swaplabs:profile-updated', {detail: {user: state.user}}));
        saveState.saved(submittedSnapshot);
        googleLinkCard?.refresh();
        window.SwapLabsPreferences?.apply(saveState.isDirty() ? profilePayload(form).preferences : state.user.preferences || {});
        renderProfileSummary(state.user);
        if ($('#guardianConsentStatus') && state.user.safety?.is_minor) {
          const status = state.user.safety.guardian_consent_status || 'pending';
          $('#guardianConsentStatus').textContent = `Guardian consent: ${status.replaceAll('_', ' ')}`;
          $('#guardianConsentStatus').className = `guardian-status ${status}`;
        }
        renderAccountNavigation();
        refreshNotificationBadge();
        const message = saveState.isDirty() ? 'Submitted changes saved. You have newer unsaved edits.' : 'All profile changes were saved and are now used across SwapLabs.';
        setStatus(form, message, 'success');
        toast(message);
      } catch (error) {
        saveState.failed();
        setStatus(form, error.message, 'error');
      } finally {
        submitButtons.forEach(button => loading(button, false));
      }
    });
    const passwordForm = $('#passwordForm');
    passwordForm.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(passwordForm);
      const submit = $('button[type="submit"]', passwordForm);
      loading(submit, true, 'Updating');
      try {
        const data = new FormData(passwordForm);
        await api('/api/profile/password', {
          method: 'POST',
          body: {
            current_password: data.get('current_password'),
            new_password: data.get('new_password')
          }
        });
        passwordForm.reset();
        setStatus(passwordForm, 'Your password has been updated.', 'success');
      } catch (error) {
        setStatus(passwordForm, error.message, 'error');
      } finally {
        loading(submit, false);
      }
    });
  }

  function userSearchText(user) {
    return [user.username, user.email, user.profile.phone_number, user.profile.display_name, user.profile.country, user.profile.city,
        user.profile.occupation, user.profile.professional_role, user.profile.primary_language,
        ...list(user.profile.additional_languages), ...list(user.profile.interests),
        ...list(user.profile.skills_to_teach), ...list(user.profile.skills_to_learn)
      ]
      .join(' ').toLowerCase();
  }

  function renderAdminStats(stats, analytics = state.adminAnalytics || {}) {
    const records = Array.isArray(state.adminUsers) ? state.adminUsers : [];
    const members = records.filter(user => user.role !== 'admin');
    const derivedStats = records.length ? {
      total: records.length,
      members: members.length,
      active: members.filter(user => user.status !== 'suspended').length,
      suspended: members.filter(user => user.status === 'suspended').length,
      verified: members.filter(user => user.verified === true).length,
      credits: members.reduce((sum, user) => sum + Number(user.time_credits || 0), 0)
    } : {};
    const mapping = {
      statTotal: 'total',
      statMembers: 'members',
      statActive: 'active',
      statSuspended: 'suspended',
      statVerified: 'verified',
      statCredits: 'credits'
    };
    Object.entries(mapping).forEach(([id, key]) => {
      const node = document.getElementById(id);
      const value = Object.prototype.hasOwnProperty.call(derivedStats, key) ? derivedStats[key] : stats?.[key];
      if (node) node.textContent = Number(value || 0).toLocaleString();
    });
    const setAdvanced = (key, value) => {
      document.querySelectorAll(`[data-advanced-stat="${key}"]`).forEach(node => node.textContent = value);
    };
    const setDetail = (key, value) => {
      document.querySelectorAll(`[data-advanced-detail="${key}"]`).forEach(node => node.textContent = value);
    };
    setAdvanced('engagement_rate', `${Number(analytics.engagement_rate || 0)}%`);
    setDetail('engaged_members', `${Number(analytics.engaged_members || 0).toLocaleString()} engaged members`);
    setAdvanced('average_profile_completeness', `${Number(analytics.average_profile_completeness || 0)}%`);
    setAdvanced('completed_session_hours', `${Number(analytics.completed_session_hours || 0).toLocaleString()}h`);
    setAdvanced('credits_earned', Number(analytics.credits_earned || 0).toLocaleString());
    setDetail('credits_spent', `${Number(analytics.credits_spent || 0).toLocaleString()} credits spent`);
    setAdvanced('sessions_scheduled', Number(analytics.sessions?.scheduled || 0).toLocaleString());
    setDetail('sessions_completed', `${Number(analytics.sessions?.completed || 0).toLocaleString()} completed sessions`);
    setAdvanced('active_last_30_days', Number(analytics.active_last_30_days || 0).toLocaleString());
    const topSkills = document.querySelector('[data-admin-top-skills]');
    if (topSkills) topSkills.innerHTML = (analytics.top_skills || []).slice(0, 6).map(item => `<span>${escapeHtml(item.label)} <b>${Number(item.value || 0)}</b></span>`).join('') || '<span>No skill data yet</span>';
    const content = analytics.content || {};
    setDetail('content_summary', `${Number(content.ideas || 0)} ideas · ${Number(content.groups || 0)} groups · ${Number(content.conversations || 0)} conversations · ${Number(content.feedback || 0)} feedback records`);
  }

  const chartTheme = () => {
    const css = getComputedStyle(document.documentElement);
    return {strong:css.getPropertyValue('--navy').trim(),muted:css.getPropertyValue('--muted').trim(),line:css.getPropertyValue('--line').trim(),surface:css.getPropertyValue('--surface').trim(),accent:css.getPropertyValue('--indigo').trim()};
  };
  const chartColors = ['#5d5fef', '#d56b9f', '#4b83f5', '#8b5cf6', '#21856a', '#f59e0b', '#667085', '#b54708',
    '#7f56d9', '#0e9384'
  ];
  const countValues = values => {
    const counts = new Map();
    values.filter(value => value !== undefined && value !== null && String(value).trim()).forEach(value => {
      const label = String(value).trim();
      counts.set(label, (counts.get(label) || 0) + 1);
    });
    return [...counts.entries()].map(([label, value]) => ({
      label,
      value
    })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  };
  const prepareCanvas = id => {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width || canvas.parentElement?.clientWidth || 280));
    const height = Math.max(1, Math.round(box.height || Number(canvas.getAttribute('height')) || 240));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.font = '11px Inter, system-ui, sans-serif';
    context.textBaseline = 'middle';
    return {
      canvas,
      context,
      width,
      height
    };
  };
  const renderChartData = (id, data) => {
    const host = document.getElementById(id);
    if (!host) return;
    host.innerHTML = data.map(item =>
        `<span>${escapeHtml(item.label)} <strong>${Number(item.value).toLocaleString()}</strong></span>`).join(
      '') || '<span>No saved values</span>';
  };
  const renderLegend = (id, data) => {
    const host = document.getElementById(id);
    if (!host) return;
    host.innerHTML = data.map((item, index) =>
      `<span><i style="background:${chartColors[index % chartColors.length]}"></i>${escapeHtml(item.label)} · ${item.value}</span>`
      ).join('');
  };

  function drawDoughnut(id, data, legendId) {
    const prepared = prepareCanvas(id);
    if (!prepared) return;
    const {
      context,
      width,
      height
    } = prepared;
    const total = data.reduce((sum, item) => sum + item.value, 0);
    // Keep the drawing helper safe when it is exercised in isolation (for
    // example by a static chart smoke test before the page theme bootstraps).
    // The normal page path still uses the live CSS-derived chart theme.
    const theme = typeof chartTheme === 'function'
      ? chartTheme()
      : {strong: '#101828', muted: '#667085'};
    const centerX = width / 2;
    const centerY = height * .48;
    const radius = Math.max(28, Math.min(width, height) * .34);
    const ringWidth = Math.max(16, Math.min(28, radius * .28));
    context.lineWidth = ringWidth;
    context.lineCap = 'butt';
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.strokeStyle = theme.line || '#e5e7eb';
    context.stroke();
    let angle = -Math.PI / 2;
    data.forEach((item, index) => {
      const slice = total ? item.value / total * Math.PI * 2 : 0;
      if (slice <= 0) return;
      context.beginPath();
      context.arc(centerX, centerY, radius, angle, angle + slice);
      context.strokeStyle = chartColors[index % chartColors.length];
      context.stroke();
      angle += slice;
    });
    context.fillStyle = theme.strong;
    context.textAlign = 'center';
    context.font = '700 24px Inter, system-ui, sans-serif';
    context.fillText(String(total), centerX, centerY - 4);
    context.fillStyle = theme.muted;
    context.font = '11px Inter, system-ui, sans-serif';
    context.fillText('accounts', centerX, centerY + 17);
    renderLegend(legendId, data);
  }

  function drawBarChart(id, data, horizontal = false) {
    const prepared = prepareCanvas(id);
    if (!prepared) return;
    const {
      context,
      width,
      height
    } = prepared;
    const shown = data.slice(0, horizontal ? 9 : 8);
    const maximum = Math.max(1, ...shown.map(item => item.value));
    const theme = chartTheme();
    const left = horizontal ? Math.min(190, Math.max(104, width * .28)) : 30;
    const right = horizontal ? 34 : 18;
    const top = 18;
    const bottom = horizontal ? 18 : 50;
    context.strokeStyle = theme.line;
    context.lineWidth = 1;
    if (horizontal) {
      const chartHeight = height - top - bottom;
      const row = chartHeight / Math.max(shown.length, 1);
      shown.forEach((item, index) => {
        const y = top + index * row + row * .22;
        const barHeight = Math.max(12, row * .52);
        const barWidth = (width - left - right) * item.value / maximum;
        context.fillStyle = theme.muted;
        context.textAlign = 'right';
        context.font = '11px Inter, system-ui, sans-serif';
        const label = item.label.length > 25 ? `${item.label.slice(0, 24)}…` : item.label;
        context.fillText(label, left - 8, y + barHeight / 2);
        context.fillStyle = chartColors[index % chartColors.length];
        context.fillRect(left, y, Math.max(2, barWidth), barHeight);
        context.fillStyle = theme.strong;
        context.textAlign = 'left';
        context.font = '700 11px Inter, system-ui, sans-serif';
        context.fillText(String(item.value), Math.min(width - 24, left + barWidth + 7), y + barHeight / 2);
      });
    } else {
      const chartHeight = height - top - bottom;
      const column = (width - left - right) / Math.max(shown.length, 1);
      context.strokeStyle = theme.line;
      context.setLineDash([3, 5]);
      for (let tick = 0; tick <= 3; tick += 1) {
        const y = top + chartHeight - chartHeight * tick / 3;
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(width - right, y);
        context.stroke();
      }
      context.setLineDash([]);
      context.beginPath();
      context.moveTo(left, top + chartHeight);
      context.lineTo(width - right, top + chartHeight);
      context.stroke();
      shown.forEach((item, index) => {
        const barWidth = Math.max(8, column * .58);
        const barHeight = chartHeight * item.value / maximum;
        const x = left + index * column + (column - barWidth) / 2;
        const y = top + chartHeight - barHeight;
        context.fillStyle = chartColors[index % chartColors.length];
        context.fillRect(x, y, barWidth, barHeight);
        context.fillStyle = theme.strong;
        context.textAlign = 'center';
        context.font = '700 11px Inter, system-ui, sans-serif';
        context.fillText(String(item.value), x + barWidth / 2, Math.max(12, y - 8));
        const label = item.label.length > 14 ? `${item.label.slice(0, 13)}…` : item.label;
        context.fillStyle = theme.muted;
        context.font = '10px Inter, system-ui, sans-serif';
        context.fillText(label, x + barWidth / 2, top + chartHeight + 18);
      });
    }
  }

  function drawLineChart(id, data) {
    const prepared = prepareCanvas(id);
    if (!prepared) return;
    const {
      context,
      width,
      height
    } = prepared;
    const left = 42,
      right = 18,
      top = 20,
      bottom = 42;
    const shown = data.slice(-10);
    const maximum = Math.max(1, ...shown.map(item => item.value));
    context.strokeStyle = chartTheme().line;
    context.lineWidth = 1;
    for (let index = 0; index <= 4; index += 1) {
      const y = top + (height - top - bottom) * index / 4;
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(width - right, y);
      context.stroke();
    }
    const points = shown.map((item, index) => ({
      x: shown.length === 1 ? width / 2 : left + (width - left - right) * index / (shown.length - 1),
      y: top + (height - top - bottom) * (1 - item.value / maximum),
      item
    }));
    context.beginPath();
    points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.strokeStyle = chartTheme().accent;
    context.lineWidth = 3;
    context.stroke();
    points.forEach(point => {
      context.beginPath();
      context.arc(point.x, point.y, 5, 0, Math.PI * 2);
      context.fillStyle = chartTheme().surface;
      context.fill();
      context.strokeStyle = chartTheme().accent;
      context.lineWidth = 3;
      context.stroke();
      context.fillStyle = chartTheme().muted;
      context.textAlign = 'center';
      context.font = '10px Inter, system-ui, sans-serif';
      context.fillText(point.item.label, point.x, height - 17);
      context.fillStyle = chartTheme().strong;
      context.font = '700 10px Inter, system-ui, sans-serif';
      context.fillText(String(point.item.value), point.x, point.y - 13);
    });
  }

  function renderAdminCharts() {
    if (!$('#chartStatus')) return;
    const overviewQuery = ($('#adminOverviewSearch')?.value || '').trim().toLowerCase();
    const recordedMembers = state.adminUsers.filter(user => user.role !== 'admin');
    const users = overviewQuery ? recordedMembers.filter(user => userSearchText(user).includes(overviewQuery)) : recordedMembers;
    const statuses = countValues(users.map(user => user.status));
    const visibility = countValues(users.map(user => user.preferences?.profile_visibility || 'public'));
    const ageBands = [{
        label: '3–17',
        min: 3,
        max: 17
      }, {
        label: '18–24',
        min: 18,
        max: 24
      },
      {
        label: '25–34',
        min: 25,
        max: 34
      }, {
        label: '35–44',
        min: 35,
        max: 44
      },
      {
        label: '45–54',
        min: 45,
        max: 54
      }, {
        label: '55–64',
        min: 55,
        max: 64
      },
      {
        label: '65+',
        min: 65,
        max: 120
      }
    ].map(band => ({
      label: band.label,
      value: users.filter(user => Number(user.profile.age) >= band.min && Number(user.profile.age) <= band.max)
        .length
    }));
    const countries = countValues(users.map(user => user.profile.country || 'Not set'));
    const languages = countValues(users.map(user => user.profile.primary_language || 'Not set'));
    const credits = [{
        label: '0–5',
        min: 0,
        max: 5
      }, {
        label: '6–10',
        min: 6,
        max: 10
      }, {
        label: '11–20',
        min: 11,
        max: 20
      },
      {
        label: '21–50',
        min: 21,
        max: 50
      }, {
        label: '51+',
        min: 51,
        max: Infinity
      }
    ].map(band => ({
      label: band.label,
      value: users.filter(user => Number(user.time_credits || 0) >= band.min && Number(user.time_credits ||
        0) <= band.max).length
    }));
    const occupations = countValues(users.flatMap(user => [user.profile.occupation, user.profile.professional_role]));
    const skills = countValues(users.flatMap(user => [...list(user.profile.skills_to_teach), ...list(user.profile
      .skills_to_learn)]));
    const verification = [{label: 'Verified', value: users.filter(user => user.verified).length}, {label: 'Unverified', value: users.filter(user => !user.verified).length}];
    const moderation = countValues(users.map(user => {
      const label = user.moderation_label || 'none';
      return label === 'none' ? 'No label' : label.replaceAll('_', ' ');
    }));
    const exchangeMix = [
      {label: 'Can teach', value: users.filter(user => list(user.profile?.skills_to_teach).length).length},
      {label: 'Want to learn', value: users.filter(user => list(user.profile?.skills_to_learn).length).length},
      {label: 'Both sides', value: users.filter(user => list(user.profile?.skills_to_teach).length && list(user.profile?.skills_to_learn).length).length},
      {label: 'No skills yet', value: users.filter(user => !list(user.profile?.skills_to_teach).length && !list(user.profile?.skills_to_learn).length).length}
    ];
    const profileCoverage = [
      {label: 'Location', value: users.filter(user => user.profile?.country || user.profile?.city).length},
      {label: 'Role', value: users.filter(user => user.profile?.occupation || user.profile?.professional_role).length},
      {label: 'Phone', value: users.filter(user => user.profile?.phone_number).length},
      {label: 'Bio', value: users.filter(user => user.profile?.bio).length}
    ];
    const inventory = [
      {label: 'Members', value: users.length},
      {label: 'Verified', value: users.filter(user => user.verified).length},
      {label: 'With phone', value: users.filter(user => user.profile?.phone_number).length},
      {label: 'Public', value: users.filter(user => (user.preferences?.profile_visibility || 'public') !== 'private').length},
      {label: '50+ credits', value: users.filter(user => Number(user.time_credits || 0) >= 50).length}
    ];
    const completenessFields = ['display_name', 'country', 'city', 'occupation', 'professional_role', 'primary_language', 'bio'];
    const completeness = [{label: '0–39%', min: 0, max: 39}, {label: '40–69%', min: 40, max: 69}, {label: '70–89%', min: 70, max: 89}, {label: '90–100%', min: 90, max: 100}].map(band => ({
      label: band.label,
      value: users.filter(user => {
        const filled = completenessFields.filter(field => String(user.profile?.[field] || '').trim()).length +
          (list(user.profile?.skills_to_teach).length ? 1 : 0) + (list(user.profile?.skills_to_learn).length ? 1 : 0);
        const score = Math.round(filled / (completenessFields.length + 2) * 100);
        return score >= band.min && score <= band.max;
      }).length
    }));
    const monthly = countValues(users.map(user => {
      const date = new Date(user.created_at);
      return Number.isNaN(date.getTime()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        year: 'numeric'
      }).format(date);
    })).sort((a, b) => {
      const parse = label => new Date(`1 ${label}`).getTime() || 0;
      return parse(a.label) - parse(b.label);
    });
    let cumulative = 0;
    const growth = monthly.map(item => ({
      label: item.label,
      value: (cumulative += item.value)
    }));
    drawDoughnut('chartStatus', statuses, 'legendStatus');
    drawDoughnut('chartVisibility', visibility, 'legendVisibility');
    drawBarChart('chartAges', ageBands);
    drawBarChart('chartCountries', countries, true);
    drawBarChart('chartLanguages', languages);
    drawBarChart('chartCredits', credits);
    drawBarChart('chartOccupations', occupations, true);
    drawBarChart('chartSkills', skills, true);
    drawLineChart('chartGrowth', growth);
    drawDoughnut('chartVerification', verification, 'legendVerification');
    drawDoughnut('chartModeration', moderation, 'legendModeration');
    drawBarChart('chartCompleteness', completeness);
    drawBarChart('chartExchangeMix', exchangeMix);
    drawBarChart('chartProfileCoverage', profileCoverage);
    drawBarChart('chartInventory', inventory);
    renderChartData('dataAges', ageBands);
    renderChartData('dataCountries', countries);
    renderChartData('dataLanguages', languages);
    renderChartData('dataCredits', credits);
    renderChartData('dataOccupations', occupations);
    renderChartData('dataSkills', skills);
    renderChartData('dataGrowth', growth);
    renderChartData('dataCompleteness', completeness);
    renderChartData('dataExchangeMix', exchangeMix);
    renderChartData('dataProfileCoverage', profileCoverage);
    renderChartData('dataInventory', inventory);
  }

  function focusAdminFeature(targetId) {
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    const details = target.closest('details');
    if (details) details.open = true;
    requestAnimationFrame(() => target.scrollIntoView({behavior: 'smooth', block: 'start', inline: 'nearest'}));
  }

  function showAdminSection(sectionName = 'overview', focusTarget = '') {
    const selected = ['overview', 'presence', 'presence-today', 'messages', 'records', 'create-account', 'reports', 'disputes', 'submissions', 'moderation', 'ideas', 'activity', 'ledger', 'sessions', 'support', 'newsletter', 'audit'].includes(sectionName) ? sectionName : 'overview';
    const sectionMeta = {
      overview: ['Dashboard', 'Workspace / Overview'],
      presence: ['Users online now', 'Overview & analytics / Current activity'],
      'presence-today': ['Users online today', 'Overview & analytics / Daily activity'],
      records: ['Members', 'Workspace / Members'],
      'create-account': ['Create account', 'Workspace / Create account'],
      messages: ['Messages', 'Communication / Messages'],
      newsletter: ['Newsletter', 'Communication / Newsletter'],
      support: ['Support', 'Communication / Support'],
      reports: ['Safety reports', 'Review queues / Safety reports'],
      disputes: ['Credit disputes', 'Review queues / Credit disputes'],
      submissions: ['Submissions', 'Review queues / Submissions'],
      moderation: ['Pending Moderation', 'Trust & safety / Blocked-word review'],
      ideas: ['Innovation review', 'Review queues / Innovation review'],
      activity: ['Member activity', 'Review queues / Member activity'],
      ledger: ['Credit ledger', 'Records / Credit ledger'],
      sessions: ['Sessions', 'Records / Sessions'],
      audit: ['Audit log', 'Records / Audit log']
    };
    const [title, subtitle] = sectionMeta[selected] || sectionMeta.overview;
    const titleNode = $('#adminPageTitle');
    const subtitleNode = $('#adminPageSubtitle');
    if (titleNode) titleNode.textContent = title;
    if (subtitleNode) subtitleNode.textContent = subtitle;
    document.title = `${title} — SwapLabs`;
    $$('[data-admin-section]').forEach(section => section.classList.toggle('active', section.dataset.adminSection ===
      selected));
    const adminNavButtons = $$('[data-admin-section-target]');
    let activeNavButton = null;
    adminNavButtons.forEach(button => {
      const sameSection = button.dataset.adminSectionTarget === selected;
      const sameFeature = focusTarget ? button.dataset.adminFocus === focusTarget : !button.dataset.adminFocus;
      const active = sameSection && sameFeature;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      if (active) activeNavButton = button;
    });
    if (!activeNavButton) {
      activeNavButton = adminNavButtons.find(button => button.dataset.adminSectionTarget === selected) || null;
      activeNavButton?.classList.add('active');
      activeNavButton?.setAttribute('aria-pressed', 'true');
    }
    activeNavButton?.closest('details.admin-nav-group')?.setAttribute('open', '');
    if (selected === 'overview') requestAnimationFrame(renderAdminCharts);
    if (selected === 'presence') loadAdminPresence();
    if (selected === 'presence-today') loadAdminPresenceToday();
    if (selected === 'messages') renderAdminMessageRecipients();
    if (selected === 'newsletter') loadNewsletterSubscribers();
    if (workConfig[selected]) loadAdminWorkspace(selected);
    focusAdminFeature(focusTarget);
  }

  function setupNewsletterForm() {
    const form = $('[data-newsletter-form]');
    form?.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.dataset.submitting === 'true') return;
      form.dataset.submitting = 'true';
      clearStatus(form);
      const fields = new FormData(form);
      const button = $('button[type="submit"]', form);
      loading(button, true, 'Subscribing');
      try {
        const result = await api('/api/newsletter/subscribe', {
          method: 'POST', body: {email: fields.get('email'), consent: fields.get('consent') === 'on'}
        });
        form.reset();
        setStatus(form, result.message, 'success');
      } catch (error) {
        setStatus(form, error.message, 'error');
      } finally {
        form.dataset.submitting = 'false';
        loading(button, false);
      }
    });
  }

  function filteredNewsletterSubscribers() {
    const query = ($('#adminNewsletterSearch')?.value || '').trim().toLowerCase();
    return state.newsletterSubscribers.filter(item => item.email.toLowerCase().includes(query));
  }

  function renderNewsletterSubscribers() {
    const items = filteredNewsletterSubscribers();
    $('#adminNewsletterCount').textContent = `${items.length} of ${state.newsletterSubscribers.length} subscribers`;
    $('#adminNewsletterCopy').disabled = items.length === 0;
    $('#adminNewsletterRows').innerHTML = items.map(item => `<tr><td>${escapeHtml(item.email)}</td><td>${escapeHtml(formatDate(item.created_at))}</td><td><button type="button" class="btn btn-sm" data-newsletter-remove="${escapeHtml(item.id)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="3">No newsletter subscribers found.</td></tr>';
  }

  let newsletterRequest = 0;
  async function loadNewsletterSubscribers() {
    const requestId = ++newsletterRequest;
    const status = $('#adminNewsletterStatus');
    if (!status) return;
    status.textContent = 'Loading subscribers…';
    try {
      const result = await api('/api/admin/newsletter');
      if (requestId !== newsletterRequest) return;
      state.newsletterSubscribers = result.subscribers;
      renderNewsletterSubscribers();
      renderStaticAdminAnalytics();
      status.textContent = '';
    } catch (error) {
      if (requestId !== newsletterRequest) return;
      state.newsletterSubscribers = [];
      renderNewsletterSubscribers();
      status.textContent = error.message;
    }
  }

  function renderAdminMessageRecipients() {
    const host = $('#adminMessageRecipients');
    if (!host) return;
    const query = ($('#adminMessageRecipientSearch')?.value || '').trim().toLowerCase();
    const recipients = state.adminUsers.filter(user => user.id !== state.user?.id && user.status === 'active' &&
      (!query || `${user.profile.display_name} ${user.username} ${user.email}`.toLowerCase().includes(query))).slice(0, 12);
    host.innerHTML = recipients.map(user => `<button class="admin-recipient-option ${state.selectedMessageRecipientId === user.id ? 'selected' : ''}" type="button" role="option" aria-selected="${state.selectedMessageRecipientId === user.id}" data-message-recipient="${escapeHtml(user.id)}">${avatarHtml(user)}<span><strong>${escapeHtml(user.profile.display_name)}</strong><small>@${escapeHtml(user.username)} · ${escapeHtml(user.email)}</small></span><i class="bx bx-chevron-right"></i></button>`).join('') || '<div class="admin-recipient-empty"><i class="bx bx-user-x"></i><span>No active members match that search.</span></div>';
    $$('[data-message-recipient]', host).forEach(button => button.addEventListener('click', () => selectAdminMessageRecipient(button.dataset.messageRecipient)));
  }

  function selectAdminMessageRecipient(userId) {
    const user = state.adminUsers.find(candidate => candidate.id === userId);
    if (!user) return;
    state.selectedMessageRecipientId = userId;
    $('#adminMessageRecipient').value = userId;
    const selected = $('#adminSelectedRecipient');
    selected.hidden = false;
    selected.innerHTML = `${avatarHtml(user)}<span><strong>To ${escapeHtml(user.profile.display_name)}</strong><small>@${escapeHtml(user.username)}</small></span><button type="button" aria-label="Remove recipient" title="Remove recipient"><i class="bx bx-x"></i></button>`;
    $('button', selected)?.addEventListener('click', () => {
      state.selectedMessageRecipientId = null;
      $('#adminMessageRecipient').value = '';
      selected.hidden = true;
      renderAdminMessageRecipients();
    });
    renderAdminMessageRecipients();
    $('#adminMessageBody')?.focus();
  }

  function updateAdminMessageMode() {
    const mode = $('#adminMessageMode')?.value || 'direct';
    const direct = $('#adminMessageDirectFields');
    const filters = $('#adminMessageFilters');
    if (!direct || !filters) return mode;
    const filtered = mode === 'filtered';
    direct.hidden = filtered;
    filters.hidden = !filtered;
    $('#adminMessageRecipient')?.toggleAttribute('required', !filtered);
    const submit = $('#adminMessageSubmit');
    if (submit && !submit.disabled) submit.innerHTML = filtered ? '<i class="bx bx-filter-alt"></i> Send to filtered members' : '<i class="bx bx-send"></i> Send message';
    return mode;
  }

  async function sendAdminMessage(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const submit = $('button[type="submit"]', form);
    const mode = updateAdminMessageMode();
    if (mode === 'direct' && !fields.get('target_user_id')) {
      setStatus(form, 'Choose a recipient before sending.', 'error');
      return;
    }
    const filters = {};
    ['min_age', 'max_age', 'timezone', 'country', 'min_credits', 'max_credits', 'verified'].forEach(name => {
      const value = String(fields.get(name) || '').trim();
      if (value) filters[name] = value;
    });
    loading(submit, true, 'Sending');
    clearStatus(form);
    try {
      const payload = mode === 'filtered' ? {broadcast: true, filters, body: fields.get('body')} : {target_user_id: fields.get('target_user_id'), body: fields.get('body')};
      const result = await api('/api/admin/messages', {method: 'POST', body: payload});
      $('#adminMessageBody').value = '';
      $('#adminMessageCount').textContent = '0';
      if (mode === 'direct') {
        state.selectedMessageRecipientId = null;
        $('#adminMessageRecipient').value = '';
        $('#adminSelectedRecipient').hidden = true;
        renderAdminMessageRecipients();
      }
      setStatus(form, result.message, 'success');
      toast(result.message);
      await loadAdminData();
    } catch (error) {
      setStatus(form, error.message, 'error');
    } finally {
      loading(submit, false);
    }
  }

  function updateAdminNotificationAudience() {
    const audience = $('#adminNotificationAudience')?.value || 'all';
    const filters = $('#adminNotificationFilters');
    if (filters) filters.hidden = audience !== 'filtered';
    const submit = $('#adminNotificationSubmit');
    if (submit && !submit.disabled) submit.innerHTML = audience === 'filtered'
      ? '<i class="bx bx-filter-alt"></i> Send filtered announcement'
      : '<i class="bx bx-bell-plus"></i> Send to all active members';
    return audience;
  }

  async function sendAdminNotification(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const audience = updateAdminNotificationAudience();
    const destination = audience === 'all' ? 'all active member accounts' : 'the active members matching these filters';
    if (!window.confirm(`Send this notification to ${destination}? Notifications cannot be recalled.`)) return;
    const filters = {};
    ['min_age', 'max_age', 'country', 'timezone', 'min_credits', 'max_credits', 'verified', 'joined_after', 'joined_before', 'active_within_days', 'inactive_for_days', 'teaching_skills'].forEach(name => {
      const value = String(fields.get(name) || '').trim();
      if (value) filters[name] = value;
    });
    const submit = $('button[type="submit"]', form);
    loading(submit, true, 'Sending');
    clearStatus(form);
    try {
      const result = await api('/api/admin/notifications', {
        method: 'POST',
        body: {title: fields.get('title'), message: fields.get('message'), audience, filters}
      });
      $('#adminNotificationTitle').value = '';
      $('#adminNotificationMessage').value = '';
      $('#adminNotificationCount').textContent = '0';
      setStatus(form, result.message, 'success');
      toast(result.message);
    } catch (error) {
      setStatus(form, error.message, 'error');
    } finally {
      loading(submit, false);
      updateAdminNotificationAudience();
    }
  }

  async function createAdminAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const submit = $('button[type="submit"]', form);
    const first = String(fields.get('first_name') || '').trim();
    const last = String(fields.get('last_name') || '').trim();
    const displayName = String(fields.get('display_name') || '').trim() || `${first} ${last}`.trim();
    clearStatus(form);
    if (!displayName) {
      setStatus(form, 'Add a display name for this member.', 'error');
      return;
    }
    const invalidName = [['first_name', first], ['last_name', last], ['display_name', displayName]]
      .find(([field, value]) => value && !validName(value, field));
    if (invalidName) {
      setStatus(form, NAME_FORMAT_MESSAGE, 'error');
      form.elements[invalidName[0]]?.focus();
      return;
    }
    loading(submit, true, 'Creating ID');
    const profile = {
      first_name: first, last_name: last, display_name: displayName,
      phone_number: fields.get('phone_number'),
      date_of_birth: fields.get('date_of_birth'), country: fields.get('country'), city: fields.get('city'),
      primary_language: fields.get('primary_language'), occupation: fields.get('occupation'),
      professional_role: fields.get('occupation'), headline: fields.get('headline'), bio: fields.get('bio'),
      skills_to_teach: fields.get('skills_to_teach'), skills_to_learn: fields.get('skills_to_learn'),
      timezone: fields.get('timezone'), availability: fields.get('availability'),
    };
    const body = {
      username: fields.get('username'), email: fields.get('email'), password: fields.get('password'),
      starting_credits: fields.get('starting_credits'), profile,
      safety: {
        guardian_name: fields.get('guardian_name'), guardian_email: fields.get('guardian_email'),
        guardian_relationship: fields.get('guardian_relationship'), guardian_consent_declared: fields.get('guardian_consent_declared') === 'on'
      }
    };
    try {
      const result = await api('/api/admin/users', {method: 'POST', body});
      form.reset();
      const created = $('#adminCreatedAccount');
      if (created) {
        created.hidden = false;
        created.innerHTML = `<i class="bx bx-check-circle"></i><div><strong>Member ID created: <code>${escapeHtml(result.account_id)}</code></strong><span>${escapeHtml(result.credentials.username)} can sign in with the username or email provided.</span></div><button type="button" class="btn btn-sm" data-created-account-view="${escapeHtml(result.account_id)}">Open record</button>`;
        $('[data-created-account-view]', created)?.addEventListener('click', () => { showAdminSection('records'); selectAdminUser(result.account_id); });
      }
      setStatus(form, `${result.message} The generated ID is ready below.`, 'success');
      toast(result.message);
      await loadAdminData();
    } catch (error) {
      setStatus(form, error.message, 'error');
    } finally {
      loading(submit, false);
    }
  }

  function filteredAdminUsers() {
    const query = ($('#adminSearch')?.value || '').trim().toLowerCase();
    const status = $('#adminStatusFilter')?.value || 'all';
    const role = $('#adminRoleFilter')?.value || 'all';
    const priority = $('#adminPriorityFilter')?.value || 'all';
    return state.adminUsers.filter(user => {
      const matches = (!query || userSearchText(user).includes(query)) && (status === 'all' || user.status === status) && (role === 'all' || user.role === role);
      if (!matches) return false;
      if (priority === 'review') return ['review', 'warning'].includes(user.moderation_label) || user.status === 'suspended';
      if (priority === 'risk') return user.moderation_label === 'warning' || user.status === 'suspended' || Boolean(user.safety?.is_minor && user.safety?.guardian_consent_status !== 'verified');
      if (priority === 'verified') return Boolean(user.verified);
      if (priority === 'recent') return (Date.now() - new Date(user.updated_at).getTime()) <= 1000 * 60 * 60 * 24 * 30;
      return true;
    }).sort((a, b) => {
      const sort = $('#adminAccountSort')?.value;
      if (sort === 'name') return memberName(a).localeCompare(memberName(b));
      if (sort === 'credits') return Number(b.time_credits || 0) - Number(a.time_credits || 0);
      const field = sort === 'joined' ? 'created_at' : 'updated_at';
      return String(b[field] || '').localeCompare(String(a[field] || ''));
    });
  }

  function renderAdminRows() {
    const rows = $('#adminUserRows');
    if (!rows) return;
    const users = filteredAdminUsers();
    $('#adminResultCount').textContent = `${users.length} record${users.length === 1 ? '' : 's'}`;
    rows.innerHTML = users.map(user =>
        `<tr class="admin-account-row${state.selectedUserId === user.id ? ' selected' : ''}" data-user-row="${escapeHtml(user.id)}" tabindex="0" role="button" aria-label="Open account details for ${escapeHtml(user.profile.display_name)}"><td><input type="checkbox" data-admin-select-user="${escapeHtml(user.id)}" aria-label="Select ${escapeHtml(user.profile.display_name)}" ${state.selectedAdminUserIds.has(user.id) ? 'checked' : ''} ${user.role === 'admin' ? 'disabled' : ''}></td><td><div class="table-user">${avatarHtml(user)}<div><strong>${escapeHtml(user.profile.display_name)}</strong><span>@${escapeHtml(user.username)} · ${escapeHtml(user.email)}</span></div></div></td><td><span class="status-pill ${escapeHtml(user.role)}">${escapeHtml(user.role)}</span></td><td><span class="status-pill ${escapeHtml(user.status)}">${escapeHtml(user.status)}</span></td><td>${escapeHtml([user.profile.city, user.profile.country].filter(Boolean).join(', ') || 'Not set')}</td><td>${escapeHtml(user.profile.phone_number || 'Not provided')}</td><td>${Number(user.time_credits || 0)}</td><td>${escapeHtml(formatDate(user.updated_at))}</td></tr>`
        ).join('') ||
      '<tr><td colspan="8" style="text-align:center;padding:35px">No accounts match these filters. Clear a filter to see more records.</td></tr>';
    $$('[data-user-row]', rows).forEach(row => {
      row.addEventListener('click', event => {
        if (event.target.closest?.('input, button, a, select, textarea, label')) return;
        selectAdminUser(row.dataset.userRow);
      });
      row.addEventListener('keydown', event => {
        if (event.target !== row || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        selectAdminUser(row.dataset.userRow);
      });
    });
    $$('[data-admin-select-user]', rows).forEach(input => input.addEventListener('change', () => {
      if (input.checked) state.selectedAdminUserIds.add(input.dataset.adminSelectUser);
      else state.selectedAdminUserIds.delete(input.dataset.adminSelectUser);
      updateAdminBulkBar();
    }));
    updateAdminBulkBar();
  }

  function updateAdminBulkBar() {
    const count = state.selectedAdminUserIds.size;
    if ($('#adminSelectedCount')) $('#adminSelectedCount').textContent = `${count} selected`;
    if ($('#adminApplyBulk')) $('#adminApplyBulk').disabled = !count || !$('#adminBulkAction')?.value;
  }

  async function applyAdminBulkAction() {
    const action = $('#adminBulkAction')?.value;
    if (!action || !state.selectedAdminUserIds.size) return;
    const button = $('#adminApplyBulk');
    loading(button, true, 'Applying');
    try {
      const result = await api('/api/admin/users/bulk', {method:'POST', body:{action, user_ids:[...state.selectedAdminUserIds]}});
      state.selectedAdminUserIds.clear();
      if ($('#adminSelectVisible')) $('#adminSelectVisible').checked = false;
      $('#adminBulkAction').value = '';
      toast(result.message);
      await loadAdminData(Boolean(state.selectedUserId));
    } catch (error) {
      toast(error.message, 'error');
      loading(button, false);
    }
  }

  function detailPairs(object) {
    return Object.entries(object).map(([key, value]) =>
      `<div><dt>${escapeHtml(key.replaceAll('_', ' '))}</dt><dd>${escapeHtml(Array.isArray(value) ? value.join(', ') || 'None' : (value === true ? 'Yes' : value === false ? 'No' : value || 'Not set'))}</dd></div>`
      ).join('');
  }

  function suspensionMinutes(fields) {
    const amount = Math.max(1, Number(fields.get('suspension_amount') || 1));
    const factors = {
      minutes: 1,
      hours: 60,
      days: 1440,
      weeks: 10080
    };
    return Math.round(amount * (factors[fields.get('suspension_unit')] || 1440));
  }

  function suspensionControls(user) {
    const deadline = user.suspended_until ? formatDate(user.suspended_until) : 'No active suspension deadline';
    return `<div class="admin-suspension-fields" data-suspension-fields ${user.status === 'suspended' ? '' : 'hidden'}>
      <div class="field"><label>Suspension length</label><input name="suspension_amount" type="number" min="1" max="365" value="1"></div>
      <div class="field"><label>Duration unit</label><select name="suspension_unit"><option value="hours">Hours</option><option value="days" selected>Days</option><option value="weeks">Weeks</option><option value="minutes">Minutes</option></select></div>
      <div class="field full"><label>Suspension reason</label><input name="suspension_reason" maxlength="1000" value="${escapeHtml(user.suspension_reason || '')}" placeholder="Explain why access is being suspended"></div>
      <p class="admin-suspension-deadline"><i class="bx bx-time-five"></i> Current access deadline: ${escapeHtml(deadline)}. Saving a suspension sets a new deadline from now.</p>
    </div>`;
  }

  function selectAdminUser(userId) {
    state.selectedUserId = userId;
    renderAdminRows();
    const user = state.adminUsers.find(candidate => candidate.id === userId);
    const detail = $('#adminDetail');
    if (!user || !detail) return;
    const safetyPanel = user.safety?.is_minor ? `<form id="guardianReviewForm" class="detail-section student-review-panel">
      <div class="student-review-heading"><div><span class="eyebrow"><i class="bx bx-shield-quarter"></i> Student safeguarding</span><h3>Guardian consent review</h3></div><span class="guardian-status ${escapeHtml(user.safety.guardian_consent_status || 'pending')}">${escapeHtml((user.safety.guardian_consent_status || 'pending').replaceAll('_', ' '))}</span></div>
      <dl class="detail-list">${detailPairs({student_age_group: Number(user.profile.age) <= 12 ? '3–12' : 'Under 13', guardian_name: user.safety.guardian_name, guardian_email: user.safety.guardian_email, guardian_relationship: user.safety.guardian_relationship, consent_declared: user.safety.guardian_consent_declared, messaging_rule: user.safety.minor_messaging, innovation_access: user.safety.innovation_access, verified_at: formatDate(user.safety.guardian_verified_at)})}</dl>
      <div class="admin-control-grid"><div class="field"><label>Consent decision</label><select name="status"><option value="pending" ${user.safety.guardian_consent_status === 'pending' ? 'selected' : ''}>Pending review</option><option value="verified" ${user.safety.guardian_consent_status === 'verified' ? 'selected' : ''}>Verified</option><option value="rejected" ${user.safety.guardian_consent_status === 'rejected' ? 'selected' : ''}>Rejected</option></select></div><div class="field full"><label>Specialist guardian-review notes</label><textarea name="guardian_notes" maxlength="2000">${escapeHtml(user.safety.guardian_notes || '')}</textarea></div></div>
      <div class="form-actions end"><button class="btn btn-primary" type="submit"><i class="bx bx-shield-quarter"></i> Save guardian review</button></div><div class="form-status" data-status></div>
    </form>` : '';
    const passwordResetPanel = user.role === 'admin' ? '' : `<section class="detail-section"><div class="account-security-note"><i class="bx bx-key"></i><div><strong>Forgotten password?</strong><span>Stored passwords are never displayed. Generate a temporary password and ask the member to change it after signing in.</span><button class="btn btn-sm" id="adminResetPassword" type="button"><i class="bx bx-key"></i> Generate temporary password</button><div id="adminResetPasswordResult" class="form-status" hidden></div></div></div></section>`;
    detail.innerHTML = `<div class="admin-detail-header"><div class="admin-detail-user">${avatarHtml(user)}<div><h2>${escapeHtml(user.profile.display_name)}</h2><p>@${escapeHtml(user.username)} · ${escapeHtml(user.email)}</p></div></div><div class="admin-detail-pills"><span>${escapeHtml(user.role)}</span><span>${escapeHtml(user.status)}</span><span>${Number(user.time_credits || 0)} credits</span></div></div><div class="admin-detail-body">
      <details class="detail-section admin-detail-subsection" open><summary><span><i class="bx bx-id-card"></i> Account record</span><i class="bx bx-chevron-down"></i></summary><dl class="detail-list">${detailPairs({id: user.id, username: user.username, email: user.email, phone_number: user.profile.phone_number, role: user.role, status: user.status, suspended_until: formatDate(user.suspended_until), suspension_reason: user.suspension_reason, verified: user.verified, time_credits: user.time_credits, moderation_label: user.moderation_label, created_at: formatDate(user.created_at), updated_at: formatDate(user.updated_at), last_login_at: formatDate(user.last_login_at), terms_accepted_at: formatDate(user.terms_accepted_at)})}</dl></details>
      <details class="detail-section admin-detail-subsection"><summary><span><i class="bx bx-user"></i> Complete profile</span><i class="bx bx-chevron-down"></i></summary><dl class="detail-list">${detailPairs(user.profile)}</dl></details>
      <details class="detail-section admin-detail-subsection"><summary><span><i class="bx bx-slider-alt"></i> Member preferences</span><i class="bx bx-chevron-down"></i></summary><dl class="detail-list">${detailPairs(user.preferences)}</dl></details>
      ${safetyPanel}
      <form id="adminControlForm" class="detail-section admin-control-section"><h3><i class="bx bx-edit-alt"></i> Administrative annotation and control</h3><div class="admin-control-grid"><div class="field"><label>Status</label><select name="status"><option value="active" ${user.status === 'active' ? 'selected' : ''}>Active</option><option value="suspended" ${user.status === 'suspended' ? 'selected' : ''}>Suspended</option></select></div><div class="field"><label>Moderation label</label><select name="moderation_label"><option value="none" ${user.moderation_label === 'none' ? 'selected' : ''}>None</option><option value="review" ${user.moderation_label === 'review' ? 'selected' : ''}>Needs review</option><option value="trusted" ${user.moderation_label === 'trusted' ? 'selected' : ''}>Trusted</option><option value="warning" ${user.moderation_label === 'warning' ? 'selected' : ''}>Warning</option></select></div><div class="field"><label>Time credits</label><input name="time_credits" type="number" min="0" max="100000" value="${Number(user.time_credits || 0)}"></div><label class="check-row"><input name="verified" type="checkbox" ${user.verified ? 'checked' : ''}><span><strong>Verified profile</strong><span>Show the verified account marker.</span></span></label><label class="check-row"><input name="messaging_restricted" type="checkbox" ${user.messaging_restricted ? 'checked' : ''} ${user.role === 'admin' ? 'disabled' : ''}><span><strong>Restrict messaging</strong><span>Pause this member’s ability to send messages.</span></span></label>${suspensionControls(user)}<div class="field full"><label>Private administrator notes</label><textarea name="admin_notes" maxlength="2000" placeholder="Only administrators can see these notes.">${escapeHtml(user.admin_notes || '')}</textarea></div></div><div class="form-actions end"><button class="btn btn-primary" type="submit"><i class="bx bx-save"></i> Save account controls</button></div><div class="form-status" data-status></div></form>
      ${passwordResetPanel}
      ${user.role === 'admin' ? '<section class="detail-section"><div class="account-security-note"><i class="bx bx-shield-quarter"></i><div><strong>Protected administrator</strong><span>The primary administrator cannot be suspended or deleted.</span></div></div></section>' : `<section class="detail-section"><div class="danger-box"><strong>Permanent account deletion</strong><p>Deletes this member record and cannot be reversed from the dashboard.</p><button class="btn btn-danger btn-sm" id="adminDeleteUser" type="button"><i class="bx bx-trash"></i> Delete member account</button></div></section>`}
    </div>`;
    $('#adminControlForm')?.addEventListener('submit', saveAdminControls);
    $('#guardianReviewForm')?.addEventListener('submit', saveGuardianReview);
    $('#adminControlForm [name="status"]')?.addEventListener('change', event => {
      const fields = $('[data-suspension-fields]', $('#adminControlForm'));
      if (fields) fields.hidden = event.currentTarget.value !== 'suspended';
    });
    $('#adminResetPassword')?.addEventListener('click', resetAdminUserPassword);
    $('#adminDeleteUser')?.addEventListener('click', deleteAdminUser);
  }

  async function saveGuardianReview(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const button = $('button[type="submit"]', form);
    loading(button, true, 'Saving review');
    clearStatus(form);
    try {
      const result = await api(`/api/admin/users/${encodeURIComponent(state.selectedUserId)}/guardian-consent`, {
        method: 'PATCH',
        body: {
          status: fields.get('status'),
          guardian_notes: fields.get('guardian_notes')
        }
      });
      const index = state.adminUsers.findIndex(user => user.id === result.user.id);
      if (index >= 0) state.adminUsers[index] = result.user;
      setStatus(form, 'Guardian consent review saved and the student was notified.', 'success');
      toast('Student safeguarding review saved.');
      await loadAdminData(true);
    } catch (error) {
      setStatus(form, error.message, 'error');
      loading(button, false);
    }
  }

  async function saveAdminControls(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const submit = $('button[type="submit"]', form);
    loading(submit, true, 'Saving controls');
    clearStatus(form);
    try {
      const payload = {
        status: data.get('status'),
        moderation_label: data.get('moderation_label'),
        time_credits: Number(data.get('time_credits')),
        verified: data.get('verified') === 'on',
        messaging_restricted: data.get('messaging_restricted') === 'on',
        admin_notes: data.get('admin_notes')
      };
      if (payload.status === 'suspended') {
        payload.suspension_minutes = suspensionMinutes(data);
        payload.suspension_reason = data.get('suspension_reason');
      }
      const result = await api(`/api/admin/users/${encodeURIComponent(state.selectedUserId)}`, {
        method: 'PATCH',
        body: payload
      });
      const index = state.adminUsers.findIndex(user => user.id === result.user.id);
      if (index >= 0) state.adminUsers[index] = result.user;
      setStatus(form, 'Account controls and private annotation saved.', 'success');
      toast('Administrator changes saved.');
      await loadAdminData(true);
      if ($('#adminControlForm')) setStatus($('#adminControlForm'), 'Account controls saved.', 'success');
    } catch (error) {
      setStatus(form, error.message, 'error');
      loading(submit, false);
    }
  }

  async function deleteAdminUser() {
    const user = state.adminUsers.find(candidate => candidate.id === state.selectedUserId);
    if (!user || !confirm(
        `Permanently delete ${user.profile.display_name}'s member account? This cannot be undone.`)) return;
    const button = $('#adminDeleteUser');
    loading(button, true, 'Deleting');
    try {
      const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'DELETE'
      });
      state.selectedUserId = null;
      toast(result.message);
      await loadAdminData();
      $('#adminDetail').innerHTML =
        '<div class="admin-detail-empty"><i class="bx bx-check-circle"></i><strong>Account deleted</strong><p>Select another account to continue.</p></div>';
    } catch (error) {
      toast(error.message, 'error');
      loading(button, false);
    }
  }

  async function resetAdminUserPassword() {
    const user = state.adminUsers.find(candidate => candidate.id === state.selectedUserId);
    if (!user || !confirm(`Generate a temporary password for ${user.profile.display_name}? Their current sessions will be signed out.`)) return;
    const button = $('#adminResetPassword');
    const output = $('#adminResetPasswordResult');
    loading(button, true, 'Generating');
    try {
      const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}/password`, {method: 'POST'});
      output.hidden = false;
      output.className = 'form-status show success';
      output.innerHTML = `<strong>Temporary password — copy it now:</strong> <code>${escapeHtml(result.temporary_password)}</code><br><small>It is not stored or shown again. Ask the member to change it after signing in.</small>`;
      toast('Temporary password generated once.');
    } catch (error) {
      if (output) { output.hidden = false; output.className = 'form-status show error'; output.textContent = error.message; }
      toast(error.message, 'error');
    } finally {
      loading(button, false);
    }
  }

  function renderAudit() {
    const host = $('#adminAudit');
    if (!host) return;
    const query = ($('#adminAuditSearch')?.value || '').trim().toLowerCase();
    const entries = state.audit.filter(entry => !query || `${entry.actor_name} ${entry.action} ${entry.details}`.toLowerCase().includes(query));
    host.innerHTML = entries.map(entry =>
      `<article class="audit-item"><i class="bx ${entry.action.includes('deleted') ? 'bx-trash' : entry.action.includes('signed') ? 'bx-log-in-circle' : entry.action.includes('registered') ? 'bx-user-plus' : 'bx-edit-alt'}"></i><div><strong>${escapeHtml(entry.actor_name)} · ${escapeHtml(entry.action.replaceAll('_', ' '))}</strong><p>${escapeHtml(entry.details)}</p></div><time>${escapeHtml(formatDate(entry.created_at))}</time></article>`
      ).join('') || '<div class="admin-detail-empty">No recorded activity.</div>';
  }

  async function loadAdminData(preserveDetail = false) {
    try {
      const result = await api('/api/admin/overview');
      state.adminUsers = result.users;
      state.audit = result.audit_log;
      state.adminAnalytics = result.analytics || {};
      renderAdminStats(result.stats, state.adminAnalytics);
      renderAdminCharts();
      renderAdminRows();
      renderMemberAnalytics();
      renderAuditAnalytics();
      renderStaticAdminAnalytics();
      renderAudit();
      renderAdminMessageRecipients();
      if (preserveDetail && state.selectedUserId) selectAdminUser(state.selectedUserId);
    } catch (error) {
      toast(error.message, 'error');
      if (error.status === 401 || error.status === 403) location.href = 'login.html';
    }
  }

  function adminPresencePageLabel(value) {
    const raw = String(value || 'app').split('/').pop() || 'app';
    const withoutExtension = raw.replace(/\.html$/i, '');
    return withoutExtension.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function adminPresenceAgeLabel(user) {
    const seconds = Number(user?.seconds_since_seen);
    if (!Number.isFinite(seconds)) return formatDate(user?.last_seen_at);
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return formatDate(user?.last_seen_at);
  }

  function filteredAdminPresence(users = state.adminPresence, searchId = 'adminPresenceSearch') {
    const query = ($('#' + searchId)?.value || '').trim().toLowerCase();
    return (Array.isArray(users) ? users : []).filter(user => {
      if (!query) return true;
      const haystack = [
        user.display_name, user.username, user.role, adminPresencePageLabel(user.page_path)
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  function renderAdminPresence() {
    const allUsers = Array.isArray(state.adminPresence) ? state.adminPresence : [];
    const users = filteredAdminPresence();
    const memberCount = allUsers.filter(user => user.role !== 'admin').length;
    const adminCount = allUsers.filter(user => user.role === 'admin').length;
    const count = $('#adminPresenceCount');
    const memberCountNode = $('#adminPresenceMemberCount');
    const adminCountNode = $('#adminPresenceAdminCount');
    const resultCount = $('#adminPresenceResultCount');
    if (count) count.textContent = String(allUsers.length);
    if (memberCountNode) memberCountNode.textContent = String(memberCount);
    if (adminCountNode) adminCountNode.textContent = String(adminCount);
    if (resultCount) resultCount.textContent = `${users.length} ${users.length === 1 ? 'user' : 'users'}`;
    const host = $('#adminPresenceList');
    if (!host) return;
    host.innerHTML = users.map(user => {
      const displayName = user.display_name || user.username || 'SwapLabs user';
      const roleLabel = user.role === 'admin' ? 'Administrator' : 'Member';
      const pageLabel = adminPresencePageLabel(user.page_path);
      return '<article class="admin-presence-card">' +
        '<div class="admin-presence-card-head">' +
          avatarHtml(user, 'admin-presence-avatar') +
          '<div class="admin-presence-identity"><strong>' + escapeHtml(displayName) + '</strong><span>@' + escapeHtml(user.username || '') + ' · ' + escapeHtml(roleLabel) + '</span></div>' +
          '<span class="admin-presence-status"><i class="bx bxs-circle" aria-hidden="true"></i> Online</span>' +
        '</div>' +
        '<div class="admin-presence-meta"><span><small>Current page</small><strong>' + escapeHtml(pageLabel) + '</strong></span><time datetime="' + escapeHtml(user.last_seen_at || '') + '">' + escapeHtml(adminPresenceAgeLabel(user)) + '</time></div>' +
      '</article>';
    }).join('') || '<div class="admin-presence-empty"><i class="bx bx-user-x"></i><strong>No users are active right now.</strong><span>Signed-in users appear here after their next heartbeat.</span></div>';
  }

  function adminPresenceTodayAgeLabel(user) {
    const seconds = Number(user?.seconds_since_seen);
    if (!Number.isFinite(seconds)) return formatDate(user?.last_seen_at);
    if (seconds < 5) return user?.is_online ? 'Online now' : 'Just now';
    if (seconds < 60) return String(seconds) + 's ago';
    if (seconds < 3600) return String(Math.floor(seconds / 60)) + 'm ago';
    if (seconds < 86400) return String(Math.floor(seconds / 3600)) + 'h ago';
    return formatDate(user?.last_seen_at);
  }

  function renderAdminPresenceToday() {
    const allUsers = Array.isArray(state.adminPresenceToday) ? state.adminPresenceToday : [];
    const users = filteredAdminPresence(allUsers, 'adminPresenceTodaySearch');
    const onlineNowCount = allUsers.filter(user => user.is_online).length;
    const memberCount = allUsers.filter(user => user.role !== 'admin').length;
    const count = $('#adminPresenceTodayCount');
    const onlineNow = $('#adminPresenceTodayNowCount');
    const memberCountNode = $('#adminPresenceTodayMemberCount');
    const resultCount = $('#adminPresenceTodayResultCount');
    if (count) count.textContent = String(allUsers.length);
    if (onlineNow) onlineNow.textContent = String(onlineNowCount);
    if (memberCountNode) memberCountNode.textContent = String(memberCount);
    if (resultCount) resultCount.textContent = String(users.length) + ' ' + (users.length === 1 ? 'user' : 'users');
    const host = $('#adminPresenceTodayList');
    if (!host) return;
    host.innerHTML = users.map(user => {
      const displayName = user.display_name || user.username || 'SwapLabs user';
      const roleLabel = user.role === 'admin' ? 'Administrator' : 'Member';
      const pageLabel = adminPresencePageLabel(user.page_path);
      const isOnline = user.is_online === true;
      const statusLabel = isOnline ? 'Online now' : 'Seen today';
      const statusClass = isOnline ? '' : ' is-away';
      const statusIcon = isOnline ? 'bxs-circle' : 'bx-history';
      const pageCaption = isOnline ? 'Current page' : 'Last page';
      return '<article class="admin-presence-card">' +
        '<div class="admin-presence-card-head">' +
          avatarHtml(user, 'admin-presence-avatar') +
          '<div class="admin-presence-identity"><strong>' + escapeHtml(displayName) + '</strong><span>@' + escapeHtml(user.username || '') + ' · ' + escapeHtml(roleLabel) + '</span></div>' +
          '<span class="admin-presence-status' + statusClass + '"><i class="bx ' + statusIcon + '" aria-hidden="true"></i> ' + statusLabel + '</span>' +
        '</div>' +
        '<div class="admin-presence-meta"><span><small>' + pageCaption + '</small><strong>' + escapeHtml(pageLabel) + '</strong></span><time datetime="' + escapeHtml(user.last_seen_at || '') + '">' + escapeHtml(adminPresenceTodayAgeLabel(user)) + '</time></div>' +
      '</article>';
    }).join('') || '<div class="admin-presence-empty"><i class="bx bx-calendar-x"></i><strong>No users have been active today.</strong><span>Signed-in users will appear here after their first heartbeat today.</span></div>';
  }

  let adminPresenceRequest = 0;
  let adminPresenceTodayRequest = 0;
  let adminPresenceTimer = null;
  async function loadAdminPresence() {
    const listHost = $('#adminPresenceList');
    const status = $('#adminPresenceStatus');
    if (!listHost) return;
    const requestId = ++adminPresenceRequest;
    if (!state.adminPresence.length) listHost.innerHTML = '<div class="admin-presence-empty"><i class="bx bx-loader-alt bx-spin"></i><span>Loading current users…</span></div>';
    if (status) status.textContent = 'Checking the last hour…';
    try {
      const result = await api('/api/admin/presence');
      if (requestId !== adminPresenceRequest) return;
      state.adminPresence = Array.isArray(result.users) ? result.users : [];
      state.adminPresenceCheckedAt = result.checked_at || '';
      renderAdminPresence();
      const checkedAt = state.adminPresenceCheckedAt ? new Date(state.adminPresenceCheckedAt) : null;
      const checkedLabel = checkedAt && !Number.isNaN(checkedAt.getTime()) ? checkedAt.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit'}) : 'just now';
      if (status) status.textContent = 'Live · active heartbeat in the last hour';
      const updated = $('#adminPresenceLastUpdated');
      if (updated) updated.textContent = 'Checked ' + checkedLabel;
    } catch (error) {
      if (requestId !== adminPresenceRequest) return;
      state.adminPresence = [];
      renderAdminPresence();
      if (status) status.textContent = error.message;
      const updated = $('#adminPresenceLastUpdated');
      if (updated) updated.textContent = 'Could not refresh';
    }
  }

  async function loadAdminPresenceToday() {
    const listHost = $('#adminPresenceTodayList');
    const status = $('#adminPresenceTodayStatus');
    if (!listHost) return;
    const requestId = ++adminPresenceTodayRequest;
    if (!state.adminPresenceToday.length) listHost.innerHTML = '<div class="admin-presence-empty"><i class="bx bx-loader-alt bx-spin"></i><span>Loading today’s users…</span></div>';
    if (status) status.textContent = 'Checking today’s activity…';
    try {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const result = await api('/api/admin/presence/today?since=' + encodeURIComponent(since.toISOString()));
      if (requestId !== adminPresenceTodayRequest) return;
      state.adminPresenceToday = Array.isArray(result.users) ? result.users : [];
      state.adminPresenceTodayCheckedAt = result.checked_at || '';
      renderAdminPresenceToday();
      const checkedAt = state.adminPresenceTodayCheckedAt ? new Date(state.adminPresenceTodayCheckedAt) : null;
      const checkedLabel = checkedAt && !Number.isNaN(checkedAt.getTime()) ? checkedAt.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit'}) : 'just now';
      if (status) status.textContent = 'Live · activity since local midnight';
      const updated = $('#adminPresenceTodayLastUpdated');
      if (updated) updated.textContent = 'Checked ' + checkedLabel;
    } catch (error) {
      if (requestId !== adminPresenceTodayRequest) return;
      state.adminPresenceToday = [];
      renderAdminPresenceToday();
      if (status) status.textContent = error.message;
      const updated = $('#adminPresenceTodayLastUpdated');
      if (updated) updated.textContent = 'Could not refresh';
    }
  }

  const workConfig = {
    reports: {source:'operations', key:'reports'}, disputes: {source:'operations', key:'disputes'},
    submissions: {source:'content'}, ideas: {source:'content', key:'ideas'},
    activity: {source:'operations', key:'activity'}, ledger: {source:'operations', key:'ledger'},
    sessions: {source:'operations', key:'events'}
  };
  const contentKeys = {contacts:'contact_messages', complaints:'complaints', feedback:'feedback', workshops:'workshops', registrations:'workshop_registrations'};
  const memberName = user => user?.profile?.display_name || user?.display_name || user?.username || 'Unknown member';
  const workRoot = key => $(`[data-workspace="${key}"]`);
  function workItems(key) {
    const config = workConfig[key];
    const data = config.source === 'content' ? state.adminContent : state.adminOperations;
    const collection = $('[data-work-collection]', workRoot(key))?.value;
    return (data?.[config.key || contentKeys[collection]] || []).map(item => ({...item, id:item.id || item.user?.id}));
  }
  function workTitle(key, item) {
    if (key === 'reports') return `${item.category || 'Safety report'} · ${memberName(item.reported_user)}`;
    if (key === 'disputes') return `${memberName(item.user)} · ${item.reason || 'Payment dispute'}`;
    if (key === 'activity') return memberName(item.user);
    if (key === 'ledger') return item.description || item.type || 'Credit entry';
    return item.title || item.subject || item.name || item.email || memberName(item.user);
  }
  function workStatus(key, item) {
    if (key === 'activity') return item.open_reports ? 'needs_review' : item.user?.status || 'active';
    if (key === 'sessions' && item.points_review?.status === 'pending') return 'points_review_pending';
    return item.status || item.type || 'new';
  }
  function filteredWorkItems(key) {
    const root = workRoot(key);
    const query = $('[data-work-search]', root).value.trim().toLowerCase();
    const status = $('[data-work-status]', root).value;
    const sort = $('[data-work-sort]', root).value;
    return workItems(key).filter(item => (status === 'all' || workStatus(key,item) === status) && (!query || JSON.stringify(item).toLowerCase().includes(query))).sort((a,b) => {
      if (sort === 'name') return workTitle(key,a).localeCompare(workTitle(key,b));
      const date = item => item.created_at || item.last_message_at || item.user?.created_at || '';
      return sort === 'oldest' ? date(a).localeCompare(date(b)) : date(b).localeCompare(date(a));
    });
  }

  function sectionAnalytics(key, items) {
    const statusCounts = values => Object.entries(values.reduce((counts, value) => {
      const label = String(value || 'Not set').replaceAll('_', ' ');
      counts[label] = (counts[label] || 0) + 1;
      return counts;
    }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({label, value}));
    const count = predicate => items.filter(predicate).length;
    const sum = getter => items.reduce((total, item) => total + (Number(getter(item)) || 0), 0);
    const metrics = [];
    let bars = statusCounts(items.map(item => workStatus(key, item)));
    let title = 'Section snapshot';
    let description = 'Live counts for this administration queue.';
    if (key === 'reports') {
      title = 'Safety workload';
      description = 'Only report status and evidence signals are shown here.';
      metrics.push({label: 'Open reports', value: count(item => !['resolved', 'dismissed'].includes(item.status))}, {label: 'Reviewing', value: count(item => item.status === 'reviewing')}, {label: 'Resolved', value: count(item => item.status === 'resolved')}, {label: 'Evidence items', value: sum(item => item.evidence?.length)});
    } else if (key === 'disputes') {
      title = 'Credit dispute workload';
      description = 'Payment decisions and credits currently at risk.';
      metrics.push({label: 'Open disputes', value: count(item => !['resolved', 'dismissed'].includes(item.status))}, {label: 'Approved', value: count(item => ['approved', 'resolved'].includes(item.status))}, {label: 'Denied', value: count(item => ['denied', 'dismissed'].includes(item.status))}, {label: 'Credits at risk', value: sum(item => Math.abs(item.ledger_entry?.amount || 0))});
    } else if (key === 'submissions') {
      const collection = $('[data-work-collection]', workRoot(key))?.value || 'submissions';
      title = `${collection.replaceAll('_', ' ')} intake`;
      description = 'Counts and status distribution for the selected submission collection.';
      metrics.push({label: 'Total records', value: items.length}, {label: 'New / open', value: count(item => ['new', 'received', 'registered', 'scheduled'].includes(item.status))}, {label: 'In review', value: count(item => ['reviewing', 'pending'].includes(item.status))}, {label: 'Closed / done', value: count(item => ['closed', 'resolved', 'completed', 'attended'].includes(item.status))});
    } else if (key === 'ideas') {
      title = 'Innovation pipeline';
      description = 'Review stage, safety review, and funding signals for ideas.';
      metrics.push({label: 'Total ideas', value: items.length}, {label: 'Needs review', value: count(item => ['under_review', 'specialist_review', 'seeking_support'].includes(item.status))}, {label: 'Published / pilot', value: count(item => ['published', 'funded', 'pilot'].includes(item.status))}, {label: 'Funding requested', value: sum(item => item.funding_needed)});
    } else if (key === 'activity') {
      title = 'Member activity pulse';
      description = 'Operational activity totals for the members in this queue.';
      metrics.push({label: 'Members tracked', value: items.length}, {label: 'Needs review', value: count(item => Number(item.open_reports) > 0)}, {label: 'Messages sent', value: sum(item => item.messages_sent)}, {label: 'Calendar events', value: sum(item => item.calendar_events)});
      bars = [{label: 'Messages', value: sum(item => item.messages_sent)}, {label: 'Reports', value: sum(item => item.reports_received)}, {label: 'Events', value: sum(item => item.calendar_events)}, {label: 'Ledger', value: sum(item => item.ledger_entries)}];
    } else if (key === 'ledger') {
      const creditsIn = sum(item => Math.max(0, item.amount));
      const creditsOut = sum(item => Math.max(0, -(Number(item.amount) || 0)));
      title = 'Credit flow';
      description = 'Only ledger movement from the selected records is shown here.';
      metrics.push({label: 'Entries', value: items.length}, {label: 'Credits in', value: creditsIn}, {label: 'Credits out', value: creditsOut}, {label: 'Net change', value: creditsIn - creditsOut});
      bars = [{label: 'Credits in', value: creditsIn}, {label: 'Credits out', value: creditsOut}];
    } else if (key === 'sessions') {
      title = 'Session pipeline';
      description = 'Scheduling outcomes for sessions in the administration record.';
      metrics.push({label: 'Scheduled', value: count(item => ['scheduled', 'upcoming', 'confirmed'].includes(item.status))}, {label: 'Completed', value: count(item => item.status === 'completed')}, {label: 'Cancelled', value: count(item => item.status === 'cancelled')}, {label: 'Hours listed', value: sum(item => item.duration_hours || item.hours)});
    }
    return {title, description, metrics, bars: bars.length ? bars : [{label: 'No data yet', value: 0}]};
  }

  function renderAnalyticsCard(host, snapshot) {
    const max = Math.max(1, ...snapshot.bars.map(item => Number(item.value) || 0));
    host.innerHTML = `<div class="admin-section-analytics-head"><div><span class="eyebrow">Section analytics</span><h3>${escapeHtml(snapshot.title)}</h3><p>${escapeHtml(snapshot.description)}</p></div><span class="admin-live-pill"><i class="bx bx-pulse"></i> Live</span></div><div class="admin-section-metric-grid">${snapshot.metrics.map(metric => `<article><span>${escapeHtml(metric.label)}</span><strong>${Number(metric.value || 0).toLocaleString()}</strong></article>`).join('')}</div><div class="admin-section-mini-chart" role="img" aria-label="${escapeHtml(snapshot.title)} chart">${snapshot.bars.map(item => { const value = Number(item.value) || 0; const height = value ? Math.max(10, Math.round(value / max * 100)) : 6; return `<div class="admin-section-bar"><span>${escapeHtml(item.label)}</span><i style="height:${height}%"></i><b>${value.toLocaleString()}</b></div>`; }).join('')}</div>`;
  }

  function renderSectionAnalytics(key, items) {
    const root = workRoot(key);
    if (!root) return;
    let host = $('[data-work-analytics]', root);
    if (!host) {
      const filters = $('.admin-work-filters', root);
      if (!filters) return;
      filters.insertAdjacentHTML('beforebegin', '<section class="admin-section-analytics" data-work-analytics></section>');
      host = $('[data-work-analytics]', root);
    }
    const snapshot = sectionAnalytics(key, items);
    renderAnalyticsCard(host, snapshot);
  }

  function renderMemberAnalytics() {
    const section = $('[data-admin-section="records"]');
    if (!section) return;
    let host = $('[data-member-analytics]', section);
    if (!host) {
      const toolbar = $('.admin-toolbar', section);
      if (!toolbar) return;
      toolbar.insertAdjacentHTML('beforebegin', '<section class="admin-section-analytics" data-member-analytics></section>');
      host = $('[data-member-analytics]', section);
    }
    const members = state.adminUsers.filter(user => user.role !== 'admin');
    const statuses = Object.entries(members.reduce((counts, user) => { const label = user.status || 'Not set'; counts[label] = (counts[label] || 0) + 1; return counts; }, {})).map(([label, value]) => ({label, value}));
    const profileReady = members.filter(user => (window.SwapLabsProfileGate?.completeness?.(user) || 0) >= 70).length;
    renderAnalyticsCard(host, {
      title: 'Member account health',
      description: 'Only account status, verification, and credit signals are shown in this section.',
      metrics: [
        {label: 'Member accounts', value: members.length},
        {label: 'Active', value: members.filter(user => user.status === 'active').length},
        {label: 'Verified', value: members.filter(user => user.verified).length},
        {label: 'Credits held', value: members.reduce((total, user) => total + (Number(user.time_credits) || 0), 0)}
      ],
      bars: [
        ...statuses,
        {label: 'Profile ready', value: profileReady},
        {label: 'With phone', value: members.filter(user => user.profile?.phone_number).length}
      ].slice(0, 5)
    });
  }

  function renderAuditAnalytics() {
    const section = $('[data-admin-section="audit"]');
    if (!section) return;
    let host = $('[data-audit-analytics]', section);
    if (!host) {
      const search = $('.admin-section-search', section);
      if (!search) return;
      search.insertAdjacentHTML('beforebegin', '<section class="admin-section-analytics" data-audit-analytics></section>');
      host = $('[data-audit-analytics]', section);
    }
    const actionCounts = Object.entries(state.audit.reduce((counts, entry) => { const label = String(entry.action || 'other').replaceAll('_', ' '); counts[label] = (counts[label] || 0) + 1; return counts; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({label, value}));
    renderAnalyticsCard(host, {
      title: 'Audit activity',
      description: 'Recent administrator and account actions recorded by the platform.',
      metrics: [
        {label: 'Recorded actions', value: state.audit.length},
        {label: 'Account changes', value: state.audit.filter(entry => /account|user|profile|credit/i.test(entry.action || '')).length},
        {label: 'Sign-ins', value: state.audit.filter(entry => /login|sign/i.test(entry.action || '')).length},
        {label: 'Destructive actions', value: state.audit.filter(entry => /delete|suspend|remove/i.test(entry.action || '')).length}
      ],
      bars: actionCounts.length ? actionCounts : [{label: 'No data yet', value: 0}]
    });
  }

  const supportClosedStatuses = new Set(['resolved', 'closed', 'dismissed', 'archived']);
  const adminSupportLabels = {
    contacts: {label: 'Contacts', icon: 'bx-envelope', singular: 'contact request'},
    complaints: {label: 'Complaints', icon: 'bx-message-square-error', singular: 'complaint'},
    feedback: {label: 'Feedback', icon: 'bx-message-square-dots', singular: 'feedback record'},
    safety: {label: 'Safety', icon: 'bx-shield-quarter', singular: 'safety report'}
  };
  const isAdminSafetySubmission = item => {
    const text = [item?.request_type, item?.category, item?.topic, item?.subject, item?.details, item?.message]
      .map(value => String(value || '').trim().toLowerCase()).join(' ');
    return String(item?.request_type || '').trim().toLowerCase() === 'safety' || /\b(safety|harassment|fraud|impersonation|threat|unsafe|student safety)\b/.test(text);
  };
  const adminSupportRecords = key => {
    const content = state.adminContent || {};
    if (key === 'contacts') return [...(content.contact_messages || [])];
    if (key === 'complaints') return (content.complaints || []).filter(item => !isAdminSafetySubmission(item));
    if (key === 'feedback') return [...(content.feedback || [])];
    if (key === 'safety') {
      const complaints = (content.complaints || []).filter(isAdminSafetySubmission).map(item => ({...item, support_source: 'Safety concern'}));
      const reports = (state.adminOperations?.reports || []).map(item => ({...item, support_source: 'Message safety report'}));
      return [...complaints, ...reports];
    }
    return [];
  };
  const adminSupportIsOpen = (item, key) => {
    const status = String(item?.status || '').toLowerCase();
    if (key === 'contacts') return ['new', 'reviewing', 'in_progress', 'waiting'].includes(status);
    if (key === 'feedback') return !['published', 'archived'].includes(status);
    return !supportClosedStatuses.has(status);
  };
  const adminSupportTitle = (key, item) => {
    if (key === 'feedback') return item.title || item.subject || 'Feedback record';
    return item.subject || item.topic || item.category || item.reason || item.title || item.type || `${adminSupportLabels[key]?.label || 'Support'} record`;
  };
  const adminSupportDetails = item => {
    const omit = new Set(['password_hash', 'admin_id_hash']);
    const scalar = {};
    const nested = {};
    Object.entries(item || {}).forEach(([field, value]) => {
      if (omit.has(field) || value === undefined) return;
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) scalar[field] = field.endsWith('_at') ? formatDate(value) : value;
      else nested[field] = value;
    });
    return {scalar, nested};
  };
  function renderAdminSupportQueue(key) {
    const host = $('[data-admin-support-queue]');
    const meta = adminSupportLabels[key];
    if (!host || !meta) return;
    state.adminSupportSelection = key;
    const records = adminSupportRecords(key);
    const openCount = records.filter(item => adminSupportIsOpen(item, key)).length;
    const recordMarkup = records.map((item, index) => {
      const {scalar, nested} = adminSupportDetails(item);
      const rawNested = Object.keys(nested).length ? `<details class="admin-support-record-more"><summary>Additional submitted details</summary><pre>${escapeHtml(JSON.stringify(nested, null, 2))}</pre></details>` : '';
      return `<article class="admin-support-record"><div class="admin-support-record-head"><div><span class="eyebrow"><i class="bx ${meta.icon}"></i> ${escapeHtml(meta.label)} ${index + 1}</span><h4>${escapeHtml(adminSupportTitle(key, item))}</h4></div><span class="status-pill">${escapeHtml(String(item.status || 'received').replaceAll('_', ' '))}</span></div><dl class="detail-list">${detailPairs(scalar)}</dl>${rawNested}</article>`;
    }).join('');
    host.hidden = false;
    host.innerHTML = `<div class="admin-support-queue-head"><div><span class="eyebrow">Complete queue</span><h3><i class="bx ${meta.icon}"></i> All ${escapeHtml(meta.label.toLowerCase())}</h3><p>Showing every ${escapeHtml(meta.singular)} currently stored, including closed and previously reviewed records. ${records.length} total · ${openCount} active.</p></div><button class="btn btn-sm" type="button" data-admin-support-close><i class="bx bx-x"></i> Hide details</button></div><div class="admin-support-record-list">${recordMarkup || `<div class="admin-detail-empty"><i class="bx ${meta.icon}"></i><strong>No ${escapeHtml(meta.label.toLowerCase())} yet</strong><p>Nothing has been submitted to this queue.</p></div>`}</div>`;
    $$('[data-admin-support-key]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.adminSupportKey === key)));
  }
  function bindAdminSupportAnalytics() {
    const analytics = $('[data-static-analytics="support"]');
    const queue = $('[data-admin-support-queue]');
    if (!analytics || analytics.dataset.supportQueueBound) return;
    analytics.dataset.supportQueueBound = 'true';
    analytics.addEventListener('click', event => {
      const bar = event.target.closest('[data-admin-support-key]');
      if (bar) renderAdminSupportQueue(bar.dataset.adminSupportKey);
    });
    queue?.addEventListener('click', event => {
      if (!event.target.closest('[data-admin-support-close]')) return;
      state.adminSupportSelection = '';
      queue.hidden = true;
      queue.innerHTML = '';
      $$('[data-admin-support-key]').forEach(button => button.setAttribute('aria-pressed', 'false'));
    });
  }

  function renderCompactAnalytics(host, snapshot) {
    if (!host) return;
    const bars = (snapshot.bars || []).slice(0, 5);
    const maximum = Math.max(1, ...bars.map(item => Number(item.value) || 0));
    const ring = snapshot.ring || {value: 0, total: 1, label: 'coverage', note: 'No activity recorded yet'};
    const ringPercent = Math.min(100, Math.max(0, Math.round((Number(ring.value) || 0) / Math.max(1, Number(ring.total) || 1) * 100)));
    const metricValue = value => typeof value === 'number' ? value.toLocaleString() : String(value ?? '0');
    const interactiveBars = snapshot.interactiveBars === true;
    const barsMarkup = bars.map((item, index) => {
      const value = Number(item.value) || 0;
      const height = value ? Math.max(12, Math.round(value / maximum * 100)) : 5;
      const active = interactiveBars && snapshot.activeKey === item.key ? ' is-active' : '';
      const tag = interactiveBars ? 'button' : 'div';
      const attributes = interactiveBars ? ` type="button" data-admin-support-key="${escapeHtml(item.key)}" aria-pressed="${snapshot.activeKey === item.key}" aria-label="Show all ${escapeHtml(item.label.toLowerCase())} records"` : '';
      return `<${tag} class="admin-mini-bar${interactiveBars ? ' is-clickable' : ''}${active}"${attributes} style="--bar-height:${height}%;--bar-color:${chartColors[index % chartColors.length]}"><span>${escapeHtml(item.label)}</span><i></i><b>${value.toLocaleString()}</b></${tag}>`;
    }).join('');
    const barsRole = interactiveBars ? 'role="group" aria-label="Click a support bar to see every submitted record"' : `role="img" aria-label="${escapeHtml(snapshot.title)} bar chart"`;
    host.innerHTML = `<div class="admin-static-analytics-head"><div><span class="eyebrow">Section analytics</span><h3>${escapeHtml(snapshot.title)}</h3><p>${escapeHtml(snapshot.description)}</p></div><span class="admin-live-pill"><i class="bx bx-pulse"></i> Live snapshot</span></div><div class="admin-static-metric-grid">${(snapshot.metrics || []).map(metric => `<article><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metricValue(metric.value))}</strong></article>`).join('')}</div><div class="admin-static-visual-grid"><article class="admin-mini-visual"><div class="admin-mini-visual-head"><div><strong>${escapeHtml(snapshot.chartTitle || 'Signal mix')}</strong><span>${escapeHtml(snapshot.chartDescription || 'Current distribution')}</span></div><i class="bx bx-bar-chart-alt-2"></i></div><div class="admin-mini-bars" ${barsRole}>${barsMarkup}</div></article><article class="admin-mini-visual admin-mini-ring-panel"><div class="admin-mini-visual-head"><div><strong>${escapeHtml(ring.title || 'Coverage')}</strong><span>${escapeHtml(ring.note || 'Share of the current audience')}</span></div><i class="bx bx-doughnut-chart"></i></div><div class="admin-mini-ring" style="--ring-progress:${ringPercent * 3.6}deg"><span><strong>${ringPercent}%</strong><small>${escapeHtml(ring.label || 'covered')}</small></span></div><small class="admin-mini-ring-note">${escapeHtml(ring.detail || `${metricValue(ring.value)} of ${metricValue(ring.total)}`)}</small></article></div>`;
  }

  function renderStaticAdminAnalytics() {
    const members = state.adminUsers.filter(user => user.role !== 'admin');
    const analytics = state.adminAnalytics || {};
    const content = analytics.content || {};
    const profileScore = user => window.SwapLabsProfileGate?.completeness?.(user) || 0;
    const active = members.filter(user => user.status === 'active').length;
    const verified = members.filter(user => user.verified).length;
    const withTeach = members.filter(user => list(user.profile?.skills_to_teach).length).length;
    const withLearn = members.filter(user => list(user.profile?.skills_to_learn).length).length;
    const engaged = Number(analytics.active_last_30_days || analytics.engaged_members || 0);
    const readyProfiles = members.filter(user => profileScore(user) >= 70).length;
    const withPhone = members.filter(user => user.profile?.phone_number).length;
    const withLocation = members.filter(user => user.profile?.country || user.profile?.city).length;
    const minors = members.filter(user => user.safety?.is_minor || Number(user.profile?.age) < 13).length;
    const averageCompleteness = members.length ? Math.round(members.reduce((sum, user) => sum + profileScore(user), 0) / members.length) : 0;

    renderCompactAnalytics($('[data-static-analytics="create-account"]'), {
      title: 'Provisioning pulse',
      description: 'A quick read on profile readiness and safe account setup before you create another member ID.',
      metrics: [{label: 'Member accounts', value: members.length}, {label: 'Ready profiles', value: readyProfiles}, {label: 'Verified', value: verified}, {label: 'Under 13', value: minors}],
      chartTitle: 'Onboarding signals', chartDescription: 'Details that make matching safer',
      bars: [{label: 'Ready', value: readyProfiles}, {label: 'Phone', value: withPhone}, {label: 'Location', value: withLocation}, {label: 'Teaching', value: withTeach}, {label: 'Learning', value: withLearn}],
      ring: {title: 'Profile readiness', label: 'ready', value: readyProfiles, total: members.length, note: 'members at 70%+ completeness', detail: `${averageCompleteness}% average completeness`}
    });

    renderCompactAnalytics($('[data-static-analytics="messages"]'), {
      title: 'Conversation pulse',
      description: 'See whether the community has enough active, skill-complete profiles to support useful outreach.',
      metrics: [{label: 'Active members', value: active}, {label: 'Engaged recently', value: engaged}, {label: 'Conversations', value: Number(content.conversations || 0)}, {label: 'With skills', value: Math.max(withTeach, withLearn)}],
      chartTitle: 'Audience signals', chartDescription: 'Reachable people and exchange intent',
      bars: [{label: 'Active', value: active}, {label: 'Engaged', value: engaged}, {label: 'Teach', value: withTeach}, {label: 'Learn', value: withLearn}, {label: 'Verified', value: verified}],
      ring: {title: 'Recent engagement', label: 'active', value: engaged, total: members.length, note: 'members active in the latest window', detail: `${engaged} of ${members.length} members`}
    });

    const subscribers = state.newsletterSubscribers || [];
    const now = Date.now();
    const newsletterBuckets = [{label: '0–7 days', value: 0}, {label: '8–30 days', value: 0}, {label: '31+ days', value: 0}, {label: 'Undated', value: 0}];
    subscribers.forEach(item => {
      const time = new Date(item.created_at).getTime();
      if (!Number.isFinite(time)) newsletterBuckets[3].value += 1;
      else {
        const age = Math.max(0, (now - time) / 86400000);
        newsletterBuckets[age <= 7 ? 0 : age <= 30 ? 1 : 2].value += 1;
      }
    });
    const recentSubscribers = subscribers.filter(item => { const time = new Date(item.created_at).getTime(); return Number.isFinite(time) && now - time <= 30 * 86400000; }).length;
    renderCompactAnalytics($('[data-static-analytics="newsletter"]'), {
      title: 'Audience growth',
      description: 'A small, useful picture of list momentum before you copy the current addresses for outreach.',
      metrics: [{label: 'Subscribers', value: subscribers.length}, {label: 'Last 30 days', value: recentSubscribers}, {label: 'Member base', value: members.length}, {label: 'List coverage', value: members.length ? `${Math.round(subscribers.length / members.length * 100)}%` : '0%'}],
      chartTitle: 'Signup recency', chartDescription: 'Subscribers grouped by signup window',
      bars: newsletterBuckets,
      ring: {title: 'Member coverage', label: 'covered', value: subscribers.length, total: members.length, note: 'subscriber list compared with members', detail: `${subscribers.length} subscribers / ${members.length} members`}
    });

    const contentStats = state.adminContent?.stats || {};
    const supportRecords = {
      contacts: adminSupportRecords('contacts'),
      complaints: adminSupportRecords('complaints'),
      feedback: adminSupportRecords('feedback'),
      safety: adminSupportRecords('safety')
    };
    const openRecords = key => supportRecords[key].filter(item => adminSupportIsOpen(item, key)).length;
    const supportBars = [
      {label: 'Contacts', key: 'contacts', value: Number(contentStats.new_contacts ?? openRecords('contacts'))},
      {label: 'Complaints', key: 'complaints', value: Number(contentStats.open_complaints ?? openRecords('complaints'))},
      {label: 'Feedback', key: 'feedback', value: supportRecords.feedback.length},
      {label: 'Safety', key: 'safety', value: Number(contentStats.safety_reports ?? openRecords('safety'))}
    ];
    const supportTotal = supportBars.reduce((sum, item) => sum + item.value, 0);
    renderCompactAnalytics($('[data-static-analytics="support"]'), {
      title: 'Support queue pulse',
      description: 'Click any bar to see every record that has been sent to that queue.',
      metrics: [{label: 'Open complaints', value: supportBars[1].value}, {label: 'New contacts', value: supportBars[0].value}, {label: 'Feedback received', value: supportBars[2].value}, {label: 'Safety reports', value: supportBars[3].value}],
      chartTitle: 'Support mix', chartDescription: 'Click a bar for the complete list',
      bars: supportBars,
      interactiveBars: true,
      activeKey: state.adminSupportSelection,
      ring: {title: 'Queue coverage', label: 'open items', value: supportTotal, total: Math.max(1, members.length), note: 'open items relative to member base', detail: `${supportTotal} active support signals`}
    });
    bindAdminSupportAnalytics();
    if (state.adminSupportSelection) renderAdminSupportQueue(state.adminSupportSelection);
  }
  function downloadAdminCSV(filename, headers, rows) {
    // Neutralize formula prefixes when files are opened in spreadsheet applications.
    const cell = value => {
      let text = String(value ?? '');
      if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g,'""') + '"';
    };
    const content = '\uFEFF' + [headers,...rows].map(row => row.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([content], {type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  async function loadAdminWorkspace(key, force = false) {
    const config = workConfig[key], root = workRoot(key);
    if (!config || !root) return;
    const stateKey = config.source === 'content' ? 'adminContent' : 'adminOperations';
    const status = $('[data-work-status-message]',root);
    if (state.adminWorkLoading[config.source]) {
      await state.adminWorkLoading[config.source];
      if (state[stateKey]) renderAdminWorkspace(key);
      else status.textContent = 'Could not load records. Use Refresh to retry.';
      return;
    }
    if (state[stateKey] && !force) { renderAdminWorkspace(key); return; }
    status.textContent = 'Loading records…';
    $('[data-work-refresh]',root).disabled = true;
    const request = (async () => {
      try {
        state[stateKey] = await api(`/api/admin/${config.source}`);
        Object.keys(workConfig).filter(name => workConfig[name].source === config.source).forEach(name => {
          renderAdminWorkspace(name); $('[data-work-status-message]',workRoot(name)).textContent = '';
        });
        renderAdminQueueCounts();
        renderStaticAdminAnalytics();
        return true;
      } catch (error) { status.textContent = error.message; return false; }
    })();
    state.adminWorkLoading[config.source] = request;
    try { await request; } finally { delete state.adminWorkLoading[config.source]; $('[data-work-refresh]',root).disabled = false; }
  }
  function renderAdminQueueCounts() {
    const counts = {reports:state.adminOperations?.stats.open_reports, disputes:state.adminOperations?.stats.open_disputes,
      submissions:state.adminContent ? state.adminContent.stats.open_complaints + state.adminContent.stats.new_contacts : null,
      ideas:state.adminContent?.stats.student_reviews,
      sessions:state.adminOperations?.stats.pending_session_point_reviews};
    Object.entries(counts).forEach(([key,count]) => { const badge = $(`[data-queue-count="${key}"]`); if (badge) badge.textContent = count ? String(count) : ''; });
  }
  function renderAdminWorkspace(key) {
    const root = workRoot(key), select = $('[data-work-status]',root);
    const previous = select.value;
    const statuses = [...new Set(workItems(key).map(item => workStatus(key,item)))].sort();
    select.innerHTML = '<option value="all">All statuses</option>' + statuses.map(status => `<option value="${escapeHtml(status)}">${escapeHtml(status.replaceAll('_',' '))}</option>`).join('');
    select.value = statuses.includes(previous) ? previous : 'all';
    const items = filteredWorkItems(key);
    renderSectionAnalytics(key, items);
    $('[data-work-count]',root).textContent = `${items.length} of ${workItems(key).length} records`;
    $('[data-work-export]',root).disabled = !items.length;
    $('[data-work-list]',root).innerHTML = items.map(item => {
      const selected = state.adminWorkSelection[key] === item.id;
      let summary = item.email || item.message || item.details || item.reason || item.tagline || '';
      if (key === 'activity') summary = `${item.messages_sent} messages · ${item.open_reports} open reports · ${item.calendar_events} events`;
      if (key === 'ledger') summary = `${item.amount > 0 ? '+' : ''}${item.amount || 0} credits · ${item.user_id || ''}`;
      if (key === 'sessions') summary = `${formatDate(item.starts_at)} · ${memberName(item.host)}`;
      return `<button type="button" class="admin-work-record ${selected ? 'selected' : ''}" data-work-record="${escapeHtml(item.id)}" aria-pressed="${selected}"><span class="admin-work-record-head"><strong>${escapeHtml(workTitle(key,item))}</strong><span class="status-pill">${escapeHtml(workStatus(key,item).replaceAll('_',' '))}</span></span><span class="admin-work-preview">${escapeHtml(String(summary).slice(0,180))}</span><small>${escapeHtml(formatDate(item.created_at || item.last_message_at || item.user?.created_at))}</small></button>`;
    }).join('') || '<div class="admin-detail-empty"><strong>No records found</strong><p>Try another search or status filter.</p></div>';
    const selected = items.find(item => item.id === state.adminWorkSelection[key]);
    if (selected) renderAdminWorkDetail(key,selected);
    else { delete state.adminWorkSelection[key]; $('[data-work-detail]',root).innerHTML = '<div class="admin-detail-empty"><strong>Select a record</strong><p>Details and available actions appear here.</p></div>'; }
  }
  function workOptions(values, current) {
    return values.map(value => `<option value="${escapeHtml(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(value.replaceAll('_',' '))}</option>`).join('');
  }
  function workSelect(label,name,values,current) {
    return `<label class="field"><span>${label}</span><select name="${name}">${workOptions(values,current)}</select></label>`;
  }
  function workNotes(name,value,required=false) {
    return `<label class="field full"><span>Administrator notes</span><textarea name="${name}" rows="4" maxlength="2400" ${required ? 'required' : ''}>${escapeHtml(value || '')}</textarea></label>`;
  }
  function renderAdminWorkDetail(key,item) {
    const root = workRoot(key), detail = $('[data-work-detail]',root);
    const omit = new Set(['password_hash','admin_id_hash','evidence','conversation_activity','comments','liked_by','saved_by']);
    const fields = Object.fromEntries(Object.entries(item).filter(([field,value]) => !omit.has(field) && (value === null || typeof value !== 'object')));
    let extra = '', controls = '';
    const account = key === 'reports' ? item.reported_user : item.user || item.owner || item.host;
    if (account?.id) extra += `<button class="btn btn-sm" type="button" data-work-account="${escapeHtml(account.id)}">Open ${escapeHtml(memberName(account))}’s account</button>`;
    if (key === 'reports') {
      controls = workSelect('Report status','status',['open','reviewing','resolved','dismissed'],item.status) + workSelect('Account action','action',['pending','dismissed','warning','restricted','suspended','restored'],item.action || 'pending') + '<label class="field"><span>Suspension duration (hours)</span><input name="suspension_hours" type="number" min="1" max="8760" value="24"></label>' + workNotes('admin_notes',item.admin_notes);
      extra += '<h3>Captured message evidence</h3><p class="muted">Visibility changes below apply to individual messages. Original evidence remains available for review.</p>';
      extra += (item.evidence || []).map(message => `<article class="admin-evidence"><strong>${escapeHtml(memberName(message.sender))}</strong><small>${escapeHtml(formatDate(message.created_at))}</small><p>${escapeHtml(message.original_body || message.body || 'No text content')}</p><span class="status-pill">${escapeHtml(message.moderation_status || 'visible')}</span><button class="btn btn-sm" type="button" data-work-message="${escapeHtml(message.id)}" data-message-visibility="${message.moderation_status === 'removed' ? 'visible' : 'removed'}">${message.moderation_status === 'removed' ? 'Restore message' : 'Remove message'}</button></article>`).join('') || '<p>No captured messages.</p>';
      extra += `<details class="admin-proposal-editor"><summary>Conversation context (${(item.conversation_activity || []).length} messages)</summary>${(item.conversation_activity || []).map(message => `<article class="admin-evidence"><strong>${escapeHtml(memberName(message.sender))}</strong><small>${escapeHtml(formatDate(message.created_at))}</small><p>${escapeHtml(message.original_body || message.body || 'No text content')}</p>${message.attachment ? `<small>Attachment: ${escapeHtml(message.attachment.original_name || message.attachment.name || 'File')}</small>` : ''}</article>`).join('')}</details>`;
    } else if (key === 'disputes') {
      extra += `<h3>Disputed payment</h3><dl class="detail-list">${detailPairs({claimant:memberName(item.user), counterparty:memberName(item.counterparty), amount:item.ledger_entry?.amount, description:item.ledger_entry?.description})}</dl>`;
      if (!['resolved','dismissed'].includes(item.status)) controls = workSelect('Decision','resolution',['approved','partial','denied'],'approved') + `<label class="field"><span>Partial refund (credits)</span><input name="refund_amount" type="number" min="0" max="${Math.abs(item.ledger_entry?.amount || 0)}" value="0"><small>Approval refunds the full payment. Denial refunds zero.</small></label>` + workNotes('admin_notes',item.admin_notes,true);
    } else if (key === 'ideas') {
      extra += `<h3>Idea proposal</h3><dl class="detail-list">${detailPairs({problem:item.problem, solution:item.solution, beneficiaries:item.beneficiaries, impact:item.impact, guardian_consent:item.guardian_consent_status, safety_review:item.safety_review_status})}</dl>`;
      controls = workSelect('Publication status','status',['published','specialist_review','under_review','funded','pilot','seeking_support','archived','rejected'],item.status) + workNotes('moderation_notes',item.moderation_notes);
      const proposalFields = {title:120,tagline:240,category:80,stage:60,problem:1800,solution:1800,beneficiaries:700,impact:1000,funding_currency:10,funds_use:1200,collaboration:500,reach:180,prototype_url:300,pitch:1200};
      controls += '<details class="full admin-proposal-editor"><summary>Edit complete proposal</summary>' + Object.entries(proposalFields).map(([field,max]) => `<label class="field"><span>${escapeHtml(field.replaceAll('_',' '))}</span><textarea name="${field}" maxlength="${max}" ${field !== 'prototype_url' ? 'required' : ''}>${escapeHtml(item[field] || '')}</textarea></label>`).join('') + `<label class="field"><span>Funding needed</span><input name="funding_needed" type="number" min="0" max="1000000000" value="${Number(item.funding_needed || 0)}"></label><label class="field"><span>Skills needed</span><input name="skills_needed" required value="${escapeHtml((item.skills_needed || []).join(', '))}"></label></details>`;

    } else if (key === 'submissions') {
      const collection = $('[data-work-collection]',root).value;
      const values = {contacts:['new','reviewing','replied','closed'], complaints:['received','reviewing','resolved','closed'],feedback:['private','reviewing','published','archived'],workshops:['scheduled','completed','cancelled'],registrations:['registered','cancelled','attended']};
      // Workshops and registrations follow calendar workflows; expose notes here.
      if (!['workshops','registrations'].includes(collection)) controls += workSelect('Status','status',[...new Set([item.status || 'new',...values[collection]])],item.status || 'new');
      if (collection === 'complaints') controls += workSelect('Priority','priority',['standard','time-sensitive','urgent'],item.priority || 'standard');
      if (collection === 'feedback') controls += `<label class="field full"><span>Title</span><input name="title" maxlength="140" required value="${escapeHtml(item.title)}"></label><label class="field full"><span>Message</span><textarea name="message" maxlength="1800" required>${escapeHtml(item.message)}</textarea></label><label class="field"><span>Author role</span><input name="role" maxlength="120" required value="${escapeHtml(item.role)}"></label><label class="field"><span>Rating</span><input name="rating" type="number" min="1" max="5" value="${Number(item.rating || 5)}"></label>` + `<label class="check-row"><input type="checkbox" name="featured" ${item.featured ? 'checked' : ''}><span>Feature testimonial</span></label><p class="muted">Publication permission: ${item.permission_to_publish ? 'Granted' : 'Not granted; publication is blocked'}</p>`;
      if (collection === 'workshops') controls += `<label class="field full"><span>Title</span><input name="title" maxlength="140" required value="${escapeHtml(item.title)}"></label><label class="field full"><span>Description</span><textarea name="description" maxlength="1200" required>${escapeHtml(item.description)}</textarea></label><label class="field full"><span>Location</span><input name="location" maxlength="160" required value="${escapeHtml(item.location)}"></label>`;
      controls += workNotes('admin_notes',item.admin_notes);
      if (['workshops','registrations'].includes(collection)) extra += '<p class="muted">Manage scheduling and cancellation through the calendar to keep participants and registrations in sync.</p><a class="btn btn-sm" href="calendar.html">Open calendar</a>';
    } else if (key === 'activity') {
      extra += `<h3>Activity summary</h3><dl class="detail-list">${detailPairs({member:memberName(item.user),messages_sent:item.messages_sent,reports_received:item.reports_received,open_reports:item.open_reports,calendar_events:item.calendar_events,ledger_entries:item.ledger_entries,last_message_at:formatDate(item.last_message_at)})}</dl>`;
    } else if (key === 'sessions') {
      if (item.viewer_can_edit) extra += '<button class="btn btn-sm" type="button" data-work-session="cancel">Cancel session</button>';
      if (item.viewer_can_complete) extra += '<button class="btn btn-sm" type="button" data-work-session="complete">Confirm completion</button>';
      const review = item.points_review;
      if (review) {
        const reviewRows = (review.ratings || []).map(rating => `<article class="admin-evidence"><strong>${escapeHtml(memberName(rating.rater))} · ${escapeHtml(rating.rating)}/5</strong><small>${escapeHtml(formatDate(rating.created_at))} · ${escapeHtml(rating.points_status || 'pending')}</small><p>${escapeHtml(rating.comment || 'No private note was added.')}</p></article>`).join('') || '<p>No ratings were captured.</p>';
        const transcript = (review.transcript || []).map(message => `<article class="admin-evidence"><strong>${escapeHtml(memberName(message.sender))}</strong><small>${escapeHtml(formatDate(message.created_at))}</small><p>${escapeHtml(message.body || 'No text content')}</p></article>`).join('') || '<p>No linked meeting transcript was found for this session.</p>';
        extra += `<section class="session-point-review"><h3>Private points review</h3><p class="muted">${review.status === 'pending' ? 'Most submitted ratings were 1 or 2 stars. Review the private transcript before deciding whether the automatic session points should stand.' : `Decision: ${escapeHtml(review.status)}.`}</p><dl class="detail-list">${detailPairs({ratings: `${review.rating_count || 0} submitted · ${review.bad_count || 0} negative`, participants: review.eligible_count || 0, created: formatDate(review.created_at), decided: review.decided_at ? formatDate(review.decided_at) : 'Awaiting decision'})}</dl><details class="admin-proposal-editor" open><summary>Session ratings</summary>${reviewRows}</details><details class="admin-proposal-editor"><summary>Session transcript (${(review.transcript || []).length} messages)</summary>${transcript}</details>${review.status === 'pending' ? `<form data-work-edit data-session-point-review-form="${escapeAttr(review.id)}" class="admin-control-grid"><div class="field full"><label>Decision<select name="decision"><option value="approve">Approve points</option><option value="deny">Deny points</option></select></label></div>${workNotes('admin_notes', review.admin_notes)}<div class="form-actions full"><button class="btn btn-primary" type="submit">Save points decision</button></div><p class="form-status full" data-status role="status"></p></form>` : review.admin_notes ? `<p class="muted"><strong>Administrator note:</strong> ${escapeHtml(review.admin_notes)}</p>` : ''}</section>`;
      }
      extra += `<h3>Participants</h3><p>${escapeHtml((item.participants || []).map(memberName).join(', ') || 'No participants')}</p><a class="btn btn-sm" href="calendar.html">Open calendar</a>`;
    }
    if (key === 'ideas' || (key === 'submissions' && $('[data-work-collection]',root).value !== 'workshops')) extra += '<div class="danger-box"><strong>Delete record permanently</strong><p>Enter the record ID when prompted to confirm deletion.</p><button class="btn btn-danger btn-sm" type="button" data-work-delete>Delete record</button></div>';
    detail.innerHTML = `<div class="admin-panel-head"><h3>${escapeHtml(workTitle(key,item))}</h3></div><div class="admin-work-detail-body"><dl class="detail-list">${detailPairs(fields)}</dl>${extra}${controls ? `<form data-work-edit class="admin-control-grid">${controls}<div class="form-actions full"><button class="btn btn-primary" type="submit">Save decision / changes</button></div><p class="form-status full" data-status role="status"></p></form>` : ''}</div>`;
  }
  async function saveAdminWorkRecord(key,form) {
    const root = workRoot(key), item = workItems(key).find(record => record.id === state.adminWorkSelection[key]);
    if (!item || form.dataset.saving) return;
    const data = new FormData(form), body = Object.fromEntries(data.entries());
    let path;
    if (key === 'reports') {
      path = `/api/admin/message-reports/${encodeURIComponent(item.id)}`;
      body.suspension_minutes = Number(body.suspension_hours) * 60; delete body.suspension_hours;
      body.suspension_reason = body.admin_notes || `Safety report ${item.id}`;
    } else if (key === 'disputes') {
      path = `/api/admin/credit-disputes/${encodeURIComponent(item.id)}`;
      body.refund_amount = Number(body.refund_amount);
      if (!confirm(`Record a final ${body.resolution} decision for this dispute?`)) return;
    } else if (key === 'ideas') {
      path = `/api/admin/ideas/${encodeURIComponent(item.id)}`;
      body.skills_needed = String(body.skills_needed || '').split(',').map(value => value.trim()).filter(Boolean);
      body.funding_needed = Number(body.funding_needed);
    } else if (key === 'sessions' && item.points_review && body.decision) {
      path = `/api/admin/session-reviews/${encodeURIComponent(item.points_review.id)}`;
      if (!confirm(`Record the ${body.decision === 'approve' ? 'approval' : 'denial'} of private session points?`)) return;
    } else {
      const collection = $('[data-work-collection]',root).value;
      path = `/api/admin/content/${collection}/${encodeURIComponent(item.id)}`;
      if (collection === 'feedback') body.featured = data.get('featured') === 'on';
    }
    form.dataset.saving = 'true'; const button = $('button[type="submit"]',form); button.disabled = true;
    try {
      await api(path,{method:'PATCH',body});
      await loadAdminWorkspace(key,true); await loadAdminData(Boolean(state.selectedUserId));
      $('[data-work-status-message]',root).textContent = 'Changes saved.';
    } catch (error) { setStatus(form,error.message); }
    finally { delete form.dataset.saving; button.disabled = false; }
  }
  function setupAdminWorkspaces() {
    $('#adminExportAudit')?.addEventListener('click',() => {
      const query = ($('#adminAuditSearch')?.value || '').trim().toLowerCase();
      const entries = state.audit.filter(entry => !query || `${entry.actor_name} ${entry.action} ${entry.details}`.toLowerCase().includes(query));
      downloadAdminCSV('swaplabs-audit.csv',['Date','Actor','Action','Target','Details'],entries.map(entry => [entry.created_at,entry.actor_name,entry.action,entry.target_id,entry.details]));
    });
    $('#adminExportAccounts')?.addEventListener('click', () => downloadAdminCSV('swaplabs-accounts.csv', ['ID','Name','Username','Email','Phone','Role','Status','Verified','Credits','Moderation','Joined'], filteredAdminUsers().map(user => [user.id,memberName(user),user.username,user.email,user.profile.phone_number || '',user.role,user.status,user.verified,user.time_credits,user.moderation_label,user.created_at])));
    Object.keys(workConfig).forEach(key => {
      const root = workRoot(key); if (!root) return;
      ['search','status','sort'].forEach(field => $('[data-work-'+field+']',root).addEventListener(field === 'search' ? 'input' : 'change',() => renderAdminWorkspace(key)));
      $('[data-work-collection]',root)?.addEventListener('change',() => { delete state.adminWorkSelection[key]; $('[data-work-status]',root).value = 'all'; renderAdminWorkspace(key); });
      $('[data-work-refresh]',root).addEventListener('click',() => loadAdminWorkspace(key,true));
      $('[data-work-export]',root).addEventListener('click',() => {
        const items = filteredWorkItems(key).map(item => ({...item, member_name:memberName(item.user || item.reported_user || item.owner || item.host)}));
        const fields = [...new Set(items.flatMap(item => Object.keys(item).filter(field => item[field] === null || typeof item[field] !== 'object')))];
        downloadAdminCSV(`swaplabs-${key}.csv`,fields,items.map(item => fields.map(field => item[field])));
      });
      root.addEventListener('submit',event => { if (!event.target.matches('[data-work-edit]')) return; event.preventDefault(); saveAdminWorkRecord(key,event.target); });
      root.addEventListener('click',async event => {
        const record = event.target.closest('[data-work-record]');
        if (record) { state.adminWorkSelection[key] = record.dataset.workRecord; renderAdminWorkspace(key); return; }
        const account = event.target.closest('[data-work-account]');
        if (account) { showAdminSection('records'); selectAdminUser(account.dataset.workAccount); return; }
        const remove = event.target.closest('[data-work-delete]');
        const session = event.target.closest('[data-work-session]');
        if (remove || session) {
          const item = workItems(key).find(record => record.id === state.adminWorkSelection[key]);
          if (!item) return;
          let path, options;
          const button = remove || session;
          if (remove) {
            if (prompt(`Permanently delete this record? Enter ${item.id} to confirm:`) !== item.id) return;
            const collection = $('[data-work-collection]',root)?.value;
            path = key === 'ideas' ? `/api/admin/ideas/${encodeURIComponent(item.id)}` : `/api/admin/content/${collection}/${encodeURIComponent(item.id)}`;
            options = {method:'DELETE'};
          } else {
            const complete = session.dataset.workSession === 'complete';
            if (!confirm(`${complete ? 'Confirm completion of' : 'Cancel'} ${item.title}? Participants will be notified.`)) return;
            path = `/api/calendar/events/${encodeURIComponent(item.id)}`;
            options = complete ? {method:'PATCH',body:{status:'completed'}} : {method:'DELETE'};
          }
          button.disabled = true;
          try {
            await api(path,options); await loadAdminWorkspace(key,true); await loadAdminData(Boolean(state.selectedUserId));
            if (session && state.adminContent) await loadAdminWorkspace('submissions',true);
            $('[data-work-status-message]',root).textContent = remove ? 'Record deleted.' : 'Session updated and participants notified.';
          } catch (error) { $('[data-work-status-message]',root).textContent = error.message; button.disabled = false; }
          return;
        }
        const message = event.target.closest('[data-work-message]');
        if (!message || message.disabled) return;
        const status = message.dataset.messageVisibility;
        const reason = status === 'removed' ? prompt('Reason for removing this message (required):') : '';
        if (status === 'removed' && !reason?.trim()) return;
        message.disabled = true;
        try { await api(`/api/admin/messages/${encodeURIComponent(message.dataset.workMessage)}/moderate`,{method:'PATCH',body:{status,reason}}); await loadAdminWorkspace(key,true); $('[data-work-status-message]',root).textContent = 'Message visibility updated.'; }
        catch (error) { $('[data-work-status-message]',root).textContent = error.message; message.disabled = false; }
      });
    });
    // Populate queue badges immediately so pending work is visible from every section.
    loadAdminWorkspace('reports'); loadAdminWorkspace('submissions');
  }

  function setupAdminPage() {
    const gate = $('#adminGate');
    const dashboard = $('#adminDashboard');
    if (!gate) return;
    if (!state.user) return;
    if (state.user.role !== 'admin') {
      gate.innerHTML =
        '<div class="container"><div class="profile-locked auth-card"><i class="bx bx-shield-x"></i><h2>Administrator access only</h2><p class="muted">Member accounts can view the platform and edit their own profile, but cannot view or annotate administration data.</p></div></div>';
      return;
    }
    gate.hidden = true;
    dashboard.hidden = false;
    loadAdminData();
    loadAdminPresence();
    loadAdminPresenceToday();
    if (adminPresenceTimer) window.clearInterval(adminPresenceTimer);
    adminPresenceTimer = window.setInterval(() => {
      loadAdminPresence();
      loadAdminPresenceToday();
    }, 20_000);
    setupAdminWorkspaces();
    ['adminSearch', 'adminStatusFilter', 'adminRoleFilter', 'adminPriorityFilter', 'adminAccountSort'].forEach(id => document.getElementById(id)
      ?.addEventListener(id === 'adminSearch' ? 'input' : 'change', renderAdminRows));
    $('#adminOverviewSearch')?.addEventListener('input', renderAdminCharts);
    $('#adminPresenceSearch')?.addEventListener('input', renderAdminPresence);
    $('#adminPresenceRefresh')?.addEventListener('click', loadAdminPresence);
    $('#adminPresenceTodaySearch')?.addEventListener('input', renderAdminPresenceToday);
    $('#adminPresenceTodayRefresh')?.addEventListener('click', loadAdminPresenceToday);
    $('#adminMessageRecipientSearch')?.addEventListener('input', renderAdminMessageRecipients);
    $('#adminMessageMode')?.addEventListener('change', updateAdminMessageMode);
    $('#adminMessageForm')?.addEventListener('submit', sendAdminMessage);
    $('#adminNotificationAudience')?.addEventListener('change', updateAdminNotificationAudience);
    $('#adminNotificationForm')?.addEventListener('submit', sendAdminNotification);
    $('#adminCreateAccountForm')?.addEventListener('submit', createAdminAccount);
    $('#adminMessageBody')?.addEventListener('input', event => { $('#adminMessageCount').textContent = String(event.currentTarget.value.length); });
    $('#adminNotificationMessage')?.addEventListener('input', event => { $('#adminNotificationCount').textContent = String(event.currentTarget.value.length); });
    updateAdminNotificationAudience();
    $('#adminAuditSearch')?.addEventListener('input', renderAudit);
    $('#adminNewsletterSearch')?.addEventListener('input', renderNewsletterSubscribers);
    $('#adminNewsletterRefresh')?.addEventListener('click', loadNewsletterSubscribers);
    $('#adminNewsletterCopy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(filteredNewsletterSubscribers().map(item => item.email).join(', '));
        $('#adminNewsletterStatus').textContent = 'Emails copied. Paste into BCC in your email app.';
      } catch (_error) {
        $('#adminNewsletterStatus').textContent = 'Clipboard unavailable. Select and copy the email addresses from the table.';
      }
    });
    updateAdminMessageMode();
    $('#adminNewsletterRows')?.addEventListener('click', async event => {
      const button = event.target.closest('[data-newsletter-remove]');
      if (!button || !confirm('Remove this subscriber from the newsletter list?')) return;
      button.disabled = true;
      try {
        await api(`/api/admin/newsletter/${encodeURIComponent(button.dataset.newsletterRemove)}`, {method: 'DELETE'});
        await loadNewsletterSubscribers();
      } catch (error) {
        $('#adminNewsletterStatus').textContent = error.message;
        button.disabled = false;
      }
    });
    $('#adminBulkAction')?.addEventListener('change', updateAdminBulkBar);
    $('#adminApplyBulk')?.addEventListener('click', applyAdminBulkAction);
    $('#adminSelectVisible')?.addEventListener('change', event => {
      filteredAdminUsers().filter(user => user.role !== 'admin').forEach(user => event.currentTarget.checked ? state.selectedAdminUserIds.add(user.id) : state.selectedAdminUserIds.delete(user.id));
      renderAdminRows();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== '/' || /input|textarea|select/i.test(document.activeElement?.tagName || '')) return;
      const active = $('[data-admin-section].active');
      const search = active?.querySelector('input[type="search"]');
      if (search) { event.preventDefault(); search.focus(); }
    });
    $('#adminRefresh')?.addEventListener('click', () => loadAdminData(Boolean(state.selectedUserId)));
    $('#adminRedrawCharts')?.addEventListener('click', renderAdminCharts);
    window.addEventListener('swaplabs:preferences-applied', () => requestAnimationFrame(renderAdminCharts));
    const adminNav = $('.admin-section-nav');
    if (adminNav) {
      $$('details.admin-nav-group[data-admin-nav-group]', adminNav).forEach(group => {
        const storageKey = `relayskills-admin-nav-${group.dataset.adminNavGroup}`;
        try {
          const savedState = localStorage.getItem(storageKey);
          if (savedState === 'open' || savedState === 'closed') group.open = savedState === 'open';
        } catch (_error) {
          // Navigation should remain usable when storage is unavailable.
        }
        group.addEventListener('toggle', () => {
          try { localStorage.setItem(storageKey, group.open ? 'open' : 'closed'); } catch (_error) {}
        });
      });
    }
    adminNav?.addEventListener('click', event => {
      const button = event.target.closest('[data-admin-section-target]');
      if (!button) return;
      showAdminSection(button.dataset.adminSectionTarget, button.dataset.adminFocus || '');
    });
    $('.admin-analytics-collapsible')?.addEventListener('toggle', event => {
      if (event.currentTarget.open) requestAnimationFrame(renderAdminCharts);
    });
    showAdminSection(new URLSearchParams(location.search).get('section') || 'overview');
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderAdminCharts, 180);
    });
  }

  function communitySearchText(user) {
    const profile = user.profile || {};
    return [
      user.username, profile.display_name, profile.full_name, profile.headline, profile.professional_role,
      profile.occupation, profile.organization, profile.country, profile.city, profile.primary_language,
      ...list(profile.additional_languages), ...list(profile.languages_to_learn), ...list(profile.skills_to_teach), ...list(profile.skills_to_learn),
      ...list(profile.interests)
    ].filter(Boolean).join(' ').toLowerCase();
  }

  // Directory relevance is intentionally calculated in the browser from the
  // same profile fields a member can already see. It never uses private data,
  // an opaque popularity score, or an inferred distance between members.
  const COMMUNITY_SKILL_FAMILIES = [
    {label: 'Web and software', terms: ['web', 'html', 'css', 'javascript', 'typescript', 'react', 'vue', 'frontend', 'front end', 'backend', 'back end', 'full stack', 'api', 'programming', 'coding', 'database', 'sql', 'devops', 'cloud', 'cybersecurity', 'figma']},
    {label: 'Data and AI', terms: ['python', 'data analysis', 'data science', 'data visualization', 'machine learning', 'deep learning', 'statistics', 'excel', 'computer vision', 'natural language processing', 'artificial intelligence', 'ai']},
    {label: 'Design and media', terms: ['graphic design', 'visual design', 'web design', 'ui design', 'ux design', 'user interface', 'user experience', 'branding', 'illustration', 'animation', 'motion design', 'photography', 'photo editing', 'video editing', 'after effects', 'lightroom', 'canva', 'presentation design']},
    {label: 'Writing and communication', terms: ['creative writing', 'content writing', 'copywriting', 'technical writing', 'editing', 'public speaking', 'presentation', 'storytelling', 'interview practice', 'communication', 'english', 'grammar', 'academic writing']},
    {label: 'Product and business', terms: ['product planning', 'product strategy', 'project planning', 'project management', 'entrepreneurship', 'digital marketing', 'seo', 'career planning', 'linkedin', 'community building', 'finance', 'business']},
    {label: 'Languages', terms: ['english', 'hindi', 'french', 'spanish', 'german', 'mandarin', 'chinese', 'japanese', 'korean', 'arabic', 'language learning', 'translation']},
    {label: 'Wellbeing and life skills', terms: ['fitness', 'running', 'yoga', 'mindfulness', 'nutrition', 'habit building', 'meditation', 'pet care', 'time management']},
    {label: 'Food and making', terms: ['cooking', 'indian cooking', 'baking', 'meal prep', 'food styling', 'grilling', 'knitting', 'crafts', 'woodworking']}
  ];
  const communityKey = value => String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const communityValues = value => list(value).map(item => String(item).trim()).filter(Boolean);
  const communityFamily = value => {
    const key = communityKey(value);
    if (!key) return '';
    return COMMUNITY_SKILL_FAMILIES.find(family => family.terms.some(term => {
      const familyKey = communityKey(term);
      return key === familyKey || key.includes(familyKey) || familyKey.includes(key);
    }))?.label || '';
  };
  const communitySkillMatches = (wantedValues, availableValues) => {
    const wanted = communityValues(wantedValues);
    const available = communityValues(availableValues);
    const direct = [];
    const related = [];
    wanted.forEach(requested => {
      const requestedKey = communityKey(requested);
      const directMatch = available.find(candidate => {
        const candidateKey = communityKey(candidate);
        return requestedKey && candidateKey && (requestedKey === candidateKey || requestedKey.includes(candidateKey) || candidateKey.includes(requestedKey));
      });
      if (directMatch) {
        direct.push({requested, found: directMatch});
        return;
      }
      const requestedFamily = communityFamily(requested);
      const relatedMatch = requestedFamily && available.find(candidate => communityFamily(candidate) === requestedFamily);
      if (relatedMatch) related.push({requested, found: relatedMatch, family: requestedFamily});
    });
    return {direct, related};
  };
  const communitySharedTerms = (left, right) => {
    const leftWords = new Set(communityKey(left).split(' ').filter(word => word.length > 2));
    return communityKey(right).split(' ').filter(word => word.length > 2 && leftWords.has(word));
  };
  const communityRelevanceFor = (candidate, viewer = state.user) => {
    const profile = candidate?.profile || {};
    const viewerProfile = viewer?.profile || {};
    const candidateTeach = communityValues(profile.skills_to_teach);
    const candidateLearn = communityValues([...communityValues(profile.skills_to_learn), ...communityValues(profile.languages_to_learn)]);
    const viewerTeach = communityValues(viewerProfile.skills_to_teach);
    const viewerLearn = communityValues([...communityValues(viewerProfile.skills_to_learn), ...communityValues(viewerProfile.languages_to_learn)]);
    const wantsToLearn = communitySkillMatches(viewerLearn, candidateTeach);
    const canHelp = communitySkillMatches(viewerTeach, candidateLearn);
    const sharedSkills = communitySkillMatches([...viewerTeach, ...viewerLearn], [...candidateTeach, ...candidateLearn]);
    const reasons = [];
    const addReason = reason => {
      if (reason && !reasons.includes(reason)) reasons.push(reason);
    };
    const matchText = matches => [...matches.direct, ...matches.related].slice(0, 2).map(match => match.found).join(' and ');
    let score = 0;
    const hasViewer = Boolean(viewer?.id || viewerProfile.display_name);
    if (wantsToLearn.direct.length) {
      score += Math.min(96, wantsToLearn.direct.length * 48);
      addReason(`Teaches ${matchText(wantsToLearn)} you want to learn`);
    }
    if (canHelp.direct.length) {
      score += Math.min(88, canHelp.direct.length * 44);
      addReason(`Wants to learn ${matchText(canHelp)} you teach`);
    }
    if (wantsToLearn.related.length) {
      score += Math.min(36, wantsToLearn.related.length * 18);
      if (!wantsToLearn.direct.length) addReason(`Related ${wantsToLearn.related[0].family} skills`);
    }
    if (canHelp.related.length) {
      score += Math.min(32, canHelp.related.length * 16);
      if (!canHelp.direct.length && !wantsToLearn.related.length) addReason(`Related ${canHelp.related[0].family} goals`);
    }
    if (wantsToLearn.direct.length && canHelp.direct.length) {
      score += 24;
      addReason('Strong two-way exchange fit');
    }
    if (sharedSkills.direct.length) score += Math.min(24, sharedSkills.direct.length * 8);
    if (sharedSkills.related.length) score += Math.min(15, sharedSkills.related.length * 5);

    const candidateCity = communityKey(profile.city);
    const viewerCity = communityKey(viewerProfile.city);
    const candidateCountry = communityKey(profile.country);
    const viewerCountry = communityKey(viewerProfile.country);
    if (hasViewer && candidateCity && viewerCity && candidateCity === viewerCity) {
      score += 18;
      addReason(`Same city: ${profile.city}`);
    } else if (hasViewer && candidateCountry && viewerCountry && candidateCountry === viewerCountry) {
      score += 9;
      addReason(`Same country: ${profile.country}`);
    }
    const viewerTimezone = communityKey(viewerProfile.timezone);
    const candidateTimezone = communityKey(profile.timezone);
    if (hasViewer && viewerTimezone && candidateTimezone && viewerTimezone === candidateTimezone) score += 5;

    const viewerLanguages = communityValues([viewerProfile.primary_language, ...communityValues(viewerProfile.additional_languages), ...communityValues(viewerProfile.languages_to_learn)]).map(communityKey).filter(Boolean);
    const candidateLanguages = communityValues([profile.primary_language, ...communityValues(profile.additional_languages), ...communityValues(profile.languages_to_learn)]).map(communityKey).filter(Boolean);
    const sharedLanguages = [...new Set(viewerLanguages.filter(language => candidateLanguages.includes(language)))];
    if (hasViewer && sharedLanguages.length) {
      score += Math.min(14, sharedLanguages.length * 5);
      addReason(`Shared language: ${sharedLanguages[0]}`);
    }
    if (hasViewer && communityKey(viewerProfile.primary_language) && communityKey(viewerProfile.primary_language) === communityKey(profile.primary_language)) score += 4;

    const availabilityOverlap = communitySharedTerms(viewerProfile.availability, profile.availability);
    if (hasViewer && availabilityOverlap.length) {
      score += 5;
      addReason('Similar availability');
    } else if (hasViewer && communityKey(viewerProfile.availability) && communityKey(viewerProfile.availability) === communityKey(profile.availability)) {
      score += 5;
      addReason('Similar availability');
    }
    if (hasViewer && communityKey(viewerProfile.preferred_format) && communityKey(viewerProfile.preferred_format) === communityKey(profile.preferred_format)) score += 3;
    if (hasViewer && communityKey(viewerProfile.teaching_style) && communityKey(viewerProfile.teaching_style) === communityKey(profile.teaching_style)) score += 2;

    const profileSignals = [profile.headline, profile.bio, profile.professional_role || profile.occupation, profile.country, profile.primary_language, profile.availability, candidateTeach.length, candidateLearn.length].filter(Boolean).length;
    score += Math.min(8, profileSignals);
    const sessions = Number(candidate.reputation?.completed_sessions || 0);
    const ideas = Number(candidate.published_idea_count || 0);
    const followers = Number(candidate.followers_count || 0);
    score += Math.min(10, sessions * 1.25) + Math.min(5, ideas * .8) + Math.min(4, followers * .25);
    if (sessions >= 2) addReason('Active exchange history');
    if (!hasViewer) {
      score += Math.min(20, (candidateTeach.length + candidateLearn.length) * 2);
      if (candidateTeach.length + candidateLearn.length >= 3) addReason('Rich skill profile');
      else if (profileSignals >= 5) addReason('Complete public profile');
    }
    if (candidate.relationship === 'self') score -= 1000;

    let label = 'Potential fit';
    if (wantsToLearn.direct.length && canHelp.direct.length) label = 'Strong two-way fit';
    else if (wantsToLearn.direct.length) label = 'Teaches what you want';
    else if (canHelp.direct.length) label = 'Learns what you teach';
    else if (wantsToLearn.related.length || canHelp.related.length || sharedSkills.related.length) label = 'Related skill fit';
    else if (candidateCity && viewerCity && candidateCity === viewerCity) label = 'Nearby member';
    else if (sharedLanguages.length) label = 'Shared language';
    else if (sessions >= 2) label = 'Active member';
    else if (!hasViewer) label = 'Complete profile';
    if (!reasons.length) addReason(hasViewer ? 'Profile and community signals' : 'New member to discover');
    return {score, label, reasons: reasons.slice(0, 2)};
  };

  function communityRelationshipAction(user, compact = false) {
    const showLabel = !compact || user.visibility === 'private';
    if (user.relationship === 'self')
    return `<a class="btn btn-sm" href="profile.html"><i class="bx bx-edit-alt"></i>${compact ? '' : ' Edit profile'}</a>`;
    if (!state.user)
    return `<a class="btn btn-sm" href="login.html"><i class="bx bx-log-in"></i>${showLabel ? (user.visibility === 'private' ? ' Log in to request access' : ' Log in to follow') : ''}</a>`;
    if (user.relationship === 'following')
    return `<button class="btn btn-sm" type="button" data-community-unfollow="${escapeHtml(user.id)}"><i class="bx bx-user-check"></i>${showLabel ? ' Following' : ''}</button>`;
    if (user.relationship === 'requested')
    return `<button class="btn btn-sm" type="button" data-community-unfollow="${escapeHtml(user.id)}"><i class="bx bx-time-five"></i>${showLabel ? ' Requested' : ''}</button>`;
    return `<button class="btn btn-primary btn-sm" type="button" data-community-follow="${escapeHtml(user.id)}"><i class="bx ${user.visibility === 'private' ? 'bx-user-plus' : 'bx-user-check'}"></i>${showLabel ? (user.visibility === 'private' ? ' Request to follow' : ' Follow') : ''}</button>`;
  }

  function communityMessageAction(user, compact = false) {
    if (user.relationship === 'self') return '';
    if (user.messaging_available === false) return '';
    if (!state.user) return '';
    return `<a class="btn btn-sm" href="notifications.html?member=${encodeURIComponent(user.id)}"><i class="bx bx-message-square-dots"></i>${compact ? '' : ' Message'}</a>`;
  }

  function filteredCommunityUsers() {
    const query = ($('#communitySearch')?.value || '').trim().toLowerCase();
    const visibility = $('#communityVisibilityFilter')?.value || 'all';
    const country = $('#communityCountryFilter')?.value || 'all';
    const skill = $('#communitySkillFilter')?.value || 'all';
    const sort = $('#communitySort')?.value || 'relevance';
    const users = state.communityUsers.filter(user => {
      const visibilityMatch = visibility === 'all' || user.visibility === visibility || user.relationship ===
        visibility;
      const countryMatch = country === 'all' || user.profile.country === country;
      const memberSkills = [...list(user.profile.skills_to_teach), ...list(user.profile.skills_to_learn), ...list(user.profile.languages_to_learn)];
      const skillMatch = skill === 'all' || memberSkills.includes(skill);
      return (!query || communitySearchText(user).includes(query)) && visibilityMatch && countryMatch && skillMatch;
    });
    if (sort === 'relevance') {
      const ranked = users.map(user => ({user, relevance: communityRelevanceFor(user)}));
      state.communityRelevance = new Map(ranked.map(item => [item.user.id, item.relevance]));
      ranked.sort((a, b) => b.relevance.score - a.relevance.score ||
        String(a.user.profile.display_name || a.user.username).localeCompare(String(b.user.profile.display_name || b.user.username)));
      return ranked.map(item => item.user);
    }
    state.communityRelevance = new Map();
    const currentUserId = state.user?.id || '';
    const isCurrentUser = user => Boolean(user.relationship === 'self' || (currentUserId && user.id === currentUserId));
    users.sort((a, b) => {
      // Keep the signed-in member discoverable at the top of the community
      // directory, while preserving the user's chosen ordering for everyone
      // else below them.
      const aIsCurrent = isCurrentUser(a);
      const bIsCurrent = isCurrentUser(b);
      if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
      if (sort === 'followers') return b.followers_count - a.followers_count || a.profile.display_name
        .localeCompare(b.profile.display_name);
      if (sort === 'skills') return (list(b.profile.skills_to_teach).length + list(b.profile.skills_to_learn).length + list(b.profile.languages_to_learn).length)
        - (list(a.profile.skills_to_teach).length + list(a.profile.skills_to_learn).length + list(a.profile.languages_to_learn).length);
      if (sort === 'rating') return Number(b.reputation?.rating || 0) - Number(a.reputation?.rating || 0);
      if (sort === 'sessions') return Number(b.reputation?.completed_sessions || 0) - Number(a.reputation
        ?.completed_sessions || 0);
      if (sort === 'ideas') return Number(b.published_idea_count || 0) - Number(a.published_idea_count || 0);
      if (sort === 'newest') return String(b.joined_at || '').localeCompare(String(a.joined_at || ''));
      return a.profile.display_name.localeCompare(b.profile.display_name);
    });
    return users;
  }

  function bindCommunityActions(root = document) {
    $$('[data-community-view]', root).forEach(button => button.addEventListener('click', () => openCommunityProfile(
      button.dataset.communityView)));
    $$('[data-community-follow]', root).forEach(button => button.addEventListener('click', () =>
      changeCommunityFollow(button.dataset.communityFollow, false, button)));
    $$('[data-community-unfollow]', root).forEach(button => button.addEventListener('click', () =>
      changeCommunityFollow(button.dataset.communityUnfollow, true, button)));
    $$('[data-community-card]', root).forEach(card => {
      card.addEventListener('click', event => {
        if (event.target.closest('a, button, input, select, textarea')) return;
        openCommunityProfile(card.dataset.communityCard);
      });
      card.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key) || event.target.closest('a, button, input, select, textarea')) return;
        event.preventDefault();
        openCommunityProfile(card.dataset.communityCard);
      });
    });
  }

  function renderCommunityUsers() {
    const host = $('#communityUserGrid');
    if (!host) return;
    const users = filteredCommunityUsers();
    const sort = $('#communitySort')?.value || 'relevance';
    const relevanceMode = sort === 'relevance';
    const rankingText = relevanceMode ? (state.user ? 'personalised to your profile' : 'sign in to personalise the order') : `sorted by ${$('#communitySort option:checked')?.textContent || 'your selection'}`;
    $('#communityResultCount').textContent = `${users.length} of ${state.communityUsers.length} active profiles shown · ${rankingText}`;
    const rankingGuide = $('#communityRankingGuide');
    if (rankingGuide) rankingGuide.innerHTML = relevanceMode ?
      `<i class="bx bx-sparkles"></i><span>${state.user ? 'Ranking is personalised from your learning goals, teaching skills, shared categories, location, language, availability, and useful activity.' : 'Sign in to personalise this order. For now, the directory favours complete skill profiles and active members.'}</span>` :
      `<i class="bx bx-sort-alt-2"></i><span>Choose “Most relevant to you” to combine two-way skill fit with shared categories, location, language, availability, and activity.</span>`;
    $('#communityEmpty').hidden = users.length > 0;
    host.hidden = users.length === 0;
    host.innerHTML = users.map(user => {
      const profile = user.profile;
      const teachSkills = user.can_view_full ? list(profile.skills_to_teach).slice(0, 3) : [];
      const learnSkills = user.can_view_full ? [...list(profile.skills_to_learn), ...list(profile.languages_to_learn)].slice(0, 2) : [];
      const reputation = user.reputation || {};
      const availability = user.availability || {};
      const copy = user.can_view_full ? (profile.bio || profile.headline ||
          'This member is building their SwapLabs profile.') :
        'This profile is private. You can view the member identity and request access to the rest of the profile.';
      const relevance = relevanceMode ? state.communityRelevance.get(user.id) : null;
      const relevanceMarkup = relevance ? `<div class="community-relevance-strip" title="${escapeHtml(relevance.reasons.join(' · '))}"><span><i class="bx bx-sparkles"></i>${escapeHtml(relevance.label)}</span><small>${escapeHtml(relevance.reasons[0])}</small></div>` : '';
      return `<article class="community-user-card" data-community-card="${escapeHtml(user.id)}" tabindex="0" role="button" aria-label="Preview ${escapeHtml(profile.display_name)}'s profile"><div class="community-card-accent ${escapeHtml(profileColor(user))}"></div><div class="community-card-head">${avatarHtml(user)}<div class="community-card-identity"><h3>${escapeHtml(profile.display_name)} ${user.verified ? '<i class="bx bx-badge-check" title="Verified account"></i>' : ''}</h3><p>@${escapeHtml(user.username)} · ${escapeHtml(profile.full_name || profile.display_name)}</p></div><span class="visibility-pill ${escapeHtml(user.visibility)}"><i class="bx ${user.visibility === 'private' ? 'bx-lock-alt' : 'bx-world'}"></i>${escapeHtml(user.visibility)}</span></div>${relevanceMarkup}<p class="community-card-headline">${escapeHtml(profile.headline || profile.professional_role || 'SwapLabs member')}</p><p class="community-card-copy">${escapeHtml(copy)}</p>${user.can_view_full ? `<div class="community-card-meta"><span><i class="bx bx-briefcase-alt-2"></i>${escapeHtml(profile.professional_role || profile.occupation || 'Role not listed')}</span><span><i class="bx bx-map"></i>${escapeHtml([profile.city, profile.country].filter(Boolean).join(', ') || 'Location private')}</span></div><div class="community-card-skill-groups"><div><small>Can teach</small><div class="community-card-skills">${teachSkills.map(skill => `<span>${escapeHtml(skill)}</span>`).join('') || '<span>Skills coming soon</span>'}</div></div><div><small>Learning</small><div class="community-card-skills learning">${learnSkills.map(skill => `<span>${escapeHtml(skill)}</span>`).join('') || '<span>Goals coming soon</span>'}</div></div></div><div class="community-card-proof"><span><strong>${escapeHtml(reputation.rating || 'New')}</strong><small>${reputation.rating ? `<i class="bx bxs-star"></i> ${reputation.review_count} reviews` : 'Building reputation'}</small></span><span><strong>${escapeHtml(reputation.completed_sessions || 0)}</strong><small>sessions</small></span><span><strong>${escapeHtml(user.published_idea_count || 0)}</strong><small>ideas</small></span></div><div class="community-availability ${availability.available_now ? 'online' : ''}"><i class="bx bx-time-five"></i><span>${escapeHtml(availability.label || profile.availability || 'Availability not listed')}</span></div>` : `<div class="community-private-state"><i class="bx bx-lock-alt"></i><strong>Basic preview only.</strong><span>Follow this member to unlock their complete portfolio.</span></div>`}<div class="community-card-meta community-card-social"><span><i class="bx bx-group"></i>${user.followers_count} followers</span><span><i class="bx bx-user-check"></i>${user.following_count} following</span></div><div class="community-card-actions"><button class="btn btn-sm" type="button" data-community-view="${escapeHtml(user.id)}"><i class="bx bx-window-open"></i> Quick preview</button>${communityMessageAction(user, true)}${communityRelationshipAction(user, true)}</div></article>`;
    }).join('');
    bindCommunityActions(host);
  }

  function renderCommunityDrawer(user) {
    const host = $('#communityDrawerContent');
    if (!host) return;
    const profile = user.profile;
    const locked = user.can_view_full === false;
    const reputation = user.reputation || {};
    const topSkills = [...list(profile.skills_to_teach), ...list(profile.skills_to_learn), ...list(profile.languages_to_learn)].slice(0, 6);
    host.innerHTML =
      `<div class="drawer-profile-head">${avatarHtml(user, 'profile-avatar-xl')}<span class="drawer-preview-label">Quick profile preview</span><h2>${escapeHtml(profile.display_name)} ${user.verified ? '<i class="bx bx-badge-check"></i>' : ''}</h2><p>@${escapeHtml(user.username)} · ${escapeHtml(profile.full_name || profile.display_name)}</p><strong class="drawer-headline">${escapeHtml(profile.headline || profile.professional_role || 'SwapLabs member')}</strong><span class="visibility-pill ${escapeHtml(user.visibility)}"><i class="bx ${user.visibility === 'private' ? 'bx-lock-alt' : 'bx-world'}"></i>${escapeHtml(user.visibility)} profile</span><div class="drawer-stats"><div><strong>${user.followers_count}</strong><span>followers</span></div><div><strong>${user.following_count}</strong><span>following</span></div>${locked ? '' : `<div><strong>${escapeHtml(reputation.rating || 'New')}</strong><span>rating</span></div><div><strong>${escapeHtml(user.published_idea_count || 0)}</strong><span>ideas</span></div>`}</div></div>${locked ? `<section class="drawer-section"><div class="community-private-state"><i class="bx bx-lock-alt"></i><strong>Full portfolio access is private.</strong><span>Send a follow request. If ${escapeHtml(profile.display_name)} accepts it from the Inbox, their complete personal and portfolio details will become visible to you.</span></div></section>` : `<section class="drawer-section drawer-preview-facts"><h3>At a glance</h3><div><span><i class="bx bx-briefcase-alt-2"></i> Role</span><strong>${escapeHtml(profile.professional_role || profile.occupation || 'Not listed')}</strong></div><div><span><i class="bx bx-map"></i> Location</span><strong>${escapeHtml([profile.city, profile.country].filter(Boolean).join(', ') || 'Private')}</strong></div><div><span><i class="bx bx-calendar-check"></i> Sessions</span><strong>${escapeHtml(reputation.completed_sessions || 0)} completed</strong></div><div><span><i class="bx bx-shield-quarter"></i> Reliability</span><strong>${reputation.reliability_known ? `${escapeHtml(reputation.reliability_score)}%` : 'No history yet'}</strong></div></section><section class="drawer-section"><h3>Featured skills</h3><div class="member-tags">${topSkills.map(skill => `<span>${escapeHtml(skill)}</span>`).join('') || '<span>Not listed</span>'}</div></section>`}<section class="drawer-section drawer-portfolio-cta"><i class="bx bx-id-card"></i><div><h3>Open the complete portfolio</h3><p>See all permitted personal details, teaching and learning goals, achievements, workshops, activity, and published ideas.</p></div><a class="btn btn-primary" href="member-profile.html?user=${encodeURIComponent(user.id)}">View full profile <i class="bx bx-right-arrow-alt"></i></a><div class="drawer-inline-actions">${communityMessageAction(user)}${communityRelationshipAction(user)}</div></section>`;
      `<div class="drawer-profile-head">${avatarHtml(user, 'profile-avatar-xl')}<span class="drawer-preview-label">Quick profile preview</span><h2>${escapeHtml(profile.display_name)} ${user.verified ? '<i class="bx bx-badge-check"></i>' : ''}</h2><p>@${escapeHtml(user.username)} · ${escapeHtml(profile.full_name || profile.display_name)}</p><strong class="drawer-headline">${escapeHtml(profile.headline || profile.professional_role || 'SwapLabs member')}</strong><span class="visibility-pill ${escapeHtml(user.visibility)}"><i class="bx ${user.visibility === 'private' ? 'bx-lock-alt' : 'bx-world'}"></i>${escapeHtml(user.visibility)} profile</span><div class="drawer-stats"><div><strong>${user.followers_count}</strong><span>followers</span></div><div><strong>${user.following_count}</strong><span>following</span></div>${locked ? '' : `<div><strong>${escapeHtml(reputation.rating || 'New')}</strong><span>rating</span></div><div><strong>${escapeHtml(user.published_idea_count || 0)}</strong><span>ideas</span></div>`}</div></div>${locked ? `<section class="drawer-section"><div class="community-private-state"><i class="bx bx-lock-alt"></i><strong>Full portfolio access is private.</strong><span>Send a follow request. If ${escapeHtml(profile.display_name)} accepts it from the Inbox, their complete personal and portfolio details will become visible to you.</span></div></section>` : `<section class="drawer-section drawer-preview-facts"><h3>At a glance</h3><div><span><i class="bx bx-briefcase-alt-2"></i> Role</span><strong>${escapeHtml(profile.professional_role || profile.occupation || 'Not listed')}</strong></div><div><span><i class="bx bx-map"></i> Location</span><strong>${escapeHtml([profile.city, profile.country].filter(Boolean).join(', ') || 'Private')}</strong></div><div><span><i class="bx bx-calendar-check"></i> Sessions</span><strong>${escapeHtml(reputation.completed_sessions || 0)} completed</strong></div><div><span><i class="bx bx-shield-quarter"></i> Reliability</span><strong>${reputation.reliability_known ? `${escapeHtml(reputation.reliability_score)}%` : 'No history yet'}</strong></div></section><section class="drawer-section"><h3>Featured skills</h3><div class="member-tags">${topSkills.map(skill => `<span>${escapeHtml(skill)}</span>`).join('') || '<span>Not listed</span>'}</div></section>`}<section class="drawer-section drawer-portfolio-cta"><i class="bx bx-id-card"></i><div><h3>Open the complete portfolio</h3><p>See all permitted personal details, teaching and learning goals, achievements, workshops, activity, and published ideas.</p></div><a class="btn btn-primary" href="member-profile.html?user=${encodeURIComponent(user.id)}">View full profile <i class="bx bx-right-arrow-alt"></i></a><div class="drawer-inline-actions">${communityMessageAction(user)}${communityRelationshipAction(user)}</div></section>`;
    host.querySelector('.drawer-profile-head h2')?.setAttribute('id', 'communityDrawerTitle');
    bindCommunityActions(host);
  }

  function openCommunityProfile(userId) {
    const user = state.communityUsers.find(candidate => candidate.id === userId);
    if (!user) return;
    const drawer = $('#communityDrawer');
    if (!drawer) return;
    if (drawer.hidden) {
      state.communityPreviewTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    renderCommunityDrawer(user);
    drawer.hidden = false;
    $('#communityDrawerBackdrop').hidden = false;
    document.body.classList.add('community-preview-open');
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => $('#communityDrawerClose')?.focus(), 40);
  }

  function closeCommunityProfile() {
    const drawer = $('#communityDrawer');
    if (!drawer) return;
    drawer.hidden = true;
    $('#communityDrawerBackdrop').hidden = true;
    document.body.classList.remove('community-preview-open');
    document.body.style.overflow = '';
    const trigger = state.communityPreviewTrigger;
    state.communityPreviewTrigger = null;
    if (trigger?.isConnected && typeof trigger.focus === 'function') trigger.focus();
  }

  window.SwapLabsProfilePreview = {
    open: openCommunityProfile,
    close: closeCommunityProfile
  };

  async function changeCommunityFollow(userId, remove, button) {
    if (!state.user) {
      location.href = 'login.html';
      return;
    }
    loading(button, true, remove ? 'Updating' : 'Sending');
    try {
      const result = await api(`/api/community/users/${encodeURIComponent(userId)}/follow`, {
        method: remove ? 'DELETE' : 'POST'
      });
      toast(result.message);
      await loadCommunity(false);
      const drawer = $('#communityDrawer');
      if (drawer && !drawer.hidden) openCommunityProfile(userId);
      if ($('#memberPortfolioContent')) await loadMemberPortfolio(userId);
      refreshNotificationBadge();
    } catch (error) {
      toast(error.message, 'error');
      loading(button, false);
    }
  }

  async function loadCommunity(setupFilters = true) {
    try {
      const result = await api('/api/community');
      state.communityUsers = result.users;
      if ($('#communityTotal')) {
        $('#communityTotal').textContent = result.stats.total;
        $('#communityPublic').textContent = result.stats.public;
        $('#communityPrivate').textContent = result.stats.private;
        $('#communityCountries').textContent = result.stats.countries;
        $('#communityIdeas').textContent = result.stats.published_ideas || 0;
      }
      if (setupFilters) {
        const countries = [...new Set(result.users.map(user => user.profile.country).filter(value => value &&
          value !== 'Private'))].sort();
        const select = $('#communityCountryFilter');
        if (select) select.innerHTML = '<option value="all">All countries</option>' + countries.map(country =>
          `<option value="${escapeHtml(country)}">${escapeHtml(country)}</option>`).join('');
        const skills = [...new Set(result.users.flatMap(user => [
          ...list(user.profile.skills_to_teach), ...list(user.profile.skills_to_learn), ...list(user.profile.languages_to_learn)
        ]))].sort((a, b) => a.localeCompare(b));
        const skillSelect = $('#communitySkillFilter');
        if (skillSelect) skillSelect.innerHTML = '<option value="all">All skills</option>' + skills.map(item =>
          `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
      }
      renderCommunityUsers();
    } catch (error) {
      const host = $('#communityUserGrid');
      if (host) host.innerHTML =
        `<div class="community-loading"><i class="bx bx-error-circle"></i>${escapeHtml(error.message)}</div>`;
    }
  }

  function setupCommunityPage() {
    if (!$('#communityUserGrid')) return;
    loadCommunity().then(() => {
      const requested = new URLSearchParams(location.search).get('user');
      if (requested) openCommunityProfile(requested);
    });
    ['communitySearch', 'communityVisibilityFilter', 'communityCountryFilter', 'communitySkillFilter',
      'communitySort'
    ].forEach(id => {
      const element = document.getElementById(id);
      element?.addEventListener(id === 'communitySearch' ? 'input' : 'change', renderCommunityUsers);
    });
    $('#communityClear')?.addEventListener('click', () => {
      $('#communitySearch').value = '';
      $('#communityVisibilityFilter').value = 'all';
      $('#communityCountryFilter').value = 'all';
      $('#communitySkillFilter').value = 'all';
      $('#communitySort').value = 'relevance';
      renderCommunityUsers();
    });
    $('#communityDrawerClose')?.addEventListener('click', closeCommunityProfile);
    $('#communityDrawerBackdrop')?.addEventListener('click', closeCommunityProfile);
    document.addEventListener('click', event => {
      const trigger = event.target.closest?.('[data-community-profile]');
      if (!trigger) return;
      const userId = trigger.dataset.communityProfile;
      if (!state.communityUsers.some(user => user.id === userId)) return;
      event.preventDefault();
      openCommunityProfile(userId);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeCommunityProfile();
      if (event.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) {
        event.preventDefault();
        $('#communitySearch')?.focus();
      }
    });
  }


  const compactNumber = value => new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(Number(value || 0));

  const portfolioDate = value => {
    if (!value) return 'Not listed';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium'
    }).format(parsed);
  };

  const safeWebsite = value => {
    try {
      const url = new URL(String(value || ''));
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_error) {
      return '';
    }
  };

  const portfolioFunding = idea => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: idea.funding_currency || 'USD',
        maximumFractionDigits: 0
      }).format(Number(idea.funding_needed || 0));
    } catch (_error) {
      return `${escapeHtml(idea.funding_currency || 'USD')} ${Number(idea.funding_needed || 0).toLocaleString()}`;
    }
  };

  function portfolioPanelHeading(icon, eyebrow, title, copy = '') {
    return `<header class="portfolio-panel-heading"><span class="portfolio-panel-icon"><i class="bx ${icon}"></i></span><div><span>${escapeHtml(eyebrow)}</span><h2>${escapeHtml(title)}</h2>${copy ? `<p>${escapeHtml(copy)}</p>` : ''}</div></header>`;
  }

  function portfolioTags(values, emptyText = 'Not listed yet') {
    const items = list(values);
    return items.length ? `<div class="portfolio-tag-list">${items.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` :
      `<p class="portfolio-empty-copy">${escapeHtml(emptyText)}</p>`;
  }

  function portfolioDetail(icon, label, value, html = '') {
    if (!value && !html) return '';
    return `<div class="portfolio-detail-row"><span class="portfolio-detail-icon"><i class="bx ${icon}"></i></span><div><small>${escapeHtml(label)}</small>${html || `<strong>${escapeHtml(value)}</strong>`}</div></div>`;
  }

  const isAdministratorPortfolio = user => user?.account_type === 'administrator' || user?.role === 'admin';
  const portfolioAdministratorNote = () => `<span class="portfolio-admin-access-note"><i class="bx bx-shield-quarter"></i> SwapLabs administrator profile</span>`;

  function memberPortfolioActions(user) {
    if (user.relationship === 'self') {
      return `<a class="btn btn-primary" href="profile.html"><i class="bx bx-edit-alt"></i> Edit my profile</a><a class="btn" href="skill-innovation.html#submitIdea"><i class="bx bx-bulb"></i> Publish an idea</a>`;
    }
    if (isAdministratorPortfolio(user)) return portfolioAdministratorNote();
    if (!state.user) {
      return `<a class="btn btn-primary" href="login.html"><i class="bx bx-log-in"></i> Log in to connect</a>`;
    }
    return `${communityMessageAction(user)}${communityRelationshipAction(user)}${state.user ? `<a class="btn" href="calendar.html?participant=${encodeURIComponent(user.id)}"><i class="bx bx-calendar-plus"></i> Schedule</a>` : ''}`;
  }

  function renderPortfolioIdentity(user) {
    const profile = user.profile;
    const administrator = isAdministratorPortfolio(user);
    $('#memberPortfolioIdentity').innerHTML = `${avatarHtml(user, 'portfolio-avatar')}<div class="portfolio-identity-copy"><div class="portfolio-identity-labels"><span class="visibility-pill ${escapeHtml(user.visibility)}"><i class="bx ${user.visibility === 'private' ? 'bx-lock-alt' : 'bx-world'}"></i>${escapeHtml(user.visibility)} profile</span>${administrator ? '<span class="portfolio-admin-badge"><i class="bx bx-shield-quarter"></i> SwapLabs administrator</span>' : ''}${user.verified ? '<span class="portfolio-verified"><i class="bx bx-badge-check"></i> Verified member</span>' : ''}${user.is_minor ? `<span class="portfolio-student-safe"><i class="bx bx-shield-quarter"></i> Student-safe profile</span>` : ''}</div><h1>${escapeHtml(profile.display_name)}</h1><p class="portfolio-username">@${escapeHtml(user.username)} · ${escapeHtml(profile.full_name || profile.display_name)}</p><p class="portfolio-headline">${escapeHtml(profile.headline || profile.professional_role || (administrator ? 'SwapLabs administrator' : 'SwapLabs community member'))}</p><div class="portfolio-identity-meta"><span><i class="bx bx-briefcase-alt-2"></i>${escapeHtml(profile.professional_role || profile.occupation || (administrator ? 'Platform administrator' : 'Role not listed'))}</span><span><i class="bx bx-map"></i>${escapeHtml(user.can_view_full ? ([profile.city, profile.country].filter(Boolean).join(', ') || 'Location private') : 'Location private')}</span><span><i class="bx bx-calendar"></i>Joined ${escapeHtml(portfolioDate(user.joined_at))}</span></div></div>`;
    $('#memberPortfolioActions').innerHTML = memberPortfolioActions(user);
  }

  function renderPortfolioStats(portfolio) {
    const user = portfolio.user;
    const stats = portfolio.stats || {};
    const cards = portfolio.locked ? [
      ['bx-group', stats.followers || 0, 'Followers'],
      ['bx-user-check', stats.following || 0, 'Following'],
      [user.visibility === 'private' ? 'bx-lock-alt' : 'bx-world', user.visibility, 'Profile access'],
      ['bx-calendar', new Date(user.joined_at || 0).getFullYear() || '—', 'Member since']
    ] : [
      ['bxs-star', stats.rating ? stats.rating.toFixed(1) : 'New', `${stats.review_count || 0} reviews`],
      ['bx-calendar-check', compactNumber(stats.completed_sessions), 'Completed sessions'],
      ['bx-shield-quarter', stats.reliability_known ? `${stats.reliability_score}%` : 'No history', 'Recorded completion ratio'],
      ['bx-bulb', compactNumber(stats.published_ideas), 'Published ideas'],
      ['bx-group', compactNumber(stats.followers), 'Followers'],
      ...(user.relationship === 'self' || isAdministratorPortfolio(user) ? [['bx-star', compactNumber(stats.points), 'Private portfolio points']] : [])
    ];
    $('#memberPortfolioStats').innerHTML = cards.map(([icon, value, label]) =>
      `<article><span><i class="bx ${icon}"></i></span><div><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></div></article>`
    ).join('');
  }

  function renderLockedPortfolio(portfolio) {
    const user = portfolio.user;
    const profile = user.profile;
    $('#memberPortfolioAbout').innerHTML = `${portfolioPanelHeading('bx-user', 'Basic profile', 'What is currently visible')}<p class="portfolio-about-copy">This member has chosen a private profile. You can still see the basic identity and request access to the rest.</p><div class="portfolio-privacy-note"><i class="bx bx-lock-alt"></i><div><strong>This complete portfolio is private.</strong><span>${state.user ? `Send a follow request to ${escapeHtml(profile.display_name)}. Their personal details, skills, availability, achievements, workshops, and ideas will appear after they accept.` : 'Log in and send a follow request to request access to this member portfolio.'}</span></div></div>`;
    $('#memberPortfolioDetails').innerHTML = `${portfolioPanelHeading('bx-id-card', 'Identity basics', 'Visible profile details')}<div class="portfolio-detail-list">${portfolioDetail('bx-user', 'Display name', profile.display_name)}${portfolioDetail('bx-at', 'Username', `@${user.username}`)}${portfolioDetail('bx-id-card', 'Full name', profile.full_name || profile.display_name)}${portfolioDetail('bx-briefcase-alt-2', 'Role', 'Private profile')}</div>`;
    const connectionActions = isAdministratorPortfolio(user) ? portfolioAdministratorNote() : `${communityRelationshipAction(user)}${communityMessageAction(user)}`;
    $('#memberPortfolioConnection').innerHTML = `${portfolioPanelHeading('bx-user-plus', 'Portfolio access', 'Connect respectfully')}<p>Private profiles reveal only basic identity information until the owner accepts a follow request.</p><div class="portfolio-sidebar-actions">${connectionActions}</div>`;
    $('#memberPortfolioSkills').hidden = false;
    $('#memberPortfolioSkills').innerHTML = `<div class="portfolio-locked-main"><span><i class="bx bx-lock-alt"></i></span><div><span class="eyebrow">Protected portfolio</span><h2>More becomes visible after approval.</h2><p>SwapLabs does not expose private personal information, exact student details, learning activity, or portfolio work without the account owner's permission.</p></div></div>`;
    ['memberPortfolioIdeas', 'memberPortfolioAchievements', 'memberPortfolioWorkshops', 'memberPortfolioActivity']
      .forEach(id => document.getElementById(id).hidden = true);
  }

  function renderPortfolioAbout(portfolio) {
    const user = portfolio.user;
    const profile = user.profile;
    const website = safeWebsite(profile.website);
    const featuredLinks = list(portfolio.portfolio?.links).map(link => ({
      label: String(link?.label || '').trim(),
      href: safeWebsite(link?.href)
    })).filter(link => link.label && link.href).slice(0, 6);
    const featuredLinksMarkup = featuredLinks.length ? `<div class="portfolio-featured-links"><small>Featured links</small>${featuredLinks.map(link => `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer"><i class="bx bx-link-external"></i><span>${escapeHtml(link.label)}</span></a>`).join('')}</div>` : '';
    $('#memberPortfolioAbout').innerHTML = `${portfolioPanelHeading('bx-user-voice', 'Introduction', 'About this member')}<p class="portfolio-about-copy">${escapeHtml(profile.bio || 'This member has not added a full biography yet.')}</p>${portfolioTags(profile.interests, 'No interests have been added yet.')}${featuredLinksMarkup}`;
    const location = [profile.city, profile.country].filter(Boolean).join(', ');
    const age = user.is_minor ? profile.age_group || 'Protected student age' : profile.age ? `${profile.age} years old` : '';
    const languages = [profile.primary_language, ...list(profile.additional_languages)].filter(Boolean).join(', ');
    $('#memberPortfolioDetails').innerHTML = `${portfolioPanelHeading('bx-detail', 'Personal profile', 'All permitted details')}<div class="portfolio-detail-list">${portfolioDetail('bx-id-card', 'Full name', profile.full_name || profile.display_name)}${portfolioDetail('bx-body', 'Pronouns', profile.pronouns)}${portfolioDetail('bx-calendar', 'Age', age)}${portfolioDetail('bx-cake', 'Date of birth', profile.date_of_birth ? portfolioDate(profile.date_of_birth) : '')}${portfolioDetail('bx-map', 'Location', location || 'Private')}${portfolioDetail('bx-briefcase-alt-2', 'Occupation', profile.occupation || profile.professional_role)}${portfolioDetail('bx-buildings', 'Organization', profile.organization)}${portfolioDetail('bx-world', 'Languages', languages)}${portfolioDetail('bx-time-five', 'Timezone', profile.timezone)}${portfolioDetail('bx-laptop', 'Preferred format', profile.preferred_format)}${portfolioDetail('bx-bar-chart-alt-2', 'Experience level', profile.experience_level)}${portfolioDetail('bx-chalkboard', 'Teaching style', profile.teaching_style)}${portfolioDetail('bx-calendar-check', 'Usual availability', profile.availability)}${website ? portfolioDetail('bx-link-external', 'Website', '', `<a href="${escapeHtml(website)}" target="_blank" rel="noopener">${escapeHtml(website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}<i class="bx bx-link-external"></i></a>`) : ''}${portfolioDetail('bx-calendar', 'Joined SwapLabs', portfolioDate(user.joined_at))}</div>`;

    const availability = user.availability || {};
    $('#memberPortfolioConnection').innerHTML = `${portfolioPanelHeading('bx-transfer-alt', 'Connect', 'Plan a useful exchange')}<div class="portfolio-availability-card ${availability.available_now ? 'online' : ''}"><span><i class="bx ${availability.available_now ? 'bx-radio-circle-marked' : 'bx-time-five'}"></i></span><div><small>${availability.available_now ? 'Available now' : 'Availability insight'}</small><strong>${escapeHtml(availability.label || profile.availability || 'Availability not listed')}</strong>${availability.overlap_minutes_next_8_days ? `<p>${escapeHtml(compactNumber(availability.overlap_minutes_next_8_days))} minutes of overlap in the next eight days.</p>` : ''}</div></div><div class="portfolio-sidebar-actions">${memberPortfolioActions(user)}</div>`;
  }

  function renderPortfolioSkills(portfolio) {
    const profile = portfolio.user.profile;
    const skillsHost = $('#memberPortfolioSkills');
    skillsHost.hidden = false;
    skillsHost.innerHTML = `${portfolioPanelHeading('bx-transfer-alt', 'Skill exchange', 'What this member brings and wants to build', 'Review teaching strengths, learning goals, interests, and preferred ways of working before starting a conversation.')}<div class="portfolio-skill-columns"><article><span class="portfolio-skill-icon teach"><i class="bx bx-chalkboard"></i></span><h3>Can teach</h3>${portfolioTags(profile.skills_to_teach, 'No teaching skills listed yet.')}</article><article><span class="portfolio-skill-icon learn"><i class="bx bx-book-reader"></i></span><h3>Wants to learn</h3>${portfolioTags([...list(profile.skills_to_learn), ...list(profile.languages_to_learn)], 'No learning skills or languages listed yet.')}</article><article><span class="portfolio-skill-icon style"><i class="bx bx-shape-circle"></i></span><h3>Learning setup</h3><dl class="portfolio-mini-facts"><div><dt>Experience</dt><dd>${escapeHtml(profile.experience_level || 'Flexible')}</dd></div><div><dt>Teaching</dt><dd>${escapeHtml(profile.teaching_style || 'Flexible')}</dd></div><div><dt>Format</dt><dd>${escapeHtml(profile.preferred_format || 'Flexible')}</dd></div></dl></article></div><div class="portfolio-learning-goal"><span><i class="bx bx-target-lock"></i></span><div><small>Current learning goal</small><p>${escapeHtml(profile.learning_goal || 'No learning goal has been shared yet.')}</p></div></div>`;
  }

  function renderPortfolioIdeas(portfolio) {
    const host = $('#memberPortfolioIdeas');
    host.hidden = false;
    const ideas = portfolio.ideas || [];
    host.innerHTML = `${portfolioPanelHeading('bx-bulb', 'Skills & Innovation', 'Published ideas', 'Ideas this member has chosen to share with the community, including the problem, proposed solution, support, and collaboration needs.')}<div class="portfolio-idea-grid">${ideas.length ? ideas.map(idea => `<article class="portfolio-idea-card"><div class="portfolio-idea-top"><span class="portfolio-idea-category"><i class="bx bx-category"></i>${escapeHtml(idea.category || 'Open category')}</span><span class="portfolio-idea-status">${escapeHtml(String(idea.status || 'published').replaceAll('_', ' '))}</span></div><h3>${escapeHtml(idea.title)}</h3><p class="portfolio-idea-tagline">${escapeHtml(idea.tagline || '')}</p><div class="portfolio-idea-summary"><div><small>Problem</small><p>${escapeHtml(idea.problem || 'Not provided')}</p></div><div><small>Proposed solution</small><p>${escapeHtml(idea.solution || 'Not provided')}</p></div></div><div class="portfolio-idea-meta"><span><i class="bx bx-layer"></i>${escapeHtml(idea.stage || 'Idea stage')}</span><span><i class="bx bx-wallet"></i>${portfolioFunding(idea)} sought</span><span><i class="bx bx-map-alt"></i>${escapeHtml(idea.reach || 'Reach not listed')}</span></div>${portfolioTags(idea.skills_needed, 'No collaboration skills listed.')}<footer><div><span><i class="bx bx-like"></i>${idea.like_count || 0}</span><span><i class="bx bx-message-rounded-dots"></i>${idea.comment_count || 0}</span><span><i class="bx bx-bookmark"></i>${idea.save_count || 0}</span></div><a href="skill-innovation.html?idea=${encodeURIComponent(idea.id)}">Explore idea <i class="bx bx-right-arrow-alt"></i></a></footer></article>`).join('') : `<div class="portfolio-empty-state"><i class="bx bx-bulb"></i><h3>No published ideas yet</h3><p>When this member publishes work in Skills & Innovation, it will become part of their portfolio here.</p></div>`}</div>`;
  }

  function renderPortfolioAchievements(portfolio) {
    const host = $('#memberPortfolioAchievements');
    host.hidden = false;
    const achievements = portfolio.achievements || [];
    host.innerHTML = `${portfolioPanelHeading('bx-award', 'Trust and progress', 'Achievements')}<div class="portfolio-achievement-grid">${achievements.length ? achievements.map(item => `<article><span><i class="bx ${escapeHtml(item.icon)}"></i></span><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p></div></article>`).join('') : `<div class="portfolio-empty-state compact"><i class="bx bx-award"></i><h3>Achievements are being built</h3><p>Verified sessions, reliable participation, workshops, and innovation contributions create portfolio achievements.</p></div>`}</div>`;
  }

  function renderPortfolioWorkshops(portfolio) {
    const host = $('#memberPortfolioWorkshops');
    host.hidden = false;
    const workshops = portfolio.workshops || [];
    host.innerHTML = `${portfolioPanelHeading('bx-chalkboard', 'Community teaching', 'Workshops hosted')}<div class="portfolio-workshop-list">${workshops.length ? workshops.map(item => `<article><div class="portfolio-workshop-date"><strong>${escapeHtml(new Intl.DateTimeFormat(undefined, {day:'2-digit'}).format(new Date(item.starts_at)))}</strong><span>${escapeHtml(new Intl.DateTimeFormat(undefined, {month:'short'}).format(new Date(item.starts_at)))}</span></div><div><span class="portfolio-workshop-label">${escapeHtml(item.category || 'Workshop')} · ${escapeHtml(item.level || 'All levels')}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description || '')}</p><div class="portfolio-workshop-meta"><span><i class="bx bx-video"></i>${escapeHtml(item.format || 'Session')}</span><span><i class="bx bx-time-five"></i>${escapeHtml(item.duration_minutes || 0)} minutes</span><span><i class="bx bx-group"></i>${escapeHtml(item.registered_count || 0)} registered</span></div></div><a class="btn btn-sm" href="workshops.html"><i class="bx bx-right-arrow-alt"></i></a></article>`).join('') : `<div class="portfolio-empty-state compact"><i class="bx bx-chalkboard"></i><h3>No hosted workshops yet</h3><p>Future workshops created by this member will be showcased here.</p></div>`}</div>`;
  }

  function renderPortfolioActivity(portfolio) {
    const host = $('#memberPortfolioActivity');
    host.hidden = false;
    const activity = portfolio.activity || [];
    const projects = portfolio.projects || [];
    const projectMarkup = projects.length ? `<div class="portfolio-project-showcase">${projects.slice(0, 8).map(item => `<article><div class="portfolio-project-showcase-top"><span><i class="bx ${item.source === 'swapjob' ? 'bx-briefcase-alt-2' : 'bx-edit-alt'}"></i>${item.source === 'swapjob' ? 'Completed SwapLabs Task' : 'Portfolio project'}</span><div><small><i class="bx ${item.visibility === 'public' ? 'bx-world' : 'bx-lock-alt'}"></i>${escapeHtml(item.visibility || 'public')}</small>${item.points_awarded ? `<small class="portfolio-project-points"><i class="bx bx-star"></i> +${escapeHtml(item.points_awarded)} points</small>` : ''}</div></div><h3>${escapeHtml(item.title || 'Portfolio project')}</h3><p>${escapeHtml(item.summary || '')}</p><div>${(item.skills || []).slice(0, 4).map(skill => `<span>${escapeHtml(skill)}</span>`).join('')}</div>${item.evidence_url ? `<a href="${escapeHtml(item.evidence_url)}" target="_blank" rel="noopener">View evidence <i class="bx bx-link-external"></i></a>` : ''}</article>`).join('')}</div>` : '';
    host.innerHTML = `${portfolioPanelHeading('bx-pulse', 'Public contributions', 'Portfolio activity')}${projectMarkup}<div class="portfolio-activity-list">${activity.length ? activity.map(item => `<a href="${escapeHtml(item.href || '#')}" class="portfolio-activity-item"><span><i class="bx ${escapeHtml(item.icon || 'bx-radio-circle')}"></i></span><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description || '')}</p></div><time>${escapeHtml(portfolioDate(item.at))}</time><i class="bx bx-chevron-right"></i></a>`).join('') : `<div class="portfolio-empty-state compact"><i class="bx bx-pulse"></i><h3>No public portfolio activity yet</h3><p>Published ideas, hosted workshops, and completed SwapLabs Tasks will appear in this timeline.</p></div>`}</div>`;
  }

  function renderMemberPortfolio(portfolio) {
    const user = portfolio.user;
    const profile = user.profile;
    // The profile owner supplies this color, even for a locked profile. A
    // separately saved portfolio theme (or the viewer's settings) must not
    // override the accent chosen in the member's Profile settings.
    const accent = profileColor(user);
    document.title = `${profile.display_name} — SwapLabs Portfolio`;
    document.querySelector('.member-portfolio-page')?.setAttribute('data-portfolio-accent', accent);
    $('#memberPortfolioState').hidden = true;
    $('#memberPortfolioContent').hidden = false;
    renderPortfolioIdentity(user);
    renderPortfolioStats(portfolio);
    if (portfolio.locked) {
      renderLockedPortfolio(portfolio);
    } else {
      renderPortfolioAbout(portfolio);
      renderPortfolioSkills(portfolio);
      renderPortfolioIdeas(portfolio);
      renderPortfolioAchievements(portfolio);
      renderPortfolioWorkshops(portfolio);
      renderPortfolioActivity(portfolio);
    }
    bindCommunityActions($('#memberPortfolioContent'));
  }

  function renderPortfolioError(message) {
    const stateHost = $('#memberPortfolioState');
    $('#memberPortfolioContent').hidden = true;
    stateHost.hidden = false;
    stateHost.innerHTML = `<div class="container"><div class="portfolio-error-card"><i class="bx bx-user-x"></i><h1>Portfolio unavailable</h1><p>${escapeHtml(message)}</p><a class="btn btn-primary" href="community.html#communityDirectory"><i class="bx bx-left-arrow-alt"></i> Return to members</a></div></div>`;
  }

  async function loadMemberPortfolio(userId) {
    if (!userId) {
      renderPortfolioError('Choose a member from the community directory to open their portfolio.');
      return;
    }
    try {
      const result = await api(`/api/community/users/${encodeURIComponent(userId)}/portfolio`);
      renderMemberPortfolio(result.portfolio);
    } catch (error) {
      renderPortfolioError(error.message);
    }
  }

  function setupMemberPortfolioPage() {
    if (!$('#memberPortfolioState')) return;
    const params = new URLSearchParams(location.search);
    loadMemberPortfolio(params.get('user') || params.get('id'));
  }

  function notificationIcon(type) {
    return type === 'follow_request' ? 'bx-user-plus' : type === 'follow_accepted' ? 'bx-user-check' :
      type === 'follow_declined' ? 'bx-user-x' : type === 'new_follower' ? 'bx-group' :
      type?.startsWith('study_') ? (type === 'study_message' ? 'bx-message-square-dots' : type === 'study_session_completed' ? 'bx-check-circle' : 'bx-group') : 'bx-bell';
  }

  function renderNotificationCenter(result) {
    const requests = result.incoming_requests || [];
    const notifications = result.notifications || [];
    $('#followRequestCount') && ($('#followRequestCount').textContent = `${requests.length} pending`);
    if ($('#followRequestEmpty')) $('#followRequestEmpty').hidden = requests.length > 0;
    const requestHost = $('#followRequestList') || $('#followRequestStack');
    if (requestHost) requestHost.innerHTML = requests.map(item => {
      const requester = item.requester;
      return `<article class="follow-request-card"><div class="follow-request-user">${avatarHtml(requester)}<div><h3>${escapeHtml(requester.profile.display_name)}</h3><p>@${escapeHtml(requester.username)} · ${escapeHtml(requester.profile.full_name || requester.profile.display_name)}</p></div></div><p>${escapeHtml(requester.profile.headline || 'This member would like permission to view your private profile.')}</p><div class="follow-request-actions"><button class="btn btn-primary btn-sm" type="button" data-follow-accept="${escapeHtml(item.id)}"><i class="bx bx-check"></i> Accept</button><button class="btn btn-danger btn-sm" type="button" data-follow-decline="${escapeHtml(item.id)}"><i class="bx bx-trash"></i> Delete</button><a class="btn btn-sm" href="community.html?user=${encodeURIComponent(requester.id)}#communityDirectory" aria-label="View requester profile"><i class="bx bx-show"></i></a></div></article>`;
    }).join('');
    const feed = $('#notificationFeed');
    const followingActivity = (result.following_activity || []).slice(0, 4);
    if (feed) {
      if ($('#notificationEmpty')) $('#notificationEmpty').hidden = notifications.length > 0 || followingActivity.length > 0;
      feed.innerHTML = notifications.map(item =>
        `<article class="notification-item ${item.read ? '' : 'unread'}">${item.actor ? avatarHtml(item.actor) : `<span class="notification-system-icon"><i class="bx ${notificationIcon(item.type)}"></i></span>`}<div class="notification-copy"><strong>${escapeHtml(item.title || notificationLabel(item.type))}</strong><p>${escapeHtml(item.message)}</p><time>${escapeHtml(formatDate(item.created_at))}</time>${item.type === 'new_follower' && item.actor ? notificationNavActionMarkup(item) : ''}</div>${item.read ? '' : `<button class="notification-read-button" type="button" data-notification-read="${escapeHtml(item.id)}"><i class="bx bx-check"></i> Mark read</button>`}</article>`
        ).join('') + (followingActivity.length ? `<div class="notification-following-summary"><strong><i class="bx bx-user-check"></i> People you follow</strong>${followingActivity.map(person => `<a href="member-profile.html?user=${encodeURIComponent(person.id)}"><span>${avatarHtml(person)}</span><span><b>${escapeHtml(person.profile.display_name)}</b><small>@${escapeHtml(person.username)}</small></span><i class="bx bx-chevron-right"></i></a>`).join('')}</div>` : '');
    }
    $$('[data-follow-accept]', requestHost || document).forEach(button => button.addEventListener('click', () =>
      respondToFollowRequest(button.dataset.followAccept, true, button)));
    $$('[data-follow-decline]', requestHost || document).forEach(button => button.addEventListener('click', () =>
      respondToFollowRequest(button.dataset.followDecline, false, button)));
    $$('[data-notification-read]', feed || document).forEach(button => button.addEventListener('click', () => markOneNotification(
      button.dataset.notificationRead, button)));
    $$('[data-notification-follow-back]', feed || document).forEach(button => button.addEventListener('click', async () => {
      await notificationFollowBack(button.dataset.notificationFollowBack, button);
      await loadNotificationCenter();
    }));
    $$('[data-notification-remove-follower]', feed || document).forEach(button => button.addEventListener('click', async () => {
      await notificationRemoveFollower(button.dataset.notificationRemoveFollower, button);
      await loadNotificationCenter();
    }));
  }

  async function loadNotificationCenter() {
    const result = await fetchNotifications();
    state.notifications = result;
    renderNotificationCenter(result);
    refreshNotificationBadge();
  }

  function fetchNotifications({force = false} = {}) {
    if (!force && state.notificationRequest) return state.notificationRequest;
    const request = api('/api/notifications').finally(() => {
      if (state.notificationRequest === request) state.notificationRequest = null;
    });
    state.notificationRequest = request;
    return request;
  }

  async function respondToFollowRequest(requestId, accept, button) {
    loading(button, true, accept ? 'Accepting' : 'Deleting');
    try {
      const result = await api(
        `/api/notifications/follow-requests/${encodeURIComponent(requestId)}${accept ? '/accept' : ''}`, {
          method: accept ? 'POST' : 'DELETE'
        });
      toast(result.message);
      await loadNotificationCenter();
    } catch (error) {
      toast(error.message, 'error');
      loading(button, false);
    }
  }

  async function markOneNotification(notificationId, button) {
    loading(button, true, 'Saving');
    try {
      await api(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
        method: 'PATCH'
      });
      await loadNotificationCenter();
    } catch (error) {
      toast(error.message, 'error');
      loading(button, false);
    }
  }

  function setupNotificationsPage() {
    const loadingPanel = $('#notificationLoading');
    if (!loadingPanel) return;
    loadingPanel.hidden = true;
    if (!state.user) {
      $('#notificationLocked').hidden = false;
      return;
    }
    $('#notificationPanel').hidden = false;
    const loadNotificationCenterWhenIdle = () => loadNotificationCenter()
      .then(() => markNotificationsSeen())
      .catch(error => toast(error.message, 'error'));
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(loadNotificationCenterWhenIdle, {timeout: 2500});
    } else {
      window.setTimeout(loadNotificationCenterWhenIdle, 700);
    }
    $('#notificationsReadAll')?.addEventListener('click', async () => {
      try {
        await api('/api/notifications/read-all', {
          method: 'POST'
        });
        await loadNotificationCenter();
        toast('All notifications marked as read.');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  async function addLiveMemberDirectory() {
    // The dedicated members directory owns this route. Keep the legacy
    // injection as a compatibility fallback for older copies of the page, but
    // never append a second directory beside the new filterable surface.
    if (currentPage !== 'talent-directory.html' || !state.user || document.querySelector('[data-member-directory]')) return;
    try {
      const result = await api('/api/members');
      const section = document.createElement('section');
      section.className = 'member-directory-section';
      section.innerHTML =
        `<div class="container"><div class="section-head"><span class="eyebrow">Registered community</span><h2>Live member profiles</h2><p>This directory is generated from saved member profiles. It is read-only for members and reflects profile changes across the platform.</p></div><div class="live-member-grid">${result.members.map(user => `<article class="live-member-card"><div class="live-member-head">${avatarHtml(user)}<div><h3>${escapeHtml(user.profile.display_name)} ${user.verified ? '<i class="bx bx-badge-check" title="Verified"></i>' : ''}</h3><p>${escapeHtml(user.profile.headline || user.profile.occupation || 'SwapLabs member')}</p></div></div><div class="member-skill-row"><span>Can teach</span><div class="member-tags">${list(user.profile.skills_to_teach).slice(0, 4).map(skill => `<span>${escapeHtml(skill)}</span>`).join('') || '<span>Not listed</span>'}</div></div><div class="member-skill-row"><span>Wants to learn</span><div class="member-tags">${list(user.profile.skills_to_learn).slice(0, 4).map(skill => `<span>${escapeHtml(skill)}</span>`).join('') || '<span>Not listed</span>'}</div></div></article>`).join('')}</div></div>`;
      $('main')?.appendChild(section);
    } catch (_error) {
      // Directory stays absent if the account loses access during the request.
    }
  }

  async function initialize() {
    const standalonePreRegistration = isPreRegistrationPage();
    setupPasswordToggles();
    setupNewsletterForm();
    if (!standalonePreRegistration) {
      // Paint the shared header from the last validated session immediately.
      // This is only a visual hint; every private operation still waits for the
      // live /api/auth/me response below.
      const cachedUser = window.SwapLabsAuth?.snapshot?.();
      if (cachedUser) {
        state.user = cachedUser;
        renderAccountNavigation();
        refreshStreakNavigation();
        window.dispatchEvent(new CustomEvent('swaplabs:auth-state', {
          detail: {authenticated: true, user: cachedUser, cached: true}
        }));
      }
      try {
        const result = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me'));
        state.user = result.authenticated ? result.user : null;
        state.csrf = result.csrf_token || state.csrf;
        if (state.user) {
          const localPreferences = window.SwapLabsPreferences?.read?.() || {};
          const localThemeIsSet = window.SwapLabsPreferences?.hasStored?.('theme');
          const effectivePreferences = {
            ...(state.user.preferences || {}),
            ...(localThemeIsSet ? {theme: localPreferences.theme} : {})
          };
          state.user.preferences = effectivePreferences;
          window.SwapLabsPreferences?.apply(effectivePreferences);
        }
      } catch (_error) {
        state.serverAvailable = false;
        showServerRequired();
      }
      window.dispatchEvent(new CustomEvent('swaplabs:auth-state', {
        detail: {authenticated: Boolean(state.user), user: state.user}
      }));
      if (state.user) startPresenceHeartbeat();
      else stopPresenceHeartbeat();
      if (state.user) {
        const checkCurrentAccess = async () => {
          if (document.hidden) return;
          try {
            const access = await api('/api/auth/me');
            if (!access.authenticated) {
              sessionStorage.setItem('swaplabs-access-notice', access.error ||
                'Your session ended. Sign in again to continue.');
              location.replace(`login.html${access.access_status === 'suspended' ? '?access=suspended' : ''}`);
            }
          } catch (_error) {
            /* A temporary server interruption should not erase the current page. */
          }
        };
        state.accessWatch = setInterval(checkCurrentAccess, 60000);
        document.addEventListener('visibilitychange', checkCurrentAccess);
        window.addEventListener('focus', checkCurrentAccess);
      }
    }
    if (!standalonePreRegistration) {
      renderAccountNavigation();
      const inboxPage = currentPage === 'notifications.html' || Boolean(document.querySelector('[data-operations-page="inbox"]'));
      // Chats owns its inbox request and emits a confirmed read event after
      // the first conversation is ready. Avoid competing with it for the
      // expensive full notifications snapshot during the critical paint.
      if (!inboxPage) {
        refreshNotificationBadge();
        refreshStreakNavigation();
      } else {
        // If the operations bundle finished before this listener was
        // registered, recover the header badge after the inbox's first paint.
        const refreshInboxBadgeWhenIdle = () => refreshNotificationBadge();
        if (typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(refreshInboxBadgeWhenIdle, {timeout: 3000});
        } else {
          window.setTimeout(refreshInboxBadgeWhenIdle, 1200);
        }
      }
    }
    const page = $('[data-auth-page]')?.dataset.authPage;
    if (page === 'login') setupLoginPage();
    if (page === 'register') setupRegistrationPage();
    if (page === 'profile') setupProfilePage();
    if (page === 'admin') setupAdminPage();
    if (page === 'community') setupCommunityPage();
    if (page === 'member-portfolio') setupMemberPortfolioPage();
    if (page === 'notifications' || currentPage === 'notifications.html') setupNotificationsPage();
    addLiveMemberDirectory();
  }

  initialize();
})();
