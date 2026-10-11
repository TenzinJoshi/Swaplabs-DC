(() => {
  'use strict';

  const page = document.querySelector('[data-platform-page]')?.dataset.platformPage || '';
  const hasTestimonials = Boolean(document.getElementById('testimonialBeltTrack') || document.getElementById(
    'feedbackCommunityGrid'));
  const hasAdmin = Boolean(document.querySelector('[data-auth-page="admin"]'));
  if (!page && !hasTestimonials && !hasAdmin) return;

  const state = {
    csrf: '',
    user: null,
    workshops: [],
    sharedWorkshop: null,
    ideas: [],
    testimonials: [],
    adminContent: null,
    adminTab: 'ideas',
    serverAvailable: true
  };
  const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const {escapeHtml, initials, profileColor, safeAvatarUrl} = window.RelayComponents;
  const normalize = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const formatDate = (value, options = {
    dateStyle: 'medium',
    timeStyle: 'short'
  }) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || 'Not set') : new Intl.DateTimeFormat(undefined, options)
      .format(date);
  };
  const safeAvatar = safeAvatarUrl;
  const profileAvatar = (profile, name, className = 'platform-avatar') => {
    const url = safeAvatar(profile);
    const color = profileColor(profile);
    return `<span class="${className} ${escapeHtml(color)}">${url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)} profile photo">` : escapeHtml(initials(name))}</span>`;
  };
  const ownerProfile = owner => owner?.profile || {};
  const ownerName = owner => ownerProfile(owner).display_name || owner?.username || 'SwapLabs member';
  const formatNumber = value => Number(value || 0).toLocaleString();

  async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (writeMethods.has(method) && !state.csrf) {
      const tokenResponse = await fetch('/api/auth/csrf', {
        credentials: 'same-origin'
      });
      if (!tokenResponse.ok) throw new Error('Could not establish a secure session. Refresh and try again.');
      state.csrf = (await tokenResponse.json()).csrf_token;
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
      const error = new Error(payload.error || 'Something went wrong.');
      error.status = response.status;
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
    if (payload.csrf_token) state.csrf = payload.csrf_token;
    return payload;
  }

  function toast(message, type = 'success') {
    let element = $('.platform-toast');
    if (!element) {
      element = document.createElement('div');
      element.className = 'platform-toast';
      document.body.appendChild(element);
    }
    element.className = `platform-toast ${type}`;
    const actionLink = window.SwapLabsNotice?.actionLink(message, type) || '';
    element.classList.toggle('has-action-link', Boolean(actionLink));
    element.innerHTML =
      `<i class="bx ${type === 'error' ? 'bx-error-circle' : 'bx-check-circle'}"></i><div class="toast-copy"><span>${escapeHtml(message)}</span>${actionLink}</div>`;
    requestAnimationFrame(() => element.classList.add('show'));
    clearTimeout(element.hideTimer);
    element.hideTimer = setTimeout(() => element.classList.remove('show'), 4200);
  }

  function setStatus(form, message, type = 'success') {
    const box = $('[data-platform-status]', form);
    if (!box) return;
    box.className = `platform-form-status show ${type}`;
    const actionLink = window.SwapLabsNotice?.actionLink(message, type) || '';
    box.classList.toggle('has-action-link', Boolean(actionLink));
    box.innerHTML =
      `<i class="bx ${type === 'error' ? 'bx-error-circle' : 'bx-check-circle'}"></i><div class="toast-copy"><span>${escapeHtml(message)}</span>${actionLink}</div>`;
  }

  function clearStatus(form) {
    const box = $('[data-platform-status]', form);
    if (!box) return;
    box.className = 'platform-form-status';
    box.textContent = '';
  }

  function setBusy(button, busy, label = 'Saving') {
    if (!button) return;
    if (busy) {
      button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML =
        `<i class="bx bx-loader-alt" style="animation:platform-spin .9s linear infinite"></i> ${escapeHtml(label)}`;
    } else {
      button.disabled = false;
      if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
    }
  }

  function formObject(form) {
    const data = new FormData(form);
    return Object.fromEntries(data.entries());
  }

  function prefillIdentity(form) {
    if (!form || !state.user) return;
    const name = $('[name="name"]', form);
    const email = $('[name="email"]', form);
    const role = $('[name="role"]', form);
    if (name && !name.value) name.value = state.user.profile?.display_name || '';
    if (email && !email.value) email.value = state.user.email || '';
    if (role && !role.value) role.value = state.user.profile?.professional_role || state.user.profile?.occupation ||
      '';
  }

  function testimonialStars(rating) {
    return Array.from({
      length: 5
    }, (_, index) => `<i class="bx ${index < Number(rating || 0) ? 'bxs-star' : 'bx-star'}"></i>`).join('');
  }

  function testimonialCard(item, hiddenDuplicate = false) {
    return `<article class="testimonial-belt-card"${hiddenDuplicate ? ' aria-hidden="true"' : ''}><div class="testimonial-rating">${testimonialStars(item.rating)}</div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.message)}</p><div class="testimonial-person">${profileAvatar({}, item.name)}<div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.role)}</span></div></div></article>`;
  }

  let testimonialPlaying = null;
  function updateTestimonialPlayback() {
    const track = $('#testimonialBeltTrack');
    const button = $('#testimonialPlayback');
    if (!track || !button) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.classList.contains('pref-reduced-motion');
    const paused = document.documentElement.classList.contains('pref-pause-testimonials');
    const playing = testimonialPlaying ?? (!reduced && !paused);
    track.classList.toggle('playback-playing', testimonialPlaying === true);
    track.classList.toggle('playback-paused', !playing);
    button.hidden = !track.classList.contains('has-testimonials');
    button.textContent = playing ? 'Pause testimonials' : 'Play testimonials';
    button.setAttribute('aria-pressed', String(playing));
  }
  $('#testimonialPlayback')?.addEventListener('click', () => {
    testimonialPlaying = $('#testimonialPlayback').getAttribute('aria-pressed') !== 'true';
    updateTestimonialPlayback();
  });
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', updateTestimonialPlayback);
  window.addEventListener('swaplabs:preferences-applied', updateTestimonialPlayback);

  async function loadTestimonials() {
    try {
      const result = await api('/api/testimonials?limit=24');
      state.testimonials = result.testimonials || [];
      const track = $('#testimonialBeltTrack');
      if (track) {
        track.classList.toggle('has-testimonials', state.testimonials.length > 0);
        const markup = state.testimonials.length
          ? state.testimonials.map(item => testimonialCard(item)).join('') + state.testimonials.map(item => testimonialCard(item, true)).join('')
          : '<article class="testimonial-belt-card"><h3>No public feedback yet</h3><p>Only actual submissions with permission to publish appear here.</p><a href="feedback.html">Share your experience</a></article>';
        if (track.dataset.rendered !== markup) {
          track.innerHTML = markup;
          track.dataset.rendered = markup;
        }
        updateTestimonialPlayback();
      }
      const grid = $('#feedbackCommunityGrid');
      if (grid) {
        grid.innerHTML = state.testimonials.length ? state.testimonials.slice(0, 9).map(item =>
            `<article class="platform-card"><div class="testimonial-rating" style="color:#7659c7">${testimonialStars(item.rating)}</div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.message)}</p><div class="testimonial-person" style="display:flex;align-items:center;gap:9px;margin-top:18px">${profileAvatar({}, item.name)}<div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.role)}</span></div></div></article>`
            ).join('') :
          '<div class="idea-empty"><i class="bx bx-message-square-dots"></i><h3>No public testimonials yet</h3><p>Be the first member to share one with publication permission.</p></div>';
      }
    } catch (_error) {
      const track = $('#testimonialBeltTrack');
      if (track) {
        track.classList.remove('has-testimonials');
        delete track.dataset.rendered;
        updateTestimonialPlayback();
        track.innerHTML = '<article class="testimonial-belt-card"><h3>Feedback unavailable</h3><p>We could not load recorded feedback. No example testimonials are shown.</p></article>';
      }
      const grid = $('#feedbackCommunityGrid');
      if (grid) grid.innerHTML =
        '<div class="idea-empty"><i class="bx bx-wifi-off"></i><h3>Testimonials are temporarily unavailable</h3><p>The saved community feedback will return when the local server is available.</p></div>';
    }
  }

  if (hasTestimonials) setInterval(() => { if (!document.hidden) loadTestimonials(); }, 30000);

  function setupSimpleForm(formId, endpoint, successLabel) {
    const form = document.getElementById(formId);
    if (!form) return;
    prefillIdentity(form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(form);
      const button = $('button[type="submit"]', form);
      setBusy(button, true, successLabel);
      try {
        const result = await api(endpoint, {
          method: 'POST',
          body: formObject(form)
        });
        const reference = result.reference ? ` Reference: ${result.reference}.` : '';
        setStatus(form, `${result.message}${reference}`, 'success');
        form.reset();
        prefillIdentity(form);
        toast(`${result.message}${reference}`);
      } catch (error) {
        setStatus(form, error.message, error.code === 'pending_moderation' ? 'info' : 'error');
        toast(error.message, error.code === 'pending_moderation' ? 'info' : 'error');
      } finally {
        setBusy(button, false);
      }
    });
  }

  function setupUnifiedSupportForm() {
    const form = $('#contactForm');
    const requestType = $('#contactRequestType');
    if (!form || !requestType) return;
    prefillIdentity(form);

    const labels = {
      help: 'Send help request',
      feedback: 'Send feedback',
      complaint: 'Submit complaint',
      safety: 'Submit safety report',
      partnership: 'Send partnership request',
      privacy: 'Send privacy request'
    };
    const routeNames = {
      help: 'Account and general support',
      feedback: 'Feedback',
      complaint: 'Formal complaint',
      safety: 'Safety concern',
      partnership: 'Partnership or program question',
      privacy: 'Privacy request'
    };
    const update = () => {
      const type = requestType.value;
      $$('[data-support-fields]', form).forEach(group => {
        const visible = group.dataset.supportFields.split(/\s+/).includes(type);
        group.hidden = !visible;
        group.querySelectorAll('input, select, textarea').forEach(input => {
          input.disabled = !visible;
        });
      });
      const button = $('button[type="submit"]', form);
      if (button) button.innerHTML = `<i class="bx bx-send"></i> ${escapeHtml(labels[type] || 'Send request')}`;
      const message = $('#contactMessage');
      if (message) message.placeholder = type === 'safety' ?
        'Tell us what happened, who may be affected, and what needs attention. Do not include passwords or unnecessary private information.' :
        type === 'feedback' ? 'Tell us what worked, what was difficult, and what you would improve.' :
        'Explain what you are trying to do, what happened, and what would help next.';
    };

    const query = new URLSearchParams(location.search);
    const requestedType = query.get('type');
    if (requestedType && [...requestType.options].some(option => option.value === requestedType)) requestType.value = requestedType;
    requestType.addEventListener('change', update);
    $$('[data-support-route]').forEach(link => link.addEventListener('click', () => {
      if ([...requestType.options].some(option => option.value === link.dataset.supportRoute)) {
        requestType.value = link.dataset.supportRoute;
        update();
      }
    }));
    update();

    form.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(form);
      if (!form.checkValidity()) {
        const invalid = [...form.elements].find(input => input && typeof input.checkValidity === 'function' && !input.disabled && !input.checkValidity());
        invalid?.reportValidity();
        invalid?.focus({preventScroll: true});
        return;
      }
      const fields = formObject(form);
      const type = fields.request_type;
      const button = $('button[type="submit"]', form);
      let endpoint = '/api/contact';
      let payload = {
        name: fields.name,
        email: fields.email,
        topic: routeNames[type] || type,
        preferred_contact: fields.preferred_contact,
        subject: fields.subject,
        message: fields.message,
        request_type: type
      };
      if (type === 'complaint' || type === 'safety') {
        endpoint = '/api/complaints';
        payload = {
          name: fields.name,
          email: fields.email,
          category: type === 'safety' ? 'Safety concern' : (fields.category || 'Other service concern'),
          priority: fields.priority || 'standard',
          subject: fields.subject,
          reference: fields.reference || '',
          details: fields.message,
          resolution: fields.resolution || (type === 'safety' ? 'Review and take the safest next action.' : ''),
          request_type: type
        };
      } else if (type === 'feedback') {
        endpoint = '/api/feedback';
        payload = {
          name: fields.name,
          email: fields.email,
          role: 'SwapLabs member',
          rating: Number(fields.rating || 5),
          title: fields.subject,
          message: fields.message,
          permission_to_publish: fields.permission_to_publish === 'on',
          request_type: type
        };
      }
      setBusy(button, true, labels[type] || 'Sending request');
      try {
        const result = await api(endpoint, {method: 'POST', body: payload});
        const reference = result.reference ? ` Reference: ${result.reference}.` : '';
        setStatus(form, `${result.message}${reference}`, 'success');
        toast(`${result.message}${reference}`);
        form.reset();
        prefillIdentity(form);
        update();
      } catch (error) {
        setStatus(form, error.message, error.code === 'pending_moderation' ? 'info' : 'error');
        toast(error.message, error.code === 'pending_moderation' ? 'info' : 'error');
      } finally {
        setBusy(button, false);
        update();
      }
    });
  }

  function setupFeedbackForm() {
    const form = $('#feedbackForm');
    if (!form) return;
    prefillIdentity(form);
    const ratingInput = $('#feedbackRating');
    const choices = $$('[data-rating]', form);
    const message = $('#feedbackMessage');
    const name = $('#feedbackName');
    const role = $('#feedbackRole');
    const preview = () => {
      $('#testimonialPreviewMessage').textContent = message.value.trim() ||
        'Your testimonial preview will appear here as you write.';
      $('#testimonialPreviewName').textContent = name.value.trim() || 'Your name';
      $('#testimonialPreviewRole').textContent = role.value.trim() || 'Your role or learning context';
      $('#testimonialPreviewInitials').textContent = initials(name.value || 'SL');
      $('#feedbackCharacterCount').textContent = String(message.value.length);
    };
    choices.forEach(choice => choice.addEventListener('click', () => {
      const selected = Number(choice.dataset.rating);
      ratingInput.value = String(selected);
      choices.forEach(item => {
        const active = Number(item.dataset.rating) <= selected;
        item.classList.toggle('selected', active);
        item.setAttribute('aria-checked', String(Number(item.dataset.rating) === selected));
        $('i', item).className = `bx ${active ? 'bxs-star' : 'bx-star'}`;
      });
    }));
    [message, name, role].forEach(input => input?.addEventListener('input', preview));
    preview();
    form.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(form);
      if (!ratingInput.value) {
        setStatus(form, 'Choose an overall rating from 1 to 5.', 'error');
        return;
      }
      const button = $('button[type="submit"]', form);
      setBusy(button, true, 'Submitting feedback');
      const payload = formObject(form);
      payload.permission_to_publish = $('#feedbackPermission').checked;
      payload.rating = Number(ratingInput.value);
      try {
        const result = await api('/api/feedback', {
          method: 'POST',
          body: payload
        });
        setStatus(form, result.message, 'success');
        toast(result.message);
        form.reset();
        ratingInput.value = '';
        choices.forEach(item => {
          item.classList.remove('selected');
          $('i', item).className = 'bx bx-star';
        });
        prefillIdentity(form);
        preview();
        await loadTestimonials();
      } catch (error) {
        setStatus(form, error.message, 'error');
        toast(error.message, 'error');
      } finally {
        setBusy(button, false);
      }
    });
  }

  function setSelectOptions(select, values, label) {
    if (!select) return;
    const current = select.value;
    select.innerHTML =
      `<option value="all">${escapeHtml(label)}</option>${[...new Set(values.filter(Boolean))].sort().map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
    if ([...select.options].some(option => option.value === current)) select.value = current;
  }

  function workshopCard(workshop) {
    const date = new Date(workshop.starts_at);
    const month = Number.isNaN(date.getTime()) ? 'TBD' : new Intl.DateTimeFormat(undefined, {
      month: 'short'
    }).format(date);
    const day = Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, {
      day: '2-digit'
    }).format(date);
    const host = workshop.host;
    const name = ownerName(host);
    const hostProfile = ownerProfile(host);
    const used = Number(workshop.registered_count || 0);
    const limit = Math.max(1, Number(workshop.seat_limit || 1));
    const percentage = Math.min(100, Math.round(used / limit * 100));
    const started = date.getTime() <= Date.now();
    const button = workshop.viewer_is_host && workshop.event_id ?
      `<a class="btn btn-primary" href="calendar.html?event=${encodeURIComponent(workshop.event_id)}">Manage your workshop</a>` : workshop.status !== 'scheduled' ?
      `<span class="tag">${escapeHtml(workshop.status)}</span>` : started && !workshop.viewer_registered ?
      '<span class="tag">Registration closed</span>' : state.user ?
      `<button class="btn ${workshop.viewer_registered ? 'registered' : 'btn-primary'}" type="button" data-workshop-register="${escapeHtml(workshop.id)}" data-cancel="${workshop.viewer_registered}"><i class="bx ${workshop.viewer_registered ? 'bx-check-circle' : 'bx-calendar-plus'}"></i> ${workshop.viewer_registered ? 'Registered — cancel' : workshop.seats_remaining ? 'Reserve my place' : 'Workshop full'}</button>` :
      '<a class="btn btn-primary" href="login.html"><i class="bx bx-log-in"></i> Sign in to reserve</a>';
    const detailsLink = workshop.share_id ?
      `<a class="btn" href="${escapeHtml(workshopShareHref(workshop))}"><i class="bx bx-detail"></i> View details</a>` :
      '<a class="btn" href="contact.html?topic=Workshops"><i class="bx bx-help-circle"></i> Ask</a>';
    return `<article class="workshop-card" data-workshop-card="${escapeHtml(workshop.id)}"><div class="workshop-card-top"><div class="workshop-date">${escapeHtml(month)}<strong>${escapeHtml(day)}</strong></div><div class="workshop-badges"><span>${escapeHtml(workshop.category)}</span><span>${escapeHtml(workshop.level)}</span><span>${escapeHtml(workshop.format)}</span></div></div><h3>${escapeHtml(workshop.title)}</h3><p>${escapeHtml(workshop.description)}</p><div class="workshop-host">${profileAvatar(hostProfile, name)}<div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(hostProfile.professional_role || hostProfile.headline || 'SwapLabs workshop host')}</span></div></div><div class="workshop-outcomes">${(workshop.outcomes || []).map(outcome => `<span><i class="bx bx-check"></i>${escapeHtml(outcome)}</span>`).join('')}</div><div class="workshop-badges" style="justify-content:flex-start;margin-bottom:14px"><span><i class="bx bx-time-five"></i> ${Number(workshop.duration_minutes)} min</span><span><i class="bx bx-map"></i> ${escapeHtml(workshop.location)}</span></div><div class="seat-meter"><div class="seat-meter-row"><span>${escapeHtml(formatDate(workshop.starts_at))}</span><strong>${Number(workshop.seats_remaining)} of ${limit} seats left</strong></div><div class="seat-meter-track"><span style="width:${percentage}%"></span></div></div><div class="workshop-card-actions">${button}${detailsLink}</div></article>`;
  }

  function workshopShareHref(workshop) {
    return workshop?.share_id ? `workshops.html?share=${encodeURIComponent(workshop.share_id)}` : '';
  }

  function sharedWorkshopReturnUrl() {
    return `${window.location.pathname}${window.location.search}`;
  }

  function renderSharedWorkshopError(error) {
    const section = $('#workshopShareView');
    const content = $('[data-workshop-share-content]', section);
    if (!section || !content) return;
    section.hidden = false;
    const expired = error?.code === 'workshop_link_expired' || error?.status === 410;
    content.innerHTML = `<div class="workshop-share-empty ${expired ? 'is-expired' : ''}"><span class="workshop-share-empty-icon"><i class="bx ${expired ? 'bx-time-five' : 'bx-link-external'}"></i></span><span class="platform-kicker">${expired ? 'Workshop link expired' : 'Workshop link unavailable'}</span><h2 id="workshopShareTitle">${expired ? 'This workshop has already happened.' : 'We could not open this workshop.'}</h2><p>${escapeHtml(error?.message || 'The link may be incorrect, or the workshop may no longer be available.')}</p><div class="workshop-share-actions"><a class="btn btn-primary" href="#workshopSchedule"><i class="bx bx-calendar"></i> Browse upcoming workshops</a><a class="btn" href="contact.html?topic=Workshops"><i class="bx bx-help-circle"></i> Contact support</a></div></div>`;
  }

  function renderSharedWorkshop(workshop, metadata = {}) {
    const section = $('#workshopShareView');
    const content = $('[data-workshop-share-content]', section);
    if (!section || !content || !workshop) return;
    state.sharedWorkshop = workshop;
    section.hidden = false;
    const host = workshop.host || {};
    const hostProfile = ownerProfile(host);
    const hostName = ownerName(host);
    const startsAt = new Date(workshop.starts_at || '');
    const started = Number.isFinite(startsAt.getTime()) && startsAt.getTime() <= Date.now();
    const expiresAt = metadata.share_expires_at || workshop.share_expires_at || '';
    const expiresDate = new Date(expiresAt);
    const expiryLabel = Number.isFinite(expiresDate.getTime()) ? formatDate(expiresDate) : 'after the workshop ends';
    const limit = Math.max(1, Number(workshop.seat_limit || 1));
    const registrationAction = workshop.viewer_is_host && workshop.event_id ?
      `<a class="btn btn-primary" href="calendar.html?event=${encodeURIComponent(workshop.event_id)}"><i class="bx bx-calendar-edit"></i> Manage workshop</a>` : workshop.status !== 'scheduled' || started ?
      '<span class="tag"><i class="bx bx-lock-alt"></i> Registration closed</span>' : state.user ?
      `<button class="btn ${workshop.viewer_registered ? 'registered' : 'btn-primary'}" type="button" data-shared-workshop-register="${escapeHtml(workshop.id)}" data-cancel="${workshop.viewer_registered}"><i class="bx ${workshop.viewer_registered ? 'bx-check-circle' : 'bx-calendar-plus'}"></i> ${workshop.viewer_registered ? 'Registered — cancel' : workshop.seats_remaining ? 'Register for this workshop' : 'Workshop full'}</button>` :
      `<a class="btn btn-primary" href="login.html?next=${encodeURIComponent(sharedWorkshopReturnUrl())}"><i class="bx bx-log-in"></i> Sign in to register</a>`;
    const outcomes = (workshop.outcomes || []).map(outcome => `<li><i class="bx bx-check-circle"></i><span>${escapeHtml(outcome)}</span></li>`).join('');
    const tags = (workshop.tags || []).map(tag => `<span>${escapeHtml(tag)}</span>`).join('');
    const statusCopy = started ? 'Registration is closed because this workshop has started.' : `This invite link stays active until ${expiryLabel}.`;
    content.innerHTML = `<article class="workshop-share-card"><div class="workshop-share-header"><div><span class="platform-kicker"><i class="bx bx-link-alt"></i> Workshop invite</span><h2 id="workshopShareTitle">${escapeHtml(workshop.title)}</h2><p>${escapeHtml(workshop.description || 'A practical SwapLabs learning session.')}</p></div><div class="workshop-share-header-badges"><span>${escapeHtml(workshop.category || 'Learning')}</span><span>${escapeHtml(workshop.level || 'All levels')}</span><span>${escapeHtml(workshop.format || 'Online')}</span></div></div><div class="workshop-share-layout"><div class="workshop-share-main"><section class="workshop-share-summary" aria-labelledby="workshopSummaryTitle"><span class="workshop-share-label">Quick preview</span><h3 id="workshopSummaryTitle">Everything you need to decide and register in one place.</h3><div class="workshop-share-meta"><div><i class="bx bx-calendar-event"></i><span><strong>${escapeHtml(formatDate(workshop.starts_at))}</strong><small>${escapeHtml(workshop.timezone || 'Your local time')}</small></span></div><div><i class="bx bx-time-five"></i><span><strong>${Number(workshop.duration_minutes || 0)} minutes</strong><small>planned session length</small></span></div><div><i class="bx bx-map"></i><span><strong>${escapeHtml(workshop.location || 'SwapLabs Live Room')}</strong><small>where the session happens</small></span></div><div><i class="bx bx-chair"></i><span><strong>${Number(workshop.seats_remaining)} of ${limit} places left</strong><small>${Number(workshop.registered_count || 0)} already registered</small></span></div></div><div class="workshop-share-outcomes"><span class="workshop-share-label">You will work toward</span><ul>${outcomes || '<li><i class="bx bx-check-circle"></i><span>A clear, practical next step</span></li>'}</ul></div>${tags ? `<div class="workshop-share-tags"><span class="workshop-share-label">Skills and topics</span><div>${tags}</div></div>` : ''}</section><section class="workshop-share-detail" aria-labelledby="workshopDetailTitle"><span class="workshop-share-label">Main details</span><h3 id="workshopDetailTitle">Arrive ready for the room.</h3><p>${escapeHtml(workshop.description || 'The host will guide the session from the listed outcome.')}</p><div class="workshop-share-detail-grid"><div><span>Host</span><div class="workshop-share-host">${profileAvatar(hostProfile, hostName)}<strong>${escapeHtml(hostName)}</strong></div></div><div><span>Experience level</span><strong>${escapeHtml(workshop.level || 'All levels')}</strong></div><div><span>Format</span><strong>${escapeHtml(workshop.format || 'Online')}</strong></div><div><span>Invite ID</span><strong class="workshop-share-id">${escapeHtml(workshop.share_id || metadata.share_id || 'Workshop invite')}</strong></div></div></section></div><aside class="workshop-share-rail"><div class="workshop-share-rail-top"><span class="workshop-share-label">Your next step</span><p>${escapeHtml(statusCopy)}</p><div class="workshop-share-actions">${registrationAction}<button class="btn" type="button" data-copy-workshop-link><i class="bx bx-copy"></i> Copy invite link</button></div></div><div class="workshop-share-rail-note"><i class="bx bx-shield-quarter"></i><div><strong>One-time workshop access</strong><span>The invite ID is unique to this workshop and stops working after the scheduled session ends.</span></div></div><a class="workshop-share-support" href="contact.html?topic=Workshops"><i class="bx bx-help-circle"></i><span><strong>Need help deciding?</strong><small>Ask about this workshop</small></span><i class="bx bx-right-arrow-alt"></i></a></aside></div></article>`;
  }

  async function loadSharedWorkshop() {
    const shareId = new URLSearchParams(window.location.search).get('share')?.trim();
    if (!shareId) return;
    const section = $('#workshopShareView');
    if (section) section.hidden = false;
    try {
      const result = await api(`/api/workshops/share/${encodeURIComponent(shareId)}`);
      renderSharedWorkshop(result.workshop, result);
    } catch (error) {
      renderSharedWorkshopError(error);
    }
  }

  async function copyWorkshopShareLink(button) {
    const workshop = state.sharedWorkshop;
    if (!workshop?.share_id) return;
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('share', workshop.share_id);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url.toString());
      else {
        const field = document.createElement('textarea');
        field.value = url.toString();
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.append(field);
        field.select();
        document.execCommand('copy');
        field.remove();
      }
      toast('Workshop invite link copied.');
    } catch (_error) {
      toast('Copy was blocked. Select and copy the invite URL from your browser.', 'error');
    }
    if (button) button.blur();
  }

  function setupSharedWorkshopActions() {
    $('#workshopShareView')?.addEventListener('click', async event => {
      const copyButton = event.target.closest('[data-copy-workshop-link]');
      if (copyButton) {
        await copyWorkshopShareLink(copyButton);
        return;
      }
      const button = event.target.closest('[data-shared-workshop-register]');
      const workshop = state.sharedWorkshop;
      if (!button || !workshop) return;
      const cancelling = button.dataset.cancel === 'true';
      if (cancelling && !confirm(`Cancel your place in ${workshop.title}?`)) return;
      setBusy(button, true, cancelling ? 'Cancelling' : 'Reserving');
      try {
        const result = await api(`/api/workshops/${encodeURIComponent(workshop.id)}/register`, {method: cancelling ? 'DELETE' : 'POST'});
        state.sharedWorkshop = result.workshop;
        const index = state.workshops.findIndex(item => item.id === workshop.id);
        if (index >= 0) state.workshops[index] = result.workshop;
        renderSharedWorkshop(result.workshop, {share_id: result.workshop.share_id, share_expires_at: result.workshop.share_expires_at});
        renderWorkshops();
        toast(result.message);
      } catch (error) {
        toast(error.message, error.code === 'pending_moderation' ? 'info' : 'error');
        setBusy(button, false);
      }
    });
  }

  function filteredWorkshops() {
    const query = normalize($('#workshopSearch')?.value);
    const category = $('#workshopCategory')?.value || 'all';
    const level = $('#workshopLevel')?.value || 'all';
    const format = $('#workshopFormat')?.value || 'all';
    return state.workshops.filter(item => {
      const haystack = normalize([item.title, item.description, item.category, item.level, item.format, item
        .location, ownerName(item.host), ...(item.outcomes || []), ...(item.tags || [])
      ].join(' '));
      return (!query || haystack.includes(query)) && (category === 'all' || item.category === category) && (
        level === 'all' || item.level === level) && (format === 'all' || item.format === format);
    });
  }

  function renderWorkshops() {
    const grid = $('#workshopGrid');
    if (!grid) return;
    const items = filteredWorkshops();
    $('#workshopResultCount').textContent = `${items.length} of ${state.workshops.length} workshops shown`;
    grid.innerHTML = items.length ? items.map(workshopCard).join('') :
      '<div class="idea-empty"><i class="bx bx-search-alt"></i><h3>No workshops match these filters</h3><p>Try a broader topic, category, level, or format.</p></div>';
  }

  async function loadWorkshops() {
    const grid = $('#workshopGrid');
    try {
      const result = await api('/api/workshops');
      state.workshops = result.workshops || [];
      $('#workshopStatScheduled').textContent = String(result.stats?.scheduled || 0);
      $('#workshopStatSeats').textContent = String(result.stats?.seats || 0);
      $('#workshopStatRegistered').textContent = String(result.stats?.registered || 0);
      $('#workshopStatHosts').textContent = String(result.stats?.hosts || 0);
      setSelectOptions($('#workshopCategory'), state.workshops.map(item => item.category), 'All categories');
      setSelectOptions($('#workshopLevel'), state.workshops.map(item => item.level), 'All levels');
      setSelectOptions($('#workshopFormat'), state.workshops.map(item => item.format), 'All formats');
      renderWorkshops();
    } catch (error) {
      if (grid) grid.innerHTML =
        `<div class="idea-empty"><i class="bx bx-wifi-off"></i><h3>Schedule unavailable</h3><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  function setupWorkshops() {
    const form = $('#hostWorkshopForm');
    if (form) {
      form.hidden = !state.user;
      $('#hostWorkshopAuth').hidden = Boolean(state.user);
      const timezone = state.user?.profile?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      form.elements.timezone.value = timezone;
      let dirty = false;
      let submitting = false;
      form.addEventListener('input', () => { dirty = true; });
      window.addEventListener('beforeunload', event => {
        if (!dirty && !submitting) return;
        event.preventDefault(); event.returnValue = '';
      });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submitting) return;
        clearStatus(form);
        const payload = formObject(form);
        payload.outcomes = payload.outcomes.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        payload.tags = payload.tags.split(',').map(value => value.trim()).filter(Boolean);
        payload.hosting_agreement = form.elements.hosting_agreement.checked;
        const button = $('button[type="submit"]', form);
        submitting = true;
        setBusy(button, true, 'Publishing');
        try {
          const result = await api('/api/workshops', {method:'POST', body:payload});
          form.reset(); form.elements.timezone.value = timezone; dirty = false;
          setStatus(form, result.message);
          const link = document.createElement('a');
          link.href = `calendar.html?event=${encodeURIComponent(result.event_id)}`;
          link.textContent = ' Open your workshop in Calendar';
          $('[data-platform-status]', form).append(link);
          if (result.workshop?.share_id) {
            const shareLink = document.createElement('a');
            shareLink.href = workshopShareHref(result.workshop);
            shareLink.textContent = ' Open the public invite page';
            shareLink.target = '_blank';
            shareLink.rel = 'noopener';
            $('[data-platform-status]', form).append(shareLink);
          }
          $('#workshopSearch').value = '';
          ['workshopCategory','workshopLevel','workshopFormat'].forEach(id => { $('#'+id).value = 'all'; });
          await loadWorkshops();
          window.SwapLabsMetrics?.refresh();
          toast('Your workshop is published.');
        } catch (error) { setStatus(form, error.message, error.code === 'pending_moderation' ? 'info' : 'error'); }
        finally { submitting = false; setBusy(button, false); }
      });
    }
    ['workshopSearch', 'workshopCategory', 'workshopLevel', 'workshopFormat'].forEach(id => document.getElementById(
      id)?.addEventListener(id === 'workshopSearch' ? 'input' : 'change', renderWorkshops));
    $('#workshopGrid')?.addEventListener('click', async event => {
      const button = event.target.closest('[data-workshop-register]');
      if (!button) return;
      const workshop = state.workshops.find(item => item.id === button.dataset.workshopRegister);
      if (!workshop) return;
      const cancelling = button.dataset.cancel === 'true';
      if (cancelling && !confirm(`Cancel your place in ${workshop.title}?`)) return;
      setBusy(button, true, cancelling ? 'Cancelling' : 'Reserving');
      try {
        const result = await api(`/api/workshops/${encodeURIComponent(workshop.id)}/register`, {
          method: cancelling ? 'DELETE' : 'POST'
        });
        const index = state.workshops.findIndex(item => item.id === workshop.id);
        if (index >= 0) state.workshops[index] = result.workshop;
        renderWorkshops();
        toast(result.message);
      } catch (error) {
        toast(error.message, error.code === 'pending_moderation' ? 'info' : 'error');
        setBusy(button, false);
      }
    });
    setupSharedWorkshopActions();
    loadWorkshops();
    loadSharedWorkshop();
  }

  function formatFunding(idea) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: idea.funding_currency || 'USD',
        maximumFractionDigits: 0
      }).format(Number(idea.funding_needed || 0));
    } catch (_error) {
      return `${escapeHtml(idea.funding_currency || '')} ${Number(idea.funding_needed || 0).toLocaleString()}`;
    }
  }

  function commentHtml(comment, idea) {
    const author = comment.author || {};
    const canDelete = Boolean(state.user && (state.user.role === 'admin' || state.user.id === author.id || idea
      .viewer_is_owner));
    return `<article class="idea-comment">${profileAvatar(author, author.display_name || 'Member')}<div><strong>${escapeHtml(author.display_name || 'Former member')}</strong><p>${escapeHtml(comment.message)}</p><time>${escapeHtml(formatDate(comment.created_at))}</time></div>${canDelete ? `<button type="button" data-delete-comment="${escapeHtml(comment.id)}" data-idea-id="${escapeHtml(idea.id)}" aria-label="Delete comment"><i class="bx bx-trash"></i></button>` : ''}</article>`;
  }

  function ownerAction(idea) {
    if (!state.user) return '<a class="btn" href="login.html"><i class="bx bx-log-in"></i> Sign in to follow</a>';
    if (idea.viewer_is_owner)
    return '<a class="btn" href="profile.html"><i class="bx bx-user-circle"></i> Your profile</a>';
    const relationship = idea.owner?.relationship || 'none';
    if (relationship === 'following')
    return `<button class="btn" type="button" data-follow-owner="${escapeHtml(idea.owner_id)}" data-remove-follow="true"><i class="bx bx-user-check"></i> Following</button>`;
    if (relationship === 'requested')
    return `<button class="btn" type="button" data-follow-owner="${escapeHtml(idea.owner_id)}" data-remove-follow="true"><i class="bx bx-time-five"></i> Requested</button>`;
    return `<button class="btn" type="button" data-follow-owner="${escapeHtml(idea.owner_id)}"><i class="bx bx-user-plus"></i> Follow owner</button>`;
  }

  function ideaCard(idea) {
    const owner = idea.owner;
    const profile = ownerProfile(owner);
    const name = ownerName(owner);
    const comments = (idea.comments || []).map(comment => commentHtml(comment, idea)).join('') ||
      '<p class="idea-summary-copy">No comments yet. Ask a useful question or offer specific help.</p>';
    const prototype = /^https?:\/\//i.test(idea.prototype_url || '') ?
      `<a class="btn btn-sm" href="${escapeHtml(idea.prototype_url)}" target="_blank" rel="noopener"><i class="bx bx-link-external"></i> View prototype</a>` :
      '';
    const signedAction = (type, active, icon, label, count = '') => state.user ?
      `<button class="idea-action ${active ? 'active' : ''}" type="button" data-idea-action="${type}" data-idea-id="${escapeHtml(idea.id)}"><i class="bx ${active ? `bxs-${icon.replace(/^bx-/, '')}` : icon}"></i><span>${escapeHtml(label)}${count !== '' ? ` ${Number(count)}` : ''}</span></button>` :
      `<a class="idea-action" href="login.html"><i class="bx ${icon}"></i><span>${escapeHtml(label)}${count !== '' ? ` ${Number(count)}` : ''}</span></a>`;
    return `<article class="idea-card" id="${escapeHtml(idea.id)}"><div class="idea-card-head"><div class="idea-card-meta"><span class="idea-category"><i class="bx bx-shape-circle"></i>${escapeHtml(idea.category)}</span><span class="idea-status ${escapeHtml(String(idea.status).replaceAll(' ', '_'))}">${escapeHtml(String(idea.status).replaceAll('_', ' '))}</span></div><h3>${escapeHtml(idea.title)}</h3><p class="idea-tagline">${escapeHtml(idea.tagline)}</p><div class="idea-owner">${profileAvatar(profile, name)}<div class="idea-owner-copy"><strong>${escapeHtml(name)} ${owner?.verified ? '<i class="bx bx-badge-check" style="color:var(--indigo)"></i>' : ''}</strong><span>@${escapeHtml(owner?.username || 'member')} · ${escapeHtml(profile.professional_role || profile.headline || 'Idea owner')}</span></div>${ownerAction(idea)}</div></div><div class="idea-card-body"><div class="idea-funding"><div><span>Funding sought</span><strong>${formatFunding(idea)}</strong></div><small>${escapeHtml(idea.stage)} · ${escapeHtml(idea.reach)}</small></div><div><span class="idea-summary-label">The problem</span><p class="idea-summary-copy">${escapeHtml(idea.problem)}</p></div><div class="idea-skill-list">${(idea.skills_needed || []).map(skill => `<span>${escapeHtml(skill)}</span>`).join('')}</div></div><details class="idea-detail"><summary>Read the complete idea <i class="bx bx-chevron-down"></i></summary><div class="idea-detail-content"><div class="idea-detail-block"><h4>Proposed solution</h4><p>${escapeHtml(idea.solution)}</p></div><div class="idea-detail-block"><h4>Who benefits</h4><p>${escapeHtml(idea.beneficiaries)}</p></div><div class="idea-detail-block"><h4>Intended impact</h4><p>${escapeHtml(idea.impact)}</p></div><div class="idea-detail-block"><h4>Use of funds</h4><p>${escapeHtml(idea.funds_use)}</p></div><div class="idea-detail-block"><h4>Collaboration sought</h4><p>${escapeHtml(idea.collaboration)}</p></div><div class="idea-detail-block"><h4>Community pitch</h4><p>${escapeHtml(idea.pitch)}</p></div>${prototype}<div class="idea-detail-block"><h4>Community discussion</h4><div class="idea-comments">${comments}</div></div>${state.user ? `<form class="idea-comment-form" data-comment-form="${escapeHtml(idea.id)}"><input name="message" maxlength="1200" required placeholder="Ask a question or offer specific help" aria-label="Comment on ${escapeHtml(idea.title)}"><button class="btn btn-primary" type="submit" aria-label="Post comment"><i class="bx bx-send"></i></button></form>` : '<div class="platform-lock"><i class="bx bx-lock-alt"></i><div><strong>Sign in to join the discussion</strong><span>Comments are connected to real member profiles.</span></div></div>'}</div></details><div class="idea-card-actions">${signedAction('like', idea.viewer_liked, 'bx-like', 'Support', idea.like_count)}<button class="idea-action" type="button" data-idea-action="comment" data-idea-id="${escapeHtml(idea.id)}"><i class="bx bx-message-rounded-dots"></i><span>Discuss ${Number(idea.comment_count)}</span></button>${signedAction('save', idea.viewer_saved, 'bx-bookmark', 'Save', '')}<button class="idea-action" type="button" data-idea-action="share" data-idea-id="${escapeHtml(idea.id)}"><i class="bx bx-share-alt"></i><span>Share</span></button></div></article>`;
  }

  function filteredIdeas() {
    const query = normalize($('#ideaSearch')?.value);
    const category = $('#ideaCategory')?.value || 'all';
    const stage = $('#ideaStage')?.value || 'all';
    const sort = $('#ideaSort')?.value || 'supported';
    const ideas = state.ideas.filter(idea => {
      const haystack = normalize([idea.title, idea.tagline, idea.problem, idea.solution, idea.impact, idea
        .beneficiaries, idea.category, idea.stage, idea.reach, ownerName(idea.owner), ...(idea
          .skills_needed || [])
      ].join(' '));
      return (!query || haystack.includes(query)) && (category === 'all' || idea.category === category) && (
        stage === 'all' || idea.stage === stage);
    });
    ideas.sort((a, b) => {
      if (sort === 'newest') return new Date(b.created_at) - new Date(a.created_at);
      if (sort === 'funding-high') return Number(b.funding_needed) - Number(a.funding_needed);
      if (sort === 'funding-low') return Number(a.funding_needed) - Number(b.funding_needed);
      if (sort === 'comments') return Number(b.comment_count) - Number(a.comment_count);
      return Number(b.like_count) - Number(a.like_count) || Number(b.comment_count) - Number(a.comment_count);
    });
    return ideas;
  }

  function renderIdeas() {
    const grid = $('#ideaGrid');
    if (!grid) return;
    const items = filteredIdeas();
    $('#ideaResultCount').textContent = `${items.length} of ${state.ideas.length} ideas shown`;
    grid.innerHTML = items.length ? items.map(ideaCard).join('') :
      '<div class="idea-empty"><i class="bx bx-search-alt"></i><h3>No ideas match these filters</h3><p>Try a broader problem, category, stage, skill, or owner.</p></div>';
  }

  async function loadIdeas() {
    const grid = $('#ideaGrid');
    try {
      const result = await api('/api/ideas');
      state.ideas = result.ideas || [];
      $('#ideaStatIdeas').textContent = String(result.stats?.ideas || 0);
      $('#ideaStatSupporters').textContent = String(result.stats?.supporters || 0);
      $('#ideaStatComments').textContent = String(result.stats?.comments || 0);
      $('#ideaStatFunding').textContent = Number(result.stats?.funding_requested || 0).toLocaleString();
      setSelectOptions($('#ideaCategory'), state.ideas.map(item => item.category), 'All categories');
      setSelectOptions($('#ideaStage'), state.ideas.map(item => item.stage), 'All stages');
      renderIdeas();
    } catch (error) {
      if (grid) grid.innerHTML =
        `<div class="idea-empty"><i class="bx bx-wifi-off"></i><h3>Innovation community unavailable</h3><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  function setupIdeaForm() {
    const form = $('#ideaForm');
    if (!form) return;
    const authState = $('#ideaAuthState');
    if (!state.user) {
      authState.innerHTML =
        '<div class="platform-lock" style="margin-bottom:20px"><i class="bx bx-lock-alt"></i><div><strong>Sign in before publishing an idea.</strong><span>Your submission must have a real owner profile. <a href="login.html" style="color:var(--indigo);font-weight:800">Log in</a> or <a href="register.html" style="color:var(--indigo);font-weight:800">create an account</a>.</span></div></div>';
      $$('input,select,textarea,button[type="submit"]', form).forEach(control => control.disabled = true);
      return;
    }
    const studentAccount = Boolean(state.user.safety?.is_minor);
    authState.innerHTML = studentAccount ?
      `<div class="platform-lock student-idea-review-notice" style="margin-bottom:20px"><i class="bx bx-shield-quarter"></i><div><strong>Submitting as a protected student account</strong><span>Your idea is saved privately first. A safeguarding specialist reviews it before community publication, and your exact age and sensitive profile details stay hidden.</span></div></div>` :
      `<div class="platform-lock" style="margin-bottom:20px"><i class="bx bx-user-check"></i><div><strong>Publishing as ${escapeHtml(state.user.profile?.display_name || state.user.username)}</strong><span>Your profile privacy settings continue to control which owner details other members can see.</span></div></div>`;
    if (studentAccount) {
      const submitButton = $('button[type="submit"]', form);
      submitButton.innerHTML = '<i class="bx bx-shield-quarter"></i> Submit for specialist review';
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      clearStatus(form);
      const button = $('button[type="submit"]', form);
      const payload = formObject(form);
      payload.community_agreement = $('[name="community_agreement"]', form).checked;
      payload.funding_needed = Number(payload.funding_needed);
      setBusy(button, true, 'Publishing idea');
      try {
        const result = await api('/api/ideas', {
          method: 'POST',
          body: payload
        });
        setStatus(form, result.message, 'success');
        toast(result.message);
        form.reset();
        await loadIdeas();
        document.getElementById(result.idea.id)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      } catch (error) {
        setStatus(form, error.message, 'error');
        toast(error.message, 'error');
      } finally {
        setBusy(button, false);
      }
    });
  }

  function setupIdeaInteractions() {
    ['ideaSearch', 'ideaCategory', 'ideaStage', 'ideaSort'].forEach(id => document.getElementById(id)
      ?.addEventListener(id === 'ideaSearch' ? 'input' : 'change', renderIdeas));
    const grid = $('#ideaGrid');
    grid?.addEventListener('click', async event => {
      const follow = event.target.closest('[data-follow-owner]');
      if (follow) {
        setBusy(follow, true, follow.dataset.removeFollow === 'true' ? 'Updating' : 'Following');
        try {
          const ownerId = follow.dataset.followOwner;
          const result = await api(`/api/community/users/${encodeURIComponent(ownerId)}/follow`, {
            method: follow.dataset.removeFollow === 'true' ? 'DELETE' : 'POST'
          });
          state.ideas.filter(idea => idea.owner_id === ownerId).forEach(idea => {
            idea.owner.relationship = result.relationship;
          });
          renderIdeas();
          toast(result.message);
        } catch (error) {
          toast(error.message, 'error');
          setBusy(follow, false);
        }
        return;
      }
      const deleteComment = event.target.closest('[data-delete-comment]');
      if (deleteComment) {
        if (!confirm('Delete this comment?')) return;
        try {
          await api(
            `/api/ideas/${encodeURIComponent(deleteComment.dataset.ideaId)}/comments/${encodeURIComponent(deleteComment.dataset.deleteComment)}`, {
              method: 'DELETE'
            });
          await loadIdeas();
          toast('Comment removed.');
        } catch (error) {
          toast(error.message, 'error');
        }
        return;
      }
      const action = event.target.closest('[data-idea-action]');
      if (!action) return;
      const idea = state.ideas.find(item => item.id === action.dataset.ideaId);
      if (!idea) return;
      if (action.dataset.ideaAction === 'comment') {
        const details = action.closest('.idea-card').querySelector('.idea-detail');
        details.open = true;
        details.querySelector('input')?.focus();
        return;
      }
      if (action.dataset.ideaAction === 'share') {
        const url = `${location.origin}${location.pathname}#${encodeURIComponent(idea.id)}`;
        try {
          await navigator.clipboard.writeText(url);
          toast('Idea link copied.');
        } catch (_error) {
          location.hash = idea.id;
          toast('The idea link is ready in your address bar.');
        }
        return;
      }
      if (['like', 'save'].includes(action.dataset.ideaAction)) {
        setBusy(action, true, action.dataset.ideaAction === 'like' ? 'Updating' : 'Saving');
        try {
          const result = await api(`/api/ideas/${encodeURIComponent(idea.id)}/${action.dataset.ideaAction}`, {
            method: 'POST'
          });
          if (action.dataset.ideaAction === 'like') {
            idea.viewer_liked = result.liked;
            idea.like_count = result.like_count;
          } else {
            idea.viewer_saved = result.saved;
            idea.save_count = result.save_count;
          }
          renderIdeas();
          toast(action.dataset.ideaAction === 'like' ? (result.liked ? 'Idea supported.' : 'Support removed.') :
            (result.saved ? 'Idea saved.' : 'Idea removed from saved items.'));
        } catch (error) {
          toast(error.message, 'error');
          setBusy(action, false);
        }
      }
    });
    grid?.addEventListener('submit', async event => {
      const form = event.target.closest('[data-comment-form]');
      if (!form) return;
      event.preventDefault();
      const button = $('button[type="submit"]', form);
      setBusy(button, true, 'Posting');
      try {
        await api(`/api/ideas/${encodeURIComponent(form.dataset.commentForm)}/comments`, {
          method: 'POST',
          body: {
            message: $('[name="message"]', form).value
          }
        });
        await loadIdeas();
        document.getElementById(form.dataset.commentForm)?.querySelector('.idea-detail')?.setAttribute('open',
          '');
        toast('Comment added.');
      } catch (error) {
        toast(error.message, 'error');
        setBusy(button, false);
      }
    });
  }

  function setupInnovation() {
    setupIdeaForm();
    setupIdeaInteractions();
    loadIdeas().then(() => {
      if (location.hash && document.getElementById(location.hash.slice(1))) document.getElementById(location.hash
        .slice(1)).scrollIntoView({
        block: 'center'
      });
    });
  }

  const statusOptions = (values, selected) => values.map(value =>
    `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value.replaceAll('_', ' '))}</option>`
    ).join('');
  const adminMeta = pairs =>
    `<div class="admin-content-meta">${pairs.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 'Not set')}</strong></div>`).join('')}</div>`;

  function adminIdeaCard(idea) {
    return `<details class="admin-content-card ${idea.status === 'specialist_review' ? 'student-specialist-review' : ''}"><summary><span class="admin-content-icon"><i class="bx ${idea.status === 'specialist_review' ? 'bx-shield-quarter' : 'bx-bulb'}"></i></span><span class="admin-content-copy"><strong>${escapeHtml(idea.title)}</strong><span>${escapeHtml(ownerName(idea.owner))} · ${escapeHtml(idea.category)} · ${formatFunding(idea)}</span></span><span class="admin-content-status">${escapeHtml(idea.status.replaceAll('_', ' '))}</span></summary><div class="admin-content-body">${adminMeta([['Record ID', idea.id], ['Owner ID', idea.owner_id], ['Owner age group', idea.owner_age_group || 'adult'], ['Safety review', idea.safety_review_status || 'not required'], ['Guardian consent', idea.guardian_consent_status || 'not required'], ['Specialist reviewer', idea.specialist_reviewer_id || 'Unassigned'], ['Created', formatDate(idea.created_at)], ['Likes', idea.like_count], ['Saves', idea.save_count], ['Comments', idea.comment_count]])}<form class="platform-form" data-admin-idea-form="${escapeHtml(idea.id)}"><div class="platform-form-grid"><div class="field full"><label>Title</label><input name="title" maxlength="120" required value="${escapeHtml(idea.title)}"></div><div class="field full"><label>Tagline</label><textarea name="tagline" maxlength="240" required>${escapeHtml(idea.tagline)}</textarea></div><div class="field"><label>Category</label><input name="category" maxlength="80" required value="${escapeHtml(idea.category)}"></div><div class="field"><label>Stage</label><input name="stage" maxlength="60" required value="${escapeHtml(idea.stage)}"></div><div class="field full"><label>Problem</label><textarea name="problem" maxlength="1800" required>${escapeHtml(idea.problem)}</textarea></div><div class="field full"><label>Solution</label><textarea name="solution" maxlength="1800" required>${escapeHtml(idea.solution)}</textarea></div><div class="field full"><label>Beneficiaries</label><textarea name="beneficiaries" maxlength="700" required>${escapeHtml(idea.beneficiaries)}</textarea></div><div class="field full"><label>Impact</label><textarea name="impact" maxlength="1000" required>${escapeHtml(idea.impact)}</textarea></div><div class="field"><label>Funding currency</label><input name="funding_currency" maxlength="10" required value="${escapeHtml(idea.funding_currency)}"></div><div class="field"><label>Funding needed</label><input name="funding_needed" type="number" min="0" max="1000000000" required value="${Number(idea.funding_needed)}"></div><div class="field full"><label>Use of funds</label><textarea name="funds_use" maxlength="1200" required>${escapeHtml(idea.funds_use)}</textarea></div><div class="field full"><label>Skills needed</label><input name="skills_needed" required value="${escapeHtml((idea.skills_needed || []).join(', '))}"></div><div class="field full"><label>Collaboration sought</label><textarea name="collaboration" maxlength="500" required>${escapeHtml(idea.collaboration)}</textarea></div><div class="field"><label>Reach</label><input name="reach" maxlength="180" required value="${escapeHtml(idea.reach)}"></div><div class="field"><label>Prototype URL</label><input name="prototype_url" maxlength="300" value="${escapeHtml(idea.prototype_url || '')}"></div><div class="field full"><label>Pitch</label><textarea name="pitch" maxlength="1200" required>${escapeHtml(idea.pitch)}</textarea></div><div class="field"><label>Moderation status</label><select name="status">${statusOptions(['specialist_review','under_review','published','funded','pilot','seeking_support','archived','rejected'], idea.status)}</select></div><div class="field full"><label>Private specialist and moderation notes</label><textarea name="moderation_notes" maxlength="2400">${escapeHtml(idea.moderation_notes || '')}</textarea></div></div><div class="admin-record-actions"><button class="btn btn-danger" type="button" data-admin-delete-idea="${escapeHtml(idea.id)}"><i class="bx bx-trash"></i> Delete idea permanently</button><button class="btn btn-primary" type="submit"><i class="bx bx-save"></i> Save idea and moderation</button></div><div class="platform-form-status" data-platform-status></div></form></div></details>`;
  }

  function adminSubmissionCard(item, collection, icon, title, subtitle, bodyHtml, formHtml, deletable = true) {
    return `<details class="admin-content-card"><summary><span class="admin-content-icon"><i class="bx ${icon}"></i></span><span class="admin-content-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(subtitle)}</span></span><span class="admin-content-status">${escapeHtml(String(item.status || 'new').replaceAll('_', ' '))}</span></summary><div class="admin-content-body">${bodyHtml}<form class="platform-form" data-admin-content-form="${escapeHtml(collection)}" data-content-id="${escapeHtml(item.id)}">${formHtml}<div class="admin-record-actions">${deletable ? `<button class="btn btn-danger" type="button" data-admin-delete-content="${escapeHtml(collection)}" data-content-id="${escapeHtml(item.id)}"><i class="bx bx-trash"></i> Delete record</button>` : ''}<button class="btn btn-primary" type="submit"><i class="bx bx-save"></i> Save changes</button></div><div class="platform-form-status" data-platform-status></div></form></div></details>`;
  }

  function renderAdminTab() {
    const host = $('#platformAdminList');
    const data = state.adminContent;
    if (!host || !data) return;
    $$('.platform-admin-tab').forEach(button => button.classList.toggle('active', button.dataset.adminContentTab ===
      state.adminTab));
    if (state.adminTab === 'ideas') {
      host.innerHTML = data.ideas.length ? data.ideas.map(adminIdeaCard).join('') :
        '<div class="idea-empty"><i class="bx bx-bulb"></i><h3>No ideas</h3></div>';
      return;
    }
    if (state.adminTab === 'complaints') {
      host.innerHTML = data.complaints.length ? data.complaints.map(item => adminSubmissionCard(item, 'complaints',
          'bx-message-square-error', item.subject, `${item.name} · ${item.email} · ${item.category}`,
          `${adminMeta([['ID', item.id], ['Priority', item.priority], ['Reference', item.reference || 'None'], ['Created', formatDate(item.created_at)]])}<div class="admin-record-copy"><strong>Complaint details</strong>\n${escapeHtml(item.details)}\n\n<strong>Requested resolution</strong>\n${escapeHtml(item.resolution)}</div>`,
          `<div class="platform-form-grid"><div class="field"><label>Status</label><select name="status">${statusOptions(['received','triage','investigating','waiting','resolved','closed'], item.status)}</select></div><div class="field"><label>Priority</label><select name="priority">${statusOptions(['standard','time-sensitive','urgent'], item.priority)}</select></div><div class="field full"><label>Private admin notes</label><textarea name="admin_notes" maxlength="2400">${escapeHtml(item.admin_notes || '')}</textarea></div></div>`
          )).join('') :
        '<div class="idea-empty"><i class="bx bx-check-circle"></i><h3>No complaints submitted</h3></div>';
      return;
    }
    if (state.adminTab === 'contacts') {
      host.innerHTML = data.contact_messages.length ? data.contact_messages.map(item => adminSubmissionCard(item,
          'contacts', 'bx-envelope', item.subject, `${item.name} · ${item.email} · ${item.topic}`,
          `${adminMeta([['ID', item.id], ['Preferred response', item.preferred_contact], ['Member ID', item.user_id || 'Anonymous'], ['Created', formatDate(item.created_at)]])}<div class="admin-record-copy">${escapeHtml(item.message)}</div>`,
          `<div class="platform-form-grid"><div class="field"><label>Status</label><select name="status">${statusOptions(['new','in_progress','waiting','resolved','closed'], item.status)}</select></div><div class="field full"><label>Private admin notes</label><textarea name="admin_notes" maxlength="2400">${escapeHtml(item.admin_notes || '')}</textarea></div></div>`
          )).join('') :
        '<div class="idea-empty"><i class="bx bx-inbox"></i><h3>No contact messages submitted</h3></div>';
      return;
    }
    if (state.adminTab === 'feedback') {
      host.innerHTML = data.feedback.length ? data.feedback.map(item => adminSubmissionCard(item, 'feedback',
          'bx-message-square-dots', item.title, `${item.name} · ${item.role} · ${item.rating}/5`, adminMeta([
            ['ID', item.id],
            ['Email', item.email],
            ['Permission', item.permission_to_publish ? 'Granted' : 'Private'],
            ['Created', formatDate(item.created_at)]
          ]),
          `<div class="platform-form-grid"><div class="field full"><label>Title</label><input name="title" maxlength="140" required value="${escapeHtml(item.title)}"></div><div class="field full"><label>Message</label><textarea name="message" maxlength="1800" required>${escapeHtml(item.message)}</textarea></div><div class="field"><label>Role</label><input name="role" maxlength="120" required value="${escapeHtml(item.role)}"></div><div class="field"><label>Rating</label><input name="rating" type="number" min="1" max="5" value="${Number(item.rating)}"></div><div class="field"><label>Status</label><select name="status">${statusOptions(item.permission_to_publish ? ['published','private','hidden'] : ['private','hidden'], item.status)}</select></div><label class="platform-check"><input name="featured" type="checkbox" ${item.featured ? 'checked' : ''}><span><strong>Featured testimonial</strong><span>Prioritize this record in public results.</span></span></label><div class="field full"><label>Private admin notes</label><textarea name="admin_notes" maxlength="2400">${escapeHtml(item.admin_notes || '')}</textarea></div></div>`
          )).join('') :
        '<div class="idea-empty"><i class="bx bx-message-square-dots"></i><h3>No feedback submitted</h3></div>';
      return;
    }
    if (state.adminTab === 'workshops') {
      const workshopCards = data.workshops.map(item => adminSubmissionCard(item, 'workshops', 'bx-chalkboard', item
        .title,
        `${item.category} · ${formatDate(item.starts_at)} · ${item.registered_count}/${item.seat_limit} registered`,
        adminMeta([
          ['ID', item.id],
          ['Host', ownerName(item.host)],
          ['Level', item.level],
          ['Format', item.format],
          ['Seats remaining', item.seats_remaining]
        ]),
        `<div class="platform-form-grid"><div class="field full"><label>Title</label><input name="title" maxlength="140" required value="${escapeHtml(item.title)}"></div><div class="field full"><label>Description</label><textarea name="description" maxlength="1200" required>${escapeHtml(item.description)}</textarea></div><div class="field"><label>Location</label><input name="location" maxlength="160" required value="${escapeHtml(item.location)}"></div><div class="field"><label>Status</label><select name="status">${statusOptions(['scheduled','completed','cancelled','archived'], item.status)}</select></div><div class="field full"><label>Private admin notes</label><textarea name="admin_notes" maxlength="2400">${escapeHtml(item.admin_notes || '')}</textarea></div></div>`,
        false)).join('');
      const registrations = data.workshop_registrations.map(item => {
        const workshop = data.workshops.find(candidate => candidate.id === item.workshop_id);
        const userName = item.user?.profile?.display_name || item.user_id;
        return adminSubmissionCard(item, 'registrations', 'bx-calendar-check', workshop?.title || item
          .workshop_id, `${userName} · ${item.status}`, adminMeta([
            ['Registration ID', item.id],
            ['Member ID', item.user_id],
            ['Workshop ID', item.workshop_id],
            ['Created', formatDate(item.created_at)]
          ]),
          `<div class="platform-form-grid"><div class="field"><label>Status</label><select name="status">${statusOptions(['registered','attended','cancelled','no_show','waitlisted'], item.status)}</select></div><div class="field full"><label>Private admin notes</label><textarea name="admin_notes" maxlength="2400">${escapeHtml(item.admin_notes || '')}</textarea></div></div>`
          );
      }).join('');
      host.innerHTML =
        `<div class="platform-heading" style="margin:12px 0 6px"><h2 style="font-size:1.35rem">Workshop definitions</h2></div>${workshopCards || '<div class="idea-empty">No workshops.</div>'}<div class="platform-heading" style="margin:30px 0 6px"><h2 style="font-size:1.35rem">Saved registrations</h2></div>${registrations || '<div class="idea-empty">No registrations.</div>'}`;
    }
  }

  function injectAdminWorkspace() {
    const container = $('#adminDashboard > .container');
    if (!container || $('#platformAdmin')) return;
    const section = document.createElement('section');
    section.className = 'platform-admin';
    section.id = 'platformAdmin';
    section.innerHTML =
      `<div class="platform-admin-head"><div><span class="eyebrow">Platform content and submissions</span><h2>Content moderation workspace</h2><p>Review every idea, complaint, contact message, testimonial, workshop, and registration saved by the new platform pages.</p></div><button class="btn" type="button" id="platformAdminRefresh"><i class="bx bx-refresh"></i> Refresh content</button></div><div class="platform-admin-stats" id="platformAdminStats"></div><div class="platform-admin-tabs"><button class="platform-admin-tab active" type="button" data-admin-content-tab="ideas"><i class="bx bx-bulb"></i> Ideas</button><button class="platform-admin-tab" type="button" data-admin-content-tab="complaints"><i class="bx bx-message-square-error"></i> Complaints</button><button class="platform-admin-tab" type="button" data-admin-content-tab="contacts"><i class="bx bx-envelope"></i> Contact</button><button class="platform-admin-tab" type="button" data-admin-content-tab="feedback"><i class="bx bx-message-square-dots"></i> Feedback</button><button class="platform-admin-tab" type="button" data-admin-content-tab="workshops"><i class="bx bx-chalkboard"></i> Workshops</button></div><div class="platform-admin-list" id="platformAdminList"><div class="platform-loading"><i class="bx bx-loader-alt"></i>Loading platform content.</div></div>`;
    const auditSection = $('[data-admin-section="audit"]', container);
    container.insertBefore(section, auditSection || null);
    section.addEventListener('click', async event => {
      const tab = event.target.closest('[data-admin-content-tab]');
      if (tab) {
        state.adminTab = tab.dataset.adminContentTab;
        renderAdminTab();
        return;
      }
      if (event.target.closest('#platformAdminRefresh')) {
        await loadAdminContent();
        return;
      }
      const deleteIdea = event.target.closest('[data-admin-delete-idea]');
      if (deleteIdea) {
        const idea = state.adminContent.ideas.find(item => item.id === deleteIdea.dataset.adminDeleteIdea);
        if (!idea || !confirm(
            `Permanently delete ${idea.title}? This removes the idea, likes, saves, and comments.`)) return;
        setBusy(deleteIdea, true, 'Deleting');
        try {
          const result = await api(`/api/admin/ideas/${encodeURIComponent(idea.id)}`, {
            method: 'DELETE'
          });
          toast(result.message);
          await loadAdminContent();
        } catch (error) {
          toast(error.message, 'error');
          setBusy(deleteIdea, false);
        }
        return;
      }
      const deleteContent = event.target.closest('[data-admin-delete-content]');
      if (deleteContent) {
        if (!confirm('Delete this saved record permanently?')) return;
        setBusy(deleteContent, true, 'Deleting');
        try {
          const result = await api(
            `/api/admin/content/${encodeURIComponent(deleteContent.dataset.adminDeleteContent)}/${encodeURIComponent(deleteContent.dataset.contentId)}`, {
              method: 'DELETE'
            });
          toast(result.message);
          await loadAdminContent();
        } catch (error) {
          toast(error.message, 'error');
          setBusy(deleteContent, false);
        }
      }
    });
    section.addEventListener('submit', async event => {
      const ideaForm = event.target.closest('[data-admin-idea-form]');
      const contentForm = event.target.closest('[data-admin-content-form]');
      if (!ideaForm && !contentForm) return;
      event.preventDefault();
      const form = ideaForm || contentForm;
      const button = $('button[type="submit"]', form);
      const payload = formObject(form);
      if (payload.funding_needed !== undefined) payload.funding_needed = Number(payload.funding_needed);
      if (payload.rating !== undefined) payload.rating = Number(payload.rating);
      if (contentForm?.dataset.adminContentForm === 'feedback') payload.featured = $('[name="featured"]', form)
        .checked;
      setBusy(button, true, 'Saving');
      clearStatus(form);
      try {
        const path = ideaForm ? `/api/admin/ideas/${encodeURIComponent(ideaForm.dataset.adminIdeaForm)}` :
          `/api/admin/content/${encodeURIComponent(contentForm.dataset.adminContentForm)}/${encodeURIComponent(contentForm.dataset.contentId)}`;
        const result = await api(path, {
          method: 'PATCH',
          body: payload
        });
        setStatus(form, result.message, 'success');
        toast(result.message);
        await loadAdminContent();
      } catch (error) {
        setStatus(form, error.message, 'error');
        toast(error.message, 'error');
        setBusy(button, false);
      }
    });
  }

  async function loadAdminContent() {
    const host = $('#platformAdminList');
    try {
      const result = await api('/api/admin/content');
      state.adminContent = result;
      const stats = [
        ['bx-bulb', result.stats.ideas, 'ideas'],
        ['bx-shield-quarter', result.stats.student_reviews, 'student ideas awaiting review'],
        ['bx-carousel', result.stats.published_testimonials, 'published testimonials'],
        ['bx-message-square-error', result.stats.open_complaints, 'open complaints'],
        ['bx-envelope', result.stats.new_contacts, 'new contact messages'],
        ['bx-calendar-check', result.stats.workshop_registrations, 'workshop registrations']
      ];
      $('#platformAdminStats').innerHTML = stats.map(([icon, value, label]) =>
        `<div class="platform-admin-stat"><i class="bx ${icon}"></i><strong>${Number(value)}</strong><span>${escapeHtml(label)}</span></div>`
        ).join('');
      renderAdminTab();
    } catch (error) {
      if (host) host.innerHTML =
        `<div class="idea-empty"><i class="bx bx-error-circle"></i><h3>Content workspace unavailable</h3><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  async function setupAdminContent() {
    if (!hasAdmin || state.user?.role !== 'admin' || $('[data-workspace="submissions"]')) return;
    injectAdminWorkspace();
    await loadAdminContent();
  }

  async function setupLeaderboards() {
    const host = $('#creditsLeaderboard');
    if (!host) return;
    try {
      const result = await api('/api/leaderboard');
      const leaders = result.leaders || [];
      $('#leaderboardSeason').textContent = `${leaders.length} live leaders`;
      $('#creditTotal').textContent = formatNumber(result.stats?.total_credits || 0);
      const topScore = Math.max(...leaders.map(member => Number(member.credits || 0)), 0);
      $('#creditProgress').style.width = `${leaders.length ? Math.min(100, Math.max(12, Math.round(topScore / Math.max(topScore, 1) * 100))) : 0}%`;
      host.innerHTML = leaders.length ? leaders.map(member => {
        const skills = (member.skills_to_teach || []).slice(0, 2).join(' · ') || member.headline || 'SwapLabs member';
        const reputation = member.reputation || {};
        return `<a class="data-row leaderboard-row" href="member-profile.html?id=${encodeURIComponent(member.id)}"><span class="step-num">${member.rank}</span>${profileAvatar(member, member.display_name, 'avatar')}<div><strong>${escapeHtml(member.display_name)}</strong><small>${escapeHtml(skills)} · ${Number(reputation.completed_sessions || 0)} sessions</small></div><span class="leaderboard-score"><strong>${formatNumber(member.credits)}</strong><small>credits</small></span></a>`;
      }).join('') :
        '<div class="data-row"><i class="bx bx-user-x"></i><div><strong>No ranked members yet</strong><small>Public credit leaders will appear as members join and build their balance.</small></div></div>';
    } catch (error) {
      host.innerHTML =
        `<div class="data-row"><i class="bx bx-wifi-off"></i><div><strong>Leaderboard unavailable</strong><small>${escapeHtml(error.message)}</small></div></div>`;
    }
  }

  async function initialize() {
    // Testimonials are public. Start that request immediately instead of
    // waiting for the private session check, so the landing and feedback
    // pages can paint both pieces in parallel.
    if (hasTestimonials) loadTestimonials();
    if (page || hasAdmin) {
      try {
        const auth = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me'));
        state.user = auth.authenticated ? auth.user : null;
        state.csrf = auth.csrf_token || state.csrf;
      } catch (_error) {
        state.serverAvailable = false;
      }
    }
    if (page === 'workshops') setupWorkshops();
    if (page === 'contact') setupUnifiedSupportForm();
    if (page === 'complaint') setupSimpleForm('complaintForm', '/api/complaints', 'Submitting complaint');
    if (page === 'feedback') setupFeedbackForm();
    if (page === 'innovation') setupInnovation();
    if (page === 'leaderboards') setupLeaderboards();
    setupAdminContent();
  }

  initialize();
})();
