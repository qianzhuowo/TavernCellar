/* Global event delegation, shared actions and boot. */
(function () {
  const A = App.actions;

  A.go = (el) => App.go(el.dataset.href);
  A.theme = () => App.setTheme(App.state.theme === 'dark' ? 'light' : 'dark');
  A['toggle-inspector'] = () => {
    if (window.innerWidth < 1100) { document.getElementById('app').classList.toggle('inspector-drawer'); return; }
    App.state.inspector = !App.state.inspector;
    App.render();
  };
  A['toggle-side'] = () => App.toggleSide();
  A['close-tab'] = (el, ev) => {
    ev.stopPropagation();
    const k = el.dataset.tab, tabs = App.state.tabs, i = tabs.indexOf(k);
    if (tabs.length <= 1) { UI.toast('至少保留一个标签页', 'info'); return; }
    tabs.splice(i, 1);
    if (k === App.route.key) App.go('#' + tabs[Math.max(0, i - 1)]); else App.render();
  };
  A.collapse = (el) => {
    const sec = el.closest('.collapsible');
    const closed = !sec.classList.contains('collapsed');
    sec.classList.toggle('collapsed', closed);
    el.setAttribute('aria-expanded', String(!closed));
    App.setCollapsed(sec.dataset.key, closed);
  };
  A.seg = (el) => {
    const g = el.parentElement;
    g.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b === el); b.setAttribute('aria-checked', String(b === el)); });
    const scr = App.screens[App.route.name];
    if (scr.onSeg) scr.onSeg(g.dataset.key, el.dataset.v, el);
  };
  A['chip-x'] = (el) => el.closest('.chip').remove();
  A.fake = (el) => UI.toast(el.dataset.msg || '完成');
  A['fake-sync'] = (el) => UI.toast(el && el.dataset.tv && Detect.offline(el.dataset.tv)
    ? '已备份原文件并写入 ' + App.tavern(el.dataset.tv).name + ' 的数据目录'
    : '已同步到 ' + (el && el.dataset.tv ? App.tavern(el.dataset.tv).name : '我的 SillyTavern'));
  A['fake-pull'] = (el) => UI.toast(Detect.mode(el.dataset.tv) === 'online'
    ? '已从 ' + App.tavern(el.dataset.tv).name + ' 取回'
    : '已从 ' + App.tavern(el.dataset.tv).name + ' 数据目录取回', 'download');
  A.expand = (el) => {
    const f = el.closest('.field');
    const on = !f.classList.contains('expanded');
    f.classList.toggle('expanded', on);
    document.body.classList.toggle('has-expanded', on);
    el.innerHTML = icon(on ? 'x' : 'maximize', 'sm');
    el.title = on ? '退出展开' : '展开编辑器';
    if (on) f.querySelector('textarea').focus();
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const scr = App.screens[App.route.name] || {};
    const fn = (scr.actions && scr.actions[el.dataset.act]) || A[el.dataset.act];
    if (fn) fn(el, ev);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches('.tree-item, [data-act][tabindex]')) ev.target.click();
    if (ev.key === 'Escape') {
      const ex = document.querySelector('.field.expanded [data-act="expand"]');
      if (ex) ex.click();
    }
    if (ev.target.matches('[data-chip-input]') && ev.key === 'Enter' && ev.target.value.trim()) {
      ev.preventDefault();
      const span = document.createElement('span');
      span.innerHTML = UI.chips([ev.target.value.trim()], ev.target.closest('.chip-input').dataset.cls || '', true);
      ev.target.before(span.firstChild);
      ev.target.value = '';
    }
  });

  /* live word count + fake "writing to workspace" dot (§5.1: 400ms debounce) */
  let writeTimer;
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.matches('[data-wc]')) {
      const out = document.querySelector('[data-wc-for="' + t.id + '"]');
      if (out) out.textContent = UI.fmtN(UI.wordCount(t.value)) + ' 字';
      if (t.dataset.autogrow !== undefined) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
    }
    const scr = App.screens[App.route.name];
    if (scr && scr.onInput) scr.onInput(t);
    const dot = document.querySelector('.tab.on .unsaved');
    if (dot && t.closest('.editor')) {
      dot.hidden = false;
      clearTimeout(writeTimer);
      writeTimer = setTimeout(() => { dot.hidden = true; }, 700);
    }
  });

  document.addEventListener('DOMContentLoaded', App.render);
})();
