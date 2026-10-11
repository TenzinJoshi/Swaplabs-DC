(() => {
  'use strict';
  const card = document.querySelector('[data-dashboard-study]');
  if (!card) return;
  const $ = selector => card.querySelector(selector);
  const formatDate = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Time to be confirmed' : new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}).format(date);
  };
  (async () => {
    try {
      const auth = await (window.SwapLabsAuth?.get?.() || fetch('/api/auth/me', {credentials: 'same-origin', cache: 'no-store'}).then(response => response.json()));
      if (!auth?.authenticated) { card.hidden = true; return; }
      const response = await fetch('/api/study', {credentials: 'same-origin', cache: 'no-store'});
      if (!response.ok) throw new Error('Study Together unavailable');
      const payload = await response.json();
      const next = payload.upcoming_sessions?.[0];
      const title = $('[data-dashboard-study-next-title]');
      const meta = $('[data-dashboard-study-next-meta]');
      const copy = $('[data-dashboard-study-copy]');
      if (next) {
        const partner = (next.participants || []).find(person => person.id !== auth.user?.id);
        if (title) title.textContent = partner?.display_name ? `Study with ${partner.display_name}` : next.room?.title || 'Upcoming study session';
        if (meta) meta.textContent = `${formatDate(next.starts_at)} · ${Number(next.duration_minutes || 50)} minutes`;
        if (copy) copy.textContent = 'Your next shared commitment is ready. Open the room when it is time.';
      } else if (!payload.onboarding_complete) {
        if (title) title.textContent = 'Set your study rhythm first.';
        if (meta) meta.textContent = 'A few preferences are enough to start finding compatible people.';
        if (copy) copy.textContent = 'Study Together uses your goals, pace, style, and time windows to make the first session easier.';
      }
    } catch (_error) {
      // The rest of the dashboard should remain independent if this preview is unavailable.
    }
  })();
})();
