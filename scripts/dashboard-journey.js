(() => {
  'use strict';

  const root = document.querySelector('[data-dashboard-journey]');
  if (!root) return;

  const $ = (selector, scope = root) => scope.querySelector(selector);
  const $$ = selector => [...root.querySelectorAll(selector)];
  const clamp = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const number = value => Number(value || 0).toLocaleString();

  function journeySignals(payload = {}) {
    const analytics = payload.analytics || {};
    const summary = payload.summary || {};
    const sessions = analytics.sessions || {};
    const profile = clamp(analytics.profile_completeness);
    const conversations = Number(analytics.conversations || 0);
    const messages = Number(analytics.messages_sent || 0);
    const scheduled = Number(sessions.scheduled || 0);
    const completed = Number(sessions.completed || 0);
    const reflections = Number(analytics.progress_reports || 0);
    const pendingReports = Number(analytics.sessions_needing_progress_report || 0);
    const learningGoal = String(payload.learning_goal?.title || '').trim();
    const hasGoal = Boolean(learningGoal && !/^add your first/i.test(learningGoal));

    // Each value is derived from a saved account signal. Partial values make
    // the dashboard useful before a member has completed a full exchange.
    const stages = {
      discover: profile,
      connect: conversations || messages ? 100 : hasGoal ? 35 : 0,
      schedule: completed ? 100 : scheduled ? 65 : conversations ? 25 : 0,
      exchange: completed ? 100 : scheduled ? 35 : 0,
      reflect: reflections ? 100 : completed ? 30 : 0
    };
    const overall = clamp(Object.values(stages).reduce((sum, value) => sum + value, 0) / Object.keys(stages).length);
    const firstIncomplete = Object.entries(stages).find(([, value]) => value < 100)?.[0] || 'reflect';
    return {
      stages,
      overall,
      profile,
      conversations,
      messages,
      scheduled,
      completed,
      reflections,
      pendingReports,
      credits: Number(summary.credit_balance ?? analytics.credits_earned ?? 0),
      learningGoal,
      firstIncomplete
    };
  }

  const stageMeta = {
    discover: {label: 'Strengthen your profile', href: 'profile.html', title: 'Give your direction a sharper signal.', copy: 'Your profile is the foundation for useful matches. Add the missing essentials and the rest of the loop gets more precise.', checklist: ['Add one skill you can teach', 'Add one skill you want to learn']},
    connect: {label: 'Find a matching person', href: 'skill-matching.html?intent=swap', title: 'Turn your direction into a conversation.', copy: 'You have enough context to start looking for someone whose skills complement what you want to learn.', checklist: ['Review an explained match', 'Start one focused conversation']},
    schedule: {label: 'Open your calendar', href: 'calendar.html', title: 'Give the exchange a time and shape.', copy: 'A useful conversation becomes real when both people agree on an outcome and a time that works.', checklist: ['Choose a session outcome', 'Find an overlapping time']},
    exchange: {label: 'Complete your session', href: 'calendar.html', title: 'Your next milestone is the exchange itself.', copy: 'Keep the session focused, then let the platform record the time and outcome for you.', checklist: ['Show up for the scheduled hour', 'Keep the agreed outcome visible']},
    reflect: {label: 'Write a progress report', href: 'learning-journal.html', title: 'Make the learning stick.', copy: 'A short reflection turns a completed hour into a personal record you can build on later.', checklist: ['Describe what happened', 'Choose the next useful step']}
  };

  function renderBars(stages) {
    const host = $('#journeyStageBars');
    if (!host) return;
    const labels = [['discover', 'Discover'], ['connect', 'Connect'], ['schedule', 'Schedule'], ['exchange', 'Exchange'], ['reflect', 'Reflect']];
    host.innerHTML = labels.map(([key, label]) => `<span class="journey-bar" title="${label}: ${stages[key]}%"><i style="height:${Math.max(7, stages[key])}%"></i><b>${label}</b></span>`).join('');
  }

  function render(payload) {
    const signals = journeySignals(payload);
    const meta = stageMeta[signals.firstIncomplete] || stageMeta.discover;
    const scoreRing = $('[data-journey-score-ring]');
    if (scoreRing) scoreRing.style.setProperty('--journey-score', String(signals.overall));
    const score = $('[data-journey-score]');
    if (score) score.textContent = `${signals.overall}%`;
    const status = $('[data-journey-status]');
    if (status) status.textContent = signals.overall >= 100 ? 'Your loop is fully in motion.' : meta.title;
    const statusCopy = $('[data-journey-status-copy]');
    if (statusCopy) statusCopy.textContent = signals.overall >= 100 ? 'You have a complete trail from direction to reflection. Keep choosing the next useful exchange.' : meta.copy;
    const nextLink = $('[data-journey-next-link]');
    if (nextLink) nextLink.href = meta.href;
    const nextLabel = $('[data-journey-next-label]');
    if (nextLabel) nextLabel.textContent = meta.label;

    const signalValues = {profile: `${signals.profile}%`, conversations: number(signals.conversations), sessions: number(signals.completed), reflections: number(signals.reflections)};
    Object.entries(signalValues).forEach(([key, value]) => {
      const node = $(`[data-journey-signal="${key}"]`);
      if (node) node.textContent = value;
    });

    $$('[data-journey-stage]').forEach(stage => {
      const key = stage.dataset.journeyStage;
      const value = clamp(signals.stages[key]);
      const valueNode = $('[data-journey-stage-value]', stage);
      if (valueNode) valueNode.textContent = `${value}%`;
      stage.classList.toggle('is-complete', value >= 100);
      stage.classList.toggle('is-active', key === signals.firstIncomplete);
    });
    renderBars(signals.stages);

    const recommendation = $('[data-journey-recommendation]');
    if (recommendation) recommendation.textContent = meta.label;
    const recommendationCopy = $('[data-journey-recommendation-copy]');
    if (recommendationCopy) recommendationCopy.textContent = meta.copy;
    const checklist = $('[data-journey-checklist]');
    if (checklist) checklist.innerHTML = meta.checklist.map(item => `<span><i class="bx bx-check-circle" aria-hidden="true"></i>${item}</span>`).join('');
    root.dataset.journeyReady = 'true';
  }

  let rendered = false;
  window.addEventListener('relayskills:dashboard-ready', event => {
    rendered = true;
    render(event.detail?.payload || {});
  }, {once: true});

  // The dashboard renderer dispatches the event above. This fallback keeps
  // the module resilient if an older cached dashboard script is still open.
  window.setTimeout(async () => {
    if (rendered || root.dataset.journeyReady === 'true') return;
    try {
      const response = await fetch('/api/dashboard', {credentials: 'same-origin', cache: 'no-store'});
      if (response.ok) render(await response.json());
    } catch (_error) {
      // The regular dashboard error state remains authoritative.
    }
  }, 1600);
})();
