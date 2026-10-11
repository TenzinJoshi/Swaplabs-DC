(() => {
  'use strict';

  const skillHost = document.getElementById('realSkillList');
  const groupHost = document.getElementById('communityGroupGrid');
  const groupPreview = document.getElementById('communityGroupPreview');
  if (!skillHost && !groupHost && !groupPreview) return;

  const state = { user: null, csrf: '', skills: [], groups: [], inbox: null };
  const {escapeHtml, initials, profileColor, safeAvatarUrl} = window.RelayComponents;
  const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const list = value => Array.isArray(value) ? value : String(value || '').split(',').map(item => item.trim()).filter(Boolean);

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (['POST', 'PATCH', 'DELETE'].includes(method) && !state.csrf) {
      const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
      state.csrf = (await response.json()).csrf_token;
    }
    const headers = { ...(options.headers || {}) };
    if (['POST', 'PATCH', 'DELETE'].includes(method)) headers['X-CSRF-Token'] = state.csrf;
    if (options.body && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({ error: 'The server returned an unreadable response.' }));
    if (!response.ok) {
      const error = new Error(payload.error || 'Something went wrong.');
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

  function toast(message, type = 'success') {
    if (type === 'error' && /pending (?:administrator )?review/i.test(String(message || ''))) type = 'info';
    let element = document.querySelector('.platform-toast.community-toast');
    if (!element) {
      element = document.createElement('div');
      element.className = 'platform-toast community-toast';
      document.body.appendChild(element);
    }
    element.className = `platform-toast community-toast ${type}`;
    const sharedActionLink = window.SwapLabsNotice?.actionLink(message, type) || '';
    const fallbackActionLink = !sharedActionLink && type === 'error' && /finish your profile|complete your profile|profile is incomplete/i.test(String(message || '')) ?
      `<a class="toast-action-link" href="profile.html?complete=1&return_to=${encodeURIComponent(`${location.pathname.split('/').pop() || 'browse-skills.html'}${location.search}${location.hash}`)}">Fill in all profile details <i class="bx bx-right-arrow-alt" aria-hidden="true"></i></a>` : '';
    const actionLink = sharedActionLink || fallbackActionLink;
    element.classList.toggle('has-action-link', Boolean(actionLink));
    element.innerHTML = `<i class="bx ${type === 'error' ? 'bx-error-circle' : 'bx-check-circle'}"></i><div class="toast-copy"><span>${escapeHtml(message)}</span>${actionLink}</div>`;
    requestAnimationFrame(() => element.classList.add('show'));
    clearTimeout(element.hideTimer);
    element.hideTimer = setTimeout(() => element.classList.remove('show'), 4200);
  }

  function profileAvatar(user, title = '') {
    const profile = user?.profile || user || {};
    const source = safeAvatarUrl(profile);
    const label = title || profile.display_name || profile.username || 'SwapLabs member';
    return `<span title="${escapeHtml(label)}" class="avatar real-member-avatar ${profileColor(user)}">${source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(label)} profile photo">` : escapeHtml(initials(label))}</span>`;
  }

  function inferCategory(skill) {
    const value = String(skill).toLowerCase();
    if (/python|web|code|program|software|figma/.test(value)) return 'Technology';
    if (/arabic|bengali|chinese|english|french|german|hindi|italian|japanese|kannada|korean|language|marathi|nepali|portuguese|punjabi|russian|sanskrit|sign language|spanish|speaking|tamil|telugu|urdu/.test(value)) return 'Languages';
    if (/design|photo|illustr|writing|music|guitar/.test(value)) return 'Creative';
    if (/excel|data|analysis|visual/.test(value)) return 'Data';
    return 'Professional';
  }

  function renderSkills() {
    if (!skillHost) return;
    const term = String(document.getElementById('skillSearch')?.value || '').trim().toLowerCase();
    const category = document.getElementById('skillCategory')?.value || 'all';
    const level = document.getElementById('skillLevel')?.value || 'all';
    const filtered = state.skills.filter(item => {
      const haystack = `${item.skill} ${item.user.profile.display_name} ${item.user.username} ${item.user.profile.headline || ''}`.toLowerCase();
      return haystack.includes(term) && (category === 'all' || slug(item.category) === category) &&
        (level === 'all' || item.user.profile.experience_level === level);
    });
    skillHost.innerHTML = filtered.map(item => {
      const profile = item.user.profile;
      const reputation = item.user.reputation || {};
      const self = state.user?.id === item.user.id;
      const offer = [...list(state.user?.profile?.skills_to_teach), ...list(state.user?.profile?.additional_languages)][0] || '';
      return `<article class="card skill-card real-skill-card" data-category="${escapeHtml(slug(item.category))}" data-level="${escapeHtml(profile.experience_level || '')}">
        <div class="tags"><span class="tag">${escapeHtml(item.category)}</span><span class="tag">${escapeHtml(profile.preferred_format || 'Flexible')}</span></div>
        <h3>${escapeHtml(item.skill)}</h3>
        <p>${escapeHtml(profile.headline || `${profile.display_name} is available for a practical peer exchange.`)}</p>
        <div class="skill-member-details"><span><i class="bx bx-time-five"></i>${escapeHtml(item.user.availability?.label || profile.availability || 'Ask about availability')}</span><span><i class="bx bx-globe"></i>${escapeHtml(profile.timezone || 'Timezone not listed')}</span></div>
        <div class="skill-footer"><a class="person" data-community-profile="${escapeHtml(item.user.id)}" href="member-profile.html?id=${encodeURIComponent(item.user.id)}">${profileAvatar(item.user)}<div><strong>${escapeHtml(profile.display_name)}</strong><small>${escapeHtml(reputation.rating || 'New')} ${reputation.rating ? `★ · ${Number(reputation.completed_sessions || 0)} sessions` : 'member'}</small></div></a>
        ${self ? '<a class="btn btn-sm" href="profile.html">Edit my skills</a>' : item.user.swap_requests_available === false ? `<a class="btn btn-sm" data-community-profile="${escapeHtml(item.user.id)}" href="member-profile.html?id=${encodeURIComponent(item.user.id)}">Quick preview</a>` : `<button class="btn btn-sm btn-primary" type="button" data-request-swap="${escapeHtml(item.user.id)}" data-skill="${escapeHtml(item.skill)}" data-offer="${escapeHtml(offer)}">Request swap</button>`}</div>
      </article>`;
    }).join('');
    document.getElementById('skillEmpty')?.classList.toggle('show', !filtered.length);
  }

  async function loadSkills() {
    try {
      const [community, auth] = await Promise.all([
        api('/api/community'),
        (window.SwapLabsAuth?.get?.() || api('/api/auth/me')).catch(() => ({ authenticated: false }))
      ]);
      state.user = auth.authenticated ? auth.user : null;
      if (!Array.isArray(community.users)) throw new Error('The server returned an invalid member list.');
      state.skills = community.users.flatMap(user => {
        if (!user.can_view_full) return [];
        const profile = user.profile || {};
        const teachable = [...list(profile.skills_to_teach), ...list(profile.additional_languages)];
        return [...new Set(teachable.map(value => String(value).trim()).filter(Boolean))].map(skill => ({
          skill, category: inferCategory(skill), user
        }));
      });
      const categories = [...new Set(state.skills.map(item => item.category))].sort();
      const categorySelect = document.getElementById('skillCategory');
      if (categorySelect) categorySelect.innerHTML = '<option value="all">All skill areas</option>' + categories.map(item => `<option value="${escapeHtml(slug(item))}">${escapeHtml(item)}</option>`).join('');
      document.getElementById('realSkillPeople').textContent = String(new Set(state.skills.map(item => item.user.id)).size);
      document.getElementById('realSkillCount').textContent = String(state.skills.length);
      renderSkills();
    } catch (error) {
      skillHost.innerHTML = `<div class="ops-empty skill-activation-empty"><span class="icon-box indigo"><i class="bx bx-refresh"></i></span><h3>No public skill listings yet</h3><p>We’re reconnecting to the member directory. You can create a profile now or join updates and come back when more teachers arrive.</p><div class="live-empty-actions"><a class="btn btn-primary" href="register.html?intent=swap&amp;return_to=browse-skills.html">Create a profile</a><a class="btn" href="index.html#platformUpdates">Join updates</a><button class="btn" type="button" data-skill-retry>Try again</button></div></div>`;
      skillHost.querySelector('[data-skill-retry]')?.addEventListener('click', loadSkills);
    }
  }

  function groupCard(group) {
    const people = (group.members || []).slice(0, 4).map(member => profileAvatar(member, member.display_name)).join('');
    const unread = Number(group.unread_count || 0);
    const action = group.joined ? `<a class="btn btn-sm btn-primary" href="notifications.html?conversation=${encodeURIComponent(group.conversation_id)}"><i class="bx bx-message-square-dots"></i> Open chat${unread ? ` <span class="community-unread-badge">${unread}</span>` : ''}</a><button class="btn btn-sm" type="button" data-leave-group="${escapeHtml(group.id)}">Leave</button>` : group.viewer_request_pending ? '<button class="btn btn-sm" type="button" disabled><i class="bx bx-time-five"></i> Request pending</button>' : `<button class="btn btn-sm btn-primary" type="button" data-join-group="${escapeHtml(group.id)}"><i class="bx bx-plus"></i> ${group.requires_approval ? 'Request to join' : 'Join group'}</button>`;
    const roles = `<span class="community-role-summary"><i class="bx bx-shield-quarter"></i>${Number(group.moderator_ids?.length || 0)} moderator${group.moderator_ids?.length === 1 ? '' : 's'} · ${Math.max(0, Number(group.member_count) - Number(group.moderator_ids?.length || 0))} members</span>`;
    const pinned = group.pinned_messages?.at(-1) ? `<div class="community-pinned-message"><i class="bx bx-pin"></i><span><strong>Pinned</strong>${escapeHtml(group.pinned_messages.at(-1).body)}</span></div>` : '';
    const requests = group.viewer_is_moderator ? `<div class="community-join-requests"><strong>${group.pending_join_count ? `${group.pending_join_count} pending join request${group.pending_join_count === 1 ? '' : 's'}` : 'No pending join requests'}</strong>${(group.pending_join_requests || []).map(member => `<span>${escapeHtml(member.display_name)}<button type="button" data-group-request="${escapeHtml(group.id)}" data-member-id="${escapeHtml(member.id)}" data-approve="true">Approve</button><button type="button" data-group-request="${escapeHtml(group.id)}" data-member-id="${escapeHtml(member.id)}" data-approve="false">Decline</button></span>`).join('')}</div>` : '';
    return `<article class="card community-group-card" data-group-card="${escapeHtml(group.id)}"><span class="icon-box ${escapeHtml(group.accent || 'blue')}"><i class="bx ${escapeHtml(group.icon || 'bx-group')}"></i></span><span class="group-topic">${escapeHtml(group.category)}</span><h3>${escapeHtml(group.title)}</h3><p>${escapeHtml(group.description)}</p>${pinned}<div class="group-live-members"><div class="group-avatar-stack">${people}</div><span><strong>${Number(group.member_count)}</strong> real member${group.member_count === 1 ? '' : 's'}</span>${unread ? `<span class="community-unread-badge">` + unread + ` unread</span>` : ''}</div>${roles}${requests}<div class="community-group-actions">${action}</div></article>`;
  }

  function renderGroups() {
    const target = groupHost || groupPreview;
    if (!target) return;
    const term = String(document.getElementById('groupSearch')?.value || '').trim().toLowerCase();
    const category = document.getElementById('groupCategory')?.value || 'all';
    let filtered = state.groups.filter(group => `${group.title} ${group.description} ${group.category}`.toLowerCase().includes(term) && (category === 'all' || group.category === category));
    const sort = document.getElementById('groupSort')?.value || 'activity';
    filtered.sort(sort === 'members' ? (a,b) => Number(b.member_count)-Number(a.member_count) : sort === 'name' ? (a,b) => String(a.title).localeCompare(String(b.title)) : (a, b) => Number(b.joined) - Number(a.joined) || Number(b.unread_count || 0) - Number(a.unread_count || 0) || String(a.title).localeCompare(String(b.title)));
    if (groupPreview && !groupHost) filtered = filtered.slice(0, 3);
    target.innerHTML = filtered.length ? filtered.map(groupCard).join('') : '<div class="ops-empty"><i class="bx bx-search-alt"></i><h3>No groups match</h3><p>Try a broader topic.</p></div>';
    if (document.getElementById('groupResultCount')) document.getElementById('groupResultCount').textContent = `${filtered.length} group chat${filtered.length === 1 ? '' : 's'}`;
  }

  async function loadGroups() {
    try {
      const [result, inbox] = await Promise.all([
        api('/api/community/groups'),
        api('/api/inbox').catch(() => null)
      ]);
      state.inbox = inbox;
      const unreadByConversation = new Map((inbox?.conversations || []).map(conversation => [conversation.id, conversation.unread_count || 0]));
      state.groups = Array.isArray(result.groups) ? result.groups : [];
      state.groups.forEach(group => {
        group.unread_count = unreadByConversation.get(group.conversation_id) || 0;
      });
      const categorySelect = document.getElementById('groupCategory');
      if (categorySelect) categorySelect.innerHTML = '<option value="all">All topics</option>' + [...new Set(state.groups.map(group => group.category))].sort().map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
      renderGroups();
    } catch (error) {
      const target = groupHost || groupPreview;
      target.innerHTML = `<div class="ops-empty"><i class="bx bx-wifi-off"></i><h3>Groups are unavailable</h3><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  document.addEventListener('click', async event => {
    const swapButton = event.target.closest('[data-request-swap]');
    const joinButton = event.target.closest('[data-join-group]');
    const leaveButton = event.target.closest('[data-leave-group]');
    const requestButton = event.target.closest('[data-group-request]');
    if (swapButton) {
      if (!state.user) {
        location.href = `login.html?next=${encodeURIComponent(location.pathname.split('/').pop())}`;
        return;
      }
      const original = swapButton.innerHTML;
      swapButton.disabled = true;
      swapButton.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Sending';
      try {
        const result = await api('/api/swaps', { method: 'POST', body: { target_user_id: swapButton.dataset.requestSwap, skill: swapButton.dataset.skill, offer: swapButton.dataset.offer } });
        swapButton.innerHTML = '<i class="bx bx-check"></i> Sent';
        toast(`${result.message} Both inboxes now have the request.`);
        setTimeout(() => { location.href = `notifications.html?conversation=${encodeURIComponent(result.conversation.id)}`; }, 900);
      } catch (error) {
        swapButton.disabled = false;
        swapButton.innerHTML = original;
        toast(error.message, 'error');
      }
    }
    if (joinButton || leaveButton) {
      const button = joinButton || leaveButton;
      const joining = Boolean(joinButton);
      const original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<i class="bx bx-loader-alt bx-spin"></i> ${joining ? 'Joining' : 'Leaving'}`;
      try {
        const result = await api(`/api/community/groups/${encodeURIComponent(joining ? joinButton.dataset.joinGroup : leaveButton.dataset.leaveGroup)}/join`, { method: joining ? 'POST' : 'DELETE' });
        toast(result.message);
        await loadGroups();
      } catch (error) {
        button.disabled = false;
        button.innerHTML = original;
        if (error.status === 401) location.href = `login.html?next=${encodeURIComponent(location.pathname.split('/').pop())}`;
        else toast(error.message, 'error');
      }
    }
    if (requestButton) {
      requestButton.disabled = true;
      try {
        const result = await api(`/api/community/groups/${encodeURIComponent(requestButton.dataset.groupRequest)}/join-requests/${encodeURIComponent(requestButton.dataset.memberId)}`, {method:'POST', body:{approve:requestButton.dataset.approve === 'true'}});
        toast(result.message);
        await loadGroups();
      } catch (error) {
        requestButton.disabled = false;
        toast(error.message, 'error');
      }
    }
  });

  ['skillSearch', 'skillCategory', 'skillLevel'].forEach(id => document.getElementById(id)?.addEventListener(id === 'skillSearch' ? 'input' : 'change', renderSkills));
  document.getElementById('skillReset')?.addEventListener('click', () => setTimeout(() => { document.getElementById('skillLevel').value = 'all'; renderSkills(); }));
  document.getElementById('groupSearch')?.addEventListener('input', renderGroups);
  document.getElementById('groupCategory')?.addEventListener('change', renderGroups);
  document.getElementById('groupSort')?.addEventListener('change', renderGroups);
  document.addEventListener('keydown', event => {
    if (event.key !== '/' || /input|textarea|select/i.test(document.activeElement?.tagName || '')) return;
    const search = document.getElementById(groupHost ? 'groupSearch' : 'skillSearch');
    if (search) { event.preventDefault(); search.focus(); }
  });

  if (skillHost) loadSkills();
  if (groupHost || groupPreview) loadGroups();
})();
