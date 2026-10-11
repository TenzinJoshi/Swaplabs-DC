(() => {
  const root = document.querySelector('[data-portfolio-builder]');
  if (!root) return;
  const $ = selector => root.querySelector(selector);
  const state = { csrf: '', user: null, settings: null, projects: [], journal: [], connections: null, connectionTab: 'followers' };
  const {escapeHtml, safeAvatarUrl} = window.RelayComponents;
  const list = value => Array.isArray(value) ? value : [];
  const splitSkills = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  const api = async (path, options = {}) => {
    const request = {credentials:'same-origin', cache:'no-store', ...options, headers:{...(options.headers || {})}};
    if (request.body && typeof request.body !== 'string') { request.headers['Content-Type'] = 'application/json'; request.body = JSON.stringify(request.body); }
    if (['POST','PATCH','PUT','DELETE'].includes(request.method)) request.headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, request); const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || 'The portfolio request could not be completed.');
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
  const date = value => { const parsed = new Date(value || ''); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString([], {month:'short', year:'numeric'}); };

  function setField(name, value) { const element = root.querySelector(`[name="${name}"]`); if (!element) return; if (element.type === 'checkbox') element.checked = Boolean(value); else element.value = value ?? ''; }
  function renderLinks(links = []) { $('#portfolioLinksList').innerHTML = list(links).map((link, index) => `<div class="portfolio-link-row" data-link-row><input name="link_label" data-link-label value="${escapeHtml(link.label)}" maxlength="60" placeholder="Label"><input name="link_href" data-link-href value="${escapeHtml(link.href)}" maxlength="240" placeholder="https://example.com"><button class="portfolio-link-remove" type="button" data-remove-link aria-label="Remove link"><i class="bx bx-trash"></i></button></div>`).join(''); }
  function readLinks() { return [...root.querySelectorAll('[data-link-row]')].map(row => ({label: row.querySelector('[data-link-label]')?.value.trim(), href: row.querySelector('[data-link-href]')?.value.trim()})).filter(item => item.label || item.href); }
  function renderPreview() {
    const settings = state.settings || {};
    const profile = state.user?.profile || {};
    const accent = ['indigo', 'blue', 'pink', 'purple', 'green', 'orange'].includes(settings.accent) ? settings.accent : 'indigo';
    $('#portfolioPreview').dataset.accent = accent;
    $('#portfolioPreviewTitle').textContent = settings.title || `${profile.display_name || 'Your'} portfolio`;
    $('#portfolioPreviewHeadline').textContent = settings.headline || 'Your headline will appear here.';
    $('#portfolioPreviewIntro').textContent = settings.intro || 'Add a short introduction to make the first impression useful.';
    $('#portfolioPreviewPill').textContent = settings.visibility === 'public' ? 'Public' : 'Private';
    $('#portfolioVisibilityHeadline').textContent = settings.visibility === 'public' ? 'Your portfolio is public.' : 'Private until you say otherwise.';
    $('#portfolioVisibilityCopy').textContent = settings.visibility === 'public' ? 'The community can see your chosen projects and profile story.' : 'You choose whether your portfolio is public. Each project can have its own visibility too.';
    $('#portfolioPublicLink').hidden = settings.visibility !== 'public';
    $('#portfolioProjectCount').textContent = Number(state.projects.length || 0);
    $('#portfolioPoints').textContent = Number(state.user?.reward_points || 0).toLocaleString();
    $('#portfolioJournalCount').textContent = Number(state.journal.length || 0);
    const skills = [...new Set([...(state.user?.profile?.skills_to_teach || []), ...(state.user?.profile?.skills_to_learn || [])])].slice(0, 6);
    $('#portfolioPreviewTags').innerHTML = skills.map(skill => `<span>${escapeHtml(skill)}</span>`).join('');
  }
  function connectionAvatar(person) {
    const profile = person?.profile || {};
    const initials = String(profile.display_name || person?.username || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
    const source = safeAvatarUrl(person);
    return source ? `<img src="${escapeHtml(source)}" alt="" loading="lazy">` : `<span>${escapeHtml(initials)}</span>`;
  }
  function renderConnections() {
    const panel = $('#portfolioConnections');
    const connections = state.connections;
    if (!panel || !connections) return;
    $('#portfolioFollowersCount').textContent = Number(connections.followers_count || connections.followers?.length || 0).toLocaleString();
    $('#portfolioFollowingCount').textContent = Number(connections.following_count || connections.following?.length || 0).toLocaleString();
    const people = Array.isArray(connections[state.connectionTab]) ? connections[state.connectionTab] : [];
    root.querySelectorAll('[data-connection-tab]').forEach(button => {
      const active = button.dataset.connectionTab === state.connectionTab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const listHost = $('#portfolioConnectionList');
    const hint = root.querySelector('[data-connection-hint]');
    if (!listHost) return;
    listHost.hidden = false;
    if (hint) hint.hidden = true;
    listHost.innerHTML = people.length ? people.map(person => `<a class="portfolio-connection-person" href="member-profile.html?user=${encodeURIComponent(person.id)}"><span class="portfolio-connection-avatar">${connectionAvatar(person)}</span><span class="portfolio-connection-person-copy"><strong>${escapeHtml(person.profile?.display_name || person.username)}</strong><small>@${escapeHtml(person.username)}${person.profile?.headline ? ` · ${escapeHtml(person.profile.headline)}` : ''}</small></span><i class="bx bx-chevron-right" aria-hidden="true"></i></a>`).join('') : `<div class="portfolio-connection-empty"><i class="bx bx-group"></i><p>You do not have any ${state.connectionTab} yet.</p></div>`;
  }
  async function loadConnections() {
    const panel = $('#portfolioConnections');
    if (!panel || !state.user) return;
    try {
      state.connections = await api('/api/profile/connections');
      renderConnections();
    } catch (error) {
      const listHost = $('#portfolioConnectionList');
      if (listHost) { listHost.hidden = false; listHost.innerHTML = `<div class="portfolio-connection-empty"><i class="bx bx-error-circle"></i><p>${escapeHtml(error.message)}</p></div>`; }
    }
  }
  function renderProjects() {
    const host = $('#portfolioProjectGrid');
    if (!state.user) { host.innerHTML = '<div class="feature-empty"><i class="bx bx-lock-alt"></i><h3>Sign in to view your portfolio evidence.</h3><p>Project records are tied to your account.</p></div>'; return; }
    if (!state.projects.length) { host.innerHTML = '<div class="feature-empty"><i class="bx bx-folder-open"></i><h3>No portfolio projects yet.</h3><p>Add your first project above or complete a SwapLabs Task with public portfolio proof.</p></div>'; return; }
    host.innerHTML = state.projects.map(item => `<article class="portfolio-project-card"><div class="portfolio-project-card-head"><span class="portfolio-project-source"><i class="bx ${item.source === 'swapjob' ? 'bx-briefcase-alt-2' : 'bx-edit-alt'}"></i>${item.source === 'swapjob' ? 'Completed SwapLabs Task' : 'Personal project'}</span><span class="portfolio-project-visibility"><i class="bx ${item.visibility === 'public' ? 'bx-world' : 'bx-lock-alt'}"></i>${escapeHtml(item.visibility || 'private')}</span></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p><div class="portfolio-project-meta"><span>${escapeHtml(item.role || 'Contributor')}</span>${item.created_at ? `<span>${escapeHtml(date(item.created_at))}</span>` : ''}${item.points_awarded ? `<span class="portfolio-project-points"><i class="bx bx-star"></i> +${escapeHtml(item.points_awarded)} points</span>` : ''}</div><div class="portfolio-project-tags">${list(item.skills).slice(0, 6).map(skill => `<span>${escapeHtml(skill)}</span>`).join('')}</div><div class="portfolio-project-actions">${item.evidence_url ? `<a class="btn btn-sm" href="${escapeHtml(item.evidence_url)}" target="_blank" rel="noopener">View evidence <i class="bx bx-link-external"></i></a>` : ''}${item.source === 'manual' ? `<button class="btn btn-sm" type="button" data-edit-project="${escapeHtml(item.id)}">Edit</button><button class="btn btn-sm" type="button" data-delete-project="${escapeHtml(item.id)}"><i class="bx bx-trash"></i></button>` : ''}</div></article>`).join('');
  }
  function fillSettings(settings) { state.settings = settings || {}; ['title','headline','intro','visibility','accent','show_completed_jobs','show_journal','show_ideas','show_workshops'].forEach(key => setField(key, state.settings[key])); renderLinks(state.settings.links || []); renderPreview(); }
  function resetProjectForm() { const form = $('#portfolioProjectForm'); form.reset(); form.elements.id.value = ''; $('#portfolioProjectSubmitLabel').textContent = 'Add project'; $('#portfolioProjectCancel').hidden = true; setStatus($('#portfolioProjectStatus'), ''); }
  function editProject(id) { const item = state.projects.find(project => project.id === id); if (!item || item.source !== 'manual') return; const form = $('#portfolioProjectForm'); form.elements.id.value = item.id; form.elements.title.value = item.title || ''; form.elements.summary.value = item.summary || ''; form.elements.role.value = item.role || ''; form.elements.skills.value = list(item.skills).join(', '); form.elements.evidence_url.value = item.evidence_url || ''; form.elements.visibility.value = item.visibility || 'private'; $('#portfolioProjectSubmitLabel').textContent = 'Save project'; $('#portfolioProjectCancel').hidden = false; $('#portfolioProjectEditor').scrollIntoView({behavior:'smooth', block:'start'}); form.elements.title.focus(); }
  async function load() { try { const payload = await api('/api/portfolio'); state.settings = payload.settings; state.projects = payload.projects || []; state.journal = payload.journal || []; fillSettings(payload.settings); renderProjects(); } catch (error) { $('#portfolioProjectGrid').innerHTML = `<div class="feature-empty"><i class="bx bx-error-circle"></i><h3>Portfolio is unavailable.</h3><p>${escapeHtml(error.message)}</p></div>`; } }

  $('#portfolioSettingsForm')?.addEventListener('input', event => { if (!state.settings) state.settings = {}; if (event.target.name && !event.target.name.startsWith('link_')) state.settings[event.target.name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value; renderPreview(); });
  $('#portfolioAddLink')?.addEventListener('click', () => { const links = readLinks(); links.push({label:'', href:''}); renderLinks(links); $('#portfolioLinksList [data-link-row]:last-child [data-link-label]')?.focus(); });
  $('#portfolioLinksList')?.addEventListener('click', event => { if (event.target.closest('[data-remove-link]')) { event.target.closest('[data-link-row]').remove(); } });
  $('#portfolioSettingsForm')?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const payload = Object.fromEntries(new FormData(form).entries()); for (const key of ['show_completed_jobs','show_journal','show_ideas','show_workshops']) payload[key] = form.elements[key].checked; payload.links = readLinks(); const button = form.querySelector('button[type="submit"]'); button.disabled = true; setStatus($('#portfolioSettingsStatus'), 'Saving…'); try { const result = await api('/api/portfolio', {method:'PATCH', body:payload}); fillSettings(result.settings); state.projects = result.portfolio?.projects || state.projects; renderProjects(); setStatus($('#portfolioSettingsStatus'), 'Portfolio settings saved.'); } catch (error) { setStatus($('#portfolioSettingsStatus'), error.message, true); } finally { button.disabled = false; } });
  $('#portfolioProjectForm')?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const payload = Object.fromEntries(new FormData(form).entries()); payload.skills = splitSkills(payload.skills); const id = payload.id; delete payload.id; const button = form.querySelector('button[type="submit"]'); button.disabled = true; setStatus($('#portfolioProjectStatus'), 'Saving…'); try { if (id) await api(`/api/portfolio/items/${encodeURIComponent(id)}`, {method:'PATCH', body:payload}); else await api('/api/portfolio/items', {method:'POST', body:payload}); resetProjectForm(); await load(); setStatus($('#portfolioProjectStatus'), 'Project saved.'); } catch (error) { setStatus($('#portfolioProjectStatus'), error.message, true); } finally { button.disabled = false; } });
  $('#portfolioProjectCancel')?.addEventListener('click', resetProjectForm);
  root.addEventListener('click', async event => { const connectionTab = event.target.closest('[data-connection-tab]'); if (connectionTab) { state.connectionTab = connectionTab.dataset.connectionTab === 'following' ? 'following' : 'followers'; renderConnections(); return; } const refreshConnections = event.target.closest('[data-connection-refresh]'); if (refreshConnections) { refreshConnections.disabled = true; await loadConnections(); refreshConnections.disabled = false; return; } const edit = event.target.closest('[data-edit-project]'); if (edit) { editProject(edit.dataset.editProject); return; } const remove = event.target.closest('[data-delete-project]'); if (remove && window.confirm('Remove this project from your portfolio?')) { remove.disabled = true; try { await api(`/api/portfolio/items/${encodeURIComponent(remove.dataset.deleteProject)}`, {method:'DELETE'}); await load(); } catch (error) { window.alert(error.message); remove.disabled = false; } } });
  window.addEventListener('relayskills:connections-updated', () => loadConnections());
  (async () => { try { const auth = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me')); state.csrf = auth.csrf_token || ''; state.user = auth.authenticated ? auth.user : null; } catch (_error) { state.user = null; } if (state.user) { $('#portfolioLoginPrompt').hidden = true; $('#portfolioSettingsForm').hidden = false; $('#portfolioProjectForm').hidden = false; $('#portfolioProjectLoginPrompt').hidden = true; $('#portfolioPublicLink').href = `member-profile.html?user=${encodeURIComponent(state.user.id)}`; $('#portfolioConnections').hidden = false; await load(); await loadConnections(); } else { renderProjects(); } })();
})();
