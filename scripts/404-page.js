(() => {
  const paper = document.querySelector('.error-paper');
  if (!paper || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let frame = 0;
  let pointerX = 0;
  let pointerY = 0;

  const renderTilt = () => {
    frame = 0;
    const tiltX = (pointerY * -2.2).toFixed(2);
    const tiltY = (pointerX * 2.2).toFixed(2);
    paper.style.setProperty('--tilt-x', `${tiltX}deg`);
    paper.style.setProperty('--tilt-y', `${tiltY}deg`);
  };

  window.addEventListener('pointermove', (event) => {
    pointerX = event.clientX / window.innerWidth - .5;
    pointerY = event.clientY / window.innerHeight - .5;
    if (!frame) frame = window.requestAnimationFrame(renderTilt);
  }, {passive: true});

  window.addEventListener('pointerleave', () => {
    pointerX = 0;
    pointerY = 0;
    if (!frame) frame = window.requestAnimationFrame(renderTilt);
  }, {passive: true});
})();
