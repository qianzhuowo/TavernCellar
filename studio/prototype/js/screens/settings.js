/* #settings (§4.6) */
(function () {
  const D = window.DATA, E = UI.esc;

  const row = (label, desc, ctl) => '<div class="set-row"><div class="set-label"><div>' + label + '</div>' + (desc ? '<div class="faint">' + desc + '</div>' : '') + '</div><div class="set-ctl">' + ctl + '</div></div>';
  const sec = (id, ic, title, body, note) => '<section class="set-sec card" id="set-' + id + '"><h3>' + icon(ic) + title + (note ? '<span class="badge">' + note + '</span>' : '') + '</h3>' + body + '</section>';

  function render() {
    const s = App.state;
    const taverns = D.taverns.map((t) => '<div class="known-tv"><span class="dot ' + (t.connected ? 'on' : 'off') + '"></span>' +
      '<input class="input" value="' + E(t.name) + '" style="max-width:200px"><span class="badge">' + t.short + '</span>' +
      '<span class="mono kt-origin">' + E(t.origin) + '</span>' +
      '<span class="faint">' + (t.connected ? '已连接 · ' + t.type + ' ' + t.version : '未连接 · 最后在线 ' + t.lastSeen) + '</span><span style="flex:1"></span>' +
      '<button class="btn sm ghost danger" data-act="fake" data-msg="已移除 ' + E(t.name) + '">' + icon('trash', 'sm') + '移除</button></div>').join('');
    return '<div class="page settings"><div class="page-head"><div><h2>设置</h2><p class="muted">设置保存在本机，不会写入工作区。</p></div></div>' +
      sec('ws', 'folder', '工作区',
        row('当前路径', null, '<div class="path-box mono" style="flex:1">' + E(D.workspace.path) + '</div>') +
        row('', null, '<button class="btn sm">切换…</button><button class="btn sm">新建…</button><button class="btn sm ghost" data-act="fake" data-msg="已在资源管理器中打开">' + icon('external', 'sm') + '在资源管理器中打开</button>')) +
      sec('conn', 'plug', '连接',
        row('端口', '伴侣程序只监听本机', '<div class="path-box mono" title="只读">127.0.0.1:' + D.port + '</div>') +
        '<div class="set-sub"><div class="set-sub-h">本机酒馆<span style="flex:1"></span>' +
          '<button class="btn sm" data-act="set-redetect">' + icon('refresh', 'sm') + '重新检测</button></div>' +
          Detect.list(D.locations) + '</div>' +
        '<div class="set-sub"><div class="set-sub-h">已知酒馆</div>' + taverns +
          '<div class="set-note faint">' + icon('info', 'sm') + '无需令牌：只有本机酒馆页面能连接伴侣程序。</div></div>') +
      sec('editor', 'type', '编辑器',
        row('主题', null, UI.seg([['dark', icon('moon', 'sm') + '深色'], ['light', icon('sun', 'sm') + '浅色'], ['system', '跟随系统']], s.theme, 'data-key="theme"')) +
        row('界面密度', '世界书列表行高 紧凑 32px / 舒适 40px', UI.seg([['comfortable', '舒适'], ['compact', '紧凑']], s.density, 'data-key="density"')) +
        row('正文字体', '用于角色描述、开场白、世界书内容等长文本', UI.seg([['sans', '无衬线'], ['serif', '衬线'], ['mono', '等宽']], s.font, 'data-key="font"') +
          '<select class="select" style="width:90px"><option>14px</option><option selected>15px</option><option>16px</option><option>18px</option></select>') +
        row('行宽限制', '长文本编辑区的最大宽度', '<select class="select" style="width:160px"><option>不限制</option><option selected>适中（约 46 字）</option><option>较窄（约 36 字）</option></select>') +
        row('显示字数', '阶段 5 起改为显示词符数', UI.toggle(true, ''))) +
      sec('ext', 'external', '外部编辑器',
        row('命令', '用于"在 VS Code 中打开"', '<input class="input mono" value="code" style="max-width:240px">')) +
      sec('app', 'box', '应用', 
        row('开机启动', null, UI.toggle(false, '')) +
        row('关闭窗口时最小化到托盘', null, UI.toggle(false, '')) +
        row('自动检查更新', null, UI.toggle(true, '')), '仅桌面版') +
      '<div class="faint" style="text-align:center;font-size:12px;padding:8px 0 32px">Cellar Studio 原型 · 伴侣程序 127.0.0.1:' + D.port + ' · <a href="#wizard">重新运行首次启动向导</a></div></div>';
  }

  function side() {
    const items = [['ws', 'folder', '工作区'], ['conn', 'plug', '连接'], ['editor', 'type', '编辑器'], ['ext', 'external', '外部编辑器'], ['app', 'box', '应用']];
    return '<div class="panel-head">设置</div><div class="panel-body">' + items.map((i, k) =>
      '<div class="tree-item' + (k === 0 ? ' on' : '') + '" style="padding-left:12px" data-act="set-jump" data-id="' + i[0] + '" tabindex="0">' + icon(i[1], 'sm') + '<span class="name">' + i[2] + '</span></div>').join('') + '</div>';
  }

  App.register('settings', {
    render, side,
    mount() {
      const m = /sec=(\w+)/.exec(location.search), s = m && document.getElementById('set-' + m[1]);
      if (s) s.scrollIntoView({ block: 'start' });
    },
    onSeg(key, v) {
      if (key === 'theme') { App.setTheme(v === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : v); }
      if (key === 'density') { App.state.density = v; App.persist.set('cs.density', v); App.applyPrefs(); }
      if (key === 'font') { App.state.font = v; App.persist.set('cs.font', v); App.applyPrefs(); }
    },
    actions: {
      'set-redetect'() { UI.toast('已重新检测：SillyTavern 1 个运行中，TauriTavern 未运行（可离线使用）'); },
      'dt-accept'(el) {
        const d = D.locations[el.dataset.type];
        d.accept = el.checked;
        UI.toast(Detect.META[el.dataset.type].name + (d.accept ? ' 的连接已接受' : ' 的连接将被拒绝'));
        const ed = document.getElementById('editor'), t = ed.scrollTop; ed.innerHTML = render(); ed.scrollTop = t;
      },
      'set-jump'(el) {
        document.querySelectorAll('.side .tree-item').forEach((x) => x.classList.toggle('on', x === el));
        document.getElementById('set-' + el.dataset.id).scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });
})();
