/* #lorebook — entry list, filters, multi-select bulk bar (§4.4). Detail pane: lorebook-detail.js */
(function () {
  const D = window.DATA, E = UI.esc;
  const LB = window.LB = { sel: 0, multi: new Set(), q: '', f: { status: 'all', pos: 'all', en: 'all', group: 'all' }, sort: 'order', anchor: 25 };
  LB.sel = 25;

  function filtered() {
    const q = LB.q.trim().toLowerCase();
    let list = D.book.entries.filter((e) => {
      if (q && !(e.comment + ' ' + e.key.join(' ') + ' ' + e.content).toLowerCase().includes(q)) return false;
      if (LB.f.status !== 'all' && UI.lampOf(e) !== LB.f.status) return false;
      if (LB.f.pos !== 'all' && String(e.position) !== LB.f.pos) return false;
      if (LB.f.en !== 'all' && (LB.f.en === 'on') === e.disable) return false;
      if (LB.f.group !== 'all' && e.group !== LB.f.group) return false;
      return true;
    });
    const by = { order: (a, b) => b.order - a.order || a.uid - b.uid, title: (a, b) => a.comment.localeCompare(b.comment, 'zh'),
      uid: (a, b) => a.uid - b.uid, recent: (a, b) => (b.modified - a.modified) || a.uid - b.uid };
    return list.sort(by[LB.sort]);
  }

  function row(e) {
    const lamp = UI.lampOf(e);
    const on = LB.multi.size > 1 ? LB.multi.has(e.uid) : e.uid === LB.sel;
    const keys = e.key.slice(0, 2), more = e.key.length - keys.length;
    return '<div class="lb-row' + (on ? ' on' : '') + (e.disable ? ' off' : '') + '" data-act="lb-row" data-uid="' + e.uid + '" tabindex="0" role="option" aria-selected="' + on + '">' +
      '<label class="check lb-chk" data-stop><input type="checkbox" data-act="lb-check" ' + (LB.multi.has(e.uid) ? 'checked' : '') + ' aria-label="多选"></label>' +
      '<span class="lamp ' + lamp + '" title="' + UI.LAMP_LABEL[lamp] + '"></span>' +
      '<span data-stop>' + UI.toggle(!e.disable, '', 'data-act="lb-enable" aria-label="启用"', 'mini') + '</span>' +
      '<span class="lb-main"><span class="lb-title">' + E(e.comment || '（无标题）') + (e.modified ? '<span class="mod-dot" title="本地有修改"></span>' : '') + '</span>' +
      '<span class="lb-keys">' + UI.chips(keys) + (more > 0 ? '<span class="chip">+' + more + '</span>' : '') + '</span></span>' +
      '<span class="lb-pos">' + UI.posShort(e) + '</span>' +
      '<span class="lb-num">' + (e.position === 4 ? e.depth : '<span class="faint">–</span>') + '</span>' +
      '<span class="lb-num">' + e.order + '</span>' +
      '<span class="lb-num' + (e.probability < 100 ? ' warn' : '') + '">' + e.probability + '%</span></div>';
  }

  function sel(key, label, opts, val) {
    return '<label class="mini-select' + (val !== 'all' ? ' active' : '') + '"><span>' + label + '</span><select data-filter="' + key + '">' +
      opts.map((o) => '<option value="' + o[0] + '"' + (String(o[0]) === String(val) ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' + icon('chevDown', 'sm') + '</label>';
  }

  function toolbar() {
    const groups = [...new Set(D.book.entries.map((e) => e.group).filter(Boolean))];
    return '<div class="lb-tools">' +
      '<div class="lb-tools-row"><div class="search" style="flex:1">' + icon('search', 'sm') + '<input class="input" id="lb-q" placeholder="搜索标题、关键字、内容" value="' + E(LB.q) + '"><kbd>Ctrl ⇧ F</kbd></div>' +
      '<button class="btn primary" data-act="lb-new" title="新建条目">' + icon('plus', 'sm') + '新建</button></div>' +
      '<div class="lb-tools-row filters">' + icon('filter', 'sm') +
      sel('status', '状态', [['all', '全部'], ['const', '🔵 永久'], ['key', '🟢 关键词'], ['vec', '🔗 向量化']], LB.f.status) +
      sel('pos', '位置', [['all', '全部']].concat(UI.POS.map((p, i) => [i, p])), LB.f.pos) +
      sel('en', '启用', [['all', '全部'], ['on', '已启用'], ['off', '已停用']], LB.f.en) +
      sel('group', '包含组', [['all', '全部']].concat(groups.map((g) => [g, g])), LB.f.group) +
      '<span style="flex:1"></span>' +
      sel('sort', icon('sort', 'sm'), [['order', '顺序'], ['title', '标题'], ['uid', 'uid'], ['recent', '最近修改']], LB.sort) + '</div></div>';
  }

  function bookSettings() {
    return UI.collapse('book-settings', icon('book', 'sm') + '书设置', '<div class="book-set">' +
      '<div class="field"><label>描述</label><input class="input" value="' + E(D.book.settings.description) + '"></div>' +
      '<div class="extras"><div class="extra-row"><span class="mono">extensions.cellar.sortHint</span><span class="faint mono">"order"</span></div></div>' +
      '<div class="help faint" style="font-size:11px">未识别字段只读展示，原样保留。</div></div>', { defaultClosed: true, cls: 'book-wrap', meta: D.book.entries.length + ' 个条目' });
  }

  App.lbRenderList = function () {
    const list = filtered();
    const body = list.length ? list.map(row).join('')
      : '<div class="empty">' + icon('search') + '<h3>没有符合条件的条目</h3><p>试试清除筛选或换个关键字</p><button class="btn sm" data-act="lb-clear">清除筛选</button></div>';
    return '<div class="lb-head"><span></span><span></span><span>启用</span><span>条目标题/备忘录 · 主要关键字</span><span>位置</span><span>深度</span><span>顺序</span><span>触发</span></div>' +
      '<div class="lb-list" role="listbox" aria-multiselectable="true">' + body + '</div>' +
      '<div class="lb-foot faint">显示 ' + list.length + ' / ' + D.book.entries.length + ' 条 · 虚拟列表 · 拖动行修改「顺序」</div>';
  };

  function bulkBar() {
    const n = LB.multi.size;
    return '<div class="bulk' + (n > 1 ? ' show' : '') + '" id="bulk"><span class="bulk-n">已选 <b>' + n + '</b> 项</span>' +
      '<button class="btn sm" data-act="bulk" data-op="enable">' + icon('check', 'sm') + '启用</button>' +
      '<button class="btn sm" data-act="bulk" data-op="disable">' + icon('power', 'sm') + '停用</button><span class="vsep"></span>' +
      '<label class="mini-select"><span>改位置</span><select>' + UI.POS.map((p) => '<option>' + p + '</option>').join('') + '</select>' + icon('chevDown', 'sm') + '</label>' +
      '<div class="bulk-num"><span>顺序</span><select class="tiny"><option>设为</option><option>加减</option></select><input class="input num sm" value="100"></div>' +
      '<div class="bulk-num"><span>深度</span><input class="input num sm" value="4"></div>' +
      '<div class="bulk-num"><span>触发 %</span><input class="input num sm" value="100"></div>' +
      '<div class="bulk-num"><span>包含组</span><input class="input sm" style="width:84px" placeholder="组名"></div>' +
      '<button class="btn sm" data-act="bulk" data-op="apply">应用</button>' +
      '<span style="flex:1"></span><button class="btn sm danger" data-act="bulk" data-op="delete">' + icon('trash', 'sm') + '删除</button>' +
      '<button class="icon-btn" data-act="bulk-clear" title="取消选择">' + icon('x', 'sm') + '</button></div>';
  }

  function render(r) {
    if (location.hash.includes('/bulk') && LB.multi.size < 2) { LB.multi = new Set([1, 5, 6, 13, 26]); LB.sel = 5; }
    const e = D.book.entries.find((x) => x.uid === LB.sel);
    return '<div class="lb">' + bulkBar() +
      '<div class="lb-panes"><section class="lb-left">' + bookSettings() + toolbar() + '<div id="lb-listwrap" class="lb-listwrap">' + App.lbRenderList() + '</div></section>' +
      '<section class="lb-right" id="lb-detail">' + App.lbRenderDetail(e) + '</section></div></div>';
  }

  function refresh(listOnly) {
    document.getElementById('lb-listwrap').innerHTML = App.lbRenderList();
    document.getElementById('bulk').outerHTML = bulkBar();
    if (!listOnly) {
      const pane = document.getElementById('lb-detail');
      pane.innerHTML = App.lbRenderDetail(D.book.entries.find((x) => x.uid === LB.sel));
      App.lbMountDetail && App.lbMountDetail();
    }
  }
  App.lbRefresh = refresh;

  App.register('lorebook', {
    item: true, render, hideSide: true,
    mount() {
      App.lbMountDetail && App.lbMountDetail();
      const on = document.querySelector('.lb-row.on'); if (on) on.scrollIntoView({ block: 'nearest' });
      document.getElementById('lb-q').addEventListener('input', (ev) => { LB.q = ev.target.value; refresh(true); });
      document.querySelector('.lb-left').addEventListener('change', (ev) => {
        const k = ev.target.dataset.filter; if (!k) return;
        if (k === 'sort') LB.sort = ev.target.value; else LB.f[k] = ev.target.value;
        ev.target.closest('.mini-select').classList.toggle('active', k !== 'sort' && ev.target.value !== 'all');
        refresh(true);
      });
    },
    inspectorExtra() {
      const es = D.book.entries;
      const c = (f) => es.filter(f).length;
      return '<div class="insp-sec"><h4>' + icon('info', 'sm') + '本书参数</h4><dl class="kv"><dt>条目</dt><dd>' + es.length + '</dd>' +
        '<dt><span class="lamp const"></span> 永久</dt><dd>' + c((e) => e.constant) + '</dd><dt><span class="lamp key"></span> 关键词</dt><dd>' + c((e) => !e.constant && !e.vectorized) + '</dd>' +
        '<dt><span class="lamp vec"></span> 向量化</dt><dd>' + c((e) => e.vectorized) + '</dd><dt>已停用</dt><dd>' + c((e) => e.disable) + '</dd><dt>本地修改条目</dt><dd>' + c((e) => e.modified) + '</dd></dl></div>';
    },
    actions: {
      'lb-row'(el, ev) {
        if (ev.target.closest('[data-stop]')) return;
        const uid = +el.dataset.uid;
        if (ev.ctrlKey || ev.metaKey) {
          if (LB.multi.size === 0) LB.multi.add(LB.sel);
          LB.multi.has(uid) ? LB.multi.delete(uid) : LB.multi.add(uid);
        } else if (ev.shiftKey) {
          const ids = filtered().map((e) => e.uid), a = ids.indexOf(LB.anchor), b = ids.indexOf(uid);
          LB.multi = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
        } else { LB.multi.clear(); LB.anchor = uid; }
        LB.sel = uid; refresh(false);
      },
      'lb-check'(el) {
        const uid = +el.closest('.lb-row').dataset.uid;
        if (LB.multi.size === 0 && uid !== LB.sel) LB.multi.add(LB.sel);
        el.checked ? LB.multi.add(uid) : LB.multi.delete(uid);
        refresh(true);
      },
      'lb-enable'(el) {
        const e = D.book.entries.find((x) => x.uid === +el.closest('.lb-row').dataset.uid);
        e.disable = !el.checked; el.closest('.lb-row').classList.toggle('off', e.disable);
      },
      'bulk'(el) {
        const op = el.dataset.op, n = LB.multi.size;
        if (op === 'enable' || op === 'disable') D.book.entries.forEach((e) => { if (LB.multi.has(e.uid)) e.disable = op === 'disable'; });
        UI.toast({ enable: '已启用 ', disable: '已停用 ', apply: '已修改 ', delete: '已删除 ' }[op] + n + ' 个条目', op === 'delete' ? 'trash' : 'check');
        if (op === 'delete') LB.multi.clear();
        refresh(true);
      },
      'bulk-clear'() { LB.multi.clear(); refresh(true); },
      'lb-clear'() { LB.q = ''; LB.f = { status: 'all', pos: 'all', en: 'all', group: 'all' }; App.render(); },
      'lb-new'() { UI.toast('已按酒馆条目模板新建条目 #40（uid 由伴侣程序分配）', 'plus'); }
    }
  });
})();
