(() => {
  const navigation = document.querySelector('.profile-nav');
  if (!navigation) return;

  navigation.setAttribute('aria-label', 'Profile sections');
  const sections = [...navigation.querySelectorAll('a[href^="#"]')].map(link => {
    const anchor = document.getElementById(link.hash.slice(1));
    return {link, section: anchor?.closest('.profile-card')};
  }).filter(entry => entry.section);

  const updateCurrentSection = () => {
    const header = document.querySelector('.site-header .nav');
    const saveBar = document.querySelector('.profile-save-state-bar');
    const viewportTop = Math.max(0, header?.getBoundingClientRect().bottom || 0,
      saveBar?.getBoundingClientRect().bottom || 0) + 12;
    const viewportBottom = window.innerHeight;
    const visibleSections = sections.filter(({link, section}) =>
      !link.hidden && section.getClientRects().length > 0
    );
    let current = null;
    let greatestVisibleHeight = 0;

    // Use the most visible card, not the last clicked link or a stale URL hash.
    visibleSections.forEach(entry => {
      const rect = entry.section.getBoundingClientRect();
      const visibleHeight = Math.max(0,
        Math.min(rect.bottom, viewportBottom) - Math.max(rect.top, viewportTop)
      );
      if (visibleHeight > greatestVisibleHeight) {
        current = entry;
        greatestVisibleHeight = visibleHeight;
      }
    });

    // Keep a sensible selection above the form, between cards, and in the footer.
    if (!current) {
      current = visibleSections.find(({section}) =>
        section.getBoundingClientRect().bottom > viewportTop
      ) || visibleSections[visibleSections.length - 1];
    }
    sections.forEach(entry => {
      if (entry === current) entry.link.setAttribute('aria-current', 'location');
      else entry.link.removeAttribute('aria-current');
    });
  };

  let updatePending = false;
  const scheduleUpdate = () => {
    if (updatePending) return;
    updatePending = true;
    requestAnimationFrame(() => {
      updatePending = false;
      updateCurrentSection();
    });
  };

  window.addEventListener('scroll', scheduleUpdate, {passive: true});
  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('hashchange', scheduleUpdate);
  window.addEventListener('load', scheduleUpdate);
  window.addEventListener('swaplabs:preferences-applied', scheduleUpdate);
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(scheduleUpdate);
    sections.forEach(({section}) => observer.observe(section));
  }
  scheduleUpdate();
})();
