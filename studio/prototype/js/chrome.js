/* Persistent chrome (title bar, activity bar, side panel, tabs, inspector, status bar) + hash router. */
(function () {
  const D = window.DATA;
  const ls = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
               set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  const q = new URLSearchParams(location.search);

  const App = window.App = {
    screens: {},
    actions: {},
    state: {
      theme: q.get('theme') || ls.get('cs.theme', 'dark'),
      density: ls.get('cs.density', 'comfortable'),
      font: ls.get('cs.font', 'sans'),
      inspector: true,
      collapsed: JSON.parse(ls.get('cs.collapsed', '{}')),
      tabs: ['character/eirin', 'lorebook/frost'],
      lastWork: 'character/eirin'
    },
    route: { name: 'character', arg: 'eirin', key: 'character/eirin' },
    register(name, def) { this.screens[name] = def; },
    isCollapsed(key, def) { const v = this.state.collapsed[key]; return v === undefined ? !!def : v; },
    setCollapsed(key, v) { this.state.collapsed[key] = v; ls.set('cs.collapsed', JSON.stringify(this.state.collapsed)); },
    item(id) { return D.items.find((i) => i.id === id); },
    tavern(id) { return D.taverns.find((t) => t.id === id); },
    go(hash) { if (location.hash === hash) this.render(); else location.hash = hash; },
    persist: ls
  };

  const DEFAULT_ARG = { character: 'eirin', lorebook: 'frost', conflict: 'eirin' };
  const ACTIVITY_OF = { library: 'library', character: 'workspace', lorebook: 'workspace', conflict: 'workspace',
    sync: 'sync', history: 'history', settings: 'settings' };

  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, '') || 'character';
    let [name, arg] = h.split('/');
    if (!App.screens[name]) { name = 'character'; arg = null; }
    if (name === 'character' && arg && !D.chars[arg]) arg = null;
    if (!(name in DEFAULT_ARG)) arg = '';
    arg = arg || DEFAULT_ARG[name] || '';
    return { name, arg, key: arg ? name + '/' + arg : name };
  }

  function applyPrefs() {
    const r = document.documentElement;
    r.dataset.theme = App.state.theme;
    r.dataset.density = App.state.density;
    r.dataset.font = App.state.font;
  }
  App.setTheme = function (t) { App.state.theme = t; ls.set('cs.theme', t); applyPrefs(); App.render(); };
  App.applyPrefs = applyPrefs;

  /* ---------- tab meta ---------- */
  function tabMeta(key) {
    const [name, arg] = key.split('/');
    if (name === 'character') { const it = App.item(arg); return { label: it.name, ic: 'user', item: it }; }
    if (name === 'lorebook') { const it = App.item(arg); return { label: it.name, ic: 'book', item: it }; }
    if (name === 'conflict') { const it = App.item(arg); return { label: '冲突 · ' + it.name, ic: 'merge', item: it, st: 'conflict' }; }
    return { label: { library: '资料库', sync: '同步', settings: '设置', history: '历史' }[name], ic: { library: 'library', sync: 'sync', settings: 'settings', history: 'history' }[name] };
  }
  const BAR_COLOR = { synced: 'var(--st-synced)', local: 'var(--st-local)', remote: 'var(--st-remote)', conflict: 'var(--st-conflict)' };

  function renderTabs() {
    return '<div class="tabs" role="tablist">' + App.state.tabs.map((k) => {
      const m = tabMeta(k);
      const st = m.st || (m.item ? UI.worst(m.item) : null);
      const bar = st && BAR_COLOR[st] ? '<span class="bar" style="background:' + BAR_COLOR[st] + '"></span>' : '';
      return '<div class="tab' + (k === App.route.key ? ' on' : '') + '" role="tab" data-act="go" data-href="#' + k + '" data-tab="' + k + '">' + bar +
        icon(m.ic, 'sm') + '<span class="label">' + UI.esc(m.label) + '</span>' +
        '<span class="unsaved" hidden title="正在写入工作区"></span>' +
        '<span class="x" data-act="close-tab" data-tab="' + k + '" title="关闭">' + icon('x', 'sm') + '</span></div>';
    }).join('') + '<div class="tabs-tools"><button class="icon-btn" data-act="toggle-side" title="侧栏">' + icon('panelLeft') + '</button><button class="icon-btn" data-act="toggle-inspector" title="检查栏">' + icon('panelRight') + '</button></div></div>';
  }

  /* ---------- title bar ---------- */
  function renderTitle() {
    const conns = D.taverns.map((t) => '<span class="conn" title="' + Detect.connTip(t.id) + '"><span class="dot ' + (t.connected ? 'on' : 'off') + '"></span>' +
      t.short + '<span class="conn-label"> ' + Detect.connLabel(t.id) + '</span></span>').join('');
    const dark = App.state.theme === 'dark';
    return '<header class="titlebar"><div class="brand"><span class="brand-mark">' + icon('wine') + '</span>TavernCellar</div>' +
      '<span class="sep">·</span><span class="ws-name">' + icon('folder', 'sm') + UI.esc(D.workspace.name) + '</span>' +
      '<span class="spacer"></span>' +
      '<button class="conn-summary" data-act="go" data-href="#sync" title="酒馆连接">' + conns + '</button>' +
      '<button class="icon-btn" data-act="theme" title="切换' + (dark ? '浅色' : '深色') + '主题">' + icon(dark ? 'sun' : 'moon') + '</button>' +
      '<div class="win-ctl" aria-hidden="true"><span>' + icon('minimize', 'sm') + '</span><span>' + icon('square', 'sm') + '</span><span>' + icon('x', 'sm') + '</span></div></header>';
  }

  /* ---------- activity bar ---------- */
  function renderActivity() {
    const a = ACTIVITY_OF[App.route.name];
    const conflicts = D.items.filter((i) => Object.values(i.status).includes('conflict')).length;
    const btn = (id, ic, tip, href, extra) => '<button class="act' + (a === id ? ' on' : '') + '" data-act="go" data-href="' + href +
      '" data-tip="' + tip + '" aria-label="' + tip + '">' + icon(ic) + (extra || '') + '</button>';
    return '<nav class="activity">' +
      btn('library', 'library', '资料库', '#library') +
      btn('workspace', 'folder', '工作区', '#' + App.state.lastWork) +
      btn('sync', 'sync', '同步', '#sync', conflicts ? '<span class="dot">' + conflicts + '</span>' : '') +
      btn('history', 'history', '历史', '#history') +
      '<span class="grow"></span>' +
      btn('settings', 'settings', '设置', '#settings') + '</nav>';
  }

  /* ---------- side panel: workspace tree ---------- */
  function treeItem(it) {
    const on = App.route.arg === it.id;
    const badges = D.taverns.map((t) => Detect.badge(it.status[t.id], t.id, { iconOnly: true })).join('');
    return '<div class="tree-item' + (on ? ' on' : '') + '" data-act="go" data-href="#' + (it.kind === 'character' ? 'character/' : 'lorebook/') + it.id + '" tabindex="0">' +
      UI.avatar(it.name[0], it.hue, 20, '5px') + '<span class="name">' + UI.esc(it.name) + '</span><span class="badges">' + badges + '</span></div>';
  }
  function group(title, ic, list, reserved) {
    return '<div class="tree-group"><div class="tg-head">' + icon('chevDown', 'sm') + icon(ic, 'sm') + title +
      '<span class="count">' + (reserved ? '' : list.length) + '</span></div>' +
      (reserved ? '<div class="tree-item reserved">' + icon('clock', 'sm') + '<span class="name">' + reserved + '</span></div>'
        : list.map(treeItem).join('')) + '</div>';
  }
  App.renderTree = function () {
    return '<div class="panel-head">工作区<span class="spacer"></span><button class="icon-btn" title="从资料库取出" data-act="go" data-href="#library">' + icon('plus', 'sm') + '</button></div>' +
      '<div class="panel-body"><div class="search" style="margin:0 6px 4px">' + icon('search', 'sm') + '<input class="input" placeholder="快速打开…" style="height:28px"><kbd>Ctrl P</kbd></div>' +
      group('角色', 'user', D.items.filter((i) => i.kind === 'character')) +
      group('世界书', 'book', D.items.filter((i) => i.kind === 'lorebook')) +
      group('正则', 'regex', [], '阶段 4 开放') + group('预设', 'sliders', [], '阶段 4 开放') +
      '<div class="tree-legend">' + D.taverns.map((t, i) => '<span>徽标 ' + (i + 1) + ' = ' + t.short + '</span>').join('') + '</div></div>';
  };

  /* ---------- inspector ---------- */
  App.renderInspector = function (it) {
    if (!it) return '';
    const rows = D.taverns.map((t) => {
      const st = it.status[t.id];
      const sub = '<div class="faint" style="font-size:11px" title="' + Detect.connTip(t.id) + '">' + Detect.connLabel(t.id) + '</div>';
      return '<div class="insp-tv"><div class="tv-name"><span class="dot ' + (t.connected ? 'on' : 'off') + '"></span><div><div>' + t.name + '</div>' + sub + '</div></div>' +
        Detect.badge(st, t.id) +
        '<div class="tv-ops">' + UI.toggle(it.auto[t.id], '随时同步', st === 'unbound' || Detect.closed(t.id) ? 'disabled' : '', 'sync') +
        '<button class="btn sm"' + (st === 'unbound' ? ' disabled' : Detect.writeAttr(t.id)) + ' data-act="fake-sync" data-tv="' + t.id + '">' + icon('upload', 'sm') + '同步</button></div></div>';
    }).join('');
    return '<div class="panel-head">检查栏<span class="spacer"></span><button class="icon-btn" data-act="toggle-inspector" title="收起">' + icon('chevRight', 'sm') + '</button></div>' +
      '<div style="overflow:auto;flex:1"><div class="insp-sec"><h4>' + icon('sync', 'sm') + '同步状态</h4>' + rows + '</div>' +
      (it.warning ? '<div class="insp-sec"><div class="banner warn" style="padding:10px 12px;font-size:12px">' + icon('alert') +
        '<div class="grow"><b>' + it.warning.text + '</b><div class="mono faint" style="margin-top:4px;font-size:11px">' + it.warning.paths.join('<br>') + '</div></div></div></div>' : '') +
      (App.screens[App.route.name].inspectorExtra ? App.screens[App.route.name].inspectorExtra(it) : '') +
      '<div class="insp-sec"><h4>' + icon('file', 'sm') + '文件位置</h4><div class="mono path-box">' + UI.esc(it.path) + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:10px"><button class="btn sm" data-act="fake" data-msg="已在资源管理器中显示">' + icon('folder', 'sm') + '在资源管理器中显示</button>' +
      '<button class="btn sm ghost" data-act="fake" data-msg="已用 VS Code 打开">' + icon('external', 'sm') + 'VS Code</button></div>' +
      '<dl class="kv" style="margin-top:12px"><dt>最后写入</dt><dd>' + it.modified + '</dd><dt>大小</dt><dd>' + it.size + '</dd></dl></div></div>';
  };

  /* ---------- status bar ---------- */
  function renderStatus() {
    const conns = D.taverns.map((t) => '<span class="si" data-act="go" data-href="#sync" title="' + t.name + ' · ' + Detect.connTip(t.id) + '"><span class="dot ' + (t.connected ? 'on' : 'off') + '"></span>' +
      t.short + ' ' + Detect.connLabel(t.id) + '</span>').join('<span class="div"></span>');
    const dirty = D.items.filter((i) => Object.values(i.status).some((s) => ['local', 'remote', 'conflict'].includes(s))).length;
    const conf = D.items.filter((i) => Object.values(i.status).includes('conflict')).length;
    return '<footer class="statusbar">' + conns + '<span class="div"></span>' +
      '<span class="si" data-act="go" data-href="#sync" style="color:var(--st-local)">' + icon('dotfill', 'sm') + dirty + ' 项有未同步修改</span><span class="div"></span>' +
      '<span class="si" data-act="go" data-href="#conflict/eirin" style="color:var(--st-conflict)">' + icon('alert', 'sm') + conf + ' 项冲突</span>' +
      '<span class="spacer"></span><span class="si hide-narrow faint">' + icon('check', 'sm') + '已自动写入工作区</span>' +
      '<span class="si hide-narrow faint mono">127.0.0.1:' + D.port + '</span></footer>';
  }

  /* ---------- render ---------- */
  App.state.side = {};
  function sideHidden(scr) { const v = App.state.side[App.route.name]; return v === undefined ? !!scr.hideSide : !v; }
  App.toggleSide = function () { App.state.side[App.route.name] = sideHidden(App.screens[App.route.name]); App.render(); };
  App.render = function () {
    applyPrefs();
    App.route = parseRoute();
    const r = App.route, scr = App.screens[r.name];
    const root = document.getElementById('app');
    if (scr.fullscreen) { root.className = 'app-full'; root.innerHTML = scr.render(r); scr.mount && scr.mount(root, r); return; }
    if (r.arg && ['character', 'lorebook'].includes(r.name)) App.state.lastWork = r.key;
    if (!App.state.tabs.includes(r.key)) App.state.tabs.push(r.key);
    const it = scr.item ? App.item(r.arg) : null;
    const side = scr.side ? scr.side(r) : App.renderTree();
    root.className = 'app' + (it && App.state.inspector ? '' : ' inspector-off') + (sideHidden(scr) ? ' side-off' : '');
    root.innerHTML = renderTitle() + '<div class="workbench">' + renderActivity() +
      '<aside class="side">' + side + '</aside>' +
      '<main class="main">' + renderTabs() + '<div class="editor" id="editor">' + scr.render(r) + '</div></main>' +
      '<aside class="inspector">' + App.renderInspector(it) + '</aside></div>' + renderStatus();
    scr.mount && scr.mount(root, r);
  };

  window.addEventListener('hashchange', App.render);
})();
