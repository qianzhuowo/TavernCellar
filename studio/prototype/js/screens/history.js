/* #history — placeholder until phase 2 (§4.7) */
(function () {
  function render() {
    const planned = [
      ['edit', '当前草稿', '尚未记录为版本的修改'],
      ['git', '已记录的版本', '像 JJ 一样随时记录、命名、回退'],
      ['wine', '每个酒馆的已部署指针', '一眼看出各酒馆用的是哪个版本'],
      ['merge', '任意两个版本的字段级对比', '与冲突视图相同的按字段比较'],
      ['upload', '把此版本同步到酒馆', '回滚或灰度发布到某个酒馆']
    ];
    return '<div class="page hist"><div class="hist-hero">' +
      '<div class="hist-icon">' + icon('history', 'lg') + '</div>' +
      '<h2>版本历史将在阶段 2 推出</h2>' +
      '<p class="muted">阶段 2 会为工作区加入 JJ 式版本管理。在此之前，工作区就是一个普通文件夹，你可以用 git 查看它的历史。</p>' +
      '<div class="hist-tip card"><div class="faint" style="font-size:12px;margin-bottom:6px">在工作区目录中运行：</div>' +
      '<code class="mono">git init &amp;&amp; git add -A &amp;&amp; git commit -m "快照"</code><br><code class="mono">git log --stat -- characters/艾琳·霜语/</code>' +
      '<button class="icon-btn" data-act="fake" data-msg="命令已复制" title="复制">' + icon('copy', 'sm') + '</button></div>' +
      '<div style="display:flex;gap:8px;justify-content:center;margin-top:16px"><button class="btn" data-act="fake" data-msg="已在终端中打开工作区">' + icon('external', 'sm') + '在终端中打开工作区</button>' +
      '<button class="btn ghost" data-act="go" data-href="#sync">查看同步状态</button></div></div>' +
      '<h3 class="hist-h">计划中的功能</h3><div class="hist-grid">' + planned.map((p) =>
        '<div class="hist-card card">' + icon(p[0]) + '<div><b>' + p[1] + '</b><div class="faint">' + p[2] + '</div></div></div>').join('') + '</div></div>';
  }
  App.register('history', { render });
})();
