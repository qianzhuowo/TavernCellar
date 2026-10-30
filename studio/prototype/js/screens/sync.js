/* #sync — item × tavern status matrix (§4.5) */
(function () {
  const D = window.DATA, E = UI.esc;
  let onlyIssues = false;

  /* status gate first (nothing to do → plain disabled), then the tavern's access mode (Detect) */
  const gate = (ok, attr) => attr.includes('disabled') ? attr : ok ? attr : ' disabled';

  function cell(it, t) {
    const st = Detect.mode(t.id) === 'closed' ? 'closed' : it.status[t.id];
    const main = Detect.badge(it.status[t.id], t.id) +
      (Detect.offline(t.id) && Detect.whenOff(t.id) === 'wait' && st === 'local' ? '<span class="cell-hint" title="' + Detect.WAIT_HINT + '">' + icon('clock', 'sm') + '待同步</span>' : '');
    let ops = '';
    if (st === 'unbound') ops = '<button class="btn sm" data-act="fake" data-msg="已绑定到 ' + t.name + '"' + Detect.pullAttr(t.id) + '>' + icon('link', 'sm') + '绑定</button>';
    else {
      if (st === 'conflict') ops += '<button class="btn sm primary" data-act="go" data-href="#conflict/' + it.id + '">处理冲突</button>';
      else ops += '<button class="btn sm" data-act="fake-sync" data-tv="' + t.id + '"' + gate(st === 'local', Detect.writeAttr(t.id)) + '>' + icon('upload', 'sm') + '同步</button>';
      ops += '<button class="btn sm ghost" data-act="fake-pull" data-tv="' + t.id + '"' + gate(st === 'remote', Detect.pullAttr(t.id)) + '>' + icon('download', 'sm') + '取回</button>';
      ops += '<button class="icon-btn" title="解除绑定" data-act="fake" data-msg="已解除绑定">' + icon('unlink', 'sm') + '</button>';
    }
    const auto = st === 'unbound' ? '' : '<div class="cell-auto">' + UI.toggle(it.auto[t.id], '随时同步', 'title="保存即同步"' + (st === 'closed' ? ' disabled' : ''), 'sync mini') + '</div>';
    return '<td class="cell ' + st + (Detect.offline(t.id) ? ' is-off' : '') + '"><div class="cell-main">' + main + '</div><div class="cell-ops">' + ops + '</div>' + auto + '</td>';
  }

  function rowsHtml() {
    return D.items.filter((it) => !onlyIssues || Object.values(it.status).some((s) => s !== 'synced' && s !== 'unbound')).map((it) => {
      const href = '#' + (it.kind === 'character' ? 'character/' : 'lorebook/') + it.id;
      const warn = it.warning ? '<tr class="warn-row"><td colspan="' + (D.taverns.length + 1) + '"><details class="warn-note"><summary>' + icon('alert', 'sm') +
        '<b>' + E(it.warning.text) + '</b><span class="muted">（我的 SillyTavern · 上次同步）</span><span class="faint">展开查看字段路径</span></summary>' +
        '<div class="mono">' + it.warning.paths.map(E).join('<br>') + '</div></details></td></tr>' : '';
      return '<tr><th scope="row"><a class="item-cell" href="' + href + '">' + UI.avatar(it.name[0], it.hue, 32, '8px') +
        '<div><div class="item-name">' + E(it.name) + '</div><div class="faint item-kind">' + icon(it.kind === 'character' ? 'user' : 'book', 'sm') +
        (it.kind === 'character' ? '角色' : '世界书') + ' · ' + E(it.path) + '</div></div></a></th>' +
        D.taverns.map((t) => cell(it, t)).join('') + '</tr>' + warn;
    }).join('');
  }

  /* TauriTavern offline banner — wording follows its 「酒馆未运行时」 choice; the demo switch flips that same setting */
  function offBanner() {
    const w = Detect.whenOff('tt');
    const text = w === 'wait' ? '等酒馆启动再同步：修改先留在工作区，酒馆启动后自动同步开了随时同步的项。'
      : '不开酒馆也同步：同步会直接写入数据目录，写入前先备份。';
    return '<div class="proto-switch faint">原型演示：TauriTavern 未运行时 ' +
      UI.seg([['write', '不开酒馆也同步'], ['wait', '等酒馆启动再同步']], w, 'data-key="demo-off"') + '</div>' +
      '<div class="banner" style="margin-bottom:16px">' + icon(w === 'wait' ? 'clock' : 'info') + '<div class="grow"><b>TauriTavern 离线</b><span class="muted"> · ' + text + '</span></div>' +
      '<button class="btn sm ghost" data-act="goto-detect">更改</button></div>';
  }

  function render() {
    const head = D.taverns.map((t) => '<th scope="col"><div class="tv-head"><span class="dot ' + (t.connected ? 'on' : 'off') + '"></span><div><div>' + t.name +
      '</div><div class="faint" title="' + Detect.connTip(t.id) + '">' + t.short + ' · ' + Detect.connLabel(t.id) + ' · ' +
      (Detect.offline(t.id) ? '读取数据目录' : t.connected ? 'v' + t.version : '最后在线 ' + t.lastSeen) + '</div></div></div></th>').join('');
    const legend = ['synced', 'local', 'remote', 'conflict', 'unbound'].map((s) => UI.stBadge(s)).join('') +
      '<span class="legend-off faint">· 离线 = 酒馆未运行，状态读取自数据目录</span>';
    return '<div class="page">' +
      '<div class="page-head"><div><h2>同步</h2><p class="muted">每个资料项在每个酒馆的状态。冲突不会被静默覆盖，需要逐字段处理。</p></div>' +
      '<div class="page-actions">' + UI.toggle(onlyIssues, '只看有问题的项', 'data-only') +
      '<div class="btn-group"><button class="btn primary" data-act="fake" data-msg="已同步 1 项到 我的 SillyTavern">' + icon('upload', 'sm') + '同步全部本地修改到</button>' +
      '<button class="btn primary" style="border-left-color:rgba(255,255,255,.25)">我的 SillyTavern' + icon('chevDown', 'sm') + '</button></div></div></div>' +
      '<div class="legend">' + legend + '</div>' +
      (Detect.offline('tt') ? offBanner() : '') +
      '<div class="matrix-wrap card"><table class="matrix"><thead><tr><th scope="col" class="item-col">资料项</th>' + head + '</tr></thead><tbody id="mx-body">' + rowsHtml() + '</tbody></table>' +
      '<div class="matrix-foot faint">' + icon('clock', 'sm') + '正则与预设将在阶段 4 加入同步矩阵</div></div></div>';
  }

  App.register('sync', {
    render,
    onSeg(key, v) { if (key === 'demo-off') { Detect.setOff(D.locations, 'tt', v); App.render(); } },
    mount() {
      document.querySelector('[data-only]').addEventListener('change', (e) => { onlyIssues = e.target.checked; document.getElementById('mx-body').innerHTML = rowsHtml(); });
    },
    actions: {
      /* open settings and land on the local-tavern detection list */
      'goto-detect'() {
        App.go('#settings');
        setTimeout(() => { const s = document.getElementById('set-conn'); if (s) s.scrollIntoView({ block: 'start' }); }, 80);
      }
    }
  });
})();
