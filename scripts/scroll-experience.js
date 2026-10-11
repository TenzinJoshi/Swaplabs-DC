/* Keep the shared back-to-top control useful when the admin shell owns scroll. */
(() => {
  const adminMain = document.querySelector('body.workspace-admin .admin-main');
  const backToTop = document.querySelector('.back-to-top');
  if (!adminMain || !backToTop) return;

  const update = () => {
    backToTop.classList.toggle('visible', adminMain.scrollTop > 420);
  };

  adminMain.addEventListener('scroll', update, { passive: true });
  backToTop.addEventListener('click', () => {
    adminMain.scrollTo({
      top: 0,
      behavior: document.documentElement.classList.contains('pref-reduced-motion') ? 'auto' : 'smooth'
    });
  });
  update();
})();
