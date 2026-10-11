/*
 * SwapLabs UI primitives.
 *
 * The site intentionally stays framework-free: its HTML routes, styles, and
 * Worker build are already production surfaces. This small component layer
 * gives every page the same safe rendering primitives without adding a React
 * runtime or changing the rendered markup contracts.
 */
(() => {
  'use strict';
  if (window.RelayComponents) return;

  // Load the final dark-mode contrast layer after every page-specific
  // stylesheet. The shared component script is present on every production
  // route, so legacy and newer pages get the same readable dark theme.
  const darkModeContrast = document.createElement('link');
  darkModeContrast.rel = 'stylesheet';
  darkModeContrast.dataset.relayDarkModeContrast = 'true';
  darkModeContrast.href = window.location.origin + '/styles/dark-mode-contrast.css?v=20261010-gradient-text1';
  document.head.appendChild(darkModeContrast);

  // Local build: no analytics scripts or third-party requests are loaded.

  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[character]));

  const displayName = person => {
    if (typeof person === 'string') return person || 'SwapLabs member';
    return person?.display_name || person?.profile?.display_name || person?.username || 'SwapLabs member';
  };

  const initials = person => {
    const value = typeof person === 'string'
      ? person
      : person?.display_name || person?.profile?.display_name || person?.username || '';
    return String(value || 'SL')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase() || 'SL';
  };

  const profileColor = person => {
    const value = person?.profile_color || person?.profile?.profile_color;
    return ['indigo', 'blue', 'pink', 'purple', 'green', 'orange'].includes(value) ? value : 'indigo';
  };

  const safeAvatarUrl = person => {
    const value = String(person?.avatar_url || person?.profile?.avatar_url || '');
    return /^(?:(?:\/uploads|\/profile-media)\/usr_[A-Za-z0-9_-]+\.(?:jpg|png|webp)|data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2})$/.test(value) ? value : '';
  };

  const list = value => (Array.isArray(value) ? value : String(value || '').split(','))
    .map(item => String(item).trim())
    .filter(item => item && item.toLowerCase() !== 'nothing for now');

  const render = (target, markup) => {
    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!element) return null;
    element.innerHTML = typeof markup === 'function' ? markup(element) : String(markup ?? '');
    return element;
  };

  const avatar = (person, className = 'avatar', options = {}) => {
    const name = displayName(person);
    const source = safeAvatarUrl(person);
    const alt = options.alt === false ? '' : `${name} profile photo`;
    const content = source
      ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}">`
      : escapeHtml(initials(person));
    return `<span class="${escapeHtml(className)} ${escapeHtml(profileColor(person))}">${content}</span>`;
  };

  window.RelayComponents = Object.freeze({
    escapeHtml,
    displayName,
    initials,
    profileColor,
    safeAvatarUrl,
    list,
    render,
    avatar
  });

  /*
   * Shared scroll behavior.
   *
   * Every public route gets the same anchor offset, reveal observer, and
   * reduced-motion handling here. Keeping it in the shared component avoids
   * subtly different scroll implementations in individual page scripts.
   */
  const initializeScrollSystem = () => {
    if (!document.body || document.documentElement.dataset.scrollSystemReady === 'true') return;
    const root = document.documentElement;
    const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const isReduced = () => Boolean(motionPreference?.matches) || root.classList.contains('pref-reduced-motion') || (() => {
      try { return window.localStorage.getItem('relayskills-reduce-motion') === 'true'; } catch (_error) { return false; }
    })();
    const syncMotionClass = () => root.classList.toggle('relayskills-reduced-motion', isReduced());
    const show = node => node?.classList.add('is-visible');
    const revealSelector = '[data-reveal], [data-scroll-reveal], .scroll-reveal';
    let revealObserver = null;

    root.dataset.scrollSystemReady = 'true';
    syncMotionClass();

    const observeReveals = scope => {
      const nodes = [];
      if (scope?.matches?.(revealSelector)) nodes.push(scope);
      if (scope?.querySelectorAll) nodes.push(...scope.querySelectorAll(revealSelector));
      if (!revealObserver || isReduced()) nodes.forEach(show);
      else nodes.forEach(node => revealObserver.observe(node));
    };

    if ('IntersectionObserver' in window && !isReduced()) {
      revealObserver = new IntersectionObserver(entries => entries.forEach(entry => {
        if (entry.isIntersecting) {
          show(entry.target);
          revealObserver.unobserve(entry.target);
        }
      }), {threshold: 0.12, rootMargin: '0px 0px -9%'});
    }
    observeReveals(document.body);

    new MutationObserver(mutations => mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) observeReveals(node);
    }))).observe(document.body, {childList: true, subtree: true});

    const headerOffset = () => {
      const header = document.querySelector('.site-header, .static-site-header, [data-site-header]');
      if (!header) return 16;
      const height = header.getBoundingClientRect().height;
      return Math.min(Math.max(16, height + 12), Math.round(window.innerHeight * 0.42));
    };

    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[href]');
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const href = link.getAttribute('href') || '';
      if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      let targetUrl;
      try { targetUrl = new URL(href, location.href); } catch (_error) { return; }
      const samePath = targetUrl.origin === location.origin &&
        (targetUrl.pathname === location.pathname ||
          (targetUrl.pathname === '/index.html' && location.pathname === '/') ||
          (targetUrl.pathname === '/' && location.pathname === '/index.html'));
      if (!samePath || !targetUrl.hash) return;
      const target = document.getElementById(decodeURIComponent(targetUrl.hash.slice(1)));
      if (!target) return;
      event.preventDefault();
      history.pushState(null, '', `${location.pathname}${targetUrl.search}${targetUrl.hash}`);
      const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - headerOffset());
      window.scrollTo({top, behavior: isReduced() ? 'auto' : 'smooth'});
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      try { target.focus({preventScroll: true}); } catch (_error) { target.focus(); }
    });

    const refreshMotion = () => {
      syncMotionClass();
      if (isReduced()) document.querySelectorAll(revealSelector).forEach(show);
    };
    motionPreference?.addEventListener?.('change', refreshMotion);
    window.addEventListener('storage', event => {
      if (event.key === 'relayskills-reduce-motion') refreshMotion();
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeScrollSystem, {once: true});
  else initializeScrollSystem();
})();
