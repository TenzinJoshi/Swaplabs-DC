(() => {
  const themeButtons = document.querySelectorAll('.workspace-theme-toggle');
  const syncThemeButtons = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeButtons.forEach(button => {
      button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      button.setAttribute('title', dark ? 'Switch to light mode' : 'Switch to dark mode');
      button.innerHTML = `<i class="bx ${dark ? 'bx-sun' : 'bx-moon'}"></i>`;
    });
  };
  themeButtons.forEach(button => button.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    window.SwapLabsPreferences?.apply({theme: dark ? 'dark' : 'light'});
    syncThemeButtons();
  }));
  window.addEventListener('swaplabs:preferences-applied', syncThemeButtons);
  syncThemeButtons();
  const sidebar = document.getElementById('workspaceSidebar');
  const toggle = document.querySelector('.workspace-menu');
  toggle?.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('workspace-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });
  document.querySelector('.workspace-logout')?.addEventListener('click', () => {
    const logout = window.SwapLabsAuth?.logout;
    if (typeof logout === 'function') logout();
    else location.href = 'login.html';
  });
  document.getElementById('workspaceSectionSearch')?.addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    sidebar.querySelectorAll('[data-admin-section-target]').forEach(button => {
      button.hidden = !button.textContent.toLowerCase().includes(query);
    });
    sidebar.querySelectorAll('.admin-nav-group').forEach(group => {
      group.hidden = ![...group.querySelectorAll('button')].some(button => !button.hidden);
    });
  });
})();
