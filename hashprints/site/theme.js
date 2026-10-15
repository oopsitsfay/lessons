// Theme for the inner pages: dark unless the visitor picked Light on any page (same key as the home page).
(function () {
  const root = document.documentElement;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('hp.theme')); } catch {}
  root.dataset.theme = saved === 'light' ? 'light' : 'dark';
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const sync = () => { btn.textContent = root.dataset.theme === 'dark' ? 'Light' : 'Dark'; };
    sync();
    btn.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('hp.theme', JSON.stringify(root.dataset.theme)); } catch {}
      sync();
    });
  });
})();
