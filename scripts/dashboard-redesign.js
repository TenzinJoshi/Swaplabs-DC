(() => {
  'use strict';

  const body = document.body;
  if (!body || !body.classList.contains('dashboard-redesign')) return;

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const number = value => Number(value || 0);
  const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function focusPlan(payload = {}) {
    const analytics = payload.analytics || {};
    const sessions = analytics.sessions || {};
    const profile = number(analytics.profile_completeness);
    const scheduled = number(sessions.scheduled);
    const completed = number(sessions.completed);
    const conversations = number(analytics.conversations);
    const reportsDue = number(analytics.sessions_needing_progress_report);

    if (reportsDue > 0) {
      return {
        title: 'Close the loop on your last exchange.',
        copy: 'A short progress report turns a finished session into evidence you can use later.',
        label: 'Write a progress report',
        href: 'learning-journal.html',
        status: `${reportsDue} reflection${reportsDue === 1 ? '' : 's'} ready`
      };
    }
    if (scheduled > 0) {
      return {
        title: 'Your next exchange already has momentum.',
        copy: 'Review the outcome you want from the next session, then arrive with one clear question.',
        label: 'Open your calendar',
        href: 'calendar.html',
        status: `${scheduled} session${scheduled === 1 ? '' : 's'} scheduled`
      };
    }
    if (completed > 0) {
      return {
        title: 'Turn your last session into the next chapter.',
        copy: 'Keep the rhythm going with another useful connection or a small reflection on what changed.',
        label: 'Find another match',
        href: 'skill-matching.html?intent=swap',
        status: `${completed} exchange${completed === 1 ? '' : 's'} completed`
      };
    }
    if (profile < 100) {
      return {
        title: 'Give your profile a sharper signal.',
        copy: 'A little more context helps SwapLabs find people whose goals and availability actually fit yours.',
        label: 'Complete your profile',
        href: 'profile.html',
        status: `${Math.max(0, Math.round(profile))}% profile ready`
      };
    }
    if (conversations > 0) {
      return {
        title: 'Turn a good conversation into a real exchange.',
        copy: 'Choose the person who feels like the strongest fit, agree on an outcome, and put a time on the calendar.',
        label: 'Open your matches',
        href: 'skill-matching.html?intent=swap',
        status: `${conversations} conversation${conversations === 1 ? '' : 's'} in motion`
      };
    }
    return {
      title: 'Make today’s next step obvious.',
      copy: 'One focused action is enough to keep your learning moving. Choose a person, a session, or a small reflection.',
      label: 'Find a match',
      href: 'skill-matching.html?intent=swap',
      status: 'Ready when you are'
    };
  }

  function renderFocus(payload) {
    const plan = focusPlan(payload);
    const title = $('#dashboardFocusTitle');
    const copy = $('[data-dashboard-focus-copy]');
    const label = $('[data-dashboard-focus-label]');
    const link = $('[data-dashboard-focus-link]');
    const status = $('[data-dashboard-focus-status]');
    if (title) title.textContent = plan.title;
    if (copy) copy.textContent = plan.copy;
    if (label) label.textContent = plan.label;
    if (link) link.href = plan.href;
    if (status) status.textContent = plan.status;
  }

  function revealInView() {
    const nodes = $$('.dashboard-reveal');
    if (!nodes.length) return;
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
      nodes.forEach(node => node.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, {rootMargin: '0px 0px -8% 0px', threshold: .08});
    nodes.forEach((node, index) => {
      node.style.setProperty('--reveal-delay', `${Math.min(index * 35, 280)}ms`);
      observer.observe(node);
    });
  }

  function tiltCards() {
    if (prefersReducedMotion() || !window.matchMedia?.('(pointer: fine)').matches) return;
    $$('.dashboard-redesign [data-dashboard-tilt]').forEach(card => {
      card.addEventListener('pointermove', event => {
        const rect = card.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - .5;
        const y = (event.clientY - rect.top) / rect.height - .5;
        card.style.setProperty('--tilt-y', `${(x * 4).toFixed(2)}deg`);
        card.style.setProperty('--tilt-x', `${(-y * 4).toFixed(2)}deg`);
      });
      card.addEventListener('pointerleave', () => {
        card.style.setProperty('--tilt-y', '0deg');
        card.style.setProperty('--tilt-x', '0deg');
      });
    });
  }

  function scrollPulse() {
    let frame = 0;
    let clearTimer = 0;
    const update = () => {
      frame = 0;
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const progress = Math.max(0, Math.min(1, window.scrollY / max));
      body.style.setProperty('--dashboard-scroll', progress.toFixed(3));
      body.classList.add('is-scrolling');
      window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => body.classList.remove('is-scrolling'), 180);
    };
    window.addEventListener('scroll', () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    }, {passive: true});
    update();
  }

  async function loadFocusFallback() {
    try {
      const response = await fetch('/api/dashboard', {credentials: 'same-origin', cache: 'no-store'});
      if (response.ok) renderFocus(await response.json());
    } catch (_error) {
      // The static copy is intentionally useful when the dashboard is locked.
    }
  }

  function init() {
    body.classList.add('dashboard-ready');
    scrollPulse();
    tiltCards();
    revealInView();
    window.addEventListener('relayskills:dashboard-ready', event => renderFocus(event.detail?.payload || {}), {once: true});
    window.setTimeout(() => {
      revealInView();
      loadFocusFallback();
    }, 450);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, {once: true});
  } else {
    init();
  }
})();
