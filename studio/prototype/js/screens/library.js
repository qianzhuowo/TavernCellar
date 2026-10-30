/* #library — catalog of a tavern: character grid + lorebook list + preview drawer (§4.2) */
(function () {
  const D = window.DATA, E = UI.esc;
  const L = { type: 'char', q: '', sort: 'recent', tag: null, preview: null, page: 1, tv: /tv=tt/.test(location.search) ? 'tt' : 'st' };
  const RECENT = ['10 分钟前', '1 小时前', '今天 09:12', '昨天', '2 天前', '3 天前', '上周', '2 周前', '1 个月前', '从未'];

  function chars() {
    let list = D.catalogChars.filter((c) => (!L.q || c.name.includes(L.q)) && (!L.tag || c.tags.includes(L.tag)));
    list = list.slice().sort(L.sort === 'name' ? (a, b) => a.name.localeCompare(b.name, 'zh') : (a, b) => RECENT.indexOf(a.lastChat) - RECENT.indexOf(b.lastChat));
    return list;
  }

  function card(c) {
    return '<button class="cat-card" data-act="lib-open" data-id="' + c.id + '">' +
      '<div class="cat-thumb" style="background:linear-gradient(150deg,hsl(' + c.hue + ' 40% 42%),hsl(' + ((c.hue + 50) % 360) + ' 35% 20%))">' +
      '<span class="cat-initial">' + E(c.initial) + '</span>' +
      (c.inWorkspace ? '<span class="in-ws">' + icon('check', 'sm') + '已在工作区</span>' : '') + '</div>' +
      '<div class="cat-info"><div class="cat-name">' + E(c.name) + '</div>' +
      '<div class="cat-tags">' + UI.chips(c.tags) + '</div>' +
      '<div class="cat-time faint">' + icon('clock', 'sm') + c.lastChat + '</div></div></button>';
  }

  function bookRow(b) {
    return '<div class="book-row" data-act="lib-open-book" data-id="' + b.id + '" tabindex="0">' + icon('book') +
      '<div class="grow"><div class="cat-name">' + E(b.name) + '</div><div class="faint" style="font-size:12px">更新于 ' + b.updated + '</div></div>' +
      '<span class="badge">' + b.count + ' 个条目</span>' +
      (b.inWorkspace ? '<span class="in-ws static">' + icon('check', 'sm') + '已在工作区</span>' : '<button class="btn sm" data-act="lib-take" data-name="' + E(b.name) + '">' + icon('download', 'sm') + '取出到工作区</button>') + '</div>';
  }

  function body() {
    if (L.type === 'book') return '<div class="book-list card">' + D.catalogBooks.filter((b) => !L.q || b.name.includes(L.q)).map(bookRow).join('') + '</div>';
    const list = chars();
    if (!list.length) return '<div class="empty">' + icon('search') + '<h3>没有找到角色</h3><p>换个关键字，或清除标签筛选</p><button class="btn sm" data-act="lib-clear">清除筛选</button></div>';
    return '<div class="cat-grid">' + list.map(card).join('') + '</div>' +
      '<div class="load-more faint"><span class="dot wait"></span>滚动到底自动加载下一页 · 已显示 ' + list.length + ' / 186</div>';
  }

  function drawer() {
    const c = D.catalogChars.find((x) => x.id === L.preview);
    if (!c) return '';
    return '<div class="drawer-scrim" data-act="lib-close"></div><aside class="drawer" role="dialog" aria-label="预览">' +
      '<div class="drawer-head"><span class="faint">预览 · 只读</span><span style="flex:1"></span><button class="icon-btn" data-act="lib-close">' + icon('x') + '</button></div>' +
      '<div class="drawer-body"><div class="pv-hero">' + UI.avatar(c.initial, c.hue, 88, '14px') + '<div><h2>' + E(c.name) + '</h2><div class="cat-tags">' + UI.chips(c.tags, 'tag') + '</div>' +
      '<div class="faint" style="margin-top:6px;font-size:12px">最后聊天：' + c.lastChat + ' · ' + E(App.tavern(L.tv).name) + '</div></div></div>' +
      '<div class="pv-sec"><h4>角色描述</h4><p>' + E(c.blurb) + '</p></div>' +
      '<div class="pv-sec"><h4>第一条消息</h4><p class="muted">*' + E(c.name) + ' 抬起头，看向你。*"你来了。"</p></div>' +
      '<dl class="kv"><dt>其他开场</dt><dd>2 条</dd><dt>主要知识书</dt><dd>—</dd><dt>创作者</dt><dd>匿名作者</dd><dt>文件</dt><dd class="mono">' + E(c.name) + '.png</dd></dl></div>' +
      '<div class="drawer-foot"><button class="btn ghost" data-act="lib-close">关闭</button>' +
      '<button class="btn primary" data-act="lib-take" data-name="' + E(c.name) + '">' + icon('download', 'sm') + '取出到工作区</button></div></aside>';
  }

  function side() {
    const tags = [...new Set(D.catalogChars.flatMap((c) => c.tags))];
    return '<div class="panel-head">资料库</div><div class="panel-body side-filters">' +
      '<div class="field compact"><label>酒馆</label><select class="select" id="lib-tv">' + D.taverns.map((t) =>
        '<option value="' + t.id + '"' + (t.id === L.tv ? ' selected' : '') + '>' + (t.connected ? '● ' : '○ ') + E(t.name) + (t.connected ? '' : '（离线）') + '</option>').join('') + '</select></div>' +
      '<div class="field compact"><label>类型</label>' + UI.seg([['char', icon('user', 'sm') + '角色'], ['book', icon('book', 'sm') + '世界书']], L.type, 'data-key="type"') + '</div>' +
      '<div class="field compact"><label>标签</label><div class="tag-cloud">' + tags.map((t) => '<button class="chip' + (L.tag === t ? ' tag' : '') + '" data-act="lib-tag" data-t="' + t + '">' + t + '</button>').join('') + '</div></div>' +
      '<div class="side-note faint">' + icon('info', 'sm') + '<span>资料库只读浏览酒馆里的内容；取出后才会出现在工作区。</span></div></div>';
  }

  function render() {
    const t = App.tavern(L.tv), l = Detect.locOf(L.tv);
    const off = !t.connected ? '<span class="offline-badge" title="' + E(l ? l.dataDir : '') + '">' + icon('folder', 'sm') + '离线 · 直接读取数据目录</span>' : '';
    return '<div class="page lib"><div class="page-head"><div><h2>资料库' + off + '</h2><p class="muted">' + E(t.name) + ' · 186 个角色 · 8 本世界书' +
      (t.connected ? '' : ' · <span class="mono" style="font-size:12px">' + E(l.dataDir) + '</span>') + '</p></div>' +
      '<div class="page-actions">' + UI.seg([['char', '角色'], ['book', '世界书']], L.type, 'data-key="type"') +
      '<div class="search" style="width:240px">' + icon('search', 'sm') + '<input class="input" id="lib-q" placeholder="搜索名称" value="' + E(L.q) + '"></div>' +
      '<select class="select" id="lib-sort" style="width:130px"><option value="recent"' + (L.sort === 'recent' ? ' selected' : '') + '>最近聊天</option><option value="name"' + (L.sort === 'name' ? ' selected' : '') + '>名称</option></select></div></div>' +
      '<div id="lib-body">' + body() + '</div></div><div id="lib-drawer">' + drawer() + '</div>';
  }

  const refreshBody = () => { document.getElementById('lib-body').innerHTML = body(); };
  const refreshDrawer = () => { document.getElementById('lib-drawer').innerHTML = drawer(); };

  App.register('library', {
    render, side,
    mount() {
      document.getElementById('lib-q').addEventListener('input', (e) => { L.q = e.target.value; refreshBody(); });
      document.getElementById('lib-sort').addEventListener('change', (e) => { L.sort = e.target.value; refreshBody(); });
      const tv = document.getElementById('lib-tv');
      if (tv) tv.addEventListener('change', (e) => { L.tv = e.target.value; App.render(); });
      if (location.hash.includes('/preview')) { L.preview = 'c4'; refreshDrawer(); }
    },
    onSeg(key, v) { if (key === 'type') { L.type = v; App.render(); } },
    actions: {
      'lib-open'(el) {
        const c = D.catalogChars.find((x) => x.id === el.dataset.id);
        if (c.inWorkspace) App.go('#character/' + c.inWorkspace); else { L.preview = c.id; refreshDrawer(); }
      },
      'lib-open-book'(el, ev) {
        if (ev.target.closest('button')) return;
        const b = D.catalogBooks.find((x) => x.id === el.dataset.id);
        if (b.inWorkspace) App.go('#lorebook/' + b.inWorkspace); else UI.toast('预览：' + b.name + '（' + b.count + ' 个条目）', 'eye');
      },
      'lib-close'() { L.preview = null; refreshDrawer(); },
      'lib-take'(el) { L.preview = null; refreshDrawer(); UI.toast('已取出「' + el.dataset.name + '」到工作区', 'download'); },
      'lib-tag'(el) { L.tag = L.tag === el.dataset.t ? null : el.dataset.t; App.render(); },
      'lib-clear'() { L.q = ''; L.tag = null; App.render(); }
    }
  });
})();
