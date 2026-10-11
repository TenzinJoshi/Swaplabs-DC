(() => {
  'use strict';

  const root = document.querySelector('[data-member-directory]');
  if (!root) return;

  const $ = (selector, scope = root) => scope.querySelector(selector);
  const $$ = (selector, scope = root) => [...scope.querySelectorAll(selector)];
  const state = {user: null, members: [], suggestions: [], loading: false, request: null};
  const {escapeHtml, initials, profileColor, safeAvatarUrl} = window.RelayComponents;
  const list = value => (Array.isArray(value) ? value : String(value || '').split(',').map(item => item.trim()).filter(Boolean))
    .map(item => String(item).trim()).filter(item => item && item.toLowerCase() !== 'nothing for now');
  const normalize = value => String(value || '').toLowerCase().trim();
  const key = value => normalize(value).replace(/[^a-z0-9]+/g, '');
  const slug = value => normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const profileOf = member => member?.profile || {};
  const valuesOf = (member, field) => list(profileOf(member)[field]);
  const fullName = member => profileOf(member).display_name || member?.username || 'SwapLabs member';
  const isSelf = member => Boolean(state.user?.id && member?.id === state.user.id);
  const canView = member => member?.can_view_full !== false;

  function avatarHtml(member) {
    const profile = profileOf(member);
    const color = profileColor(profile);
    const avatar = safeAvatarUrl(profile);
    return `<span class="auth-avatar ${escapeHtml(color)}">${avatar ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(fullName(member))} profile photo">` : escapeHtml(initials(fullName(member)))}</span>`;
  }

  function overlap(left, right) {
    const result = [];
    list(left).forEach(value => {
      const valueKey = key(value);
      const found = list(right).find(candidate => {
        const candidateKey = key(candidate);
        return valueKey && candidateKey && (valueKey === candidateKey || valueKey.includes(candidateKey) || candidateKey.includes(valueKey));
      });
      if (found && !result.some(item => key(item) === key(found))) result.push(found);
    });
    return result;
  }

  const relatedSkillMatcher = window.SwapLabsSkillMatch;
  function skillFit(left, right) {
    if (relatedSkillMatcher?.overlap) return relatedSkillMatcher.overlap(left, right);
    const direct = overlap(left, right).map(found => ({requested: found, found, kind: 'direct'}));
    return {direct, related: [], best: direct[0] || null};
  }

  function profileSignals(member) {
    const profile = profileOf(member);
    return {
      teach: valuesOf(member, 'skills_to_teach'),
      learn: valuesOf(member, 'skills_to_learn'),
      interests: valuesOf(member, 'interests'),
      languages: [...list(profile.primary_language), ...valuesOf(member, 'additional_languages'), ...valuesOf(member, 'languages_to_learn')],
      country: canView(member) ? String(profile.country || '').trim() : '',
      format: canView(member) ? String(profile.preferred_format || '').trim() : '',
      level: canView(member) ? String(profile.experience_level || '').trim() : ''
    };
  }

  function viewerSignals() {
    return profileSignals({profile: state.user?.profile || {}, can_view_full: true});
  }

  function memberMatch(member) {
    const viewer = viewerSignals();
    const candidate = profileSignals(member);
    const directFit = skillFit(viewer.learn, candidate.teach);
    const reciprocalFit = skillFit(viewer.teach, candidate.learn);
    const direct = directFit.direct.map(item => item.found);
    const related = directFit.related.map(item => item.found);
    const reciprocal = reciprocalFit.best;
    const sharedTeach = overlap(viewer.teach, candidate.teach);
    const sharedLearn = overlap(viewer.learn, candidate.learn);
    const sharedInterests = overlap(viewer.interests, candidate.interests);
    const sharedLanguages = overlap(viewer.languages, candidate.languages);
    const sameCountry = viewer.country && candidate.country && key(viewer.country) === key(candidate.country);
    const sameFormat = viewer.format && candidate.format && key(viewer.format) === key(candidate.format);
    const sameLevel = viewer.level && candidate.level && key(viewer.level) === key(candidate.level);
    const reciprocalPoints = reciprocal ? (reciprocal.kind === 'related' ? 18 : 25) : 0;
    const score = Math.min(99,
      direct.length * 31 + related.length * 22 + reciprocalPoints + sharedInterests.length * 10 + sharedLanguages.length * 8 +
      sharedTeach.length * 4 + sharedLearn.length * 4 + (sameCountry ? 7 : 0) + (sameFormat ? 4 : 0) + (sameLevel ? 4 : 0)
    );
    const reasons = [];
    if (direct.length) reasons.push(`Teaches ${direct[0]}, which you want to learn`);
    if (!direct.length && related.length) {
      const relatedMatch = directFit.related[0];
      reasons.push(`Teaches ${related[0]}, related to ${relatedMatch.requested}`);
    }
    if (reciprocal) reasons.push(`Wants to learn ${reciprocal.found} from you`);
    if (sharedInterests.length) reasons.push(`Shares your interest in ${sharedInterests[0]}`);
    if (sharedLanguages.length) reasons.push(`Shares ${sharedLanguages[0]} for conversation`);
    if (sameCountry) reasons.push(`Also based in ${candidate.country}`);
    if (!reasons.length && sharedTeach.length) reasons.push(`Also teaches ${sharedTeach[0]}`);
    return {score, direct, related, reciprocal, reasons, label: reasons[0] || 'A discovery result from your public profile'};
  }

  function optionValue(value) {
    return String(value || '').trim();
  }

  function setOptions(select, firstLabel, values) {
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '';
    const first = document.createElement('option');
    first.value = 'all';
    first.textContent = firstLabel;
    select.appendChild(first);
    [...new Set(values.map(optionValue).filter(value => value && value.toLowerCase() !== 'private'))]
      .sort((left, right) => left.localeCompare(right, undefined, {sensitivity: 'base'}))
      .forEach(value => {
        const option = document.createElement('option');
        option.value = slug(value);
        option.textContent = value;
        option.dataset.rawValue = value;
        select.appendChild(option);
      });
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  function publicSkills(member) {
    return canView(member) ? [...new Set([...valuesOf(member, 'skills_to_teach'), ...valuesOf(member, 'skills_to_learn')])] : [];
  }

  function tagMarkup(values, kind = '') {
    const visible = list(values);
    if (!visible.length) return '<span class="member-tag-empty">Not listed</span>';
    const shown = visible.slice(0, 5).map(value => `<span>${escapeHtml(value)}</span>`).join('');
    const rest = visible.length > 5 ? `<span class="member-tag-more">+${visible.length - 5}</span>` : '';
    return `<div class="member-tags ${kind}">${shown}${rest}</div>`;
  }

  function memberCard(member, match = null) {
    const profile = profileOf(member);
    const self = isSelf(member);
    const publicProfile = canView(member);
    const name = fullName(member);
    const headline = publicProfile ? (profile.headline || profile.professional_role || profile.occupation || 'Open to a practical exchange.') : 'This member has chosen a private profile.';
    const profileUrl = `member-profile.html?id=${encodeURIComponent(member.id || '')}`;
    const country = publicProfile && profile.country ? profile.country : '';
    const format = publicProfile && profile.preferred_format ? profile.preferred_format : '';
    const level = publicProfile && profile.experience_level ? profile.experience_level : '';
    const badge = self ? '<span class="member-card-badge">You</span>' : publicProfile ? (member.verified ? '<span class="member-card-badge"><i class="bx bx-badge-check"></i> Verified</span>' : '') : '<span class="member-card-badge private"><i class="bx bx-lock-alt"></i> Private</span>';
    const matchMarkup = match ? `<div class="member-card-match"><i class="bx bx-sparkles"></i><span><strong>${escapeHtml(String(match.score))}% alignment</strong><small>${escapeHtml(match.label)}</small></span></div>` : '';
    const meta = publicProfile ? `<div class="member-card-meta">${country ? `<span><i class="bx bx-map"></i>${escapeHtml(country)}</span>` : ''}${format ? `<span><i class="bx bx-video"></i>${escapeHtml(format)}</span>` : ''}${level ? `<span><i class="bx bx-bar-chart-alt-2"></i>${escapeHtml(level)}</span>` : ''}</div>` : '<p class="member-card-private-note"><i class="bx bx-lock-alt"></i> Profile details are visible only with permission.</p>';
    const skills = publicProfile ? `<div class="member-skill-row"><span>Can teach</span>${tagMarkup(profile.skills_to_teach)}</div><div class="member-skill-row"><span>Wants to learn</span>${tagMarkup(profile.skills_to_learn, 'learning')}</div>` : '';
    const secondAction = self ? '<a class="btn btn-sm" href="profile.html"><i class="bx bx-edit-alt"></i> Edit profile</a>' : '<a class="btn btn-sm" href="skill-matching.html?intent=swap"><i class="bx bx-transfer-alt"></i> Find an exchange</a>';
    return `<article class="member-directory-card${match ? ' suggested-member-card' : ''}${self ? ' is-current-member' : ''}">
      <div class="member-card-top"><div class="member-card-identity">${avatarHtml(member)}<div><a class="member-card-name-link" href="${profileUrl}"><h3>${escapeHtml(name)}${member.verified ? ' <i class="bx bx-badge-check" title="Verified member"></i>' : ''}</h3></a><p>@${escapeHtml(member.username || 'member')}</p></div></div>${badge}</div>
      <p class="member-card-headline">${escapeHtml(headline)}</p>${matchMarkup}${meta}${skills}
      <div class="member-card-actions"><a class="btn btn-primary btn-sm" href="${profileUrl}"><i class="bx bx-user"></i> View profile</a>${secondAction}</div>
    </article>`;
  }

  function currentFilter(name) {
    const value = $(`[data-directory-filter="${name}"]`)?.value;
    return value || (name === 'search' ? '' : 'all');
  }

  function currentFilterOptionRaw(name) {
    const select = $(`[data-directory-filter="${name}"]`);
    return select?.selectedOptions?.[0]?.dataset?.rawValue || '';
  }

  function matchesFilters(member) {
    const profile = profileOf(member);
    const publicProfile = canView(member);
    const search = normalize(currentFilter('search'));
    const skills = publicSkills(member);
    const allText = [
      fullName(member), member.username, publicProfile ? profile.headline : '', publicProfile ? profile.professional_role : '',
      publicProfile ? profile.occupation : '', publicProfile ? profile.country : '', ...skills,
      ...(publicProfile ? valuesOf(member, 'interests') : []), ...(publicProfile ? valuesOf(member, 'languages') : [])
    ].join(' ').toLowerCase();
    if (search && !allText.includes(search)) return false;
    const skill = currentFilter('skill');
    if (skill !== 'all' && !skills.some(value => slug(value) === skill)) return false;
    const country = currentFilter('country');
    if (country !== 'all' && slug(profile.country) !== country) return false;
    const visibility = currentFilter('visibility');
    if (visibility !== 'all' && String(member.visibility || 'public') !== visibility) return false;
    const format = currentFilter('format');
    if (format !== 'all' && slug(profile.preferred_format) !== format) return false;
    const level = currentFilter('level');
    if (level !== 'all' && slug(profile.experience_level) !== level) return false;
    const connection = currentFilter('connection');
    if (connection !== 'all') {
      const match = memberMatch(member);
      if (connection === 'can-teach-me' && !match.direct.length && !match.related.length) return false;
      if (connection === 'can-learn-from-me' && !match.reciprocal) return false;
      if (connection === 'mutual' && (!match.direct.length && !match.related.length || !match.reciprocal)) return false;
      if (connection === 'shared-interests' && !overlap(viewerSignals().interests, valuesOf(member, 'interests')).length) return false;
    }
    return true;
  }

  function sortMembers(members) {
    const sort = currentFilter('sort');
    return [...members].sort((left, right) => {
      if (isSelf(left) !== isSelf(right)) return isSelf(left) ? 1 : -1;
      if (sort === 'relevance') {
        const score = memberMatch(right).score - memberMatch(left).score;
        if (score) return score;
      } else if (sort === 'newest') {
        const recent = new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime();
        if (recent) return recent;
      } else if (sort === 'skills') {
        const skillCount = publicSkills(right).length - publicSkills(left).length;
        if (skillCount) return skillCount;
      }
      return fullName(left).localeCompare(fullName(right), undefined, {sensitivity: 'base'});
    });
  }

  function updateFilterSummary(total) {
    const terms = [];
    const search = String(currentFilter('search') || '').trim();
    if (search) terms.push(`matching “${search}”`);
    const connection = $(`[data-directory-filter="connection"]`)?.selectedOptions?.[0]?.textContent;
    if (connection && currentFilter('connection') !== 'all') terms.push(connection.toLowerCase());
    ['skill', 'country', 'visibility', 'format', 'level'].forEach(name => {
      const select = $(`[data-directory-filter="${name}"]`);
      if (select && select.value !== 'all') terms.push(select.selectedOptions[0].textContent);
    });
    const suffix = terms.length ? ` · ${terms.join(' · ')}` : '';
    $('[data-directory-filter-summary]').textContent = `Showing ${total} of ${state.members.length} active member${state.members.length === 1 ? '' : 's'}${suffix}.`;
  }

  function renderSuggestions() {
    const candidates = state.members.filter(member => !isSelf(member) && canView(member))
      .map(member => ({member, match: memberMatch(member)}))
      .filter(item => item.match.score > 0)
      .sort((left, right) => right.match.score - left.match.score || fullName(left.member).localeCompare(fullName(right.member)))
      .slice(0, 4);
    state.suggestions = candidates;
    $('[data-suggestions-count]').textContent = `${candidates.length} suggestion${candidates.length === 1 ? '' : 's'}`;
    $('[data-suggestions-list]').innerHTML = candidates.map(item => memberCard(item.member, item.match)).join('');
    $('[data-suggestions-empty]').hidden = candidates.length > 0;
  }

  function renderMembers() {
    const filtered = sortMembers(state.members.filter(matchesFilters));
    const listHost = $('[data-directory-list]');
    listHost.innerHTML = filtered.map(member => memberCard(member)).join('');
    $('[data-directory-empty]').hidden = filtered.length > 0;
    $('[data-directory-result-count]').textContent = `${filtered.length} member${filtered.length === 1 ? '' : 's'}`;
    $('[data-directory-stat="shown"]').textContent = String(filtered.length);
    updateFilterSummary(filtered.length);
  }

  function populateFilters() {
    const visibleMembers = state.members.filter(canView);
    setOptions($('[data-directory-filter="skill"]'), 'All listed skills', visibleMembers.flatMap(publicSkills));
    setOptions($('[data-directory-filter="country"]'), 'Every country', visibleMembers.map(member => profileOf(member).country));
    setOptions($('[data-directory-filter="format"]'), 'Any format', visibleMembers.map(member => profileOf(member).preferred_format));
    setOptions($('[data-directory-filter="level"]'), 'Any level', visibleMembers.map(member => profileOf(member).experience_level));
  }

  function renderDirectory() {
    const skills = new Set(state.members.flatMap(publicSkills).map(value => key(value)).filter(Boolean));
    $('[data-directory-stat="members"]').textContent = String(state.members.length);
    $('[data-directory-stat="skills"]').textContent = String(skills.size);
    populateFilters();
    renderSuggestions();
    renderMembers();
  }

  function showMode(mode) {
    $('#directoryLoading').hidden = mode !== 'loading';
    $('#directoryLocked').hidden = mode !== 'locked';
    $('#directoryError').hidden = mode !== 'error';
    $('#directoryApp').hidden = mode !== 'ready';
  }

  async function loadDirectory() {
    if (state.request) return state.request;
    state.loading = true;
    showMode('loading');
    state.request = (async () => {
      try {
        const auth = await (window.SwapLabsAuth?.get?.() || fetch('/api/auth/me', {credentials: 'same-origin', cache: 'no-store'}).then(response => response.json()));
        if (!auth?.authenticated || !auth.user) {
          state.user = null;
          showMode('locked');
          return;
        }
        state.user = auth.user;
        const response = await fetch('/api/members', {credentials: 'same-origin', cache: 'no-store'});
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'The member directory is unavailable.');
        state.members = Array.isArray(result.members) ? result.members.filter(member => member?.id) : [];
        renderDirectory();
        showMode('ready');
      } catch (error) {
        $('[data-directory-error-message]').textContent = error.message || 'Try again in a moment.';
        showMode('error');
      } finally {
        state.loading = false;
      }
    })();
    try { await state.request; } finally { state.request = null; }
  }

  function clearFilters() {
    $$('[data-directory-filter]').forEach(control => {
      control.value = control.dataset.directoryFilter === 'sort' ? 'relevance' : control.dataset.directoryFilter === 'search' ? '' : 'all';
    });
    renderMembers();
  }

  $$('[data-directory-filter]').forEach(control => control.addEventListener(control.tagName === 'INPUT' ? 'input' : 'change', renderMembers));
  $$('[data-directory-clear]').forEach(button => button.addEventListener('click', clearFilters));
  $('[data-directory-retry]')?.addEventListener('click', loadDirectory);
  window.addEventListener('swaplabs:auth-state', event => {
    if (event.detail?.authenticated && !state.members.length && !state.loading) loadDirectory();
  });
  loadDirectory();
})();
