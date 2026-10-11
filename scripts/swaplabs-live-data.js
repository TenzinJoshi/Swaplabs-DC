/* Public, recorded content only. No fabricated fallbacks or private activity. */
(() => {
  'use strict';
  const rawCurrent = location.pathname.split('/').pop() || 'index.html';
  const current = rawCurrent.includes('.') ? rawCurrent : `${rawCurrent}.html`;
  if (current === 'notifications.html') return;
  const hosts = [...document.querySelectorAll('[data-live-feed]')];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const emptyLabels = {groups:'groups',workshops:'upcoming workshops',ideas:'published ideas',members:'public profiles',skills:'publicly listed skills'};
  const cacheKey = 'swaplabs-public-content-v1';
  const cacheMaxAge = 24 * 60 * 60 * 1000;
  let pending = false;
  let lastPayload = null;
  const skillSearchInput = document.querySelector('[data-skill-search]');
  const skillSearchClear = document.querySelector('[data-skill-search-clear]');
  const skillSearchStatus = document.querySelector('[data-skill-search-status]');
  const skillSearchHost = document.querySelector('[data-live-feed="skills"]');
  const skillRotator = document.querySelector('[data-skill-rotator]');
  const skillRotatorStatus = document.querySelector('[data-skill-rotator-status]');
  const skillRotatorControls = document.querySelector('.home-skills-rotator-controls');
  const skillPrev = document.querySelector('[data-skill-prev]');
  const skillNext = document.querySelector('[data-skill-next]');
  const skillToggle = document.querySelector('[data-skill-toggle]');
  const skillDots = document.querySelector('[data-skill-dots]');
  const skillRotationMs = 5200;
  let skillPage = 0;
  let skillRotationTimer = null;
  let skillRotationPaused = false;
  let skillInteractionPaused = false;
  const getSkillPageSize = () => window.matchMedia?.('(max-width: 680px)').matches ? 3 : 6;
  const getSkillMatches = () => {
    if (!skillSearchInput || !skillSearchHost) return [];
    const query = String(skillSearchInput.value || '').trim().toLowerCase();
    return [...skillSearchHost.querySelectorAll('[data-skill-record]')]
      .filter(card => !query || String(card.dataset.skillSearchText || '').includes(query));
  };
  const stopSkillRotation = () => {
    if (skillRotationTimer) window.clearInterval(skillRotationTimer);
    skillRotationTimer = null;
  };
  const startSkillRotation = () => {
    stopSkillRotation();
    if (!skillRotator || skillRotationPaused || skillInteractionPaused || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const pageCount = Math.ceil(getSkillMatches().length / getSkillPageSize());
    if (pageCount < 2) return;
    skillRotationTimer = window.setInterval(() => {
      if (!document.hidden) {
        skillPage = (skillPage + 1) % pageCount;
        applySkillSearch();
      }
    }, skillRotationMs);
  };
  const updateSkillDots = (pageCount) => {
    if (!skillDots) return;
    skillDots.hidden = pageCount < 2;
    if (pageCount < 2) {
      skillDots.replaceChildren();
      return;
    }
    skillDots.innerHTML = Array.from({length: pageCount}, (_, index) => `<button class="home-skills-rotator-dot${index === skillPage ? ' is-active' : ''}" type="button" role="tab" aria-selected="${index === skillPage}" aria-label="Show skills ${index + 1}" data-skill-page="${index}"></button>`).join('');
    skillDots.querySelectorAll('[data-skill-page]').forEach(dot => dot.addEventListener('click', () => {
      skillPage = Number(dot.dataset.skillPage || 0);
      applySkillSearch();
    }));
  };
  const updateSkillToggle = () => {
    if (!skillToggle) return;
    skillToggle.setAttribute('aria-pressed', String(skillRotationPaused));
    const icon = skillToggle.querySelector('i');
    const label = skillToggle.querySelector('span');
    if (icon) icon.className = skillRotationPaused ? 'bx bx-play' : 'bx bx-pause';
    if (label) label.textContent = skillRotationPaused ? 'Resume rotation' : 'Pause rotation';
  };
  const applySkillSearch = (resetPage = false) => {
    if (!skillSearchInput || !skillSearchHost) return;
    const query = String(skillSearchInput.value || '').trim().toLowerCase();
    const cards = [...skillSearchHost.querySelectorAll('[data-skill-record]')];
    const matchingCards = cards.filter(card => !query || String(card.dataset.skillSearchText || '').includes(query));
    const pageSize = getSkillPageSize();
    const pageCount = Math.max(1, Math.ceil(matchingCards.length / pageSize));
    if (resetPage) skillPage = 0;
    skillPage = Math.min(skillPage, pageCount - 1);
    const pageStart = skillPage * pageSize;
    const visibleCards = matchingCards.slice(pageStart, pageStart + pageSize);
    cards.forEach(card => {
      const isVisible = visibleCards.includes(card);
      card.hidden = !isVisible;
      card.classList.toggle('is-visible', isVisible);
    });
    if (skillSearchClear) skillSearchClear.hidden = !query;
    if (skillSearchStatus) {
      skillSearchStatus.textContent = query
        ? `${matchingCards.length} of ${cards.length} listed skill${cards.length === 1 ? '' : 's'} found`
        : cards.length ? `${cards.length} listed skill${cards.length === 1 ? '' : 's'}` : '';
    }
    if (skillRotatorStatus) {
      skillRotatorStatus.textContent = matchingCards.length
        ? `Showing ${pageStart + 1}–${Math.min(pageStart + pageSize, matchingCards.length)} of ${matchingCards.length} ${query ? 'matches' : 'skills'}`
        : query ? 'No matching skills' : '';
    }
    if (skillRotatorControls) skillRotatorControls.hidden = pageCount < 2;
    if (skillPrev) skillPrev.disabled = pageCount < 2;
    if (skillNext) skillNext.disabled = pageCount < 2;
    if (skillToggle) skillToggle.hidden = pageCount < 2;
    updateSkillDots(pageCount);
    let empty = skillSearchHost.querySelector('[data-skill-search-empty]');
    if (query && !matchingCards.length && cards.length) {
      if (!empty) {
        empty = document.createElement('p');
        empty.className = 'home-skills-search-empty';
        empty.dataset.skillSearchEmpty = '';
        skillSearchHost.append(empty);
      }
      empty.textContent = `No skills match “${skillSearchInput.value.trim()}”. Try a broader search.`;
      empty.hidden = false;
    } else if (empty) {
      empty.hidden = true;
    }
    updateSkillToggle();
    startSkillRotation();
  };
  skillSearchInput?.addEventListener('input', () => applySkillSearch(true));
  skillSearchClear?.addEventListener('click', () => {
    skillSearchInput.value = '';
    skillSearchInput.focus();
    applySkillSearch(true);
  });
  skillPrev?.addEventListener('click', () => {
    const pageCount = Math.ceil(getSkillMatches().length / getSkillPageSize());
    if (pageCount < 2) return;
    skillPage = (skillPage - 1 + pageCount) % pageCount;
    applySkillSearch();
  });
  skillNext?.addEventListener('click', () => {
    const pageCount = Math.ceil(getSkillMatches().length / getSkillPageSize());
    if (pageCount < 2) return;
    skillPage = (skillPage + 1) % pageCount;
    applySkillSearch();
  });
  skillToggle?.addEventListener('click', () => {
    skillRotationPaused = !skillRotationPaused;
    updateSkillToggle();
    startSkillRotation();
  });
  skillRotator?.addEventListener('mouseenter', () => {
    skillInteractionPaused = true;
    stopSkillRotation();
  });
  skillRotator?.addEventListener('mouseleave', () => {
    skillInteractionPaused = false;
    startSkillRotation();
  });
  skillRotator?.addEventListener('focusin', () => {
    skillInteractionPaused = true;
    stopSkillRotation();
  });
  skillRotator?.addEventListener('focusout', event => {
    if (skillRotator.contains(event.relatedTarget)) return;
    skillInteractionPaused = false;
    startSkillRotation();
  });
  window.addEventListener('resize', () => applySkillSearch());
  document.addEventListener('keydown', event => {
    const active = document.activeElement;
    const typing = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
    if (event.key === '/' && !typing && skillSearchInput) {
      event.preventDefault();
      skillSearchInput.focus();
    }
    if (event.key === 'Escape' && active === skillSearchInput && skillSearchInput.value) {
      skillSearchInput.value = '';
      applySkillSearch();
    }
  });
  const readSnapshot = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (!saved?.payload || Date.now() - Number(saved.saved_at || 0) > cacheMaxAge) return null;
      return saved.payload;
    } catch (_error) { return null; }
  };
  const writeSnapshot = payload => {
    try { localStorage.setItem(cacheKey, JSON.stringify({saved_at: Date.now(), payload})); }
    catch (_error) { /* An unavailable cache must never block the live request. */ }
  };
  const emptyMarkup = type => {
    if (type === 'skills') return `<article class="card live-empty"><span class="icon-box indigo"><i class="bx bx-bulb"></i></span><h3>No public skill listings yet</h3><p>Be the first to share something useful. Your profile can appear here after you publish the skills you teach.</p><div class="live-empty-actions"><a class="btn btn-primary" href="register.html?intent=swap&amp;return_to=index.html%23platformUpdates">Create a profile</a><a class="btn" href="index.html#platformUpdates">Join updates</a></div></article>`;
    const label = emptyLabels[type] || 'public records';
    return `<article class="card live-empty"><span class="icon-box indigo"><i class="bx bx-compass"></i></span><h3>No ${label} yet</h3><p>There is nothing published here yet. Join the community or check back when the next update is ready.</p><div class="live-empty-actions"><a class="btn btn-primary" href="register.html?intent=swap&amp;return_to=index.html%23platformUpdates">Create a profile</a><a class="btn" href="index.html#platformUpdates">Join updates</a></div></article>`;
  };
  const unavailableMarkup = type => {
    const label = emptyLabels[type] || 'public records';
    return `<article class="card live-empty"><span class="icon-box indigo"><i class="bx bx-refresh"></i></span><h3>No ${label} right now</h3><p>We’re reconnecting to the public directory. You can create a profile, join updates, or try again in a moment; no sample records are shown.</p><div class="live-empty-actions"><a class="btn btn-primary" href="register.html?intent=swap&amp;return_to=index.html%23platformUpdates">Create a profile</a><a class="btn" href="index.html#platformUpdates">Join updates</a><button class="btn" type="button" data-live-retry>Try again</button></div></article>`;
  };
  const render = payload => {
    if (!hosts.length || !payload) return;
    hosts.forEach(host => {
      const records = payload[host.dataset.liveFeed];
      if (!Array.isArray(records)) throw new Error('Missing records');
      const markup = records.length ? records.map(item => {
        const href = /^[a-z-]+\.html(?:\?id=[A-Za-z0-9_-]+)?$/.test(item.href) ? item.href : 'index.html';
        const skillSearchText = escape([item.title, item.detail, item.description].filter(Boolean).join(' '));
        const skillAttrs = host.dataset.liveFeed === 'skills' ? ` data-skill-record data-skill-search-text="${skillSearchText}"` : '';
        return `<article class="card live-record"${skillAttrs}><span class="tag">${escape(item.detail)}</span><h3>${escape(item.title)}</h3><p>${escape(item.description)}</p><a class="btn btn-sm" href="${escape(href)}">View details</a></article>`;
      }).join('') : emptyMarkup(host.dataset.liveFeed);
      // Avoid replacing focused links on every polling cycle.
      if (host.dataset.rendered !== markup) { host.innerHTML = markup; host.dataset.rendered = markup; }
    });
    applySkillSearch();
  };
  async function refresh() {
    if (!hosts.length || pending) return;
    pending = true;
    try {
      const response = await fetch('/api/public/content', {credentials:'same-origin',cache:'no-store'});
      if (!response.ok) throw new Error('Content unavailable');
      const payload = await response.json();
      if (!payload.ok) throw new Error('Invalid content');
      render(payload);
      lastPayload = payload;
      writeSnapshot(payload);
    } catch (_error) {
      // Keep a previously recorded response visible during a transient tunnel
      // hiccup.  The next poll will revalidate it without flashing an error.
      if (lastPayload) return;
      hosts.forEach(host => {
        host.innerHTML = unavailableMarkup(host.dataset.liveFeed);
        delete host.dataset.rendered;
        host.querySelector('[data-live-retry]').addEventListener('click', refresh);
      });
    } finally { pending = false; }
  }
  const cached = readSnapshot();
  if (cached) { lastPayload = cached; render(cached); }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  document.getElementById('honestPractice')?.addEventListener('submit', event => {
    event.preventDefault();
    const answer = new FormData(event.currentTarget).get('answer');
    document.getElementById('practiceResult').textContent = answer === 'mapping'
      ? 'Correct. A dictionary maps keys to values. This checks this answer only, not your overall Python level.'
      : 'Not quite. A dictionary is a collection of key-value pairs. Try again; this practice does not assign a proficiency level.';
  });
})();
