(() => {
  'use strict';

  const body = document.body;
  if (!body?.classList.contains('home-scroll-journey')) return;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const reducePreference = 'relayskills-reduce-motion';
  const nativeReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let reduced = nativeReduced || localStorage.getItem(reducePreference) === 'true';
  let redirecting = false;
  let animationFrame = 0;
  let activeScene = -1;
  let activeNextMove = -1;
  let linearStory = false;
  let mobileRouteCards = [];
  let mobileSceneCards = [];
  const compactStory = window.matchMedia('(max-width: 840px)');

  const nextMoveContent = [
    { label: '01 / FRAME THE QUESTION', title: 'Start with a question you can actually answer.', copy: 'Pick one useful outcome—not a giant subject. The clearer the question, the better the match.', from: 'YOU BRING', focus: 'Curiosity', target: 'A clear outcome', payoff: 'Clarity creates momentum.', link: 'Start with a question', href: 'skill-matching.html?intent=swap', icon: 'bx-help-circle' },
    { label: '02 / FIND THE MISSING PIECE', title: 'Find the person with the missing piece.', copy: 'Related skills count. A web designer and developer can learn from each other without starting from zero.', from: 'YOU KNOW', focus: 'Web development', target: 'Web design', payoff: 'Different strengths connect.', link: 'Find an adjacent skill', href: 'browse-skills.html?search=web%20design', icon: 'bx-git-compare' },
    { label: '03 / MAKE IT REAL', title: 'Put one focused hour on the calendar.', copy: 'Agree on the goal, meet, and let the one-credit exchange rule settle after both reports.', from: 'YOU OFFER', focus: 'One useful hour', target: 'A shared win', payoff: 'Small steps compound.', link: 'Choose a time', href: 'calendar.html', icon: 'bx-calendar-check' },
    { label: '04 / LEAVE A TRAIL', title: 'Write down what changed.', copy: 'Both people reflect after the session so progress becomes a journey—not a vague memory.', from: 'YOU KEEP', focus: 'Your progress', target: 'Your next step', payoff: 'Your journey stays yours.', link: 'Open your journal', href: 'learning-journal.html', icon: 'bx-bookmark-heart' }
  ];

  function finishAuthGate() {
    body.classList.remove('home-auth-gate');
    body.classList.add('home-auth-ready');
  }

  function routeSignedInUser(auth) {
    if (redirecting || !auth?.authenticated || !auth?.user) return false;
    redirecting = true;
    body.classList.add('home-auth-redirecting');
    location.replace('dashboard.html?entry=home');
    return true;
  }

  async function checkHomeAccess() {
    try {
      const auth = await (window.SwapLabsAuth?.get?.() || fetch('/api/auth/me', {
        credentials: 'same-origin', cache: 'no-store'
      }).then(response => response.json()));
      if (routeSignedInUser(auth)) return;
    } catch (_error) {
      // The public story stays available if the local API is being restarted.
    }
    finishAuthGate();
  }

  function splitWords() {
    $$('[data-word-reveal]').forEach(node => {
      if (node.dataset.wordsReady) return;
      const words = node.textContent.trim().split(/\s+/);
      node.textContent = '';
      words.forEach((word, index) => {
        const span = document.createElement('span');
        span.textContent = `${word}${index < words.length - 1 ? ' ' : ''}`;
        span.style.setProperty('--word-opacity', '.18');
        node.append(span);
      });
      node.dataset.wordsReady = 'true';
    });
  }

  function setupReveals() {
    const nodes = $$('[data-reveal]');
    if (!('IntersectionObserver' in window) || reduced) {
      nodes.forEach(node => node.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) entry.target.classList.add('is-visible');
    }), { threshold: .14, rootMargin: '0px 0px -8%' });
    nodes.forEach(node => observer.observe(node));
  }

  function stripStoryHooks(node) {
    [node, ...node.querySelectorAll('*')].forEach(element => {
      [...element.attributes].forEach(attribute => {
        if (attribute.name === 'id' || attribute.name.startsWith('data-next-move-') || attribute.name.startsWith('data-scene')) {
          element.removeAttribute(attribute.name);
        }
      });
    });
    node.removeAttribute('aria-live');
  }

  function jumpToMobileCard(card) {
    // `auto` can inherit the page's smooth scrolling, even with motion disabled.
    card?.scrollIntoView({ block: 'start', behavior: reduced || compactStory.matches ? 'auto' : 'smooth' });
  }

  function buildMobileStories() {
    const route = $('[data-next-move]');
    const stage = route && $('.rs-next-move-stage', route);
    const cardTemplate = route && $('.rs-next-move-card', route);
    if (route && stage && cardTemplate && !mobileRouteCards.length) {
      const list = document.createElement('div');
      list.className = 'rs-mobile-route';
      nextMoveContent.forEach((item, index) => {
        const card = cardTemplate.cloneNode(true);
        card.classList.add('rs-mobile-route-card');
        const fields = { label: item.label, title: item.title, copy: item.copy, payoff: item.payoff };
        Object.entries(fields).forEach(([field, value]) => $(`[data-next-move-${field}]`, card).textContent = value);
        $('[data-next-move-icon]', card).className = `bx ${item.icon}`;
        const note = $('.rs-next-move-note', route).cloneNode(true);
        $('[data-next-move-from]', note).textContent = item.from;
        $('[data-next-move-focus]', note).textContent = item.focus;
        $('[data-next-move-target]', note).textContent = item.target;
        $('.rs-next-move-card-bottom', card).before(note);
        const link = $('[data-next-move-link]', route).cloneNode(true);
        link.href = item.href;
        link.firstChild.textContent = `${item.link} `;
        card.append(link);
        stripStoryHooks(card);
        card.dataset.mobileRouteIndex = String(index);
        mobileRouteCards.push(card);
        list.append(card);
      });
      const nav = $('.rs-next-move-steps', route).cloneNode(true);
      nav.classList.add('rs-mobile-story-nav');
      nav.setAttribute('role', 'navigation');
      $$('button', nav).forEach((button, index) => {
        button.removeAttribute('role');
        button.removeAttribute('aria-selected');
        button.removeAttribute('data-next-move-step-button');
        button.dataset.mobileRouteJump = String(index);
        button.addEventListener('click', () => jumpToMobileCard(mobileRouteCards[index]));
      });
      stage.after(nav, list);
    }

    const film = $('[data-scroll-film]');
    const visualTemplate = film && $('.rs-scene-visual', film);
    if (film && visualTemplate && !mobileSceneCards.length) {
      const list = document.createElement('div');
      list.className = 'rs-mobile-scenes';
      $$('[data-scene]', visualTemplate).forEach((scene, index) => {
        const card = document.createElement('article');
        card.className = 'rs-mobile-scene-card';
        card.dataset.mobileSceneIndex = String(index);
        const count = document.createElement('span');
        count.className = 'rs-mobile-scene-count';
        count.textContent = `${String(index + 1).padStart(2, '0')} / 04`;
        const visual = visualTemplate.cloneNode(false);
        visual.classList.add('rs-mobile-scene-visual');
        const illustration = scene.cloneNode(true);
        illustration.hidden = false;
        illustration.classList.add('is-active');
        stripStoryHooks(illustration);
        visual.append(illustration);
        const copy = document.createElement('div');
        copy.className = 'rs-scene-copy rs-mobile-scene-copy';
        const content = $(`[data-scene-copy="${index}"]`, film).cloneNode(true);
        content.hidden = false;
        stripStoryHooks(content);
        copy.append(content);
        card.append(count, visual, copy);
        mobileSceneCards.push(card);
        list.append(card);
      });
      const nav = document.createElement('nav');
      nav.className = 'rs-mobile-story-nav rs-mobile-scene-nav';
      nav.setAttribute('aria-label', $('.rs-scene-dots', film).getAttribute('aria-label'));
      $$('[data-scene-jump]', film).forEach((original, index) => {
        const button = original.cloneNode(false);
        button.removeAttribute('data-scene-jump');
        button.dataset.mobileSceneJump = String(index);
        button.textContent = `${String(index + 1).padStart(2, '0')} · ${original.getAttribute('aria-label')}`;
        button.addEventListener('click', () => jumpToMobileCard(mobileSceneCards[index]));
        nav.append(button);
      });
      $('.rs-film-sticky', film).append(nav, list);
    }
  }

  function setupStoryLayout() {
    linearStory = compactStory.matches;
    if (linearStory) buildMobileStories();
    body.classList.toggle('rs-linear-story', linearStory);
    if (linearStory) {
      // A resize may create the mobile navigation without changing the stage.
      // Initialize its current step even when the desktop stage was already 0.
      const route = $('[data-next-move]');
      const film = $('[data-scroll-film]');
      if (route) markMobileStep('[data-mobile-route-jump]', Math.max(0, activeNextMove), route);
      if (film) markMobileStep('[data-mobile-scene-jump]', Math.max(0, activeScene), film);
    }
  }

  function mobileCardIndex(cards) {
    const readingLine = Math.max(96, Math.min(window.innerHeight * .35, 240));
    let index = 0;
    cards.forEach((card, position) => {
      if (card.getBoundingClientRect().top <= readingLine) index = position;
    });
    return index;
  }

  function markMobileStep(selector, index, root) {
    $$(selector, root).forEach(button => {
      const selected = Number(button.dataset.mobileRouteJump ?? button.dataset.mobileSceneJump) === index;
      // The shared contrast stylesheet recognizes filled dark surfaces.
      button.classList.toggle('dark-surface', selected);
      if (selected) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
  }

  function setScene(index) {
    const film = $('[data-scroll-film]');
    if (!film || index === activeScene) return;
    activeScene = index;
    markMobileStep('[data-mobile-scene-jump]', index, film);
    const colors = ['#ebeeff', '#fff0e7', '#e5f7ef', '#efe9ff'];
    film.style.setProperty('--scene-color', colors[index] || colors[0]);
    film.dataset.scene = String(index);
    $$('[data-scene]').forEach(node => {
      const selected = Number(node.dataset.scene) === index;
      node.hidden = !selected;
      node.classList.toggle('is-active', selected);
    });
    $$('[data-scene-copy]').forEach(node => node.hidden = Number(node.dataset.sceneCopy) !== index);
    $$('[data-scene-jump]').forEach(node => {
      const selected = Number(node.dataset.sceneJump) === index;
      node.toggleAttribute('aria-current', selected);
    });
    const number = $('[data-scene-number]');
    if (number) number.textContent = `${String(index + 1).padStart(2, '0')} / 04`;
    const scrollState = $('[data-scene-scroll-state]');
    if (scrollState) scrollState.textContent = `SCENE ${String(index + 1).padStart(2, '0')} / 04`;
  }

  function filmProgress() {
    const film = $('[data-scroll-film]');
    if (!film) return;
    if (linearStory) {
      film.classList.remove('is-pinned');
      setScene(mobileCardIndex(mobileSceneCards));
      return;
    }
    const rect = film.getBoundingClientRect();
    const scrollSpace = Math.max(1, film.offsetHeight - window.innerHeight);
    const progress = Math.max(0, Math.min(1, -rect.top / scrollSpace));
    const start = rect.top + (window.scrollY || 0);
    film.classList.toggle('is-pinned', (window.scrollY || 0) > start && (window.scrollY || 0) < start + scrollSpace);
    $('[data-film-progress]')?.style.setProperty('width', `${Math.max(12, progress * 100)}%`);
    film.style.setProperty('--film-glow-x', `${18 + progress * 64}%`);
    $('.rs-scene-visual', film)?.style.setProperty('--scene-lift', `${Math.sin(progress * Math.PI) * -18}px`);
    $('.rs-scene-visual', film)?.style.setProperty('--scene-tilt', `${(progress - .5) * -2}deg`);
    $('.rs-scene-copy', film)?.style.setProperty('--copy-lift', `${Math.sin(progress * Math.PI) * 10}px`);
    setScene(Math.min(3, Math.floor(progress * 4)));
  }

  function setNextMove(index) {
    const root = $('[data-next-move]');
    if (!root) return;
    const safeIndex = Math.max(0, Math.min(nextMoveContent.length - 1, index));
    if (safeIndex === activeNextMove) return;
    activeNextMove = safeIndex;
    markMobileStep('[data-mobile-route-jump]', safeIndex, root);
    const item = nextMoveContent[safeIndex];
    root.dataset.active = String(safeIndex);
    const text = {
      step: `[data-next-move-step]`,
      from: `[data-next-move-from]`,
      focus: `[data-next-move-focus]`,
      target: `[data-next-move-target]`,
      label: `[data-next-move-label]`,
      title: `[data-next-move-title]`,
      copy: `[data-next-move-copy]`,
      payoff: `[data-next-move-payoff]`,
      link: `[data-next-move-link]`,
      icon: `[data-next-move-icon]`
    };
    $(text.step, root).textContent = `STEP ${String(safeIndex + 1).padStart(2, '0')} / ${String(nextMoveContent.length).padStart(2, '0')}`;
    $(text.from, root).textContent = item.from;
    $(text.focus, root).textContent = item.focus;
    $(text.target, root).textContent = item.target;
    $(text.label, root).textContent = item.label;
    $(text.title, root).textContent = item.title;
    $(text.copy, root).textContent = item.copy;
    $(text.payoff, root).textContent = item.payoff;
    const link = $(text.link, root);
    if (link) {
      link.href = item.href;
      link.firstChild.textContent = `${item.link} `;
    }
    const icon = $(text.icon, root);
    if (icon) icon.className = `bx ${item.icon}`;
    $$('[data-next-move-step-button]', root).forEach(button => {
      button.setAttribute('aria-selected', String(Number(button.dataset.nextMoveStepButton) === safeIndex));
    });
  }

  function nextMoveProgress() {
    const root = $('[data-next-move]');
    if (!root) return;
    if (linearStory) {
      root.classList.remove('is-pinned');
      setNextMove(mobileCardIndex(mobileRouteCards));
      return;
    }
    const start = root.getBoundingClientRect().top + (window.scrollY || 0);
    const scrollSpace = Math.max(1, root.offsetHeight - window.innerHeight);
    const progress = Math.max(0, Math.min(1, ((window.scrollY || 0) - start) / scrollSpace));
    root.classList.toggle('is-pinned', (window.scrollY || 0) > start && (window.scrollY || 0) < start + scrollSpace);
    const index = Math.min(nextMoveContent.length - 1, Math.floor(progress * nextMoveContent.length));
    setNextMove(index);
    $('[data-next-move-progress]', root)?.style.setProperty('width', `${Math.max(12, progress * 100)}%`);
    root.style.setProperty('--route-glow-x', `${18 + progress * 64}%`);
    $('[data-next-move-stage]', root)?.style.setProperty('--route-lift', `${Math.sin(progress * Math.PI) * -16}px`);
    $('[data-next-move-stage]', root)?.style.setProperty('--route-tilt', `${(progress - .5) * 3}deg`);
  }

  function setupNextMove() {
    const root = $('[data-next-move]');
    if (!root) return;
    $$('[data-next-move-step-button]', root).forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.nextMoveStepButton);
      const target = root.offsetTop + ((root.offsetHeight - window.innerHeight) * (index / (nextMoveContent.length - 1)));
      window.scrollTo({ top: target, behavior: reduced || compactStory.matches ? 'auto' : 'smooth' });
      setNextMove(index);
    }));
  }

  function updateMotion() {
    animationFrame = 0;
    const y = window.scrollY || 0;
    const doc = document.documentElement;
    const progress = Math.max(0, Math.min(1, y / Math.max(1, doc.scrollHeight - window.innerHeight)));
    const progressNode = $('.rs-reading-progress i');
    if (progressNode) progressNode.style.transform = `scaleX(${progress})`;

    const heroArt = $('.rs-hero-art');
    if (heroArt && !reduced) {
      const heroRect = $('.rs-hero')?.getBoundingClientRect();
      const heroProgress = heroRect ? Math.max(0, Math.min(1, -heroRect.top / Math.max(1, heroRect.height))) : 0;
      heroArt.style.setProperty('--parallax-y', `${heroProgress * -34}px`);
      heroArt.style.setProperty('--hero-tilt', `${-4 + heroProgress * 5}deg`);
      heroArt.style.setProperty('--hero-scale', `${1 - heroProgress * .06}`);
    }

    $$('[data-word-reveal]').forEach(node => {
      if (reduced) return;
      const rect = node.getBoundingClientRect();
      const start = window.innerHeight * .9;
      const reveal = Math.max(0, Math.min(1, (start - rect.top) / Math.max(1, rect.height + window.innerHeight * .2)));
      $$('span', node).forEach((word, index, words) => {
        const local = Math.max(0, Math.min(1, reveal * words.length - index));
        word.style.setProperty('--word-opacity', `${.16 + local * .84}`);
      });
    });

    nextMoveProgress();
    filmProgress();

    const horizontal = $('[data-horizontal-story]');
    const track = $('.rs-tools-track');
    if (horizontal && track && !reduced && window.innerWidth > 700) {
      const rect = horizontal.getBoundingClientRect();
      const available = Math.max(1, horizontal.offsetHeight - window.innerHeight);
      const local = Math.max(0, Math.min(1, -rect.top / available));
      const distance = Math.max(0, track.scrollWidth - window.innerWidth + Math.max(48, window.innerWidth * .12));
      track.style.setProperty('--track-x', `${-distance * local}px`);
      $('.rs-track-progress i')?.style.setProperty('--track-progress', local);
    }

    const imageSection = $('[data-image-reveal]');
    if (imageSection && !reduced) {
      const rect = imageSection.getBoundingClientRect();
      const local = Math.max(0, Math.min(1, (window.innerHeight - rect.top) / Math.max(1, window.innerHeight + rect.height)));
      $('.rs-community-image')?.style.setProperty('--image-inset', `${Math.max(0, 17 - local * 17)}%`);
      $('.rs-community-image img')?.style.setProperty('--image-scale', `${1.13 - local * .13}`);
    }
  }

  function queueMotion() {
    if (!animationFrame) animationFrame = requestAnimationFrame(updateMotion);
  }

  function setupJumps() {
    $$('[data-scene-jump]').forEach(button => button.addEventListener('click', () => {
      const film = $('[data-scroll-film]');
      if (!film) return;
      const index = Number(button.dataset.sceneJump);
      const target = film.offsetTop + ((film.offsetHeight - window.innerHeight) * (index / 3));
      window.scrollTo({ top: target, behavior: reduced || compactStory.matches ? 'auto' : 'smooth' });
      setScene(index);
    }));
  }

  function setupMotionToggle() {
    const toggle = $('.rs-motion-toggle');
    if (!toggle) return;
    const render = () => {
      body.classList.toggle('rs-reduced-motion', reduced);
      body.classList.toggle('rs-motion-enabled', !reduced);
      toggle.setAttribute('aria-pressed', String(reduced));
      $('span', toggle).textContent = reduced ? 'Enable motion' : 'Reduce motion';
      $('i', toggle).className = reduced ? 'bx bx-play' : 'bx bx-pause';
    };
    toggle.addEventListener('click', () => {
      reduced = !reduced;
      localStorage.setItem(reducePreference, String(reduced));
      render();
      updateMotion();
    });
    render();
  }

  window.addEventListener('swaplabs:auth-state', event => {
    if (!event.detail?.cached && !routeSignedInUser(event.detail)) finishAuthGate();
  });
  window.addEventListener('scroll', queueMotion, { passive: true });
  window.addEventListener('resize', () => {
    setupStoryLayout();
    queueMotion();
  }, { passive: true });

  splitWords();
  setupReveals();
  setupStoryLayout();
  setupJumps();
  setupNextMove();
  setupMotionToggle();
  setScene(0);
  setNextMove(0);
  updateMotion();
  checkHomeAccess();
})();
