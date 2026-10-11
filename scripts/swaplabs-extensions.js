(() => {
  'use strict';

  const root = document.querySelector('[data-extension-page]');
  if (!root) return;

  const page = root.dataset.extensionPage;
  const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  let csrfToken = '';

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const {escapeHtml} = window.RelayComponents;
  const formatNumber = value => Number(value || 0).toLocaleString();
  const formatDate = value => value ? new Date(value).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short'
  }) : 'Not scheduled';

  async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (writeMethods.has(method) && !csrfToken) {
      csrfToken = (await (await fetch('/api/auth/csrf', {
        credentials: 'same-origin'
      })).json()).csrf_token;
    }
    const headers = {
      ...(options.headers || {})
    };
    if (writeMethods.has(method)) headers['X-CSRF-Token'] = csrfToken;
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
    let payload = {};
    try {
      payload = await response.json();
    } catch (_error) {
      payload = {
        error: 'SwapLabs returned an unreadable response.'
      };
    }
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `Request failed (${response.status}).`);
    }
    if (payload.moderation?.status === 'pending') {
      const error = new Error(payload.message || 'Your submission is pending administrator review and is hidden from the platform.');
      error.status = response.status;
      error.code = 'pending_moderation';
      throw error;
    }
    return payload;
  }

  function formValues(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    form.querySelectorAll('input[type="checkbox"]').forEach(input => {
      values[input.name] = input.checked;
    });
    return values;
  }

  function setStatus(element, message, type = 'success') {
    if (!element) return;
    if (type === 'error' && /pending (?:administrator )?review/i.test(String(message || ''))) type = 'info';
    element.className = `feature-status show ${type}`;
    element.innerHTML = `<i class="bx ${type === 'error' ? 'bx-error-circle' : 'bx-check-circle'}"></i><span>${escapeHtml(message)}</span>`;
  }

  function avatar(member) {
    const initials = String(member?.display_name || member?.username || 'SL').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(part => part[0]).join('').toUpperCase();
    const url = String(member?.avatar_url || '');
    const image = /^(?:\/uploads\/usr_[A-Za-z0-9_-]+\.(?:jpg|png|webp)|data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2})$/.test(url) ?
      `<img src="${escapeHtml(url)}" alt="">` : escapeHtml(initials);
    const color = ['indigo', 'blue', 'pink', 'purple', 'green', 'orange'].includes(member?.profile_color) ? member.profile_color : 'indigo';
    return `<span class="feature-avatar ${escapeHtml(color)}">${image}</span>`;
  }

  function renderStats(stats = {}) {
    $$('[data-feature-stat]').forEach(element => {
      const key = element.dataset.featureStat;
      element.textContent = formatNumber(stats[key]);
    });
  }

  function requireLogin(message = 'Log in to use this feature.') {
    root.innerHTML = `<section class="feature-empty"><i class="bx bx-lock-alt"></i><h2>${escapeHtml(message)}</h2><p>Your saved account powers this page.</p><a class="btn btn-primary" href="login.html">Log in</a></section>`;
  }

  async function copyMeetingInvite(token, button) {
    const link = new URL('video-room.html', window.location.href);
    link.search = `?invite=${encodeURIComponent(token)}`;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link.toString());
      else {
        const input = document.createElement('input');
        input.value = link.toString();
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      const original = button.innerHTML;
      button.innerHTML = '<i class="bx bx-check"></i> Copied';
      window.setTimeout(() => { button.innerHTML = original; }, 2200);
    } catch (_error) {
      alert('Could not copy the meeting invite link.');
    }
  }

  function cardEmpty(message) {
    return `<div class="feature-empty inline"><i class="bx bx-info-circle"></i><h3>${escapeHtml(message)}</h3></div>`;
  }

  async function initAchievements() {
    try {
      const result = await api('/api/achievements');
      renderStats(result.stats);
      const grid = $('#achievementGrid');
      grid.innerHTML = result.badges.map(badge => `
        <article class="feature-card achievement-card ${badge.earned ? 'earned' : ''}">
          <span class="feature-card-icon"><i class="bx ${escapeHtml(badge.icon)}"></i></span>
          <div class="feature-card-main">
            <span class="feature-chip">${badge.earned ? 'Earned' : `${badge.progress}% complete`}</span>
            <h3>${escapeHtml(badge.title)}</h3>
            <p>${escapeHtml(badge.description)}</p>
            <div class="feature-progress"><span style="width:${badge.progress}%"></span></div>
            <small>${formatNumber(badge.current)} of ${formatNumber(badge.target)}</small>
          </div>
          <button class="feature-icon-button ${badge.pinned ? 'active' : ''}" data-pin-achievement="${escapeHtml(badge.id)}" title="Pin achievement"><i class="bx bx-pin"></i></button>
        </article>
      `).join('');
      grid.addEventListener('click', async event => {
        const button = event.target.closest('[data-pin-achievement]');
        if (!button) return;
        const pinned = result.badges.filter(item => item.pinned).map(item => item.id);
        const id = button.dataset.pinAchievement;
        const next = pinned.includes(id) ? pinned.filter(item => item !== id) : [...pinned, id].slice(-4);
        const updated = await api('/api/achievements/pins', {
          method: 'PATCH',
          body: {
            achievement_ids: next
          }
        });
        result.badges = updated.badges;
        await initAchievements();
      }, {
        once: true
      });
    } catch (error) {
      requireLogin(error.message);
    }
  }

  async function initSessionRoom() {
    try {
      const result = await api('/api/session-room');
      renderStats(result.stats);
      $('#sessionEventGrid').innerHTML = result.events.length ? result.events.map(event => `
        <article class="feature-card">
          <span class="feature-chip">${escapeHtml(event.status)}</span>
          <h3>${escapeHtml(event.title)}</h3>
          <p>${escapeHtml(event.description || 'No session description was added.')}</p>
          <div class="feature-meta"><span><i class="bx bx-calendar"></i>${formatDate(event.starts_at)}</span><span><i class="bx bx-group"></i>${event.participants?.length || 0} invited</span></div>
          <div class="feature-actions">
            <a class="btn btn-sm" href="calendar.html?event=${encodeURIComponent(event.id)}">Calendar</a>
            <button class="btn btn-primary btn-sm" data-open-room="${escapeHtml(event.id)}"><i class="bx bx-video"></i>${event.video_room_id ? 'Open room' : 'Create room'}</button>
            ${event.video_invite_token ? `<button class="btn btn-sm" type="button" data-copy-meeting-invite="${escapeHtml(event.video_invite_token)}"><i class="bx bx-link"></i> Copy invite</button>` : ''}
          </div>
        </article>
      `).join('') : cardEmpty('Schedule a calendar session first.');
      $('#sessionRoomGrid').innerHTML = result.rooms.length ? result.rooms.map(room => `
        <article class="feature-card dark-feature-card">
          <span class="feature-card-icon"><i class="bx bx-video"></i></span>
          <h3>${escapeHtml(room.title)}</h3>
          <p>${escapeHtml(room.waiting_room_enabled ? 'Waiting room enabled' : 'Direct entry enabled')} · ${escapeHtml(room.screen_sharing_enabled ? 'Screen sharing enabled' : 'Screen sharing disabled')}</p>
          <div class="feature-meta"><span>${room.participants?.length || 0} people</span><span>${room.attendance?.length || 0} attendance records</span></div>
          <div class="feature-actions"><a class="btn btn-primary btn-sm" href="video-room.html?room=${encodeURIComponent(room.id)}">Enter room</a>${room.invite_token ? `<button class="btn btn-sm" type="button" data-copy-meeting-invite="${escapeHtml(room.invite_token)}"><i class="bx bx-link"></i> Copy invite</button>` : ''}</div>
        </article>
      `).join('') : cardEmpty('No live rooms have been opened yet.');
      root.addEventListener('click', async event => {
        const copyButton = event.target.closest('[data-copy-meeting-invite]');
        if (copyButton) {
          await copyMeetingInvite(copyButton.dataset.copyMeetingInvite, copyButton);
          return;
        }
        const button = event.target.closest('[data-open-room]');
        if (!button) return;
        button.disabled = true;
        try {
          const created = await api('/api/video/rooms', {
            method: 'POST',
            body: {
              event_id: button.dataset.openRoom,
              waiting_room_enabled: true,
              screen_sharing_enabled: true
            }
          });
          location.href = `video-room.html?room=${encodeURIComponent(created.room.id)}`;
        } catch (error) {
          button.disabled = false;
          alert(error.message);
        }
      });
    } catch (error) {
      requireLogin(error.message);
    }
  }

  async function initMarketplace() {
    const result = await api('/api/marketplace');
    renderStats(result.stats);
    const grid = $('#marketplaceGrid');
    grid.innerHTML = result.items.map(item => `
      <article class="feature-card marketplace-card">
        <div class="feature-card-top">${avatar(item.seller)}<span class="feature-chip">${escapeHtml(item.category)}</span></div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.description)}</p>
        <div class="feature-meta"><span><i class="bx bx-wallet"></i>${item.price_credits} credits</span><span><i class="bx bx-time"></i>${item.duration_minutes} min</span><span><i class="bx bx-star"></i>${item.rating == null ? 'No reviews yet' : escapeHtml(item.rating)}</span></div>
        <div class="feature-tags">${(item.tags || []).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
        <div class="feature-actions">
          <a class="btn btn-sm" href="member-profile.html?id=${encodeURIComponent(item.seller_id)}">Seller</a>
          <button class="btn btn-primary btn-sm" data-buy-item="${escapeHtml(item.id)}" ${item.viewer_purchased || item.viewer_is_seller ? 'disabled' : ''}>${item.viewer_is_seller ? 'Your offer' : item.viewer_purchased ? 'Purchased' : 'Buy'}</button>
        </div>
      </article>
    `).join('');
    $('#marketplaceOrders').innerHTML = result.my_orders?.length ? result.my_orders.map(order => `
      <article class="feature-list-row"><i class="bx bx-receipt"></i><div><strong>${escapeHtml(order.item?.title || 'Marketplace order')}</strong><span>${escapeHtml(order.status)} · ${order.price_credits} credits · ${formatDate(order.created_at)}</span></div><a href="notifications.html?conversation=${encodeURIComponent(order.conversation_id || '')}">Chat</a></article>
    `).join('') : cardEmpty(result.authenticated ? 'Your marketplace orders will appear here.' : 'Log in to buy marketplace offers.');
    grid.addEventListener('click', async event => {
      const button = event.target.closest('[data-buy-item]');
      if (!button) return;
      button.disabled = true;
      try {
        await api(`/api/marketplace/${encodeURIComponent(button.dataset.buyItem)}/purchase`, {
          method: 'POST',
          body: {}
        });
        await initMarketplace();
      } catch (error) {
        button.disabled = false;
        alert(error.message);
      }
    }, {
      once: true
    });
  }

  async function initLearningJournal() {
    try {
      const result = await api('/api/journal');
      renderStats(result.stats);
      const list = $('#journalEntries');
      list.innerHTML = result.entries.length ? result.entries.map(entry => `
        <article class="feature-card journal-entry">
          <span class="feature-chip">${escapeHtml(entry.visibility || 'private')}</span>
          <h3>${escapeHtml(entry.title)}</h3>
          <p>${escapeHtml(entry.reflection || entry.body || '')}</p>
          <div class="feature-meta"><span>${escapeHtml(entry.skill || '')}</span><span>${Number(entry.minutes ?? entry.practice_minutes ?? 0)} minutes</span><span>Confidence ${Number(entry.confidence || 0)}/5</span></div>
          ${entry.next_step ? `<small>Next: ${escapeHtml(entry.next_step)}</small>` : ''}
          <button class="feature-icon-button danger" data-delete-journal="${escapeHtml(entry.id)}" title="Delete entry"><i class="bx bx-trash"></i></button>
        </article>
      `).join('') : cardEmpty('Write your first reflection to start your learning trail.');
      $('#journalForm')?.addEventListener('submit', async event => {
        event.preventDefault();
        const status = $('[data-journal-status]');
        const form = event.currentTarget;
        try {
          await api('/api/journal', {
            method: 'POST',
            body: formValues(form)
          });
          form.reset();
          setStatus(status, 'Journal entry saved.');
          await initLearningJournal();
        } catch (error) {
          setStatus(status, error.message, 'error');
        }
      }, {
        once: true
      });
      list.addEventListener('click', async event => {
        const button = event.target.closest('[data-delete-journal]');
        if (!button) return;
        await api(`/api/journal/${encodeURIComponent(button.dataset.deleteJournal)}`, {
          method: 'DELETE'
        });
        await initLearningJournal();
      }, {
        once: true
      });
    } catch (error) {
      requireLogin(error.message);
    }
  }

  async function initSkillBattle() {
    const result = await api('/api/skill-battle');
    renderStats(result.stats);
    $('#battleGrid').innerHTML = result.battles.map(battle => `
      <article class="feature-card battle-card">
        <span class="feature-chip">${escapeHtml(battle.status)}</span>
        <h3>${escapeHtml(battle.title)}</h3>
        <p>${escapeHtml(battle.prompt)}</p>
        <div class="feature-meta"><span>${escapeHtml(battle.category)}</span><span>${battle.entry_count} entries</span><span>${battle.reward_credits} credits available</span></div>
        <button class="btn btn-primary btn-sm" data-battle-target="${escapeHtml(battle.id)}">Submit entry</button>
        <div class="feature-list compact">${battle.entries.slice(0, 3).map(entry => `<article><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.author?.display_name || 'Member')} · ${entry.like_count} likes</span><button data-like-battle="${escapeHtml(entry.id)}"><i class="bx bx-like"></i></button></article>`).join('') || '<p>No entries yet.</p>'}</div>
      </article>
    `).join('');
    root.addEventListener('click', async event => {
      const like = event.target.closest('[data-like-battle]');
      if (like) {
        await api(`/api/skill-battle/entries/${encodeURIComponent(like.dataset.likeBattle)}/like`, {
          method: 'POST',
          body: {}
        });
        await initSkillBattle();
      }
      const target = event.target.closest('[data-battle-target]');
      if (target) {
        $('#battle_id').value = target.dataset.battleTarget;
        $('#battleEntryForm').scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }
    }, {
      once: true
    });
    $('#battleEntryForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const status = $('[data-battle-status]');
      const form = event.currentTarget;
      const values = formValues(form);
      try {
        await api(`/api/skill-battle/${encodeURIComponent(values.battle_id)}/entries`, {
          method: 'POST',
          body: values
        });
        form.reset();
        setStatus(status, 'Challenge entry published.');
        await initSkillBattle();
      } catch (error) {
        setStatus(status, error.message, 'error');
      }
    }, {
      once: true
    });
  }

  async function initFundingHub() {
    const result = await api('/api/funding');
    renderStats(result.stats);
    $('#fundingIdeaGrid').innerHTML = result.ideas.map(idea => `
      <article class="feature-card funding-card">
        <span class="feature-chip">${escapeHtml(idea.category)}</span>
        <h3>${escapeHtml(idea.title)}</h3>
        <p>${escapeHtml(idea.tagline)}</p>
        <div class="feature-progress"><span style="width:${Math.min(100, idea.funding_needed ? idea.pledged_amount / idea.funding_needed * 100 : 0)}%"></span></div>
        <div class="feature-meta"><span>${escapeHtml(idea.funding_currency)} ${formatNumber(idea.pledged_amount)} pledged</span><span>${formatNumber(idea.pledge_count)} offers</span><span>${formatNumber(idea.skill_supporters)} skill supporters</span></div>
        <div class="feature-actions">
          <a class="btn btn-sm" href="skill-innovation.html?idea=${encodeURIComponent(idea.id)}">View idea</a>
          <button class="btn btn-primary btn-sm" data-pledge-idea="${escapeHtml(idea.id)}">Offer support</button>
        </div>
      </article>
    `).join('');
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-pledge-idea]');
      if (!button) return;
      $('#pledge_idea_id').value = button.dataset.pledgeIdea;
      $('#fundingPledgeForm').scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });
    });
    $('#fundingPledgeForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const status = $('[data-funding-status]');
      const form = event.currentTarget;
      const values = formValues(form);
      try {
        await api(`/api/funding/ideas/${encodeURIComponent(values.idea_id)}/pledges`, {
          method: 'POST',
          body: values
        });
        form.reset();
        setStatus(status, 'Support offer saved and sent to the idea owner.');
        await initFundingHub();
      } catch (error) {
        setStatus(status, error.message, 'error');
      }
    }, {
      once: true
    });
  }

  async function initMentorDashboard() {
    try {
      const result = await api('/api/mentor/dashboard');
      renderStats(result.stats);
      $('#mentorSessions').innerHTML = result.sessions.length ? result.sessions.map(session => `
        <article class="feature-list-row"><i class="bx bx-calendar"></i><div><strong>${escapeHtml(session.title)}</strong><span>${formatDate(session.starts_at)} · ${escapeHtml(session.status)}</span></div><a href="calendar.html?event=${encodeURIComponent(session.id)}">Open</a></article>
      `).join('') : cardEmpty('Host or schedule a session to see it here.');
      $('#mentorAssets').innerHTML = [
        ...result.workshops.map(item => `<article class="feature-list-row"><i class="bx bx-chalkboard"></i><div><strong>${escapeHtml(item.title)}</strong><span>${item.registered_count} registered · ${escapeHtml(item.status)}</span></div><a href="workshops.html">Workshop</a></article>`),
        ...result.marketplace_items.map(item => `<article class="feature-list-row"><i class="bx bx-store"></i><div><strong>${escapeHtml(item.title)}</strong><span>${item.purchase_count} purchases · ${item.price_credits} credits</span></div><a href="marketplace.html">Offer</a></article>`)
      ].join('') || cardEmpty('Create a workshop or marketplace offer to build your mentor shelf.');
      if (result.application) {
        $('#mentorApplicationState').innerHTML = `<div class="feature-callout"><i class="bx bx-check-shield"></i><div><strong>Application ${escapeHtml(result.application.status)}</strong><span>Last updated ${formatDate(result.application.updated_at)}</span></div></div>`;
      }
      $('#mentorApplicationForm')?.addEventListener('submit', async event => {
        event.preventDefault();
        const status = $('[data-mentor-status]');
        const form = event.currentTarget;
        try {
          await api('/api/mentor/application', {
            method: 'POST',
            body: formValues(form)
          });
          setStatus(status, 'Mentor application saved for admin review.');
          await initMentorDashboard();
        } catch (error) {
          setStatus(status, error.message, 'error');
        }
      }, {
        once: true
      });
    } catch (error) {
      requireLogin(error.message);
    }
  }

  async function initStudentSafety() {
    const result = await api('/api/student-safety');
    renderStats(result.stats);
    $('#studentSafetyControls').innerHTML = result.controls.map(control => `
      <article class="feature-list-row"><i class="bx bx-shield-quarter"></i><div><strong>${escapeHtml(control)}</strong><span>Active across profiles, ideas, messaging, and moderation.</span></div></article>
    `).join('');
    $('#guardianState').innerHTML = result.authenticated ? `
      <div class="feature-callout"><i class="bx bx-user-check"></i><div><strong>${result.safety?.guardian_consent_status || 'not required'}</strong><span>${result.safety?.is_minor ? 'Child account safety controls are active.' : 'Your account is not marked as under 13.'}</span></div></div>
    ` : `<div class="feature-callout"><i class="bx bx-lock-alt"></i><div><strong>Log in to view account safety.</strong><span>Public safety guidance is still visible here.</span></div></div>`;
    $('#guardianConsentForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const status = $('[data-safety-status]');
      const form = event.currentTarget;
      try {
        await api('/api/student-safety/guardian-consent', {
          method: 'POST',
          body: formValues(form)
        });
        setStatus(status, 'Guardian consent details saved.');
        await initStudentSafety();
      } catch (error) {
        setStatus(status, error.message, 'error');
      }
    }, {
      once: true
    });
  }

  async function initModerationCenter() {
    try {
      const result = await api('/api/moderation/center');
      renderStats(result.stats);
      $('#moderationReports').innerHTML = result.reports.length ? result.reports.map(report => `
        <article class="feature-card">
          <span class="feature-chip">${escapeHtml(report.status)}</span>
          <h3>${escapeHtml(report.category || 'Safety report')}</h3>
          <p>${escapeHtml(report.details)}</p>
          <div class="feature-meta"><span>Reported: ${escapeHtml(report.reported_user?.username || 'unknown')}</span><span>${report.evidence_count} evidence messages</span></div>
          <div class="feature-actions"><a class="btn btn-sm" href="admin.html">Full admin</a><button class="btn btn-primary btn-sm" data-review-report="${escapeHtml(report.id)}">Mark reviewing</button></div>
        </article>
      `).join('') : cardEmpty('No moderation reports are open.');
      $('#studentReviewQueue').innerHTML = result.student_ideas.length ? result.student_ideas.map(idea => `
        <article class="feature-list-row"><i class="bx bx-bulb"></i><div><strong>${escapeHtml(idea.title)}</strong><span>${escapeHtml(idea.owner?.username || 'student')} · ${escapeHtml(idea.safety_review_status || 'pending')}</span></div><a href="skill-innovation.html?idea=${encodeURIComponent(idea.id)}">Open</a></article>
      `).join('') : cardEmpty('No student ideas are waiting for specialist review.');
      $('#mentorReviewQueue').innerHTML = result.mentor_applications.length ? result.mentor_applications.map(app => `
        <article class="feature-list-row"><i class="bx bx-user-voice"></i><div><strong>${escapeHtml(app.expertise)}</strong><span>${escapeHtml(app.status)} · ${formatDate(app.updated_at)}</span></div></article>
      `).join('') : cardEmpty('No mentor applications yet.');
      root.addEventListener('click', async event => {
        const button = event.target.closest('[data-review-report]');
        if (!button) return;
        await api(`/api/admin/message-reports/${encodeURIComponent(button.dataset.reviewReport)}`, {
          method: 'PATCH',
          body: {
            status: 'reviewing',
            action: 'pending',
            admin_notes: 'Marked for review from Moderation Center.'
          }
        });
        await initModerationCenter();
      }, {
        once: true
      });
    } catch (error) {
      requireLogin(error.message);
    }
  }

  async function initRoadmap() {
    const result = await api('/api/roadmap');
    renderStats(result.stats);
    $('#roadmapGrid').innerHTML = result.items.map(item => `
      <article class="feature-card roadmap-card">
        <span class="feature-chip">${escapeHtml(item.status.replace('_', ' '))}</span>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.summary)}</p>
        <div class="feature-meta"><span>${escapeHtml(item.area)}</span><span>${escapeHtml(item.priority)}</span><span>${item.vote_count} votes</span></div>
        <button class="btn btn-primary btn-sm ${item.viewer_voted ? 'active' : ''}" data-roadmap-vote="${escapeHtml(item.id)}"><i class="bx bx-upvote"></i>${item.viewer_voted ? 'Voted' : 'Vote'}</button>
      </article>
    `).join('');
    $('#roadmapGrid').addEventListener('click', async event => {
      const button = event.target.closest('[data-roadmap-vote]');
      if (!button) return;
      await api(`/api/roadmap/items/${encodeURIComponent(button.dataset.roadmapVote)}/vote`, {
        method: 'POST',
        body: {}
      });
      await initRoadmap();
    }, {
      once: true
    });
    $('#roadmapForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const status = $('[data-roadmap-status]');
      const form = event.currentTarget;
      try {
        await api('/api/roadmap/suggestions', {
          method: 'POST',
          body: formValues(form)
        });
        form.reset();
        setStatus(status, 'Roadmap suggestion added.');
        await initRoadmap();
      } catch (error) {
        setStatus(status, error.message, 'error');
      }
    }, {
      once: true
    });
  }

  const initializers = {
    achievements: initAchievements,
    'session-room': initSessionRoom,
    marketplace: initMarketplace,
    'learning-journal': initLearningJournal,
    'skill-battle': initSkillBattle,
    'funding-hub': initFundingHub,
    'mentor-dashboard': initMentorDashboard,
    'student-safety': initStudentSafety,
    'moderation-center': initModerationCenter,
    roadmap: initRoadmap
  };

  initializers[page]?.().catch(error => {
    root.innerHTML = `<section class="feature-empty"><i class="bx bx-error-circle"></i><h2>Could not load this feature.</h2><p>${escapeHtml(error.message)}</p></section>`;
  });
})();
