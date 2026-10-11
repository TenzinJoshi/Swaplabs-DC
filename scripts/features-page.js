(() => {
  'use strict';

  const body = document.body;
  if (!body?.classList.contains('features-page')) return;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const film = $('[data-feature-film]');
  const scenes = $$('[data-feature-scene]', film || document);
  const sceneButtons = $$('[data-feature-scene-jump]');
  const chapterButtons = $$('[data-feature-jump]');
  const reduceKey = 'relayskills-reduce-motion';
  const nativeReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let reduced = nativeReduced || localStorage.getItem(reduceKey) === 'true';
  let activeScene = -1;
  let frame = 0;
  let lastChapter = -1;

  const setReduced = value => {
    reduced = Boolean(value);
    body.classList.toggle('rs-reduced-motion', reduced);
  };

  setReduced(reduced);

  function reveal() {
    const nodes = $$('[data-reveal]');
    if (reduced || !('IntersectionObserver' in window)) {
      nodes.forEach(node => node.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: .12, rootMargin: '0px 0px -8%' });
    nodes.forEach(node => observer.observe(node));
  }

  function setScene(index) {
    const safe = Math.max(0, Math.min(scenes.length - 1, Number(index) || 0));
    if (safe === activeScene) return;
    activeScene = safe;
    if (film) film.dataset.active = String(safe);
    scenes.forEach(scene => {
      const selected = Number(scene.dataset.featureScene) === safe;
      scene.hidden = !selected;
      scene.classList.toggle('is-active', selected);
    });
    sceneButtons.forEach(button => {
      button.toggleAttribute('aria-current', Number(button.dataset.featureSceneJump) === safe);
    });
    const sceneState = $('[data-feature-scene-state]');
    if (sceneState) sceneState.textContent = `SCENE ${String(safe + 1).padStart(2, '0')} / ${String(scenes.length).padStart(2, '0')}`;
  }

  function updateChapterRail(index) {
    if (index === lastChapter) return;
    lastChapter = index;
    chapterButtons.forEach(button => button.classList.toggle('is-active', Number(button.dataset.featureJump) === index));
  }

  function updateFilm() {
    if (!film) return;
    const pageY = window.scrollY || window.pageYOffset || 0;
    const rect = film.getBoundingClientRect();
    const start = rect.top + pageY;
    const sticky = $('.feature-film-sticky', film);
    const stickyStyle = sticky ? getComputedStyle(sticky) : null;
    const stickyViewport = stickyStyle?.position === 'sticky' ? sticky.offsetHeight : window.innerHeight;
    const travel = Math.max(1, film.offsetHeight - stickyViewport);
    const progress = Math.max(0, Math.min(1, (pageY - start) / travel));
    const inFilm = pageY >= start - 8 && pageY <= start + travel + 8;
    const sceneIndex = Math.min(scenes.length - 1, Math.floor(progress * scenes.length));
    film.classList.toggle('is-pinned', inFilm && !reduced);
    film.style.setProperty('--feature-glow-x', `${18 + progress * 64}%`);
    film.style.setProperty('--feature-stage-lift', `${Math.sin(progress * Math.PI) * -18}px`);
    film.style.setProperty('--feature-stage-tilt', `${(progress - .5) * -1.8}deg`);
    $('[data-feature-film-progress]', film)?.style.setProperty('width', `${Math.max(12, progress * 100)}%`);
    if (inFilm || pageY < start) updateChapterRail(inFilm ? sceneIndex : 0);
    setScene(sceneIndex);
  }

  function updateReadingProgress() {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    $('.features-progress span')?.style.setProperty('transform', `scaleX(${Math.max(0, Math.min(1, (window.scrollY || 0) / max))})`);
  }

  function update() {
    frame = 0;
    updateFilm();
    updateReadingProgress();
  }

  function requestUpdate() {
    if (!frame) frame = window.requestAnimationFrame(update);
  }

  function scrollToScene(index) {
    if (!film) return;
    const pageY = window.scrollY || window.pageYOffset || 0;
    const start = film.getBoundingClientRect().top + pageY;
    const sticky = $('.feature-film-sticky', film);
    const stickyStyle = sticky ? getComputedStyle(sticky) : null;
    const stickyViewport = stickyStyle?.position === 'sticky' ? sticky.offsetHeight : window.innerHeight;
    const travel = Math.max(0, film.offsetHeight - stickyViewport);
    const target = start + travel * (Number(index) / Math.max(1, scenes.length - 1));
    if (travel < 20 || reduced) {
      setScene(index);
      return;
    }
    window.scrollTo({ top: target, behavior: 'smooth' });
  }

  sceneButtons.forEach(button => {
    button.addEventListener('click', () => scrollToScene(Number(button.dataset.featureSceneJump)));
  });

  chapterButtons.forEach(button => {
    button.addEventListener('click', event => {
      const target = document.getElementById(button.getAttribute('href')?.slice(1) || '');
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    });
  });

  if ('IntersectionObserver' in window) {
    const chapterObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const index = Number(entry.target.dataset.featureChapter);
        updateChapterRail(Number.isFinite(index) ? index : 0);
      });
    }, { threshold: .08, rootMargin: '-18% 0px -62%' });
    $$('[data-feature-chapter]').forEach(chapter => chapterObserver.observe(chapter));
  }

  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate, { passive: true });
  window.addEventListener('pageshow', requestUpdate);
  window.addEventListener('load', requestUpdate, { once: true });
  reveal();
  setScene(0);
  requestUpdate();
})();
