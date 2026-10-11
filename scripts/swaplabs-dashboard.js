(() => {
  'use strict';

  const portalType = document.querySelector('[data-member-portal]')?.dataset.memberPortal;
  if (!portalType) return;

  const state = {
    csrf: '',
    user: null,
    dashboard: null
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const {escapeHtml, initials, profileColor, safeAvatarUrl} = window.RelayComponents;
  const asList = value => (Array.isArray(value) ? value.filter(Boolean) : String(value || '').split(',').map(item =>
    item.trim()).filter(Boolean)).filter(item => String(item).trim().toLowerCase() !== 'nothing for now');
  const uniqueList = values => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
  const formatNumber = value => new Intl.NumberFormat().format(Number(value || 0));
  const formatDateTime = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Time to be confirmed' : new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(parsed);
  };
  const avatarUrl = safeAvatarUrl;
  const avatarHtml = (person, className = 'match-avatar') => {
    const url = avatarUrl(person);
    const name = person?.display_name || person?.profile?.display_name || person?.username || 'SwapLabs member';
    const color = escapeHtml(profileColor(person));
    return `<span class="${className} ${color}">${url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)} profile photo">` : escapeHtml(initials(person))}</span>`;
  };

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = {
      ...(options.headers || {})
    };
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      if (!state.csrf) {
        const secure = await fetch('/api/auth/csrf', {
          credentials: 'same-origin'
        });
        if (!secure.ok) throw new Error('Could not create a secure session.');
        state.csrf = (await secure.json()).csrf_token;
      }
      headers['X-CSRF-Token'] = state.csrf;
    }
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
    const payload = await response.json().catch(() => ({
      error: 'The server returned an unreadable response.'
    }));
    if (!response.ok) {
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
      const error = new Error(payload.message || 'Your submission is pending administrator review and is hidden from the platform.');
      error.status = response.status;
      error.code = 'pending_moderation';
      throw error;
    }
    if (payload.csrf_token) state.csrf = payload.csrf_token;
    return payload;
  }

  function reasonRows(reasons = []) {
    return reasons.map(reason => {
      const percent = Math.max(0, Math.min(100, Math.round(Number(reason.points || 0) / Math.max(Number(reason
        .max_points || 1), 1) * 100)));
      return `<li><div class="match-factor-title"><strong>${escapeHtml(reason.label)}</strong><span>${Number(reason.points || 0)}/${Number(reason.max_points || 0)}</span></div><span class="match-factor-bar"><i style="width:${percent}%"></i></span><p>${escapeHtml(reason.explanation)}</p></li>`;
    }).join('');
  }

  function matchCard(match, compact = false) {
    const person = match.candidate;
    const reputation = person.reputation || {};
    const teaches = asList(person.skills_to_teach).slice(0, compact ? 2 : 4);
    const learns = asList(person.skills_to_learn).slice(0, compact ? 1 : 3);
    const categories = asList(person.skill_categories).slice(0, 3);
    const skillGroup = match.skill_group || person.skill_group || categories[0] || '';
    const rating = Number(reputation.review_count || 0) ? `${Number(reputation.rating || 0).toFixed(1)} rating` :
      'New member';
    const availabilityClass = match.availability?.available_now || match.availability?.next_overlap_at ? 'available' :
      'unavailable';
    const quality = ['strong', 'good', 'related', 'discovery'].includes(match.match_quality) ? match.match_quality : 'discovery';
    const qualityMeta = {
      strong: ['bx-check-circle', 'Strong skill fit'],
      good: ['bx-badge-check', 'Good skill fit'],
      related: ['bx-git-compare', 'Related skill fit'],
      discovery: ['bx-compass', 'Discovery suggestion']
    }[quality];
    const explanation = match.top_reasons?.[0] ||
      'A discovery recommendation based on your wider profile preferences.';
    const requestSkill = match.request_skill || teaches[0] || 'a useful skill';
    const requestOffer = match.request_offer || '';
    const exchangeType = match.exchange_type || '';
    const exchangeLabel = exchangeType === 'mutual' ? 'Mutual exchange · no transfer' : exchangeType === 'one_way' ? 'One-way exchange · 1 credit' : '';
    const requestAction = person.swap_requests_available === false ? '' : `<button class="btn btn-primary btn-sm" type="button" data-request-swap-match="${escapeHtml(person.id)}" data-swap-skill="${escapeHtml(requestSkill)}" data-swap-offer="${escapeHtml(requestOffer)}"><i class="bx bx-transfer-alt"></i> Request swap</button>`;
    return `<article class="match-profile-card${compact ? ' compact' : ''}" data-match-id="${escapeHtml(match.id)}">
      <div class="match-profile-top">
        <div class="match-person">${avatarHtml(person)}<div><h3>${escapeHtml(person.display_name)}</h3><span>@${escapeHtml(person.username)}${person.country ? ` · ${escapeHtml(person.country)}` : ''}</span></div></div>
        <div class="match-score-ring small" style="--score:${Number(match.score || 0)}"><strong>${Number(match.score || 0)}</strong><span>match</span></div>
      </div>
      <div class="match-profile-status"><span class="match-quality-pill ${quality}"><i class="bx ${qualityMeta[0]}"></i> ${qualityMeta[1]}</span><span class="availability-pill ${availabilityClass}"><i class="bx bxs-circle"></i> ${escapeHtml(match.availability?.label || 'Availability not set')}</span>${exchangeLabel ? `<span class="skill-category-pill"><i class="bx ${exchangeType === 'mutual' ? 'bx-git-compare' : 'bx-transfer-alt'}"></i> ${exchangeLabel}</span>` : ''}${skillGroup ? `<span class="skill-category-pill"><i class="bx bx-category"></i> ${escapeHtml(skillGroup)}</span>` : ''}${categories.filter(category => category !== skillGroup).map(category => `<span class="skill-category-pill">${escapeHtml(category)}</span>`).join('')}</div>
      <p class="match-headline">${escapeHtml(person.headline || 'SwapLabs member ready to exchange practical knowledge.')}</p>
      <div class="match-skill-block"><span>Can teach</span><div>${teaches.length ? teaches.map(skill => `<b>${escapeHtml(skill)}</b>`).join('') : '<em>No teaching skills listed</em>'}</div></div>
      ${compact ? '' : `<div class="match-skill-block"><span>Wants to learn</span><div>${learns.length ? learns.map(skill => `<b class="soft">${escapeHtml(skill)}</b>`).join('') : '<em>No learning skills listed</em>'}</div></div>`}
      <div class="match-trust-row"><span><i class="bx bx-star"></i> ${escapeHtml(rating)}</span><span><i class="bx bx-check-shield"></i> ${reputation.reliability_known ? `${Number(reputation.reliability_score)}% recorded completion ratio` : 'No attendance history'}</span><span><i class="bx bx-calendar-check"></i> ${Number(reputation.completed_sessions || 0)} sessions</span></div>
      <div class="match-explanation"><i class="bx bx-bulb"></i><p><strong>Best reason:</strong> ${escapeHtml(explanation)}</p></div>
      ${compact ? '' : `<details class="match-reasons"><summary>Why this match? <span>See all scoring factors</span><i class="bx bx-chevron-down"></i></summary><ul>${reasonRows(match.reasons)}</ul></details>`}
      <div class="match-card-actions">${requestAction}<button class="btn btn-sm" type="button" data-message-user="${escapeHtml(person.id)}"><i class="bx bx-message-square-dots"></i> Message</button><a class="btn btn-sm" href="member-profile.html?id=${encodeURIComponent(person.id)}"><i class="bx bx-id-card"></i> View portfolio</a>${compact ? `<a class="text-button" href="skill-matching.html">Why ${Number(match.score || 0)}?</a>` : ''}</div>
    </article>`;
  }

  function emptyBlock(icon, title, text, href, action) {
    return `<div class="dashboard-empty"><i class="bx ${escapeHtml(icon)}"></i><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p></div><a href="${escapeHtml(href)}">${escapeHtml(action)} <i class="bx bx-right-arrow-alt"></i></a></div>`;
  }

  const PROFILE_SETUP_FIELDS = [
    ['first_name', 'First name'], ['last_name', 'Last name'], ['date_of_birth', 'Date of birth'],
    ['country', 'Country'], ['primary_language', 'Primary language'],
    ['skills_to_teach', 'A skill you can teach'], ['skills_to_learn', 'A skill you want to learn'],
    ['learning_goal', 'Main learning goal']
  ];
  const profileSetupFilled = value => Array.isArray(value) ? value.some(profileSetupFilled) : Boolean(String(value ?? '').trim()) && String(value).trim().toLowerCase() !== 'nothing for now';
  const profileSetupMissing = user => PROFILE_SETUP_FIELDS.filter(([field]) => !profileSetupFilled(user?.profile?.[field]));
  const profileSetupSnoozeKey = user => user?.id ? `relayskills-profile-setup-snooze:${user.id}` : '';
  const profileSetupIsSnoozed = user => {
    const key = profileSetupSnoozeKey(user);
    if (!key) return false;
    try { return Number(localStorage.getItem(key) || 0) > Date.now(); } catch (_error) { return false; }
  };
  const profileSetupAnchor = field => ['first_name', 'last_name'].includes(field) ? '#identity' :
    ['date_of_birth', 'country', 'primary_language'].includes(field) ? '#location' : '#learning';
  function setupProfileSetupDialog(payload) {
    const dialog = $('#profileSetupDialog');
    const user = payload?.user;
    if (!dialog || !user || payload?.onboarding_complete || profileSetupIsSnoozed(user)) return;
    const missing = profileSetupMissing(user);
    if (!missing.length) return;
    const list = $('[data-profile-setup-missing]', dialog);
    if (list) list.innerHTML = missing.slice(0, 4).map(([, label]) => `<li><i class="bx bx-circle" aria-hidden="true"></i><span>${escapeHtml(label)}</span></li>`).join('');
    const continueLink = $('[data-profile-setup-continue]', dialog);
    if (continueLink) continueLink.href = `profile.html?complete=1${profileSetupAnchor(missing[0][0])}`;
    if (!dialog.dataset.profileSetupReady) {
      dialog.dataset.profileSetupReady = 'true';
      $('[data-profile-setup-later]', dialog)?.addEventListener('click', () => {
        const key = profileSetupSnoozeKey(user);
        if (key) {
          try { localStorage.setItem(key, String(Date.now() + 24 * 60 * 60 * 1000)); } catch (_error) { /* Storage can be unavailable. */ }
        }
        dialog.close();
      });
      dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    }
    if (!dialog.open) {
      dialog.showModal();
      window.setTimeout(() => $('[data-profile-setup-continue]', dialog)?.focus(), 40);
    }
  }

  function renderDashboard(payload) {
    state.dashboard = payload;
    const firstName = payload.user?.profile?.first_name || payload.user?.profile?.display_name?.split(/\s+/)[0] ||
      'member';
    $('[data-dashboard-first-name]').textContent = firstName;
    $('[data-dashboard-date]').textContent = new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    }).format(new Date());
    Object.entries(payload.summary || {}).forEach(([key, value]) => {
      const target = $(`[data-summary="${key}"]`);
      if (target) target.textContent = formatNumber(value);
    });
    const analytics = payload.analytics || {};
    const setAnalytics = (key, value) => $$(`[data-member-analytics="${key}"]`).forEach(target => target.textContent = value);
    const setAnalyticsDetail = (key, value) => $$(`[data-member-analytics-detail="${key}"]`).forEach(target => target.textContent = value);
    setAnalytics('completed_session_hours', `${Number(analytics.completed_session_hours || 0).toLocaleString()}h`);
    setAnalytics('credits_earned', formatNumber(analytics.credits_earned));
    setAnalyticsDetail('credits_spent', `${formatNumber(analytics.credits_spent)} spent`);
    setAnalytics('conversations', formatNumber(analytics.conversations));
    setAnalyticsDetail('messages_sent', `${formatNumber(analytics.messages_sent)} messages sent`);
    setAnalytics('profile_completeness', `${Number(analytics.profile_completeness || 0)}%`);
    setAnalytics('sessions_completed', formatNumber(analytics.sessions?.completed));
    setAnalytics('sessions_scheduled', formatNumber(analytics.sessions?.scheduled));
    setAnalytics('sessions_cancelled', formatNumber(analytics.sessions?.cancelled));
    setAnalytics('progress_reports', formatNumber(analytics.progress_reports));
    setAnalytics('sessions_needing_progress_report', formatNumber(analytics.sessions_needing_progress_report));
    setAnalytics('workshops_hosted', formatNumber(analytics.workshops_hosted));
    setAnalytics('ideas_published', formatNumber(analytics.ideas_published));
    renderMemberActivityChart(analytics);
    Object.entries(payload.metrics || {}).forEach(([key, value]) => {
      $$(`[data-platform-metric="${key}"]`).forEach(target => {
        target.textContent = formatNumber(value);
      });
    });

    const action = payload.suggested_action || {};
    $('[data-next-action]').innerHTML =
      `<div class="next-action-content"><span class="next-action-icon"><i class="bx ${escapeHtml(action.icon || 'bx-compass')}"></i></span><div><h3>${escapeHtml(action.title || 'Choose your next step')}</h3><p>${escapeHtml(action.description || 'Explore your dashboard and continue learning.')}</p><a class="btn btn-primary" href="${escapeHtml(action.href || 'browse-skills.html')}">Continue <i class="bx bx-right-arrow-alt"></i></a></div></div>`;

    const goal = payload.learning_goal || {};
    $('[data-learning-goal]').innerHTML =
      `<p class="goal-title">${escapeHtml(goal.title || 'Add your first learning goal')}</p><p class="muted">Goal attainment is not measured automatically. Record your practice in the learning journal.</p><div class="goal-context"><span><strong>${Number(goal.completed_sessions || 0)}</strong> recorded completed sessions</span><span><strong>${Number(goal.profile_completeness || 0)}%</strong> of core profile fields filled</span></div>`;

    const matches = payload.recommended_matches || [];
    $('#dashboardMatches').innerHTML = matches.length ? matches.map(match => matchCard(match, true)).join('') :
      emptyBlock('bx-radar', 'No recommendation yet',
        'Add skills, languages, and availability so the matcher has enough context.', 'profile.html',
        'Complete profile');

    const sessions = payload.upcoming_sessions || [];
    $('#dashboardSessions').innerHTML = sessions.length ? sessions.map(event =>
      `<a class="dashboard-list-item" href="video-room.html?event=${encodeURIComponent(event.id)}"><span class="dashboard-list-icon"><i class="bx bx-video"></i></span><div><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(formatDateTime(event.starts_at))}</span><small>${escapeHtml(event.host?.display_name || 'SwapLabs host')} · Open protected live room</small></div><i class="bx bx-chevron-right"></i></a>`
      ).join('') : emptyBlock('bx-calendar-plus', 'No upcoming session',
      'Choose a match, agree on a useful outcome, then put it on both calendars.', 'calendar.html', 'Schedule one');

    const pendingReports = payload.sessions_needing_progress_report || [];
    const journey = payload.progress_journey || [];
    const journeyHost = $('#dashboardJourney');
    if (journeyHost) {
      journeyHost.innerHTML = pendingReports.length || journey.length ? `${pendingReports.map(event => `<a class="dashboard-journey-item pending" href="calendar.html?event=${encodeURIComponent(event.id)}"><span class="dashboard-journey-icon"><i class="bx bx-edit"></i></span><div><strong>Report due: ${escapeHtml(event.title || 'Completed session')}</strong><span>${escapeHtml(formatDateTime(event.ends_at))} · Both participants must report</span><small>Open the session to record what happened and settle the one-credit exchange rule.</small></div><i class="bx bx-right-arrow-alt"></i></a>`).join('')}${journey.map(entry => `<article class="dashboard-journey-item"><span class="dashboard-journey-icon"><i class="bx bx-check-circle"></i></span><div><strong>${escapeHtml(entry.event_title || 'Session reflection')}</strong><span>${escapeHtml(formatDateTime(entry.session_date))}${entry.other_member?.display_name ? ` · with ${escapeHtml(entry.other_member.display_name)}` : ''} · ${Number(entry.overall_rating || 0)}/5</span><p>${escapeHtml(entry.progress || entry.what_happened || '')}</p>${entry.next_step ? `<small>Next: ${escapeHtml(entry.next_step)}</small>` : ''}</div><a class="dashboard-journey-link" href="learning-journal.html">Journal <i class="bx bx-chevron-right"></i></a></article>`).join('')}` : emptyBlock('bx-line-chart', 'Your journey starts after your first session', 'Complete an exchange and both reports will appear here as a private learning record.', 'skill-matching.html', 'Find a match');
    }

    const messages = payload.recent_messages || [];
    $('#dashboardMessages').innerHTML = messages.length ? messages.map(conversation => {
      const member = conversation.members?.[0];
      const body = conversation.latest_message?.body || 'Conversation ready';
      return `<a class="dashboard-list-item message" href="notifications.html?conversation=${encodeURIComponent(conversation.id)}">${conversation.kind === 'bot' ? '<span class="dashboard-list-icon bot"><i class="bx bx-bot"></i></span>' : avatarHtml(member, 'dashboard-message-avatar')}<div><strong>${escapeHtml(conversation.title)}</strong><span>${escapeHtml(body.slice(0, 90))}</span><small>${conversation.unread_count ? `${Number(conversation.unread_count)} unread` : 'Up to date'}</small></div>${conversation.unread_count ? `<b class="message-count">${Number(conversation.unread_count)}</b>` : '<i class="bx bx-chevron-right"></i>'}</a>`;
    }).join('') : emptyBlock('bx-message-square-dots', 'No conversation yet',
      'Your Inbox holds member chats and SwapBot account updates.', 'notifications.html', 'Open Inbox');

    const tour = $('#dashboardTour');
    const firstVisit = !payload.onboarding_complete;
    if (tour) {
      tour.open = firstVisit;
      tour.classList.toggle('is-first-visit', firstVisit);
      tour.classList.toggle('is-complete', !firstVisit);
    }
    if (payload.onboarding_complete) $('#dashboardOnboarding')?.classList.add('completed');
    setupProfileSetupDialog(payload);
  }

  function renderMemberActivityChart(analytics = {}) {
    const values = {
      sessions_completed: Number(analytics.sessions?.completed || 0),
      sessions_scheduled: Number(analytics.sessions?.scheduled || 0),
      credits_earned: Number(analytics.credits_earned || 0),
      messages_sent: Number(analytics.messages_sent || 0),
      profile_completeness: Number(analytics.profile_completeness || 0)
    };
    const maximum = Math.max(...Object.values(values), 1);
    $$('[data-member-chart]').forEach(bar => {
      const value = Math.max(5, Math.round((values[bar.dataset.memberChart] / maximum) * 100));
      bar.style.height = `${value}%`;
      bar.title = `${values[bar.dataset.memberChart]} ${bar.parentElement.textContent.trim()}`;
    });
  }

  function savedMatchProfile(profile = {}) {
    const learningSkills = uniqueList([...asList(profile.skills_to_learn), ...asList(profile.languages_to_learn)]);
    const teachingSkills = uniqueList([...asList(profile.skills_to_teach), ...asList(profile.additional_languages)]);
    const learningGoal = String(profile.learning_goal || '').trim();
    return {
      learningSkills,
      teachingSkills,
      learningGoal,
      // A saved goal is a useful starting value when the member has not yet
      // named a specific skill. It stays editable and is never written back
      // to the profile from this search form.
      startingLearningValue: learningSkills.length ? learningSkills.join(', ') : learningGoal
    };
  }

  function updateMatchProfileContext(profile = {}, source = 'profile') {
    const saved = savedMatchProfile(profile);
    const name = state.user?.profile?.display_name || state.user?.username || 'Your SwapLabs profile';
    const initialsValue = initials(state.user);
    const nameNode = $('#matchingProfileName');
    const avatarNode = $('#matchingProfileAvatar');
    const stateNode = $('#matchingProfileState');
    const learnState = $('#matchLearnState');
    const teachState = $('#matchTeachState');
    const learnHelp = $('#matchLearnHelp');
    if (nameNode) nameNode.textContent = name;
    if (avatarNode) avatarNode.textContent = initialsValue;
    if (stateNode) {
      if (saved.learningSkills.length) {
        stateNode.textContent = `${saved.learningSkills.length} saved learning ${saved.learningSkills.length === 1 ? 'skill' : 'skills'} ready to edit`;
      } else if (saved.learningGoal) {
        stateNode.textContent = 'Saved learning goal ready to edit';
      } else {
        stateNode.textContent = 'No learning direction saved yet';
      }
      stateNode.className = saved.learningSkills.length || saved.learningGoal ? 'is-ready' : 'is-missing';
    }
    if (learnState) {
      learnState.textContent = source === 'handoff' ? 'From handoff' : saved.learningSkills.length || saved.learningGoal ? 'Saved' : 'New';
      learnState.className = `matching-input-status ${saved.learningSkills.length || saved.learningGoal ? 'is-saved' : 'is-new'}`;
    }
    if (teachState) {
      teachState.textContent = saved.teachingSkills.length ? 'Saved' : '';
      teachState.className = `matching-input-status ${saved.teachingSkills.length ? 'is-saved' : ''}`;
    }
    if (learnHelp) {
      if (source === 'handoff') {
        learnHelp.textContent = 'Started from the previous page. Edit this search without changing your profile.';
      } else if (saved.learningSkills.length) {
        learnHelp.textContent = 'Saved from your profile — edit this search anytime; your profile will not change.';
      } else if (saved.learningGoal) {
        learnHelp.textContent = 'Started from your saved learning goal — turn it into a skill or edit it for this search.';
      } else {
        learnHelp.innerHTML = 'Nothing is saved here yet. <a class="match-profile-link" href="profile.html#learning">Fill in your profile</a> to add skills for next time.';
      }
      learnHelp.className = `match-field-help ${saved.learningSkills.length || saved.learningGoal ? 'is-saved' : 'is-missing'}`;
    }
  }

  function updateMatchFieldState() {
    const form = $('#advancedMatchForm');
    if (!form) return;
    const learn = asList(form.elements.learn_skills?.value);
    const teach = asList(form.elements.teach_skills?.value);
    const dirty = form.dataset.matchDirty === 'true';
    const source = form.dataset.matchProfileSource || 'profile';
    const learnState = $('#matchLearnState');
    const teachState = $('#matchTeachState');
    if (learnState) {
      learnState.textContent = learn.length ? (dirty ? 'Edited' : source === 'handoff' ? 'From handoff' : 'Saved') : 'New';
      learnState.className = `matching-input-status ${learn.length ? dirty ? 'is-edited' : 'is-saved' : 'is-new'}`;
    }
    if (teachState) {
      teachState.textContent = teach.length ? (dirty ? 'Edited' : 'Saved') : '';
      teachState.className = `matching-input-status ${teach.length ? dirty ? 'is-edited' : 'is-saved' : ''}`;
    }
    const learnHelp = $('#matchLearnHelp');
    if (learnHelp && dirty) {
      if (learn.length) {
        learnHelp.textContent = 'Edited for this search — your saved profile stays unchanged.';
      } else {
        learnHelp.innerHTML = 'This search is cleared; your saved profile stays unchanged. <a class="match-profile-link" href="profile.html#learning">Fill in your profile</a>';
      }
      learnHelp.className = `match-field-help ${learn.length ? 'is-edited' : 'is-missing'}`;
    }
    const broaden = $('#broadenMatch');
    if (broaden) broaden.hidden = !learn.length;
  }

  function fillMatchForm({force = false} = {}) {
    const form = $('#advancedMatchForm');
    if (!form || !state.user) return;
    const profile = state.user.profile || {};
    const saved = savedMatchProfile(profile);
    const preserveSearch = !force && form.dataset.matchDirty === 'true';
    if (preserveSearch) {
      updateMatchProfileContext(profile, form.dataset.matchProfileSource || 'profile');
      updateMatchFieldState();
      return;
    }
    form.elements.learn_skills.value = saved.startingLearningValue;
    form.elements.teach_skills.value = saved.teachingSkills.join(', ');
    form.elements.proficiency.value = ['Beginner', 'Intermediate', 'Advanced', 'Expert'].includes(profile
      .experience_level) ? profile.experience_level : 'Intermediate';
    form.elements.learning_goal.value = profile.learning_goal || '';
    form.elements.teaching_style.value = profile.teaching_style || 'Project-based';
    form.elements.session_format.value = profile.preferred_format || 'Remote or local';
    form.elements.timezone.value = profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    form.elements.languages.value = [profile.primary_language, ...asList(profile.additional_languages)].filter(
      Boolean).join(', ');
    let source = 'profile';
    try {
      const seed = JSON.parse(sessionStorage.getItem('swaplabs-match-seed') || 'null');
      if (seed) {
        if (seed.learn_skills) form.elements.learn_skills.value = seed.learn_skills;
        if (seed.teach_skills) form.elements.teach_skills.value = seed.teach_skills;
        if (seed.session_format) form.elements.session_format.value = seed.session_format;
        source = seed.learn_skills || seed.teach_skills ? 'handoff' : source;
        sessionStorage.removeItem('swaplabs-match-seed');
      }
    } catch (_error) {
      sessionStorage.removeItem('swaplabs-match-seed');
    }
    form.dataset.matchDirty = 'false';
    form.dataset.matchProfileSource = source;
    updateMatchProfileContext(profile, source);
    updateMatchFieldState();
  }

  function renderMatchReadyState({title = 'Ready to find your fit', message = 'Add a skill you want to learn, then we’ll rank members who can teach it.', mode = 'ready'} = {}) {
    const empty = $('#matchEmpty');
    const emptyTitle = empty?.querySelector('h3');
    const emptyCopy = empty?.querySelector('p');
    const emptyKicker = $('#matchEmptyKicker');
    const summary = $('#matchingResultSummary');
    const resultState = $('#matchingResultState');
    const status = $('#matchingStatus');
    const broaden = $('#broadenMatch');
    if (empty) empty.hidden = false;
    if (emptyTitle) emptyTitle.textContent = title;
    if (emptyCopy) emptyCopy.textContent = message;
    if (emptyKicker) emptyKicker.textContent = mode === 'ready' ? 'Start with one skill' : 'No direct fit yet';
    if (summary) summary.textContent = mode === 'ready' ? 'Your saved profile will appear here first, and every field remains editable.' : 'No direct fit was found with the current filters.';
    if (resultState) resultState.innerHTML = mode === 'ready' ? '<i class="bx bx-sparkles"></i> Ready when you are' : '<i class="bx bx-search-alt"></i> Refine your search';
    if (broaden) broaden.hidden = mode === 'ready';
    if (status && mode === 'ready') {
      status.textContent = '';
      status.className = 'form-status';
    }
  }

  function matchingPayload(form) {
    const values = new FormData(form);
    return {
      learn_skills: asList(values.get('learn_skills')),
      teach_skills: asList(values.get('teach_skills')),
      proficiency: values.get('proficiency'),
      learning_goal: values.get('learning_goal'),
      teaching_style: values.get('teaching_style'),
      session_format: values.get('session_format'),
      timezone: values.get('timezone'),
      languages: asList(values.get('languages')),
      category: values.get('category'),
      strict_skill_match: Boolean(form.elements.strict_skill_match.checked),
      use_demographic_preferences: Boolean(form.elements.use_demographic_preferences?.checked)
    };
  }

  async function runMatching() {
    const form = $('#advancedMatchForm');
    if (!asList(form.elements.learn_skills.value).length) {
      renderMatchReadyState({title: 'Add a learning direction first', message: 'Type a skill in the first field. You can use a saved profile value or enter a one-off search without changing your profile.'});
      $('#matchingStatus').textContent = 'Add at least one skill you want to learn.';
      $('#matchingStatus').className = 'form-status show info';
      form.elements.learn_skills.focus();
      return;
    }
    const button = $('button[type="submit"]', form);
    const status = $('#matchingStatus');
    button.disabled = true;
    button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Finding a swap soon';
    $('#matchingResultState').innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Ranking members';
    status.className = 'form-status';
    try {
      const result = await api('/api/matches', {
        method: 'POST',
        body: matchingPayload(form)
      });
      const matches = result.matches || [];
      $('#matchResults').innerHTML = matches.map(match => matchCard(match)).join('');
      $('#matchEmpty').hidden = matches.length > 0;
      if (!matches.length && result.empty_state?.message) $('#matchEmpty p').textContent = result.empty_state.message;
      const demographicCopy = form.elements.use_demographic_preferences?.checked ? ' Optional age and gender preferences were included because you enabled them.' : ' Age and gender preferences were not used.';
      $('#matchingResultSummary').textContent = matches.length ?
        `${matches.length} member${matches.length === 1 ? '' : 's'} ranked by grouped skill fit, reciprocal potential, goals, language, schedule, format, profile context, and exchange history.${demographicCopy}` :
        'No active discovery candidates were found with the current filters. Broaden the search or add more context to find a practical swap.';
      $('#matchingResultState').innerHTML = matches.length ? `<i class="bx bx-check-circle"></i> ${matches.length} result${matches.length === 1 ? '' : 's'} ready` : '<i class="bx bx-search-alt"></i> Refine your search';
      if (!matches.length) renderMatchReadyState({title: 'No strong match found yet', message: result.empty_state?.message || 'Try a broader skill name, turn off exact-fit prioritisation, or add more languages and skills to your profile.', mode: 'empty'});
      const resultQualityLabel = {
        strong: 'strong skill fit',
        good: 'good skill fit',
        related: 'related skill fit',
        discovery: 'discovery suggestion'
      }[matches[0]?.match_quality] || 'discovery suggestion';
      status.textContent = matches.length ?
        `Matching complete. Your strongest result is a ${resultQualityLabel} with a score of ${matches[0].score}.` :
        'No strong match was found. Broaden the search or update your profile.';
      status.className = `form-status show ${matches.length ? 'success' : 'info'}`;
    } catch (error) {
      if (error.code === 'profile_incomplete') {
        window.SwapLabsProfileGate?.open(error);
        return;
      }
      status.textContent = error.message;
      status.className = 'form-status show error';
    } finally {
      button.disabled = false;
      button.innerHTML = '<i class="bx bx-transfer-alt"></i> Find my swap';
    }
  }

  async function requestSwapMatch(button) {
    if (!state.user) {
      location.href = `login.html?next=${encodeURIComponent('skill-matching.html?intent=swap')}`;
      return;
    }
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Sending';
    try {
      const result = await api('/api/swaps', {
        method: 'POST',
        body: {
          target_user_id: button.dataset.requestSwapMatch,
          skill: button.dataset.swapSkill,
          offer: button.dataset.swapOffer || ''
        }
      });
      button.innerHTML = '<i class="bx bx-check"></i> Sent';
      setTimeout(() => { location.href = `notifications.html?conversation=${encodeURIComponent(result.conversation.id)}`; }, 500);
    } catch (error) {
      button.disabled = false;
      button.innerHTML = original;
      if (error.code === 'profile_incomplete') {
        window.SwapLabsProfileGate?.open(error);
        return;
      }
      alert(error.message);
    }
  }

  async function startConversation(userId, button) {
    button.disabled = true;
    const previous = button.innerHTML;
    button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Opening';
    try {
      const result = await api('/api/inbox/conversations', {
        method: 'POST',
        body: {
          target_user_id: userId
        }
      });
      location.href = `notifications.html?conversation=${encodeURIComponent(result.conversation.id)}`;
    } catch (error) {
      button.disabled = false;
      button.innerHTML = previous;
      if (error.code === 'profile_incomplete') {
        window.SwapLabsProfileGate?.open(error);
        return;
      }
      alert(error.message);
    }
  }

  function setupCommonActions() {
    document.addEventListener('click', event => {
      const messageButton = event.target.closest('[data-message-user]');
      const swapButton = event.target.closest('[data-request-swap-match]');
      if (swapButton) requestSwapMatch(swapButton);
      if (messageButton) startConversation(messageButton.dataset.messageUser, messageButton);
    });
  }

  function setupTour() {
    $$('[data-onboarding-step]').forEach(button => button.addEventListener('click', () => {
      $$('[data-onboarding-step]').forEach(item => item.classList.toggle('active', item === button));
      $$('[data-onboarding-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset
        .onboardingPanel === button.dataset.onboardingStep));
    }));
    $('#finishDashboardTour')?.addEventListener('click', async () => {
      try {
        await api('/api/dashboard/onboarding', {
          method: 'POST',
          body: {
            complete: true
          }
        });
        $('#dashboardOnboarding').classList.add('completed');
        $('#finishDashboardTour').innerHTML = '<i class="bx bx-check-double"></i> Tour completed';
        const tour = $('#dashboardTour');
        if (tour) {
          tour.open = false;
          tour.classList.remove('is-first-visit');
          tour.classList.add('is-complete');
          const action = tour.querySelector('.tour-summary-action');
          if (action) action.innerHTML = '<i class="bx bx-check" aria-hidden="true"></i> Tour completed';
        }
      } catch (error) {
        alert(error.message);
      }
    });
  }

  function setupMatching() {
    const quickSwap = new URLSearchParams(location.search).get('intent') === 'swap';
    const primaryCta = document.getElementById('matchingPrimaryCta');
    if (primaryCta) {
      primaryCta.href = '#advancedMatchForm';
      primaryCta.addEventListener('click', event => {
        const target = document.getElementById('advancedMatchForm');
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({behavior: 'smooth', block: 'start'});
        target.querySelector('input:not([readonly]), textarea, select')?.focus({preventScroll: true});
      });
    }
    if (quickSwap) {
      document.body.classList.add('direct-swap-flow');
      const heroTitle = document.querySelector('.matching-portal-hero h1');
      const heroCopy = document.querySelector('.matching-portal-hero p');
      const demoTitle = document.getElementById('matchingDemoTitle');
      const submit = document.querySelector('#advancedMatchForm button[type="submit"]');
      if (heroTitle) heroTitle.textContent = 'Get into a useful swap soon.';
      if (heroCopy) heroCopy.textContent = 'Tell us one thing you want to learn. We will surface people who already teach it, even when they do not want to learn the same thing from you.';
      if (demoTitle) demoTitle.textContent = 'One clear path from curiosity to a real swap.';
      if (submit) submit.innerHTML = '<i class="bx bx-transfer-alt"></i> Find my swap';
    }
    fillMatchForm();
    $('#advancedMatchForm')?.addEventListener('submit', event => {
      event.preventDefault();
      runMatching();
    });
    const form = $('#advancedMatchForm');
    form?.addEventListener('input', event => {
      if (event.target.matches('input, textarea')) {
        form.dataset.matchDirty = 'true';
        updateMatchFieldState();
      }
    });
    form?.addEventListener('change', event => {
      if (event.target.matches('select, input[type="checkbox"]')) form.dataset.matchDirty = 'true';
    });
    $('#useSavedProfile')?.addEventListener('click', () => {
      fillMatchForm({force: true});
      runMatching();
    });
    $('#broadenMatch')?.addEventListener('click', () => {
      $('#matchCategory').value = '';
      $('#matchStrict').checked = false;
      runMatching();
    });
    if (asList(form?.elements.learn_skills?.value).length) runMatching();
    else renderMatchReadyState();
  }

  async function initialize() {
    setupCommonActions();
    try {
      // The dashboard payload is protected by the same session cookie. Start
      // it alongside auth validation so a signed-in reload pays for one
      // round-trip instead of two sequential tunnel requests.
      const dashboardRequest = portalType === 'dashboard'
        ? api('/api/dashboard').catch(error => ({__requestError: error}))
        : null;
      const auth = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me'));
      state.csrf = auth.csrf_token || state.csrf;
      state.user = auth.authenticated ? auth.user : null;
      if (!state.user) {
        $(`#${portalType === 'dashboard' ? 'dashboardLoading' : 'matchingLoading'}`).hidden = true;
        $(`#${portalType === 'dashboard' ? 'dashboardLocked' : 'matchingLocked'}`).hidden = false;
        return;
      }
      if (portalType === 'dashboard') {
        const payload = await dashboardRequest;
        if (payload?.__requestError) throw payload.__requestError;
        $('#dashboardLoading').hidden = true;
        $('#dashboardPortal').hidden = false;
        renderDashboard(payload);
        window.dispatchEvent(new CustomEvent('relayskills:dashboard-ready', {detail: {payload}}));
        setupTour();
      } else {
        $('#matchingLoading').hidden = true;
        $('#matchingPortal').hidden = false;
        setupMatching();
      }
    } catch (error) {
      const loading = $(`#${portalType === 'dashboard' ? 'dashboardLoading' : 'matchingLoading'}`);
      if (portalType === 'matching') {
        if (loading) loading.hidden = true;
        const locked = $('#matchingLocked');
        if (locked) {
          locked.hidden = false;
          const heading = $('h2', locked);
          const copy = $('p', locked);
          if (heading) heading.textContent = 'Matching is warming up';
          if (copy) copy.textContent = 'The account connection is taking a moment. You can try again shortly, or create your swap profile now and return to this search.';
        }
      } else if (loading) loading.innerHTML =
        '<i class="bx bx-error-circle"></i><span>Dashboard is temporarily unavailable. Try again shortly.</span>';
    }
  }

  initialize();
})();
