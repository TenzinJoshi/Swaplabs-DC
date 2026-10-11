(() => {
  'use strict';
  if (!document.body?.classList.contains('blog-community-page')) return;

  const state = {csrf: '', user: null, posts: [], sort: 'latest', previewUrls: []};
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  const {escapeHtml, displayName, initials, profileColor, safeAvatarUrl} = window.RelayComponents;
  const safeAvatar = safeAvatarUrl;
  const safeMediaUrl = value => {
    const source = String(value || '');
    if (/^(?:\/?assets\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png|webp|gif)|\/community-media\/blog_[A-Za-z0-9_-]+\.(?:jpg|png|webp|mp4|webm)|\/community-media\/post_[A-Za-z0-9_-]+\.(?:jpg|png|webp|mp4|webm))$/.test(source)) return source;
    return /^data:(?:image|video)\/(?:jpeg|jpg|png|webp|mp4|webm);base64,[A-Za-z0-9+/]+={0,2}$/.test(source) ? source : '';
  };
  const mediaList = post => Array.isArray(post?.media) ? post.media : post?.media ? [post.media] : [];

  const avatarMarkup = (person, className = 'blog-avatar') => {
    const name = displayName(person);
    const source = safeAvatar(person);
    return `<span class="${className} ${profileColor(person)}">${source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(name)} profile photo">` : escapeHtml(initials(name))}</span>`;
  };

  const relativeTime = value => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'recently';
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
    return new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'}).format(date);
  };

  const mediaMarkup = post => mediaList(post).map((media, index) => {
    const source = safeMediaUrl(media?.url || media);
    if (!source) return '';
    const type = String(media?.type || media?.content_type || '').toLowerCase();
    const caption = escapeHtml(media?.name || `Blog media ${index + 1}`);
    const visual = type.startsWith('video') || /\.(mp4|webm)$/.test(source)
      ? `<video controls preload="metadata" src="${escapeHtml(source)}"></video>`
      : `<img loading="lazy" src="${escapeHtml(source)}" alt="${caption}">`;
    return `<figure>${visual}<figcaption>${caption}</figcaption></figure>`;
  }).join('');

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (writeMethods.has(method) && !state.csrf) {
      const csrf = await fetch('/api/auth/csrf', {credentials: 'same-origin', cache: 'no-store'});
      if (!csrf.ok) throw new Error('Could not establish a secure session.');
      state.csrf = (await csrf.json()).csrf_token || '';
    }
    const headers = {...(options.headers || {})};
    if (writeMethods.has(method)) headers['X-CSRF-Token'] = state.csrf;
    if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, {...options, method, headers, credentials: 'same-origin', cache: 'no-store'});
    const payload = await response.json().catch(() => ({error: 'The server returned an unreadable response.'}));
    if (!response.ok) {
      const error = new Error(payload.error || 'Something went wrong.');
      error.status = response.status;
      throw error;
    }
    if (payload.csrf_token) state.csrf = payload.csrf_token;
    return payload;
  }

  function renderViewer() {
    const host = $('#blogViewerCard');
    if (!host) return;
    if (!state.user) {
      host.innerHTML = `<span class="eyebrow">Join the writers</span><h2>Bring your perspective.</h2><p>Publish a story, respond to another member, and make the next exchange easier to find.</p><a class="btn btn-primary btn-sm" href="register.html?next=blog.html"><i class="bx bx-user-plus"></i> Create an account</a>`;
      return;
    }
    const profile = state.user.profile || {};
    host.innerHTML = `<div class="blog-viewer-profile">${avatarMarkup(state.user)}<div><strong>${escapeHtml(displayName(state.user))}</strong><span>@${escapeHtml(state.user.username || 'member')}</span></div></div><p>${escapeHtml(profile.headline || 'Ready to share something useful.')}</p><div class="blog-viewer-meta"><div><strong>${Number(state.user.time_credits || 0)}</strong><span>time credits</span></div><div><strong>${(profile.skills_to_teach || []).length || '—'}</strong><span>skills to teach</span></div></div><a class="btn btn-soft btn-sm" href="portfolio.html"><i class="bx bx-id-card"></i> Open my portfolio</a>`;
  }

  function setStatus(element, message, type = '') {
    if (!element) return;
    element.textContent = message || '';
    element.classList.toggle('error', type === 'error');
  }

  function renderStats(result) {
    const totalComments = state.posts.reduce((sum, post) => sum + Number(post.counts?.comments || 0), 0);
    $('#blogStatPosts').textContent = Number(result.stats?.posts ?? state.posts.length).toLocaleString();
    $('#blogStatMedia').textContent = Number(result.stats?.media ?? state.posts.filter(post => mediaList(post).length).length).toLocaleString();
    $('#blogStatConversations').textContent = totalComments.toLocaleString();
  }

  function commentMarkup(comment) {
    return `<div class="blog-comment">${avatarMarkup(comment.author, 'blog-avatar')}<div class="blog-comment-bubble"><strong>${escapeHtml(displayName(comment.author))}</strong><span>${escapeHtml(comment.body)}</span><small>${relativeTime(comment.created_at)}</small></div></div>`;
  }

  function postMarkup(post) {
    const liked = Boolean(post.viewer_liked);
    const likes = Number(post.counts?.likes || 0);
    const comments = Number(post.counts?.comments || 0);
    const tags = (Array.isArray(post.tags) ? post.tags : []).slice(0, 6).map(tag => `<span class="blog-post-tag">${escapeHtml(tag)}</span>`).join('');
    const visibility = post.visibility === 'followers' ? 'Followers' : 'Public';
    return `<article class="blog-post-card" id="blog-${escapeHtml(post.id)}" data-blog-id="${escapeHtml(post.id)}"><header class="blog-post-card-head"><div class="blog-author">${avatarMarkup(post.author)}<div><strong>${escapeHtml(displayName(post.author))}</strong><span>${post.author?.username ? `@${escapeHtml(post.author.username)} · ` : ''}${relativeTime(post.created_at)}</span></div></div><span class="blog-post-visibility"><i class="bx ${post.visibility === 'followers' ? 'bx-lock-alt' : 'bx-world'}"></i> ${visibility}</span></header><div class="blog-post-content"><h3>${escapeHtml(post.title)}</h3>${post.excerpt ? `<p class="blog-post-excerpt">${escapeHtml(post.excerpt)}</p>` : ''}<div class="blog-post-body">${escapeHtml(post.body)}</div>${tags ? `<div class="blog-post-tags">${tags}</div>` : ''}</div>${mediaMarkup(post) ? `<div class="blog-post-media">${mediaMarkup(post)}</div>` : ''}<footer class="blog-post-footer"><div class="blog-post-counts"><span>${likes ? `${likes} like${likes === 1 ? '' : 's'}` : 'Be the first to like this'}</span><span>${comments} comment${comments === 1 ? '' : 's'}</span></div><div class="blog-post-actions"><button class="${liked ? 'active' : ''}" type="button" data-blog-like="${escapeHtml(post.id)}" aria-pressed="${liked}"><i class="bx ${liked ? 'bxs-heart' : 'bx-heart'}"></i><span>${liked ? 'Liked' : 'Like'}</span></button><button type="button" data-blog-comments="${escapeHtml(post.id)}"><i class="bx bx-message-rounded"></i><span>Comment</span></button></div></footer><section class="blog-comments" data-comments-for="${escapeHtml(post.id)}"><div class="blog-comments-list" data-comments-list="${escapeHtml(post.id)}"><div class="blog-loading">Open comments to join the conversation.</div></div>${state.user ? `<form class="blog-comment-form" data-blog-comment-form="${escapeHtml(post.id)}"><input name="body" maxlength="800" placeholder="Add a thoughtful comment…" autocomplete="off"><button type="submit" aria-label="Post comment"><i class="bx bx-send"></i></button></form>` : `<a class="blog-comment-form" aria-disabled="true" href="login.html?next=blog.html"><input disabled placeholder="Log in to comment"><button type="button" aria-label="Log in"><i class="bx bx-log-in"></i></button></a>`}</section></article>`;
  }

  function renderPosts() {
    const host = $('#blogPostList');
    const empty = $('#blogPostEmpty');
    if (!host) return;
    if (!state.posts.length) {
      host.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    host.innerHTML = state.posts.map(postMarkup).join('');
  }

  async function loadFeed() {
    const result = await api(`/api/blog/feed?sort=${encodeURIComponent(state.sort)}`);
    state.user = result.viewer || null;
    state.posts = Array.isArray(result.posts) ? result.posts : [];
    renderViewer();
    renderPosts();
    renderStats(result);
    const form = $('#blogComposerForm');
    const locked = $('#blogComposerLocked');
    if (form) form.hidden = !state.user;
    if (locked) locked.hidden = Boolean(state.user);
    const identity = $('#blogComposerIdentity');
    if (identity && state.user) identity.textContent = `Publishing as ${displayName(state.user)} · your story can include up to four images or videos.`;
  }

  function validateFiles(files) {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);
    if (files.length > 4) return 'Add up to four images or videos.';
    let total = 0;
    for (const file of files) {
      if (!allowed.has(String(file.type || '').toLowerCase())) return 'Choose JPG, PNG, WebP, MP4, or WebM files.';
      if (Number(file.size || 0) <= 0 || Number(file.size || 0) > 2_500_000) return 'Each image or video must be 2.5 MB or smaller in local mode.';
      total += Number(file.size || 0);
    }
    return total > 8_000_000 ? 'Keep the combined media under 8 MB in local mode.' : '';
  }

  function clearPreview() {
    state.previewUrls.forEach(url => URL.revokeObjectURL(url));
    state.previewUrls = [];
    const preview = $('#blogMediaPreview');
    if (preview) { preview.hidden = true; preview.innerHTML = ''; }
  }

  function previewFiles(input) {
    clearPreview();
    const files = [...(input.files || [])];
    if (!files.length) return;
    const issue = validateFiles(files);
    if (issue) {
      input.value = '';
      setStatus($('#blogComposerStatus'), issue, 'error');
      return;
    }
    const preview = $('#blogMediaPreview');
    if (!preview) return;
    preview.hidden = false;
    preview.innerHTML = files.map(file => {
      const url = URL.createObjectURL(file);
      state.previewUrls.push(url);
      return String(file.type).startsWith('video/') ? `<video controls muted src="${escapeHtml(url)}"></video>` : `<img src="${escapeHtml(url)}" alt="Selected blog media">`;
    }).join('');
  }

  async function submitBlog(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const status = $('#blogComposerStatus');
    const title = String($('#blogTitle')?.value || '').trim();
    const body = String($('#blogBody')?.value || '').trim();
    if (title.length < 4) return setStatus(status, 'Give your blog a title of at least four characters.', 'error');
    if (body.length < 40) return setStatus(status, 'Add at least 40 characters so your blog has enough context.', 'error');
    const files = [...($('#blogMedia')?.files || [])];
    const issue = validateFiles(files);
    if (issue) return setStatus(status, issue, 'error');
    const data = new FormData();
    ['title', 'excerpt', 'body', 'tags', 'visibility'].forEach(name => data.set(name, String(form.elements[name]?.value || '')));
    files.forEach(file => data.append('media', file));
    button.disabled = true;
    button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Publishing';
    setStatus(status, '');
    try {
      const result = await api('/api/blog/posts', {method: 'POST', body: data});
      form.reset();
      clearPreview();
      $('#blogBodyCount').textContent = '0 / 20,000';
      setStatus(status, result.message || 'Your blog is published.');
      await loadFeed();
      $('#blog-posts')?.scrollIntoView({behavior: 'smooth', block: 'start'});
    } catch (error) {
      if (error.status === 401) location.href = 'login.html?next=blog.html';
      else setStatus(status, error.message, 'error');
    } finally {
      button.disabled = false;
      button.innerHTML = '<i class="bx bx-send"></i> Publish blog';
    }
  }

  async function toggleLike(button) {
    if (!state.user) return location.href = 'login.html?next=blog.html';
    const blogId = button.dataset.blogLike;
    button.disabled = true;
    try {
      await api(`/api/blog/posts/${encodeURIComponent(blogId)}/like`, {method: button.classList.contains('active') ? 'DELETE' : 'POST'});
      await loadFeed();
    } catch (error) {
      if (error.status === 401) location.href = 'login.html?next=blog.html';
      else setStatus($('#blogComposerStatus'), error.message, 'error');
    } finally { button.disabled = false; }
  }

  async function loadComments(blogId) {
    const host = $(`[data-comments-list="${CSS.escape(blogId)}"]`);
    if (!host) return;
    host.innerHTML = '<div class="blog-loading"><i class="bx bx-loader-alt bx-spin"></i> Loading comments…</div>';
    try {
      const result = await api(`/api/blog/posts/${encodeURIComponent(blogId)}/comments`);
      host.innerHTML = result.comments?.length ? result.comments.map(commentMarkup).join('') : '<div class="blog-loading">No comments yet. Start the conversation.</div>';
    } catch (error) { host.innerHTML = `<div class="blog-loading">${escapeHtml(error.message)}</div>`; }
  }

  async function submitComment(event) {
    event.preventDefault();
    if (!state.user) return location.href = 'login.html?next=blog.html';
    const form = event.currentTarget;
    const blogId = form.dataset.blogCommentForm;
    const input = form.elements.namedItem('body');
    const body = String(input?.value || '').trim();
    if (!body) return;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const result = await api(`/api/blog/posts/${encodeURIComponent(blogId)}/comments`, {method: 'POST', body: {body}});
      if (result.moderation?.status === 'pending') { input.value = ''; setStatus($('#blogComposerStatus'), result.message || 'Your comment is pending administrator review and is hidden from the platform.'); return; }
      input.value = '';
      await loadFeed();
      const section = $(`[data-comments-for="${CSS.escape(blogId)}"]`);
      if (section) { section.classList.add('open'); await loadComments(blogId); }
    } catch (error) {
      if (error.status === 401) location.href = 'login.html?next=blog.html';
      else setStatus($('#blogComposerStatus'), error.message, 'error');
    } finally { button.disabled = false; }
  }

  document.addEventListener('click', event => {
    const like = event.target.closest('[data-blog-like]');
    const comments = event.target.closest('[data-blog-comments]');
    if (like) return toggleLike(like);
    if (comments) {
      const section = $(`[data-comments-for="${CSS.escape(comments.dataset.blogComments)}"]`);
      if (!section) return;
      const open = section.classList.toggle('open');
      if (open) loadComments(comments.dataset.blogComments);
    }
  });

  document.addEventListener('submit', event => {
    const form = event.target.closest('[data-blog-comment-form]');
    if (form) submitComment(event);
  });
  $('#blogComposerForm')?.addEventListener('submit', submitBlog);
  $('#blogMedia')?.addEventListener('change', event => previewFiles(event.currentTarget));
  $('#blogBody')?.addEventListener('input', event => { $('#blogBodyCount').textContent = `${event.currentTarget.value.length.toLocaleString()} / 20,000`; });
  $$('.blog-sort [data-blog-sort]').forEach(button => button.addEventListener('click', async () => {
    state.sort = button.dataset.blogSort || 'latest';
    $$('.blog-sort [data-blog-sort]').forEach(item => item.classList.toggle('active', item === button));
    try { await loadFeed(); } catch (error) { setStatus($('#blogComposerStatus'), error.message, 'error'); }
  }));
  window.addEventListener('SwapLabs:blog-seeded', () => loadFeed().catch(() => {}));

  loadFeed().catch(error => {
    const host = $('#blogPostList');
    if (host) host.innerHTML = `<div class="blog-empty-state"><i class="bx bx-wifi-off"></i><h3>The blog community is reconnecting.</h3><p>${escapeHtml(error.message)}</p></div>`;
  });
})();
