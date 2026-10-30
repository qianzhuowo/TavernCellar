/* #conflict — field-level conflict resolution (§4.5 冲突处理) */
(function () {
  const D = window.DATA, E = UI.esc;
  const choices = { f1: 'merge', f3: 'ws', f4: 'tv', a0: 'ws', 'm1-0': 'ws' };
  let showBase = false;

  /* char-level LCS diff: returns [[op, text]] with op in '=', '+', '-' */
  function diff(a, b) {
    const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = []; let i = 0, j = 0;
    const push = (op, ch) => { const l = out[out.length - 1]; if (l && l[0] === op) l[1] += ch; else out.push([op, ch]); };
    while (i < n && j < m) { if (a[i] === b[j]) { push('=', a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) push('-', a[i++]); else push('+', b[j++]); }
    while (i < n) push('-', a[i++]); while (j < m) push('+', b[j++]);
    return out;
  }
  const renderDiff = (from, to) => diff(from, to).map(([op, t]) => op === '=' ? E(t) : op === '+' ? '<ins>' + E(t) + '</ins>' : '<del>' + E(t) + '</del>').join('');

  function choiceSeg(id, kind) {
    const opts = kind === 'add' ? [['ws', '保留'], ['tv', '丢弃']] : kind === 'del' ? [['tv', '确认删除'], ['ws', '保留']]
      : [['ws', '用工作区'], ['tv', '用酒馆'], ['merge', '手动合并']];
    return UI.seg(opts, choices[id] || '', 'data-key="' + id + '"', 'choice');
  }

  function fieldRow(id, f) {
    const c = choices[id] || '';
    const base = f.base != null ? f.base : f.tv;
    const left = f.base != null ? renderDiff(base, f.ws) : renderDiff(f.tv, f.ws);
    const right = f.base != null ? renderDiff(base, f.tv) : E(f.tv);
    return '<div class="cf-field' + (c ? ' chosen-' + c : '') + '" data-id="' + id + '">' +
      '<div class="cf-head"><div class="cf-label">' + (c ? icon('check', 'sm') : '<span class="pending-dot"></span>') + '<b>' + E(f.label) + '</b>' + (f.path ? '<span class="mono faint">' + E(f.path) + '</span>' : '') + '</div>' + choiceSeg(id) + '</div>' +
      '<div class="cf-cols' + (showBase && f.base != null ? ' with-base' : '') + '">' +
      (showBase && f.base != null ? '<div class="cf-side base"><div class="cf-side-h">基准版本</div><div class="cf-text' + (f.long ? ' long' : '') + '">' + E(f.base) + '</div></div>' : '') +
      '<div class="cf-side ws"><div class="cf-side-h">' + icon('folder', 'sm') + '工作区</div><div class="cf-text' + (f.long ? ' long' : '') + '">' + left + '</div></div>' +
      '<div class="cf-side tv"><div class="cf-side-h">' + icon('wine', 'sm') + '酒馆 · 我的 SillyTavern</div><div class="cf-text' + (f.long ? ' long' : '') + '">' + right + '</div></div></div>' +
      (c === 'merge' ? '<div class="cf-merge"><div class="cf-side-h">' + icon('merge', 'sm') + '合并结果（可编辑）</div><textarea class="textarea" rows="' + (f.long ? 4 : 1) + '">' + E(f.ws) + '</textarea></div>' : '') +
      '</div>';
  }

  function allIds(arg) {
    if (arg !== 'frost') return D.conflict.fields.map((f, i) => 'f' + i);
    const b = D.conflict.book;
    return b.added.map((x, i) => 'a' + i).concat(b.removed.map((x, i) => 'r' + i), ...b.modified.map((m, i) => m.fields.map((f, j) => 'm' + i + '-' + j)));
  }

  function entryLine(id, e, kind) {
    const c = choices[id];
    const who = e.side === 'ws' ? '工作区' : '酒馆';
    return '<div class="cf-entry' + (c ? ' chosen-' + c : '') + '"><span class="cf-kind ' + kind + '">' + (kind === 'add' ? '+' : '−') + '</span>' +
      '<span class="uid mono">#' + e.uid + '</span><b>' + E(e.comment) + '</b><span class="faint">在' + who + (kind === 'add' ? '新增' : '删除') + '</span>' +
      '<span style="flex:1"></span>' + choiceSeg(id, kind) + '</div>';
  }

  function bookBody() {
    const b = D.conflict.book;
    const grp = (t, ic, n, body) => '<section class="cf-group"><h3>' + icon(ic, 'sm') + t + '<span class="badge">' + n + '</span></h3>' + body + '</section>';
    return grp('新增的条目', 'plus', b.added.length, b.added.map((e, i) => entryLine('a' + i, e, 'add')).join('')) +
      grp('删除的条目', 'trash', b.removed.length, b.removed.map((e, i) => entryLine('r' + i, e, 'del')).join('')) +
      grp('修改的条目', 'edit', b.modified.length, b.modified.map((m, i) => '<div class="cf-mod"><div class="cf-mod-h"><span class="uid mono">#' + m.uid + '</span><b>' + E(m.comment) + '</b><span class="faint">' + m.fields.length + ' 个字段两边都改了</span></div>' +
        m.fields.map((f, j) => fieldRow('m' + i + '-' + j, f)).join('') + '</div>').join(''));
  }

  function summary(arg) {
    const ids = allIds(arg), done = ids.filter((id) => choices[id]).length;
    const cnt = (v) => ids.filter((id) => choices[id] === v).length;
    return '<div class="cf-summary" id="cf-summary"><div class="cf-prog"><div><b>' + done + '</b> / ' + ids.length + ' 项已选定</div>' +
      '<div class="bar"><span style="width:' + (done / ids.length * 100) + '%"></span></div></div>' +
      '<div class="cf-counts"><span>' + icon('folder', 'sm') + '用工作区 ' + cnt('ws') + '</span><span>' + icon('wine', 'sm') + '用酒馆 ' + cnt('tv') + '</span><span>' + icon('merge', 'sm') + '手动合并 ' + cnt('merge') + '</span></div>' +
      '<span style="flex:1"></span><button class="btn sm ghost" data-act="cf-all" data-v="ws">全部用工作区</button><button class="btn sm ghost" data-act="cf-all" data-v="tv">全部用酒馆</button>' +
      '<button class="btn primary" data-act="cf-apply"' + (done < ids.length ? ' disabled title="还有未选定的项"' : '') + '>' + icon('sync', 'sm') + '应用并同步</button></div>';
  }

  function render(r) {
    const isBook = r.arg === 'frost';
    const it = App.item(r.arg);
    const body = isBook ? bookBody() : D.conflict.fields.map((f, i) => fieldRow('f' + i, f)).join('');
    return '<div class="page cf">' +
      '<div class="page-head"><div><div class="crumb faint"><a href="#' + (isBook ? 'lorebook/frost' : 'character/eirin') + '">' + icon('chevLeft', 'sm') + '返回编辑</a></div>' +
      '<h2>' + icon('alert') + '处理冲突 · ' + E(it.name) + '</h2>' +
      '<p class="muted">工作区和「我的 SillyTavern」在上次同步后都修改了以下字段。逐项选择保留哪一边；应用后写入工作区，并以酒馆当前版本为基准写回酒馆。</p></div>' +
      '<div class="page-actions">' + UI.toggle(showBase, '显示基准版本', 'data-base') + '</div></div>' +
      '<div class="proto-switch faint">原型演示：' + UI.seg([['eirin', '角色冲突'], ['frost', '世界书冲突']], isBook ? 'frost' : 'eirin', 'data-key="demo"') + '</div>' +
      summary(r.arg) + '<div class="cf-list" id="cf-list">' + body + '</div></div>';
  }

  function refresh() { const ed = document.getElementById('editor'), top = ed.scrollTop; ed.innerHTML = render(App.route); bind(); ed.scrollTop = top; }
  function bind() {
    const b = document.querySelector('[data-base]');
    if (b) b.addEventListener('change', (e) => { showBase = e.target.checked; refresh(); });
  }

  App.register('conflict', {
    item: true, render, mount: bind, hideSide: true,
    inspectorExtra() {
      return '<div class="insp-sec"><h4>' + icon('info', 'sm') + '冲突详情</h4><dl class="kv"><dt>酒馆</dt><dd>我的 SillyTavern</dd><dt>基准哈希</dt><dd class="mono">3f9a…c21e</dd>' +
        '<dt>酒馆哈希</dt><dd class="mono">b70d…5e48</dd><dt>工作区哈希</dt><dd class="mono">e12c…90af</dd><dt>发现于</dt><dd>2 分钟前</dd></dl></div>';
    },
    onSeg(key, v) {
      if (key === 'demo') { App.go('#conflict/' + v); return; }
      choices[key] = v; refresh();
    },
    actions: {
      'cf-all'(el) { allIds(App.route.arg).forEach((id) => { choices[id] = id[0] === 'r' ? (el.dataset.v === 'ws' ? 'ws' : 'tv') : el.dataset.v; }); refresh(); },
      'cf-apply'() { UI.toast('已写入工作区并同步到 我的 SillyTavern'); }
    }
  });
  App.cfPreset = (o) => Object.assign(choices, o);
})();
