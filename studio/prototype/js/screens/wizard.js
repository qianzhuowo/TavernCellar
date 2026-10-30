/* #wizard — first-run wizard, 3 steps (§4.1). Full screen, no chrome. */
(function () {
  const D = window.DATA;
  const W = { step: 0, tab: 'st', ws: 'default', timer: null, det: null, pending: false };
  const STEPS = ['选择工作区', '安装 Cellar Link', '连接酒馆'];

  /* wizard starts with nothing connected; the SillyTavern link arrives after ~3s (visual only) */
  function freshDetect() {
    const d = JSON.parse(JSON.stringify(D.locations));
    d.st.instances.forEach((i) => { i.connected = false; });
    d.tt.connected = false;
    return d;
  }

  function stepper() {
    return '<ol class="wz-steps">' + STEPS.map((s, i) => '<li class="' + (i < W.step ? 'done' : i === W.step ? 'on' : '') + '">' +
      '<span class="wz-n">' + (i < W.step ? icon('check', 'sm') : i + 1) + '</span>' + s + '</li>').join('<li class="wz-line" aria-hidden="true"></li>') + '</ol>';
  }

  function step0() {
    const opt = (id, ic, title, desc, extra) => '<button class="wz-opt' + (W.ws === id ? ' on' : '') + '" data-act="wz-ws" data-id="' + id + '">' +
      '<span class="wz-radio"></span>' + icon(ic, 'lg') + '<div class="grow"><b>' + title + '</b><div class="faint">' + desc + '</div>' + (extra || '') + '</div></button>';
    return '<h1>选择工作区</h1><p class="muted">工作区是一个普通文件夹，存放你从酒馆取出的角色卡与世界书。Studio 和 VS Code 改的都是这里的文件。</p>' +
      '<div class="wz-opts">' +
      opt('default', 'folder', '使用默认位置', '推荐，适合大多数人', '<div class="path-box mono" style="margin-top:8px">文档\\TavernCellar</div>') +
      opt('existing', 'folder', '选择已有文件夹…', '检测到 cellar.json 时直接打开') + '</div>';
  }

  function step1() {
    const st = ['打开 SillyTavern，点击顶部的 <b>扩展</b>（积木图标）。', '点击 <b>安装扩展</b>，在输入框中粘贴下面的仓库地址。', '安装完成后刷新页面，在扩展列表中找到 <b>Cellar Link</b>。'];
    const tt = ['打开 TauriTavern，进入 <b>扩展</b> 面板。', '选择 <b>安装扩展</b>，粘贴下面的仓库地址。', '安装完成后重新加载，在扩展列表中找到 <b>Cellar Link</b>。'];
    return '<h1>安装 Cellar Link</h1><p class="muted">Cellar Link 是运行在酒馆页面里的小插件，酒馆运行时由它负责读写。装好后它会自动连接本机的 Studio，无需任何配置。</p>' +
      UI.seg([['st', 'SillyTavern'], ['tt', 'TauriTavern']], W.tab, 'data-key="wz-tab"') +
      '<ol class="wz-howto">' + (W.tab === 'st' ? st : tt).map((s) => '<li>' + s + '</li>').join('') + '</ol>' +
      '<div class="copy-line"><span class="mono">https://github.com/qianzhuowo/TavernCellar</span><button class="btn sm" data-act="fake" data-msg="仓库地址已复制">' + icon('copy', 'sm') + '复制</button></div>';
  }

  function step2() {
    if (!W.det) W.det = freshDetect();
    return '<h1>连接酒馆</h1><p class="muted">打开酒馆页面后，Cellar Link 会自动连接。告诉伴侣程序酒馆装在哪里，酒馆没运行时也能浏览和取出。这一步可以跳过。</p>' +
      Detect.list(W.det) +
      '<div class="wz-detect-foot"><button class="btn sm" data-act="wz-redetect">' + icon('refresh', 'sm') + '重新检测</button></div>';
  }

  function render() {
    const body = [step0, step1, step2][W.step]();
    return '<div class="wz"><div class="wz-brand"><span class="brand-mark">' + icon('wine') + '</span>TavernCellar<span class="faint">· Cellar Studio</span></div>' +
      '<div class="wz-card card' + (W.step === 2 ? ' wide' : '') + '">' + stepper() + '<div class="wz-body">' + body + '</div>' +
      '<div class="wz-foot"><button class="btn ghost" data-act="wz-later">稍后再说</button><span style="flex:1"></span>' +
      (W.step > 0 ? '<button class="btn" data-act="wz-prev">' + icon('chevLeft', 'sm') + '上一步</button>' : '') +
      (W.step < 2 ? '<button class="btn primary" data-act="wz-next">下一步' + icon('chevRight', 'sm') + '</button>'
        : '<button class="btn primary" data-act="wz-done">进入资料库' + icon('chevRight', 'sm') + '</button>') +
      '</div></div><div class="wz-note faint">第 ' + (W.step + 1) + ' / 3 步 · 任何一步都可以稍后在“设置”中完成</div></div>';
  }

  function redraw() {
    const root = document.getElementById('app'), sc = root.scrollTop;
    root.innerHTML = render(); root.scrollTop = sc; mount();
  }

  /* visual only: the running SillyTavern instance links in after `ms` if SillyTavern is accepted */
  function scheduleLink(ms) {
    clearTimeout(W.timer);
    W.timer = setTimeout(() => {
      const inst = W.det.st.instances[0];
      if (App.route.name !== 'wizard' || W.step !== 2 || !W.det.st.accept || inst.connected) return;
      inst.connected = true;
      redraw();
    }, ms);
  }

  function mount() {
    if (W.step !== 2) { clearTimeout(W.timer); return; }
    if (!W.det) W.det = freshDetect();
    if (!W.pending) { W.pending = true; scheduleLink(3200); }
  }

  App.register('wizard', {
    fullscreen: true, render: () => { if (/step=(\d)/.test(location.search)) W.step = +RegExp.$1; return render(); }, mount,
    onSeg(key, v) { if (key === 'wz-tab') { W.tab = v; redraw(); } },
    actions: {
      'wz-ws'(el) { W.ws = el.dataset.id; redraw(); },
      'wz-next'() { W.step++; if (W.step === 2) { W.det = freshDetect(); W.pending = false; } redraw(); },
      'wz-prev'() { clearTimeout(W.timer); W.pending = false; W.step--; redraw(); },
      'wz-later'() { clearTimeout(W.timer); App.go('#library'); },
      'wz-done'() { clearTimeout(W.timer); App.go('#library'); },
      'dt-accept'(el) {
        const d = W.det[el.dataset.type];
        d.accept = el.checked;
        if (el.dataset.type === 'st') { d.instances.forEach((i) => { i.connected = false; }); if (d.accept) scheduleLink(1500); }
        redraw();
      },
      'wz-redetect'() {
        UI.toast('已重新检测：SillyTavern 1 个运行中，TauriTavern 未运行（可离线使用）');
        if (W.det.st.accept && !W.det.st.instances[0].connected) scheduleLink(1200);
      }
    }
  });
})();
