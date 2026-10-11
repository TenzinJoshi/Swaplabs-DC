(() => {
  'use strict';

  const root = document.querySelector('[data-journey-insights]');
  if (!root) return;

  const $ = (selector, scope = root) => scope.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const plural = (value, one, many = `${one}s`) => `${value} ${value === 1 ? one : many}`;
  const formatMinutes = value => value >= 60 ? `${Math.floor(value / 60)}h${value % 60 ? ` ${value % 60}m` : ''}` : `${value}m`;
  const formatDate = value => {
    const date = new Date(value || 0);
    return Number.isNaN(date.getTime()) ? 'Recently' : new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'}).format(date);
  };
  let payload = null;
  let period = 12;

  function set(name, value) {
    const node = $(`[data-insight="${name}"]`);
    if (node) node.textContent = value;
  }

  function renderChart(weeks) {
    const host = $('[data-insight-chart]');
    if (!host) return;
    host.style.setProperty('--columns', String(Math.max(1, weeks.length)));
    const highestMinutes = Math.max(1, ...weeks.map(week => Number(week.minutes || 0)));
    const highestSessions = Math.max(1, ...weeks.map(week => Number(week.sessions || 0)));
    host.innerHTML = weeks.map(week => {
      const minutes = Number(week.minutes || 0);
      const sessions = Number(week.sessions || 0);
      const bar = Math.max(minutes ? 9 : 2, Math.round((minutes / highestMinutes) * 100));
      const session = Math.max(sessions ? 8 : 3, Math.round((sessions / highestSessions) * 100));
      return `<div class="journey-activity-column" title="${escape(week.label)}: ${minutes} minutes, ${plural(sessions, 'session')}"><span class="journey-minute-bar" style="height:${bar}%"></span><span class="journey-session-dot" style="bottom:${session}%"></span><b>${escape(week.label)}</b></div>`;
    }).join('');
  }

  function renderSkills(skills) {
    const host = $('[data-insight-skills]');
    if (!host) return;
    if (!skills.length) {
      host.innerHTML = '<div class="journey-empty"><i class="bx bx-book-open"></i><span>Your practised skills will appear after your first saved reflection.</span></div>';
      return;
    }
    const longest = Math.max(1, ...skills.map(skill => Number(skill.minutes || 0)));
    host.innerHTML = skills.map(skill => `<article><div><strong>${escape(skill.name)}</strong><span>${formatMinutes(Number(skill.minutes || 0))} · ${plural(Number(skill.sessions || 0), 'reflection')}</span></div><i><b style="width:${Math.max(7, Math.round((Number(skill.minutes || 0) / longest) * 100))}%"></b></i><small>${formatDate(skill.last_practiced_at)}</small></article>`).join('');
  }

  function renderTimeline(timeline) {
    const host = $('[data-insight-timeline]');
    if (!host) return;
    if (!timeline.length) {
      host.innerHTML = '<div class="journey-empty"><i class="bx bx-compass"></i><span>When you complete an exchange or save a reflection, the evidence will live here.</span></div>';
      return;
    }
    host.innerHTML = timeline.map(item => `<article><i class="bx ${escape(item.icon || 'bx-check-circle')}"></i><div><strong>${escape(item.title)}</strong><span>${escape(item.detail)}</span></div><time datetime="${escape(item.at)}">${formatDate(item.at)}</time></article>`).join('');
  }

  function render(nextPayload) {
    payload = nextPayload || payload || {};
    const data = payload.journey_analytics || {};
    const outcomes = data.outcomes || {};
    const credits = data.credits || {};
    const allWeeks = Array.isArray(data.weeks) ? data.weeks : [];
    const weeks = allWeeks.slice(-period);
    const minutes = weeks.reduce((total, week) => total + Number(week.minutes || 0), 0);
    const sessions = weeks.reduce((total, week) => total + Number(week.sessions || 0), 0);
    const reflections = weeks.reduce((total, week) => total + Number(week.reflections || 0), 0);
    set('minutes', formatMinutes(minutes));
    set('minutes-copy', minutes ? `across ${plural(sessions, 'completed session')}` : 'from completed sessions');
    set('sessions', String(sessions));
    set('sessions-copy', sessions ? `${formatMinutes(minutes)} of learning saved` : 'completed sessions');
    set('reflection-rate', `${Number(outcomes.reflection_rate || 0)}%`);
    set('reflection-copy', reflections ? `${plural(reflections, 'reflection')} in this view` : 'reports after sessions');
    set('credits', String(Number(credits.balance || 0)));
    set('credits-copy', `${Number(credits.earned || 0)} earned · ${Number(credits.spent || 0)} spent`);
    set('completion-rate', `${Number(outcomes.completion_rate || 0)}%`);
    set('scheduled', String(Number(outcomes.scheduled || 0)));
    set('reports-due', String(Number(outcomes.reports_due || 0)));
    const ring = $('[data-insight-ring]');
    if (ring) ring.style.setProperty('--insight-ring', String(Number(outcomes.completion_rate || 0)));
    const activitySummary = $('[data-insight="activity-summary"]');
    if (activitySummary) activitySummary.textContent = sessions ? `${formatMinutes(minutes)} saved in ${period} weeks` : 'Your first session will start this chart.';
    renderChart(weeks);
    renderSkills(Array.isArray(data.skills) ? data.skills : []);
    renderTimeline(Array.isArray(data.timeline) ? data.timeline : []);
    root.dataset.ready = 'true';
  }

  root.addEventListener('click', event => {
    const button = event.target.closest('[data-journey-period]');
    if (!button) return;
    period = Number(button.dataset.journeyPeriod) || 12;
    root.querySelectorAll('[data-journey-period]').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
    render();
  });

  window.addEventListener('relayskills:dashboard-ready', event => render(event.detail?.payload || {}), {once: true});
  fetch('/api/dashboard', {credentials: 'same-origin', cache: 'no-store'}).then(response => response.ok ? response.json() : null).then(data => { if (data && !payload) render(data); }).catch(() => render({}));
})();
