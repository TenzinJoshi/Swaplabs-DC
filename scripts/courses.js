(() => {
  'use strict';

  const root = document.querySelector('[data-courses-page]');
  if (!root) return;

  const $ = (selector, scope = root) => scope.querySelector(selector);
  const $$ = (selector, scope = root) => [...scope.querySelectorAll(selector)];
  const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  const state = {user: null, csrf: '', courses: [], mine: []};

  const {escapeHtml} = window.RelayComponents;
  const list = value => Array.isArray(value) ? value : [];
  const ownerName = course => course?.owner?.profile?.display_name || course?.owner?.username || 'SwapLabs member';
  const safeUrl = value => {
    try {
      const url = new URL(String(value || ''), location.origin);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_error) { return ''; }
  };

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (writeMethods.has(method) && !state.csrf) {
      const csrfResponse = await fetch('/api/auth/csrf', {credentials: 'same-origin', cache: 'no-store'});
      if (!csrfResponse.ok) throw new Error('Could not establish a secure session. Refresh and try again.');
      state.csrf = (await csrfResponse.json()).csrf_token || '';
    }
    const headers = {...(options.headers || {})};
    if (writeMethods.has(method)) headers['X-CSRF-Token'] = state.csrf;
    if (options.body && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, {...options, method, headers, credentials: 'same-origin', cache: 'no-store'});
    let payload = {};
    try { payload = await response.json(); } catch (_error) { /* Use the fallback message below. */ }
    if (!response.ok) throw new Error(payload.error || 'The course request could not be completed.');
    if (payload.moderation?.status === 'pending') {
      const error = new Error(payload.message || 'Your submission is pending administrator review and is hidden from the platform.');
      error.status = response.status;
      error.code = 'pending_moderation';
      throw error;
    }
    if (payload.csrf_token) state.csrf = payload.csrf_token;
    return payload;
  }

  function setStatus(message, type = '') {
    const status = $('[data-course-status]');
    if (!status) return;
    status.textContent = message;
    if (type === 'error' && /pending (?:administrator )?review/i.test(String(message || ''))) type = 'info';
    status.className = `form-status${message ? ` show ${type}` : ''}`;
  }

  function courseCard(course, mine = false) {
    const isDraft = course.visibility !== 'public' || course.status !== 'published';
    const lessons = list(course.lessons);
    const resourceUrl = safeUrl(course.resource_url);
    const lessonMarkup = lessons.slice(0, 4).map((lesson, index) => `<span class="course-card-lesson"><b>${String(index + 1).padStart(2, '0')}</b>${escapeHtml(lesson.title || 'Lesson')}</span>`).join('');
    const moreLessons = lessons.length > 4 ? `<span class="course-card-lesson"><b>+</b>${lessons.length - 4} more lesson${lessons.length - 4 === 1 ? '' : 's'}</span>` : '';
    return `<article class="course-card${isDraft ? ' course-card-draft' : ''}">
      <div class="course-card-top"><span class="course-card-badge"><i class="bx bx-category"></i>${escapeHtml(course.category || 'Learning')}</span><span class="course-card-status${isDraft ? ' draft' : ''}"><i class="bx ${isDraft ? 'bx-pencil' : 'bx-world'}"></i>${isDraft ? 'Draft' : 'Public'}</span></div>
      <h3>${escapeHtml(course.title)}</h3>
      <p class="course-card-description">${escapeHtml(course.description)}</p>
      <div class="course-card-meta"><span><i class="bx bx-bar-chart-alt-2"></i>${escapeHtml(course.level || 'All levels')}</span><span><i class="bx bx-time-five"></i>${escapeHtml(course.estimated_hours || 1)} hr${Number(course.estimated_hours || 1) === 1 ? '' : 's'}</span><span><i class="bx bx-book-open"></i>${Number(course.lesson_count || lessons.length)} lessons</span></div>
      <div class="course-card-lessons"><strong>${isDraft ? 'Your lesson path' : 'What learners will cover'}</strong>${lessonMarkup || '<span class="course-card-lesson">Lessons are being prepared.</span>'}${moreLessons}</div>
      <div class="course-card-owner"><i class="bx bx-user-circle"></i><span>By <strong>${escapeHtml(ownerName(course))}</strong></span></div>
      <div class="course-card-actions">${resourceUrl ? `<a class="btn btn-sm" href="${escapeHtml(resourceUrl)}" target="_blank" rel="noopener noreferrer"><i class="bx bx-link-external"></i> Open resource</a>` : ''}${mine && isDraft ? `<button class="btn btn-sm btn-primary" type="button" data-course-publish="${escapeHtml(course.id)}"><i class="bx bx-world"></i> Publish draft</button><span class="course-card-draft-note"><i class="bx bx-lock-alt"></i> Only you can see this draft.</span>` : ''}${mine && !isDraft ? `<button class="btn btn-sm" type="button" data-course-unpublish="${escapeHtml(course.id)}"><i class="bx bx-lock-alt"></i> Make draft</button>` : ''}${mine ? `<button class="course-card-delete" type="button" data-course-delete="${escapeHtml(course.id)}" aria-label="Remove ${escapeHtml(course.title)}" title="Remove course"><i class="bx bx-trash"></i></button>` : ''}</div>
    </article>`;
  }

  function renderStats() {
    const published = state.courses.filter(course => course.visibility === 'public' && course.status === 'published');
    const lessons = published.reduce((total, course) => total + Number(course.lesson_count || list(course.lessons).length || 0), 0);
    const creators = new Set(published.map(course => course.owner_id).filter(Boolean));
    $('[data-courses-stat="published"]').textContent = String(published.length);
    $('[data-courses-stat="lessons"]').textContent = String(lessons);
    $('[data-courses-stat="creators"]').textContent = String(creators.size);
  }

  function renderCategories() {
    const select = $('[data-courses-category]');
    if (!select) return;
    const previous = select.value;
    const categories = [...new Set(state.courses.map(course => String(course.category || '').trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    select.innerHTML = '<option value="all">All categories</option>';
    categories.forEach(category => {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = category;
      select.appendChild(option);
    });
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  function filteredCourses() {
    const query = String($('[data-courses-search]')?.value || '').trim().toLowerCase();
    const category = $('[data-courses-category]')?.value || 'all';
    return state.courses.filter(course => {
      const searchText = [course.title, course.description, course.category, course.level, ownerName(course), ...list(course.lessons).map(lesson => `${lesson.title} ${lesson.description || ''}`)].join(' ').toLowerCase();
      return (!query || searchText.includes(query)) && (category === 'all' || course.category === category);
    });
  }

  function renderCatalogue() {
    const courses = filteredCourses();
    const host = $('[data-courses-list]');
    host.innerHTML = courses.map(course => courseCard(course)).join('');
    host.hidden = courses.length === 0;
    $('[data-courses-empty]').hidden = courses.length > 0;
    $('[data-course-result-count]').textContent = `${courses.length} public course${courses.length === 1 ? '' : 's'}`;
  }

  function renderMine() {
    const section = $('[data-my-courses-section]');
    const host = $('[data-my-courses-list]');
    if (!state.user) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    host.innerHTML = state.mine.map(course => courseCard(course, true)).join('');
    host.hidden = state.mine.length === 0;
    $('[data-my-courses-empty]').hidden = state.mine.length > 0;
  }

  function renderAuth() {
    $('[data-course-auth-gate]').hidden = Boolean(state.user);
    $('[data-course-builder]').hidden = !state.user;
    renderMine();
  }

  function lessonMarkup(index) {
    return `<div class="course-lesson-row" data-course-lesson><div class="course-lesson-number">${String(index).padStart(2, '0')}</div><div class="course-lesson-fields"><label class="course-field"><span>Lesson title</span><input name="lesson_title" maxlength="140" required placeholder="e.g. Practise the next step"></label><label class="course-field"><span>Lesson summary <em>optional</em></span><textarea name="lesson_description" maxlength="600" placeholder="What will this lesson help someone do?"></textarea></label><label class="course-field"><span>Lesson link <em>optional</em></span><input name="lesson_resource_url" type="url" maxlength="500" placeholder="https://…"></label></div><button class="course-remove-lesson" type="button" data-course-remove-lesson aria-label="Remove lesson"><i class="bx bx-trash"></i></button></div>`;
  }

  function renumberLessons() {
    const rows = $$('[data-course-lesson]');
    rows.forEach((row, index) => {
      row.querySelector('.course-lesson-number').textContent = String(index + 1).padStart(2, '0');
      const remove = row.querySelector('[data-course-remove-lesson]');
      remove.hidden = rows.length === 1;
    });
  }

  function collectLessons() {
    return $$('[data-course-lesson]').map((row, index) => ({
      position: index + 1,
      title: row.querySelector('[name="lesson_title"]')?.value.trim() || '',
      description: row.querySelector('[name="lesson_description"]')?.value.trim() || '',
      resource_url: row.querySelector('[name="lesson_resource_url"]')?.value.trim() || ''
    }));
  }

  function resetBuilder() {
    const form = $('#courseForm');
    form.reset();
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.innerHTML = '<i class="bx bx-cloud-upload"></i> Publish course';
    const lessonList = $('[data-course-lessons]');
    lessonList.innerHTML = lessonMarkup(1);
    $$('.course-visibility-option').forEach(option => option.classList.toggle('selected', option.querySelector('input')?.checked));
    renumberLessons();
  }

  async function load() {
    try {
      const result = await api('/api/courses');
      state.courses = Array.isArray(result.courses) ? result.courses : [];
      state.mine = Array.isArray(result.mine) ? result.mine : [];
      renderStats();
      renderCategories();
      renderCatalogue();
      renderMine();
    } catch (error) {
      const host = $('[data-courses-list]');
      host.hidden = false;
      host.innerHTML = `<div class="course-empty"><i class="bx bx-wifi-off"></i><h3>Courses are temporarily unavailable.</h3><p>${escapeHtml(error.message)}</p><button class="btn btn-primary" type="button" data-course-retry>Try again</button></div>`;
      $('[data-course-result-count]').textContent = 'Unable to load';
      $('[data-course-retry]')?.addEventListener('click', load, {once: true});
    }
  }

  async function loadAuth() {
    try {
      const result = await (window.SwapLabsAuth?.get?.() || api('/api/auth/me'));
      state.user = result?.authenticated ? result.user : null;
      if (result?.csrf_token) state.csrf = result.csrf_token;
    } catch (_error) {
      state.user = null;
    }
    renderAuth();
  }

  $('#courseForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const lessons = collectLessons();
    if (!lessons.length || lessons.some(lesson => !lesson.title)) {
      setStatus('Add a title for every lesson before publishing.', 'error');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus('Publishing your course…', '');
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const result = await api('/api/courses', {method: 'POST', body: {
        title: data.title, description: data.description, category: data.category, level: data.level,
        estimated_hours: data.estimated_hours, resource_url: data.resource_url, visibility: data.visibility, lessons
      }});
      setStatus(result.message || 'Your course is published.', 'success');
      resetBuilder();
      await load();
      document.querySelector('[data-my-courses-section]')?.scrollIntoView({behavior: 'smooth', block: 'start'});
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('[data-course-add-lesson]')?.addEventListener('click', () => {
    const lessons = $('[data-course-lessons]');
    lessons.insertAdjacentHTML('beforeend', lessonMarkup($$('[data-course-lesson]').length + 1));
    renumberLessons();
  });

  $('[data-course-lessons]')?.addEventListener('click', event => {
    const remove = event.target.closest('[data-course-remove-lesson]');
    if (!remove) return;
    remove.closest('[data-course-lesson]')?.remove();
    renumberLessons();
  });

  $('[data-my-courses-list]')?.addEventListener('click', async event => {
    const publish = event.target.closest('[data-course-publish]');
    const unpublish = event.target.closest('[data-course-unpublish]');
    const remove = event.target.closest('[data-course-delete]');
    const action = publish || unpublish;
    if (!action && !remove) return;
    const courseId = action?.dataset.coursePublish || action?.dataset.courseUnpublish || remove?.dataset.courseDelete;
    if (!courseId) return;
    if (remove && !window.confirm('Remove this course? This cannot be undone.')) return;
    const button = action || remove;
    button.disabled = true;
    try {
      if (remove) await api(`/api/courses/${encodeURIComponent(courseId)}`, {method: 'DELETE'});
      else await api(`/api/courses/${encodeURIComponent(courseId)}`, {method: 'PATCH', body: {visibility: publish ? 'public' : 'private'}});
      setStatus(remove ? 'Course removed.' : publish ? 'Your course is now public.' : 'Your course is now a private draft.', 'success');
      await load();
    } catch (error) {
      setStatus(error.message, 'error');
      button.disabled = false;
    }
  });

  $$('.course-visibility-option input').forEach(input => input.addEventListener('change', () => {
    $$('.course-visibility-option').forEach(option => option.classList.toggle('selected', option.querySelector('input')?.checked));
    const submit = $('#courseForm button[type="submit"]');
    if (submit) submit.innerHTML = input.value === 'public' ? '<i class="bx bx-cloud-upload"></i> Publish course' : '<i class="bx bx-save"></i> Save draft';
  }));

  $('[data-courses-search]')?.addEventListener('input', renderCatalogue);
  $('[data-courses-category]')?.addEventListener('change', renderCatalogue);
  $('[data-courses-clear]')?.addEventListener('click', () => {
    $('[data-courses-search]').value = '';
    $('[data-courses-category]').value = 'all';
    renderCatalogue();
  });
  window.addEventListener('swaplabs:auth-state', event => {
    state.user = event.detail?.authenticated ? event.detail.user : null;
    renderAuth();
    if (state.user) load();
  });

  renumberLessons();
  renderAuth();
  loadAuth().then(load);
})();
