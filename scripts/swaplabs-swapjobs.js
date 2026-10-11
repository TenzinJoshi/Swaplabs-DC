(() => {
  const root = document.querySelector('[data-swapjobs-page]');
  if (!root) return;
  const $ = selector => root.querySelector(selector);
  const state = { csrf: '', user: null, jobs: [], mine: [], proposals: [] };
  const {escapeHtml} = window.RelayComponents;
  const list = value => Array.isArray(value) ? value : [];
  const formatDate = value => {
    if (!value) return 'No deadline';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString([], {month:'short', day:'numeric', year:'numeric'});
  };
  const modeLabel = mode => ({exchange:'Skill exchange', volunteer:'Volunteer · 25 points', credits:'Time credits'}[mode] || 'Skill exchange');
  const statusLabel = status => ({open:'Open', in_progress:'In progress', completed:'Completed', cancelled:'Cancelled', pending:'Pending', accepted:'Accepted', declined:'Declined'}[status] || status);
  const api = async (path, options = {}) => {
    const request = {credentials:'same-origin', cache:'no-store', ...options, headers:{...(options.headers || {})}};
    if (request.body && typeof request.body !== 'string') { request.headers['Content-Type'] = 'application/json'; request.body = JSON.stringify(request.body); }
    if (['POST','PATCH','PUT','DELETE'].includes(request.method)) request.headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, request);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || 'The SwapLabs Tasks request could not be completed.');
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
  const setStatus = (element, message, error = false) => { if (!element) return; element.textContent = message; const pending = /pending (?:administrator )?review/i.test(String(message || '')); element.classList.toggle('error', error && !pending); };
  const splitSkills = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);

  function renderStats(stats = {}, matchCount = 0) {
    $('#swapjobOpenCount').textContent = Number(stats.open || 0).toLocaleString();
    $('#swapjobMatchCount').textContent = Number(matchCount || 0).toLocaleString();
    $('#swapjobCompletedCount').textContent = Number(stats.completed || 0).toLocaleString();
  }

  function jobCard(job) {
    const match = job.match;
    const owner = job.owner || {};
    const tags = list(job.skills_needed).slice(0, 5).map(tag => `<span>${escapeHtml(tag)}</span>`).join('');
    const reasons = list(match?.reasons).map(reason => `<li>${escapeHtml(reason)}</li>`).join('');
    const canPropose = state.user && !job.viewer_is_owner && job.status === 'open' && !job.viewer_applied;
    return `<article class="swapjob-card ${match && match.score >= 60 ? 'is-match' : ''}">
      <div class="swapjob-card-top"><span class="swapjob-category"><i class="bx bx-category"></i>${escapeHtml(job.category || 'Other')}</span><span class="swapjob-mode ${escapeHtml(job.exchange_mode || 'exchange')}">${escapeHtml(modeLabel(job.exchange_mode))}</span></div>
      <h3>${escapeHtml(job.title)}</h3><p class="swapjob-card-description">${escapeHtml(job.description)}</p>
      <div class="swapjob-tags">${tags || '<span>Skills to be agreed</span>'}</div>
      <div class="swapjob-card-meta"><span><i class="bx bx-user"></i>${escapeHtml(owner.display_name || 'SwapLabs member')}</span><span><i class="bx bx-time-five"></i>${escapeHtml(job.deadline ? `Due ${formatDate(job.deadline)}` : 'Flexible timing')}</span></div>
      ${job.offer_title ? `<div class="swapjob-offer"><small>In return</small><strong>${escapeHtml(job.offer_title)}</strong>${job.offer_description ? `<p>${escapeHtml(job.offer_description)}</p>` : ''}</div>` : ''}
      ${match ? `<div class="swapjob-match"><div class="swapjob-match-head"><span><i class="bx bx-sparkles"></i> Match for you</span><strong>${escapeHtml(match.score)}%</strong></div>${reasons ? `<ul class="swapjob-match-reasons">${reasons}</ul>` : ''}</div>` : ''}
      <div class="swapjob-card-foot"><small>${Number(job.proposal_count || 0)} proposal${Number(job.proposal_count || 0) === 1 ? '' : 's'} · ${escapeHtml(statusLabel(job.status))}</small>${canPropose ? `<button class="btn btn-primary btn-sm" type="button" data-propose-job="${escapeHtml(job.id)}">Propose to help <i class="bx bx-right-arrow-alt"></i></button>` : job.viewer_is_owner ? `<a class="btn btn-sm" href="#swapjobMine">Manage task <i class="bx bx-right-arrow-alt"></i></a>` : job.viewer_applied ? '<span class="swapjob-applied">Proposal sent</span>' : '<span class="swapjob-applied">Sign in to propose</span>'}</div>
    </article>`;
  }

  function renderJobs() {
    const host = $('#swapjobGrid');
    const jobs = state.jobs || [];
    host.innerHTML = jobs.length ? jobs.map(jobCard).join('') : '';
    $('#swapjobEmpty').hidden = Boolean(jobs.length);
    const banner = $('#swapjobMatchBanner');
    banner.hidden = !(state.user && jobs.some(item => item.match && item.match.score >= 30));
  }

  function renderMine() {
    const host = $('#swapjobMine');
    if (!state.user) { host.innerHTML = '<div class="feature-empty"><i class="bx bx-user"></i><h3>Sign in to see your tasks.</h3><p>Your postings and proposals will appear here.</p></div>'; return; }
    const ownerRows = (state.mine || []).map(job => {
      const proposals = list(job.proposals);
      const proposalMarkup = proposals.length ? `<details class="swapjob-proposals"><summary>${proposals.length} proposal${proposals.length === 1 ? '' : 's'} · review matches</summary><div>${proposals.map(proposal => `<article class="swapjob-proposal-row"><div><strong>${escapeHtml(proposal.applicant?.display_name || 'Member')}</strong><span>${escapeHtml(proposal.message)}</span><small>${escapeHtml((proposal.match?.score || 0) + '% match')} · ${escapeHtml(statusLabel(proposal.status))}</small></div>${job.status === 'open' && proposal.status === 'pending' ? `<button class="btn btn-sm btn-primary" type="button" data-accept-proposal="${escapeHtml(job.id)}" data-proposal-id="${escapeHtml(proposal.id)}">Accept</button>` : ''}</article>`).join('')}</div></details>` : '<span class="swapjob-no-proposals">No proposals yet — share the task board link.</span>';
      return `<article class="swapjob-mine-row"><strong>${escapeHtml(job.title)}</strong><span>${escapeHtml(statusLabel(job.status))} · ${Number(job.proposal_count || 0)} proposals</span>${proposalMarkup}<div class="swapjob-mine-actions">${job.status === 'in_progress' ? `<button class="btn btn-sm" type="button" data-complete-job="${escapeHtml(job.id)}"><i class="bx bx-check"></i> Mark complete</button>` : ''}${['open','in_progress'].includes(job.status) ? `<button class="btn btn-sm" type="button" data-cancel-job="${escapeHtml(job.id)}">Cancel</button>` : ''}</div></article>`;
    }).join('');
    const proposalRows = (state.proposals || []).map(proposal => `<article class="swapjob-mine-row"><strong>${escapeHtml(proposal.job?.title || 'SwapLabs Task proposal')}</strong><span>${escapeHtml(statusLabel(proposal.status))} · ${escapeHtml(proposal.match?.score || 0)}% match</span><p>${escapeHtml(proposal.message || '')}</p></article>`).join('');
    host.innerHTML = ownerRows || proposalRows ? `<div class="swapjob-mine-list">${ownerRows}${proposalRows}</div>` : '<div class="feature-empty"><i class="bx bx-folder-open"></i><h3>Your workspace is empty.</h3><p>Post a task or propose to an open SwapLabs Task to start building your record.</p></div>';
  }

  function renderCategories(categories) {
    const select = $('#swapjobCategory');
    const current = select.value;
    select.innerHTML = '<option value="">All categories</option>' + list(categories).map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    if (categories.includes(current)) select.value = current;
  }

  async function load() {
    try {
      const query = new URLSearchParams();
      const search = $('#swapjobSearch').value.trim(); if (search) query.set('q', search);
      const category = $('#swapjobCategory').value; if (category) query.set('category', category);
      const mode = $('#swapjobMode').value; if (mode) query.set('mode', mode);
      const payload = await api(`/api/swapjobs${query.toString() ? `?${query}` : ''}`);
      state.jobs = payload.jobs || []; state.mine = payload.mine || []; state.proposals = payload.my_proposals || [];
      renderCategories(payload.categories || []); renderStats(payload.stats, (payload.matches || []).length); renderJobs(); renderMine();
    } catch (error) {
      $('#swapjobGrid').innerHTML = `<div class="feature-empty"><i class="bx bx-error-circle"></i><h3>SwapLabs Tasks are unavailable.</h3><p>${escapeHtml(error.message)}</p><button class="btn" type="button" id="swapjobRetry">Try again</button></div>`;
      $('#swapjobRetry')?.addEventListener('click', load);
    }
  }

  function openProposal(job) {
    if (!state.user) { window.location.href = 'login.html?next=swapjobs.html'; return; }
    const dialog = document.getElementById('swapjobProposalDialog');
    const form = document.getElementById('swapjobProposalForm');
    const title = document.getElementById('swapjobDialogTitle');
    const description = document.getElementById('swapjobDialogDescription');
    const status = document.getElementById('swapjobProposalStatus');
    const message = document.getElementById('swapjobProposalMessage');
    if (!dialog || !form || !title || !description || !status || !message) return;
    title.textContent = `Help with ${job.title}`;
    description.textContent = `${job.deliverable || job.description} ${job.exchange_mode === 'volunteer' ? 'This task awards 25 points on completion.' : job.offer_title ? `The poster offers: ${job.offer_title}.` : ''}`;
    form.reset();
    form.elements.job_id.value = job.id;
    status.textContent = '';
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    message.focus();
  }

  root.addEventListener('click', async event => {
    const propose = event.target.closest('[data-propose-job]');
    if (propose) { const job = state.jobs.find(item => item.id === propose.dataset.proposeJob); if (job) openProposal(job); return; }
    const accept = event.target.closest('[data-accept-proposal]');
    if (accept) { accept.disabled = true; try { await api(`/api/swapjobs/${encodeURIComponent(accept.dataset.acceptProposal)}/proposals/${encodeURIComponent(accept.dataset.proposalId)}/accept`, {method:'POST'}); await load(); } catch (error) { if (error.code !== 'profile_incomplete') window.alert(error.message); accept.disabled = false; } return; }
    const complete = event.target.closest('[data-complete-job]');
    if (complete) { const url = window.prompt('Optional link to the completed deliverable (leave blank if none):', ''); if (url === null) return; complete.disabled = true; try { await api(`/api/swapjobs/${encodeURIComponent(complete.dataset.completeJob)}/complete`, {method:'POST', body:{deliverable_url:url}}); await load(); } catch (error) { if (error.code !== 'profile_incomplete') window.alert(error.message); complete.disabled = false; } return; }
    const cancel = event.target.closest('[data-cancel-job]');
    if (cancel && window.confirm('Cancel this SwapLabs Task and its pending proposals?')) { cancel.disabled = true; try { await api(`/api/swapjobs/${encodeURIComponent(cancel.dataset.cancelJob)}/cancel`, {method:'POST'}); await load(); } catch (error) { if (error.code !== 'profile_incomplete') window.alert(error.message); cancel.disabled = false; } }
  });
  $('#swapjobRefresh')?.addEventListener('click', load);
  $('#swapjobSearch')?.addEventListener('input', (() => { let timer; return () => { clearTimeout(timer); timer = setTimeout(load, 220); }; })());
  $('#swapjobCategory')?.addEventListener('change', load); $('#swapjobMode')?.addEventListener('change', load);
  $('#swapjobModeInput')?.addEventListener('change', event => { $('#swapjobCreditField').hidden = event.target.value !== 'credits'; if (event.target.value === 'volunteer') $('#swapjobCreditReward').value = 0; });
  $('#swapjobCreateForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget; const payload = Object.fromEntries(new FormData(form).entries());
    payload.skills_needed = splitSkills(payload.skills_needed); payload.offer_skills = splitSkills(payload.offer_skills); payload.credit_reward = Number(payload.credit_reward || 0);
    const status = $('#swapjobCreateStatus'); const button = form.querySelector('button[type="submit"]'); button.disabled = true; setStatus(status, 'Posting…');
    try { const result = await api('/api/swapjobs', {method:'POST', body:payload}); form.reset(); $('#swapjobCreditReward').value = 0; $('#swapjobCreditField').hidden = false; if (result.moderation?.status === 'pending') { setStatus(status, result.message || 'Your submission is pending administrator review and is hidden from the platform.'); return; } setStatus(status, result.message || 'SwapLabs Task posted.'); await load(); document.getElementById('swapjobDirectory').scrollIntoView({behavior:'smooth'}); }
    catch (error) { setStatus(status, error.message, true); } finally { button.disabled = false; }
  });
  document.getElementById('swapjobProposalForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') { document.getElementById('swapjobProposalDialog').close(); return; }
    const form = event.currentTarget; const payload = Object.fromEntries(new FormData(form).entries()); payload.skills = splitSkills(payload.skills);
    const button = form.querySelector('button[value="submit"]');
    const status = document.getElementById('swapjobProposalStatus');
    button.disabled = true; setStatus(status, 'Sending…');
    try { const result = await api(`/api/swapjobs/${encodeURIComponent(payload.job_id)}/proposals`, {method:'POST', body:payload}); if (result.moderation?.status === 'pending') { setStatus(status, result.message || 'Your proposal is pending administrator review and is hidden from the platform.'); return; } setStatus(status, result.message || 'Proposal sent.'); setTimeout(() => document.getElementById('swapjobProposalDialog').close(), 450); await load(); }
    catch (error) { setStatus(status, error.message, true); button.disabled = false; }
  });
  (async () => {
    try { const auth = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me')); state.csrf = auth.csrf_token || ''; state.user = auth.authenticated ? auth.user : null; if (state.user) { $('#swapjobLoginPrompt').hidden = true; $('#swapjobCreateForm').hidden = false; } }
    catch (_error) { state.user = null; }
    await load();
  })();
})();
