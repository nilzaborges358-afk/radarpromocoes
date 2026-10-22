/* Radar — tema claro/escuro. Carregado no <head> (sem defer) para aplicar o tema antes de pintar a tela. */
(function () {
  var KEY = 'radar-theme';
  var root = document.documentElement;

  function systemTheme() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }
  function saved() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch (e) { return null; }
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.setAttribute('aria-label', theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro');
      btn.title = theme === 'dark' ? 'Tema claro' : 'Tema escuro';
    }
  }

  apply(saved() || systemTheme());

  var SUN = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function mount() {
    if (document.getElementById('themeToggle')) return;
    var btn = document.createElement('button');
    btn.id = 'themeToggle';
    btn.type = 'button';
    btn.innerHTML = '<span class="ico-sun">' + SUN + '</span><span class="ico-moon">' + MOON + '</span>';
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
    });
    var nav = document.querySelector('nav');
    if (nav) {
      // agrupa o botão ao lado do "Sair", sem mexer nos elementos existentes
      var logout = nav.querySelector('.logout-link');
      var box = document.createElement('div');
      box.className = 'nav-tools';
      if (logout) { logout.parentNode.insertBefore(box, logout); box.appendChild(btn); box.appendChild(logout); }
      else { box.appendChild(btn); nav.appendChild(box); }
    } else {
      btn.classList.add('floating');
      document.body.appendChild(btn);
    }
    apply(root.getAttribute('data-theme'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
