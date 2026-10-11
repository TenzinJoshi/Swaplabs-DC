(() => {
  'use strict';

  const root = document.getElementById('communityFeed');
  if (!root) return;

  const state = {
    csrf: '',
    user: null,
    posts: [],
    stories: [],
    discover: [],
    sort: 'latest',
    previewUrls: []
  };

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  const {escapeHtml, initials, displayName, profileColor, safeAvatarUrl} = window.RelayComponents;
  const mediaUrl = value => /^\/community-media\/(?:post|story)_[A-Za-z0-9_-]+\.(?:jpg|png|webp|mp4|webm)$/.test(String(value || '')) ? String(value) : '';
  const safeAvatar = safeAvatarUrl;
  const avatar = (person, className = 'community-avatar') => {
    const source = safeAvatar(person);
    const name = displayName(person);
    return `<span class="${className} ${profileColor(person)}">${source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(name)} profile photo">` : escapeHtml(initials(name))}</span>`;
  };
  const list = value => Array.isArray(value) ? value : String(value || '').split(',').map(item => item.trim()).filter(Boolean);

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

  function goToLogin() {
    location.href = `login.html?next=${encodeURIComponent('community.html')}`;
  }

  function toast(message, type = 'success') {
    let element = document.querySelector('.platform-toast.community-toast');
    if (!element) {
      element = document.createElement('div');
      element.className = 'platform-toast community-toast';
      document.body.appendChild(element);
    }
    element.className = `platform-toast community-toast ${type}`;
    const actionLink = window.SwapLabsNotice?.actionLink(message, type) || '';
    element.classList.toggle('has-action-link', Boolean(actionLink));
    element.innerHTML = `<i class="bx ${type === 'error' ? 'bx-error-circle' : 'bx-check-circle'}"></i><div class="toast-copy"><span>${escapeHtml(message)}</span>${actionLink}</div>`;
    requestAnimationFrame(() => element.classList.add('show'));
    clearTimeout(element.hideTimer);
    element.hideTimer = setTimeout(() => element.classList.remove('show'), 4200);
  }

  function relativeTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'recently';
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
    return new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'}).format(date);
  }

  function mediaMarkup(media, className = 'community-post-media') {
    const source = mediaUrl(media?.url || media);
    if (!source) return '';
    const type = String(media?.type || media?.content_type || '').toLowerCase();
    if (type.startsWith('video') || /\.(mp4|webm)$/.test(source)) {
      return `<video class="${className}" controls preload="metadata" src="${escapeHtml(source)}"></video>`;
    }
    return `<img class="${className}" loading="lazy" src="${escapeHtml(source)}" alt="Community post media">`;
  }

  function memberMini(person, compact = false) {
    const name = displayName(person);
    return `<div class="community-member-mini">${avatar(person)}<div><strong>${escapeHtml(name)}</strong><span>${person?.username ? `@${escapeHtml(person.username)}` : (compact ? 'SwapLabs member' : 'Member')}</span></div></div>`;
  }

  function renderProfile() {
    const host = $('#communityFeedProfile');
    if (!host) return;
    const composerIdentity = $('#communityComposerIdentity');
    if (composerIdentity) composerIdentity.innerHTML = state.user ? memberMini(state.user) : '';
    if (!state.user) {
      host.innerHTML = `<div class="community-member-mini">${avatar({display_name: 'SwapLabs'})}<div><strong>Join the conversation</strong><span>Meet people who keep learning.</span></div></div><p>Log in to share, follow members, and join the community.</p><a class="btn btn-primary btn-sm" href="login.html?next=community.html"><i class="bx bx-log-in"></i> Log in</a>`;
      return;
    }
    const profile = state.user.profile || {};
    host.innerHTML = `${memberMini(state.user)}<p>${escapeHtml(profile.headline || profile.learning_goal || 'Ready to learn, teach, and connect.')}</p><div class="community-feed-profile-stats"><span><strong>${Number(state.user.time_credits || 0)}</strong> credits</span><span><strong>${escapeHtml(profile.primary_language || '—')}</strong> language</span></div><a class="btn btn-sm" href="profile.html"><i class="bx bx-edit-alt"></i> View my profile</a>`;
  }

  function renderDiscover() {
    const host = $('#communityFeedConnections');
    if (!host) return;
    const people = state.discover.filter(person => person.id !== state.user?.id).slice(0, 5);
    if (!people.length) {
      host.innerHTML = '<p class="muted">You’re among the first members here. More people will appear as they join.</p>';
      return;
    }
    host.innerHTML = `<div class="community-discovery-list">${people.map(person => {
      const following = ['following', 'requested'].includes(person.relationship);
      return `<div class="community-discovery-item">${memberMini(person, true)}<button class="btn ${following ? '' : 'btn-primary'}" type="button" data-feed-follow="${escapeHtml(person.id)}" data-following="${following ? 'true' : 'false'}">${following ? (person.relationship === 'requested' ? 'Sent' : 'Following') : 'Follow'}</button></div>`;
    }).join('')}</div>`;
  }

  function renderStories() {
    const host = $('#communityStoriesList');
    if (!host) return;
    const add = state.user ? `<button class="community-story-orb community-story-add" type="button" data-story-create><span class="community-story-avatar ${profileColor(state.user)}"><i class="bx bx-plus"></i></span><span>Your story</span></button>` : '';
    const items = state.stories.map(story => `<button class="community-story-orb" type="button" data-story-view="${escapeHtml(story.id)}"><span class="community-story-avatar ${profileColor(story.author)}">${story.media?.url ? mediaMarkup({...story.media, type: story.media.type}, 'community-story-thumb') : `<span>${escapeHtml(initials(displayName(story.author)))}</span>`}</span><span>${escapeHtml(displayName(story.author))}</span><small class="community-story-time">${relativeTime(story.created_at)}</small></button>`).join('');
    host.innerHTML = `${add}${items || (!add ? '<div class="community-feed-loading">Stories from members will appear here.</div>' : '')}`;
  }

  function commentMarkup(comment) {
    return `<div class="community-comment">${avatar(comment.author, 'community-avatar') }<div class="community-comment-bubble"><strong>${escapeHtml(displayName(comment.author))}</strong><span>${escapeHtml(comment.body)}</span><small>${relativeTime(comment.created_at)}</small></div></div>`;
  }

  function postMarkup(post) {
    const liked = Boolean(post.viewer_liked);
    const shared = Boolean(post.viewer_shared);
    const count = Number(post.counts?.likes || 0);
    const commentCount = Number(post.counts?.comments || 0);
    const shareCount = Number(post.counts?.shares || 0);
    const visibility = post.visibility === 'followers' ? 'Followers' : 'Public';
    return `<article class="community-post-card" id="post-${escapeHtml(post.id)}" data-post-id="${escapeHtml(post.id)}"><div class="community-post-card-head">${memberMini(post.author)}<span class="community-post-visibility"><i class="bx ${post.visibility === 'followers' ? 'bx-lock-alt' : 'bx-world'}"></i> ${visibility} · ${relativeTime(post.created_at)}</span></div>${post.body ? `<div class="community-post-body">${escapeHtml(post.body)}</div>` : ''}${mediaMarkup(post.media)}<div class="community-post-stats"><span>${count ? `${count} like${count === 1 ? '' : 's'}` : 'Be the first to like this'}</span><span>${commentCount} comment${commentCount === 1 ? '' : 's'} · ${shareCount} share${shareCount === 1 ? '' : 's'}</span></div><div class="community-post-actions"><button class="${liked ? 'active' : ''}" type="button" data-post-like="${escapeHtml(post.id)}" aria-pressed="${liked}"><i class="bx ${liked ? 'bxs-heart' : 'bx-heart'}"></i><span>Like</span></button><button type="button" data-post-comments="${escapeHtml(post.id)}"><i class="bx bx-message-rounded"></i><span>Comment</span></button><button class="${shared ? 'active' : ''}" type="button" data-post-share="${escapeHtml(post.id)}"><i class="bx bx-share-alt"></i><span>${shared ? 'Shared' : 'Share'}</span></button></div><section class="community-comments" data-comments-for="${escapeHtml(post.id)}"><div class="community-comments-list" data-comments-list="${escapeHtml(post.id)}"><div class="community-feed-loading">Open comments to join the conversation.</div></div>${state.user ? `<form class="community-comment-form" data-comment-form="${escapeHtml(post.id)}"><input name="body" maxlength="800" placeholder="Add a thoughtful comment…" autocomplete="off"><button type="submit" aria-label="Post comment"><i class="bx bx-send"></i></button></form>` : '<a class="community-comment-form" href="login.html?next=community.html"><input disabled placeholder="Log in to comment"><button type="button" aria-label="Log in"><i class="bx bx-log-in"></i></button></a>'}</section></article>`;
  }

  function renderPosts() {
    const host = $('#communityPostList');
    const empty = $('#communityPostEmpty');
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
    const result = await api(`/api/community/feed?sort=${encodeURIComponent(state.sort)}`);
    state.user = result.viewer || null;
    state.posts = Array.isArray(result.posts) ? result.posts : [];
    state.stories = Array.isArray(result.stories) ? result.stories : [];
    state.discover = Array.isArray(result.discover) ? result.discover : [];
    renderProfile();
    renderDiscover();
    renderStories();
    renderPosts();
    const form = $('#communityPostForm');
    const locked = $('#communityComposerLocked');
    if (form) form.hidden = !state.user;
    if (locked) locked.hidden = Boolean(state.user);
  }

  function setStatus(element, message, type = '') {
    if (!element) return;
    element.textContent = message || '';
    element.classList.toggle('error', type === 'error');
  }

  function validateFile(file, kind) {
    if (!file) return '';
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];
    if (!allowed.includes(String(file.type || '').toLowerCase())) return 'Choose a JPG, PNG, WebP, MP4, or WebM file.';
    const max = String(file.type || '').startsWith('video/') ? (kind === 'story' ? 25_000_000 : 40_000_000) : 8_000_000;
    if (Number(file.size || 0) > max) return `That file is too large. ${String(file.type || '').startsWith('video/') ? 'Videos' : 'Images'} must be ${Math.round(max / 1_000_000)} MB or smaller.`;
    return '';
  }

  function previewFile(input, target, kind) {
    if (!input || !target) return;
    const file = input.files?.[0];
    if (!file) {
      target.hidden = true;
      target.innerHTML = '';
      return;
    }
    const issue = validateFile(file, kind);
    if (issue) {
      input.value = '';
      target.hidden = true;
      target.innerHTML = '';
      toast(issue, 'error');
      return;
    }
    const url = URL.createObjectURL(file);
    state.previewUrls.push(url);
    target.hidden = false;
    target.innerHTML = String(file.type).startsWith('video/') ? `<video controls muted src="${escapeHtml(url)}"></video>` : `<img src="${escapeHtml(url)}" alt="Selected media preview">`;
  }

  function openStoryComposer() {
    if (!state.user) return goToLogin();
    const dialog = $('#communityStoryDialog');
    if (!dialog) return;
    $('#communityStoryForm')?.reset();
    $('#communityStoryPreview').hidden = true;
    $('#communityStoryPreview').innerHTML = '';
    setStatus($('#communityStoryStatus'), '');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeStoryComposer() {
    const dialog = $('#communityStoryDialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function ensureStoryViewer() {
    let viewer = $('#communityStoryViewer');
    if (viewer) return viewer;
    viewer = document.createElement('dialog');
    viewer.id = 'communityStoryViewer';
    viewer.className = 'community-story-viewer';
    viewer.innerHTML = '<button type="button" data-story-view-close aria-label="Close story"><i class="bx bx-x"></i></button><div data-story-view-content></div>';
    document.body.appendChild(viewer);
    viewer.addEventListener('click', event => {
      if (event.target === viewer || event.target.closest('[data-story-view-close]')) viewer.close();
    });
    return viewer;
  }

  function viewStory(storyId) {
    const story = state.stories.find(item => item.id === storyId);
    if (!story) return;
    const viewer = ensureStoryViewer();
    const content = $('[data-story-view-content]', viewer);
    content.innerHTML = `<div class="community-story-view-head">${memberMini(story.author)}<span>${relativeTime(story.created_at)}</span></div>${mediaMarkup(story.media, 'community-story-view-media')}${story.body ? `<p>${escapeHtml(story.body)}</p>` : ''}`;
    if (typeof viewer.showModal === 'function') viewer.showModal();
    else viewer.setAttribute('open', '');
  }

  async function submitPost(event) {
    event.preventDefault();
    if (!state.user) return goToLogin();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const status = $('#communityPostStatus');
    const file = $('#communityPostMedia')?.files?.[0];
    const body = String($('#communityPostBody')?.value || '').trim();
    if (!body && !file) return setStatus(status, 'Add a thought or choose a photo/video first.', 'error');
    const issue = validateFile(file, 'post');
    if (issue) return setStatus(status, issue, 'error');
    const data = new FormData();
    data.set('body', body);
    data.set('visibility', $('#communityPostVisibility')?.value || 'public');
    if (file) data.set('media', file);
    button.disabled = true;
    button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Posting';
    setStatus(status, '');
    try {
      const result = await api('/api/community/posts', {method: 'POST', body: data});
      form.reset();
      $('#communityPostPreview').hidden = true;
      $('#communityPostPreview').innerHTML = '';
      $('#communityPostCount').textContent = '0 / 2,000';
      toast(result.message || 'Your post is live.');
      await loadFeed();
    } catch (error) {
      if (error.status === 401) return goToLogin();
      setStatus(status, error.message, 'error');
    } finally {
      button.disabled = false;
      button.innerHTML = '<i class="bx bx-send"></i> Post';
    }
  }

  async function submitStory(event) {
    event.preventDefault();
    if (!state.user) return goToLogin();
    const form = event.currentTarget;
    const button = $('#communityStorySubmit');
    const status = $('#communityStoryStatus');
    const file = $('#communityStoryMedia')?.files?.[0];
    const body = String($('#communityStoryBody')?.value || '').trim();
    if (!body && !file) return setStatus(status, 'Add a short note or choose a photo/video first.', 'error');
    const issue = validateFile(file, 'story');
    if (issue) return setStatus(status, issue, 'error');
    const data = new FormData();
    data.set('body', body);
    data.set('visibility', $('#communityStoryVisibility')?.value || 'public');
    if (file) data.set('media', file);
    button.disabled = true;
    button.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Sharing';
    setStatus(status, '');
    try {
      const result = await api('/api/community/stories', {method: 'POST', body: data});
      closeStoryComposer();
      toast(result.message || 'Your story is live for 24 hours.');
      await loadFeed();
    } catch (error) {
      if (error.status === 401) return goToLogin();
      setStatus(status, error.message, 'error');
    } finally {
      button.disabled = false;
      button.innerHTML = '<i class="bx bx-send"></i> Share story';
    }
  }

  async function toggleLike(button) {
    if (!state.user) return goToLogin();
    const postId = button.dataset.postLike;
    button.disabled = true;
    try {
      await api(`/api/community/posts/${encodeURIComponent(postId)}/like`, {method: button.classList.contains('active') ? 'DELETE' : 'POST'});
      await loadFeed();
    } catch (error) {
      if (error.status === 401) goToLogin();
      else toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function sharePost(button) {
    if (!state.user) return goToLogin();
    const postId = button.dataset.postShare;
    button.disabled = true;
    try {
      const result = await api(`/api/community/posts/${encodeURIComponent(postId)}/share`, {method: 'POST'});
      const shareUrl = `${location.origin}${location.pathname}#post-${encodeURIComponent(postId)}`;
      if (navigator.share) {
        try { await navigator.share({title: 'A SwapLabs community post', url: shareUrl}); } catch (_error) { /* user closed share sheet */ }
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      }
      toast(result.message || (navigator.share ? 'Post shared.' : 'Post link copied.'));
      await loadFeed();
    } catch (error) {
      if (error.status === 401) goToLogin();
      else toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function loadComments(postId) {
    const host = $(`[data-comments-list="${CSS.escape(postId)}"]`);
    if (!host) return;
    host.innerHTML = '<div class="community-feed-loading"><i class="bx bx-loader-alt bx-spin"></i> Loading comments…</div>';
    try {
      const result = await api(`/api/community/posts/${encodeURIComponent(postId)}/comments`);
      host.innerHTML = result.comments?.length ? result.comments.map(commentMarkup).join('') : '<div class="community-feed-loading">No comments yet. Start the conversation.</div>';
    } catch (error) {
      host.innerHTML = `<div class="community-feed-loading">${escapeHtml(error.message)}</div>`;
    }
  }

  async function submitComment(event) {
    event.preventDefault();
    if (!state.user) return goToLogin();
    const form = event.currentTarget;
    const postId = form.dataset.commentForm;
    const input = form.elements.namedItem('body');
    const body = String(input?.value || '').trim();
    if (!body) return;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api(`/api/community/posts/${encodeURIComponent(postId)}/comments`, {method: 'POST', body: {body}});
      input.value = '';
      await loadFeed();
      const comments = $(`[data-comments-for="${CSS.escape(postId)}"]`);
      if (comments) {
        comments.classList.add('open');
        await loadComments(postId);
      }
    } catch (error) {
      if (error.status === 401) goToLogin();
      else toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function followPerson(button) {
    if (!state.user) return goToLogin();
    const id = button.dataset.feedFollow;
    const removing = button.dataset.following === 'true' && button.textContent.trim() === 'Following';
    button.disabled = true;
    try {
      const result = await api(`/api/community/users/${encodeURIComponent(id)}/follow`, {method: removing ? 'DELETE' : 'POST'});
      toast(result.message || 'Connection updated.');
      await loadFeed();
    } catch (error) {
      if (error.status === 401) goToLogin();
      else toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('click', event => {
    const like = event.target.closest('[data-post-like]');
    const share = event.target.closest('[data-post-share]');
    const comments = event.target.closest('[data-post-comments]');
    const storyCreate = event.target.closest('[data-story-create], #communityStoryOpen');
    const storyView = event.target.closest('[data-story-view]');
    const follow = event.target.closest('[data-feed-follow]');
    if (like) return toggleLike(like);
    if (share) return sharePost(share);
    if (comments) {
      const section = $(`[data-comments-for="${CSS.escape(comments.dataset.postComments)}"]`);
      if (!section) return;
      const open = section.classList.toggle('open');
      if (open) loadComments(comments.dataset.postComments);
      return;
    }
    if (storyCreate) return openStoryComposer();
    if (storyView) return viewStory(storyView.dataset.storyView);
    if (follow) return followPerson(follow);
  });

  $('#communityPostForm')?.addEventListener('submit', submitPost);
  $('#communityStoryForm')?.addEventListener('submit', submitStory);
  $('#communityStoryClose')?.addEventListener('click', closeStoryComposer);
  $('#communityStoryCancel')?.addEventListener('click', closeStoryComposer);
  $('#communityPostBody')?.addEventListener('input', event => {
    const count = $('#communityPostCount');
    if (count) count.textContent = `${event.currentTarget.value.length} / 2,000`;
  });
  $('#communityPostMedia')?.addEventListener('change', event => previewFile(event.currentTarget, $('#communityPostPreview'), 'post'));
  $('#communityStoryMedia')?.addEventListener('change', event => previewFile(event.currentTarget, $('#communityStoryPreview'), 'story'));
  document.addEventListener('submit', event => {
    const form = event.target.closest('[data-comment-form]');
    if (form) submitComment(event);
  });
  $$('.community-feed-sort [data-community-sort]').forEach(button => button.addEventListener('click', async () => {
    state.sort = button.dataset.communitySort || 'latest';
    $$('.community-feed-sort [data-community-sort]').forEach(item => item.classList.toggle('active', item === button));
    try { await loadFeed(); } catch (error) { toast(error.message, 'error'); }
  }));

  loadFeed().catch(error => {
    const host = $('#communityPostList');
    if (host) host.innerHTML = `<div class="community-feed-empty"><i class="bx bx-wifi-off"></i><h3>The community feed is taking a moment.</h3><p>${escapeHtml(error.message)}</p></div>`;
  });
})();
