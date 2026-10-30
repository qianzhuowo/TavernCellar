/* Local tavern cards — shared by #wizard (step 3) and #settings ("本机酒馆").
   Each tavern type has an accept toggle (links are admitted by browser Origin) and on-disk locations,
   so the companion can read a tavern's data folder while it is not running. */
(function () {
  const E = UI.esc;
  const META = { st: { name: 'SillyTavern', mark: 'ST' }, tt: { name: 'TauriTavern', mark: 'tt' } };
  const PLUGIN_HINT = '在酒馆的扩展 → 安装扩展中填入仓库地址';
  const ONCE_HINT = '需在该酒馆中启用过一次 Cellar Link（用于识别同一酒馆）';

  const pill = (tone, ic, text, title) => '<span class="dt-pill ' + tone + '"' + (title ? ' title="' + E(title) + '"' : '') + '>' +
    (tone === 'wait' ? '<span class="dot wait"></span>' : icon(ic, 'sm')) + text + '</span>';

  /* status pills for one location (an ST instance or the TT install) */
  function pills(l, accept) {
    let h = l.running ? pill('ok', 'power', '运行中') : pill('off', 'power', '未运行');
    h += l.plugin ? pill('ok', 'check', 'Cellar Link 已安装') : pill('warn', 'alert', 'Cellar Link 未安装', PLUGIN_HINT);
    if (l.running) {
      if (!accept) h += pill('off', 'minus', '不接受连接', '酒馆中的 Cellar Link 会显示“伴侣程序未接受本酒馆”');
      else if (l.connected) h += pill('ok', 'link', '已连接', l.origin);
      else if (l.plugin) h += pill('wait', '', '等待连接…');
    } else {
      h += l.offlineReady ? pill('info', 'folder', '离线可用', '酒馆未运行时直接读取数据目录') : pill('off', 'folder', '离线不可用', ONCE_HINT);
    }
    return '<div class="dt-pills">' + h + '</div>';
  }

  function pathField(label, value, extra, valid) {
    return '<div class="dt-field"><label>' + label + '</label><div class="dt-path"><input class="input mono" value="' + E(value) + '" spellcheck="false">' +
      '<button class="btn sm" data-act="fake" data-msg="（原型）将打开文件夹选择器">' + icon('folder', 'sm') + '浏览…</button>' + (extra || '') + '</div>' +
      (valid ? '<div class="dt-valid">' + icon('check', 'sm') + valid + '</div>' : '') + '</div>';
  }

  function stInstance(l, accept, i) {
    const lamp = l.connected && accept ? 'on' : l.running ? 'wait' : 'off';
    const user = l.users.length > 1 ? '<div class="dt-field user"><label>用户</label><select class="select">' +
      l.users.map((u) => '<option' + (u === l.user ? ' selected' : '') + '>' + E(u) + '</option>').join('') + '</select></div>' : '';
    const valid = l.found ? '已找到 ' + l.found.books + ' 本世界书 · ' + l.found.chars + ' 个角色' : '';
    return '<div class="dt-inst"><div class="dt-inst-head"><span class="dot ' + lamp + '"></span><b>' + E(l.name) + '</b>' +
      '<span class="faint mono">v' + E(l.version) + '</span><span style="flex:1"></span>' + pills(l, accept) +
      (i > 0 ? '<button class="icon-btn" title="移除此实例" data-act="fake" data-msg="已移除 ' + E(l.name) + '">' + icon('trash', 'sm') + '</button>' : '') + '</div>' +
      '<div class="dt-fields">' + pathField('安装目录', l.dir, '', valid) + user + '</div>' +
      '<div class="dt-derived faint">数据目录 <span class="mono">' + E(l.dataDir) + '</span> · 端口 ' + l.port +
      (l.plugin ? '' : '<span class="dt-warn"> · ' + icon('alert', 'sm') + '未安装 Cellar Link：' + PLUGIN_HINT + '</span>') + '</div></div>';
  }

  function ttBody(l, accept) {
    const lamp = l.connected && accept ? 'on' : l.running ? 'wait' : 'off';
    return '<div class="dt-inst"><div class="dt-inst-head"><span class="dot ' + lamp + '"></span><b>TauriTavern</b>' +
      '<span class="faint mono">v' + E(l.version) + '</span><span style="flex:1"></span>' + pills(l, accept) + '</div>' +
      '<div class="dt-fields two">' + pathField('安装目录', l.install) +
      pathField('数据目录', l.dataDir, '<button class="btn sm ghost" data-act="fake" data-msg="已从 TauriTavern 上次运行记录识别数据目录">' + icon('search', 'sm') + '自动识别</button>') + '</div>' +
      '<div class="dt-derived faint">TauriTavern 可自定义数据目录；自动识别读取 tt 上次运行记录</div></div>';
  }

  function card(type, d) {
    const m = META[type];
    const body = type === 'st' ? d.instances.map((l, i) => stInstance(l, d.accept, i)).join('') +
      '<button class="btn sm ghost dt-add" data-act="fake" data-msg="（原型）将添加一个 SillyTavern 实例">' + icon('plus', 'sm') + '添加 SillyTavern</button>'
      : ttBody(d, d.accept);
    return '<div class="dt-card' + (d.accept ? '' : ' refused') + '">' +
      '<div class="dt-head"><span class="badge">' + m.mark + '</span><b>' + m.name + '</b><span style="flex:1"></span>' +
      UI.toggle(d.accept, '接受连接', 'data-act="dt-accept" data-type="' + type + '"', 'mini') + '</div>' +
      '<div class="dt-body">' + body + '</div></div>';
  }

  function list(locs) {
    return '<div class="dt-list">' + card('st', locs.st) + card('tt', locs.tt) +
      '<div class="dt-note faint">' + icon('info', 'sm') + '<div>未运行的酒馆可离线浏览与取出；写回仅在酒馆未运行时进行，并先备份原文件。<br>' + ONCE_HINT + '。</div></div></div>';
  }

  /* location record bound to a tavern id from DATA.taverns */
  function locOf(tid) {
    const L = window.DATA.locations;
    return L.tt.tavern === tid ? L.tt : L.st.instances.find((i) => i.tavern === tid);
  }
  /* tavern not connected, not running, folder usable → offline read/write allowed */
  function offline(tid) { const l = locOf(tid); return !!l && !l.connected && !l.running && l.offlineReady; }

  /* attributes for a 同步 (write-back) button targeting tavern `tid` */
  function writeAttr(tid) {
    const l = locOf(tid);
    if (l && l.connected) return '';
    if (offline(tid)) return ' title="将直接写入数据目录（会先备份）"';
    if (l && l.running) return ' disabled title="酒馆正在运行，请在酒馆中启用 Cellar Link 同步"';
    return ' disabled title="酒馆未运行，且未设置可用的数据目录"';
  }

  window.Detect = { card, list, locOf, offline, writeAttr, META };
})();
