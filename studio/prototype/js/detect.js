/* Local taverns — the single tavern list shared by #wizard (step 3) and #settings ("本机酒馆"),
   plus the per-tavern access mode used by every sync / pull button and status badge.
   Each tavern type has an on/off switch (接受连接); off = Studio neither connects to nor reads it. */
(function () {
  const E = UI.esc;
  const META = { st: { name: 'SillyTavern', mark: 'ST' }, tt: { name: 'TauriTavern', mark: 'tt' } };
  const PLUGIN_HINT = '在酒馆的扩展 → 安装扩展中填入仓库地址';
  const ONCE_HINT = '需在该酒馆中启用过一次 Cellar Link（用于识别同一酒馆）';
  const CLOSED_HINT = '已在设置中关闭此酒馆';

  const pill = (tone, ic, text, title) => '<span class="dt-pill ' + tone + '"' + (title ? ' title="' + E(title) + '"' : '') + '>' +
    (tone === 'wait' ? '<span class="dot wait"></span>' : icon(ic, 'sm')) + text + '</span>';
  const pluginPill = (l, dim) => l.plugin ? pill('ok' + (dim ? ' dim' : ''), 'check', 'Cellar Link 已安装')
    : pill('warn' + (dim ? ' dim' : ''), 'alert', 'Cellar Link 未安装', PLUGIN_HINT);

  /* status pills for one location (an ST instance or the TT install) */
  function pills(l, accept) {
    if (!accept) return '<div class="dt-pills">' + pill('off', 'minus', '已关闭', CLOSED_HINT) + pluginPill(l, true) + '</div>';
    let h = (l.running ? pill('ok', 'power', '运行中') : pill('off', 'power', '未运行')) + pluginPill(l);
    if (l.running) {
      if (l.connected) h += pill('ok', 'link', '已连接', l.origin);
      else if (l.plugin) h += pill('wait', '', '等待连接…');
    } else {
      h += l.offlineReady ? pill('info', 'folder', '离线可用', '酒馆未运行时直接读取数据目录') : pill('off', 'folder', '离线不可用', ONCE_HINT);
    }
    return '<div class="dt-pills">' + h + '</div>';
  }

  const lamp = (l, accept) => !accept ? 'off' : l.connected ? 'on' : l.running ? 'wait' : 'off';

  function pathField(label, value, extra, valid) {
    return '<div class="dt-field"><label>' + label + '</label><div class="dt-path"><input class="input mono" value="' + E(value) + '" spellcheck="false">' +
      '<button class="btn sm" data-act="fake" data-msg="（原型）将打开文件夹选择器">' + icon('folder', 'sm') + '浏览…</button>' + (extra || '') + '</div>' +
      (valid ? '<div class="dt-valid">' + icon('check', 'sm') + valid + '</div>' : '') + '</div>';
  }

  /* head row; `open` = true/false makes it collapsible (wizard), undefined = always expanded (settings) */
  function head(l, accept, name, open, removable) {
    const chev = open === undefined ? '' : '<button class="icon-btn dt-chev" data-act="dt-expand" data-id="' + l.id + '" title="' + (open ? '收起' : '展开') + '">' + icon(open ? 'chevDown' : 'chevRight', 'sm') + '</button>';
    return '<div class="dt-inst-head">' + chev + '<span class="dot ' + lamp(l, accept) + '"></span><b>' + E(name) + '</b>' +
      '<span class="faint mono">v' + E(l.version) + '</span><span style="flex:1"></span>' + pills(l, accept) +
      (removable ? '<button class="icon-btn" title="移除" data-act="fake" data-msg="已移除 ' + E(name) + '">' + icon('trash', 'sm') + '</button>' : '') + '</div>';
  }

  /* tavern that has only connected through Cellar Link — no folder set yet */
  function linkOnly(l, accept) {
    const st = !accept ? pill('off', 'minus', '已关闭', CLOSED_HINT) : l.connected ? pill('ok', 'link', '已连接', l.origin)
      : '<span class="faint">上次连接 ' + E(l.lastSeen) + '</span>';
    return '<div class="dt-inst link-only"><div class="dt-inst-head"><span class="dot ' + lamp(l, accept) + '"></span><b>' + E(l.name) + '</b>' +
      '<span class="faint mono">' + E(l.origin) + '</span><span style="flex:1"></span>' + st +
      '<button class="btn sm" data-act="fake" data-msg="（原型）将打开文件夹选择器">' + icon('folder', 'sm') + '设置目录…</button>' +
      '<button class="icon-btn" title="移除" data-act="fake" data-msg="已移除 ' + E(l.name) + '">' + icon('trash', 'sm') + '</button></div>' +
      '<div class="dt-derived faint">只通过 Cellar Link 连接过；设置目录后酒馆未运行时也能浏览与取出</div></div>';
  }

  function stInstance(l, accept, i, open) {
    if (!l.dir) return linkOnly(l, accept);
    const h = head(l, accept, l.name, open, i > 0);
    if (open === false) return '<div class="dt-inst collapsed">' + h + '</div>';
    const user = l.users.length > 1 ? '<div class="dt-field user"><label>用户</label><select class="select">' +
      l.users.map((u) => '<option' + (u === l.user ? ' selected' : '') + '>' + E(u) + '</option>').join('') + '</select></div>' : '';
    const valid = l.found ? '已找到 ' + l.found.books + ' 本世界书 · ' + l.found.chars + ' 个角色' : '';
    return '<div class="dt-inst">' + h + '<div class="dt-fields">' + pathField('安装目录', l.dir, '', valid) + user + '</div>' +
      '<div class="dt-derived faint">数据目录 <span class="mono">' + E(l.dataDir) + '</span> · 端口 ' + l.port +
      (l.plugin ? '' : '<span class="dt-warn"> · ' + icon('alert', 'sm') + '未安装 Cellar Link：' + PLUGIN_HINT + '</span>') + '</div></div>';
  }

  function ttBody(l, accept) {
    const valid = l.found ? '已找到 ' + l.found.books + ' 本世界书 · ' + l.found.chars + ' 个角色' : '';
    return '<div class="dt-inst">' + head(l, accept, 'TauriTavern') +
      '<div class="dt-fields two">' + pathField('安装目录', l.install) +
      pathField('数据目录', l.dataDir, '<button class="btn sm ghost" data-act="fake" data-msg="已从 TauriTavern 上次运行记录识别数据目录">' + icon('search', 'sm') + '自动识别</button>', valid) + '</div></div>';
  }

  /* opts.open: array of expanded ST instance ids (wizard); omitted = all expanded */
  function card(type, d, opts) {
    const m = META[type], open = opts && opts.open;
    const body = type === 'st' ? d.instances.map((l, i) => stInstance(l, d.accept, i, open ? open.includes(l.id) : undefined)).join('') +
      '<button class="btn sm ghost dt-add" data-act="fake" data-msg="（原型）将添加一个 SillyTavern 实例">' + icon('plus', 'sm') + '添加 SillyTavern</button>'
      : ttBody(d, d.accept);
    return '<div class="dt-card' + (d.accept ? '' : ' refused') + '">' +
      '<div class="dt-head"><span class="badge">' + m.mark + '</span><b>' + m.name + '</b><span style="flex:1"></span>' +
      UI.toggle(d.accept, '接受连接', 'data-act="dt-accept" data-type="' + type + '"', 'mini') + '</div>' +
      '<div class="dt-body">' + body + '</div></div>';
  }

  /* opts.foot: extra html placed at the right of the hint row */
  function list(locs, opts) {
    return '<div class="dt-list">' + card('st', locs.st, opts) + card('tt', locs.tt, opts) +
      '<div class="dt-note faint">' + icon('info', 'sm') + '<div class="grow">关闭「接受连接」= Studio 不再连接、也不再读取该酒馆。<br>' +
      '未运行的酒馆可离线浏览、取出与取回；写回仅在酒馆未运行时进行，并先备份原文件。' + ONCE_HINT + '。</div>' +
      (opts && opts.foot ? opts.foot : '') + '</div></div>';
  }

  /* ---------- access mode per sync-target tavern id ---------- */
  function locOf(tid) {
    const L = window.DATA.locations;
    return L.tt.id === tid ? L.tt : L.st.instances.find((i) => i.id === tid);
  }
  function closed(tid) { const L = window.DATA.locations; return L.tt.id === tid ? !L.tt.accept : !L.st.accept; }
  /* closed | online | running (running, not linked: read-only) | offline (not running, folder usable) | none */
  function mode(tid) {
    const l = locOf(tid);
    if (closed(tid)) return 'closed';
    if (!l) return 'none';
    if (l.connected) return 'online';
    if (l.running) return 'running';
    return l.offlineReady ? 'offline' : 'none';
  }
  const offline = (tid) => mode(tid) === 'offline';

  /* real status + offline marker, e.g. 「本地有修改 · 离线」 */
  function badge(st, tid, opts) {
    const m = mode(tid);
    if (m === 'closed') return UI.stBadge('closed', Object.assign({ title: CLOSED_HINT }, opts));
    if (m !== 'offline' || st === 'unbound') return UI.stBadge(st, opts);
    const label = UI.STATUS[st].label + ' · 离线';
    return UI.stBadge(st, Object.assign({ label, title: label + '（读取自数据目录）', cls: 'is-off' }, opts));
  }

  const dis = (t) => ' disabled title="' + t + '"';
  /* attributes for a 同步 (write-back) button */
  function writeAttr(tid) {
    switch (mode(tid)) {
      case 'online': return '';
      case 'offline': return ' title="将直接写入数据目录（会先备份）"';
      case 'closed': return dis(CLOSED_HINT);
      case 'running': return dis('酒馆正在运行，请在酒馆中启用 Cellar Link 同步');
      default: return dis('酒馆未运行，且未设置可用的数据目录');
    }
  }
  /* attributes for a 取回 (pull) button — reading works offline and while running unlinked */
  function pullAttr(tid) {
    switch (mode(tid)) {
      case 'online': return '';
      case 'offline': return ' title="从数据目录读取"';
      case 'running': return ' title="酒馆运行中：只读取数据目录"';
      case 'closed': return dis(CLOSED_HINT);
      default: return dis('酒馆未连接，且未设置可用的数据目录');
    }
  }
  const CONN = { online: '已连接', offline: '离线', running: '未连接', closed: '已关闭', none: '未连接' };
  const CONN_TIP = { online: 'Cellar Link 已连接', offline: '酒馆未运行 · 直接读写数据目录', running: '酒馆运行中但 Cellar Link 未连接', closed: CLOSED_HINT, none: '未连接，且未设置数据目录' };
  const connLabel = (tid) => CONN[mode(tid)];
  const connTip = (tid) => CONN_TIP[mode(tid)];

  window.Detect = { card, list, locOf, closed, mode, offline, badge, writeAttr, pullAttr, connLabel, connTip, META, CLOSED_HINT };
})();
