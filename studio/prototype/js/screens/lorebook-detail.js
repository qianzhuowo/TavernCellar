/* #lorebook — entry detail pane (§4.4 条目详情, fields per Appendix A) */
(function () {
  const E = UI.esc;
  const LOGIC = [[0, '与任意'], [3, '与所有'], [2, '非所有'], [1, '非任何']];
  const TRIGGERS = ['正常', '继续', 'AI 帮答', '滑动', '重新生成', '静默'];
  const MATCH = [['matchCharacterDescription', '角色描述'], ['matchCharacterPersonality', '角色性格'], ['matchScenario', '情景'],
    ['matchPersonaDescription', '用户设定描述'], ['matchCharacterDepthPrompt', '角色备注'], ['matchCreatorNotes', '创作者的注释']];

  const num = (label, val, o) => {
    o = o || {};
    return '<div class="field compact' + (o.disabled ? ' is-disabled' : '') + '"><label>' + label + (o.hint ? '<span class="hint">' + o.hint + '</span>' : '') + '</label>' +
      '<input class="input num" type="number" value="' + (val == null ? '' : val) + '" placeholder="' + (o.ph || '') + '"' + (o.disabled ? ' disabled' : '') + (o.attrs || '') + '></div>';
  };
  const block = (title, body, cls) => '<div class="ent-block ' + (cls || '') + '"><div class="ent-block-title">' + title + '</div>' + body + '</div>';

  function advanced(e) {
    const g = (t, body) => '<div class="adv-grp"><h4>' + t + '</h4>' + body + '</div>';
    return '<div class="ent-adv">' +
      g('递归', '<div class="checks">' + UI.check(e.excludeRecursion, '不可递归') + UI.check(e.preventRecursion, '防止进一步递归') + '</div>' +
        '<div class="inline-fields">' + UI.check(e.delayUntilRecursion > 0, '延迟到递归') + num('递归等级', e.delayUntilRecursion || '', { ph: '1' }) + '</div>') +
      g('分组', '<div class="inline-fields"><div class="field compact" style="flex:1"><label>包含组</label><input class="input" value="' + E(e.group) + '" placeholder="组名，逗号分隔"></div>' +
        num('组权重', e.groupWeight) + '</div><div class="inline-fields">' + UI.check(e.groupOverride, '确定优先级') +
        '<div class="field compact"><label>组评分</label>' + UI.tri(e.useGroupScoring) + '</div></div>') +
      g('时效', '<div class="inline-fields">' + num('黏性', e.sticky, { ph: '无' }) + num('冷却', e.cooldown, { ph: '无' }) + num('延迟', e.delay, { ph: '无' }) + '</div>') +
      g('扫描', '<div class="tri-grid">' +
        '<span>扫描深度</span><div class="inline-fields">' + UI.seg([['null', '使用全局设置', 'null'], ['num', '自定义']], e.scanDepth === null ? 'null' : 'num', 'data-key="scan"') +
        '<input class="input num" type="number" value="' + (e.scanDepth == null ? '' : e.scanDepth) + '" placeholder="全局"' + (e.scanDepth == null ? ' disabled' : '') + ' id="scan-num"></div>' +
        '<span>区分大小写</span>' + UI.tri(e.caseSensitive) +
        '<span>完整单词</span>' + UI.tri(e.matchWholeWords) + '</div>') +
      g('额外匹配来源', '<div class="checks cols-3">' + MATCH.map((m) => UI.check(e[m[0]], m[1])).join('') + '</div>') +
      g('筛选', '<div class="field compact"><label>绑定到角色或标签</label>' + UI.chipInput(e.characterFilter.names, '输入角色名或标签') + '</div>' +
        '<div class="inline-fields">' + UI.check(e.characterFilter.isExclude, '排除') + '</div>' +
        '<div class="field compact"><label>筛选生成触发器<span class="hint">都不选 = 全部</span></label><div class="trig">' +
        TRIGGERS.map((t) => '<button type="button" class="trig-btn' + (e.triggers.includes(t) ? ' on' : '') + '" data-act="trig">' + t + '</button>').join('') + '</div></div>') +
      g('其他', '<div class="checks">' + UI.check(e.ignoreBudget, '无视回复限额') + UI.check(e.addMemo, '添加备忘录') + UI.check(e.selective, '选择性') + '</div>' +
        '<div class="field compact"><label>自动化 ID</label><input class="input mono" value="' + E(e.automationId) + '" placeholder="（空）"></div>') +
      '</div>';
  }

  App.lbRenderDetail = function (e) {
    if (!e) return '<div class="empty" style="margin-top:80px">' + icon('book') + '<h3>选择一个条目</h3><p>在左侧列表中点击条目查看与编辑</p></div>';
    if (window.LB.multi.size > 1) {
      return '<div class="empty" style="margin-top:80px">' + icon('layers') + '<h3>已选 ' + window.LB.multi.size + ' 个条目</h3><p>使用上方批量操作条统一修改；单击条目回到单项编辑。</p></div>';
    }
    const lamp = UI.lampOf(e);
    const isD = e.position === 4, isOut = e.position === 7;
    return '<div class="ent">' +
      /* 标题行 */
      '<div class="ent-title"><span class="lamp ' + lamp + '"></span>' +
        '<input class="input title-input" value="' + E(e.comment) + '" placeholder="条目标题/备忘录" aria-label="条目标题/备忘录">' +
        '<span class="uid mono" title="uid">#' + e.uid + '</span>' +
        '<button class="icon-btn" title="复制条目（生成新 uid）" data-act="fake" data-msg="已复制为新条目 #40">' + icon('copy', 'sm') + '</button>' +
        '<button class="icon-btn" title="更多">' + icon('more', 'sm') + '</button></div>' +
      '<div class="ent-status"><div class="field compact"><label>状态</label>' +
        UI.seg([['const', '<span class="lamp const"></span>永久'], ['key', '<span class="lamp key"></span>关键词'], ['vec', '<span class="lamp vec"></span>向量化']], lamp, 'data-key="lamp"') + '</div>' +
        '<div class="field compact"><label>启用</label>' + UI.toggle(!e.disable, e.disable ? '已停用' : '已启用', 'data-en') + '</div></div>' +
      /* 关键字 */
      block('关键字', '<div class="field compact"><label>主要关键字<span class="hint">支持 /正则/</span></label>' + UI.chipInput(e.key, '输入关键字后回车') + '</div>' +
        '<div class="kw-row"><div class="field compact"><label>逻辑</label><select class="select" style="width:120px">' +
        LOGIC.map((l) => '<option' + (l[0] === e.selectiveLogic ? ' selected' : '') + '>' + l[1] + '</option>').join('') + '</select></div>' +
        '<div class="field compact" style="flex:1"><label>可选过滤器</label>' + UI.chipInput(e.keysecondary, '可选，与逻辑配合') + '</div></div>') +
      /* 插入 */
      block('插入', '<div class="ins-row">' +
        '<div class="field compact"><label>位置</label><select class="select" data-pos style="width:196px">' +
        UI.POS.map((p, i) => '<option value="' + i + '"' + (i === e.position ? ' selected' : '') + '>' + p + ' · ' + UI.POS_LABEL[i] + '</option>').join('') + '</select></div>' +
        num('深度', e.depth, { disabled: !isD, hint: isD ? '' : '仅 @D' }) +
        (isD ? '<div class="field compact"><label>角色</label>' + UI.seg([[0, '⚙ 系统'], [1, '👤 用户'], [2, '🤖 AI']], e.role) + '</div>' : '') +
        num('顺序', e.order) +
        '<div class="field compact"><label>触发 %</label><div class="prob"><input class="input num" type="number" min="0" max="100" value="' + e.probability + '">' +
        UI.check(e.useProbability, '使用概率') + '</div></div>' +
        (isOut ? '<div class="field compact"><label>Outlet 名称</label><input class="input mono" style="width:130px" value="' + E(e.outletName) + '"></div>' : '') +
        '</div>') +
      /* 内容 */
      '<div class="ent-content">' + UI.textField('ent-content', '内容', e.content, { rows: 10, cls: 'big' }) + '</div>' +
      /* 高级 */
      UI.collapse('ent-adv', '高级', advanced(e), { defaultClosed: true, cls: 'card ent-adv-wrap', meta: '递归 · 分组 · 时效 · 扫描 · 额外匹配来源 · 筛选 · 其他' }) +
      '<div style="height:24px"></div></div>';
  };

  App.lbMountDetail = function () {
    const t = document.getElementById('ent-content');
    if (t) { t.style.height = 'auto'; t.style.height = Math.max(240, t.scrollHeight + 2) + 'px'; }
    const pos = document.querySelector('[data-pos]');
    if (pos) pos.addEventListener('change', () => {
      const e = window.DATA.book.entries.find((x) => x.uid === window.LB.sel);
      e.position = +pos.value; App.lbRefresh(false);
    });
    const en = document.querySelector('[data-en]');
    if (en) en.addEventListener('change', () => {
      const e = window.DATA.book.entries.find((x) => x.uid === window.LB.sel);
      e.disable = !en.checked; en.nextElementSibling.nextElementSibling.textContent = en.checked ? '已启用' : '已停用';
      document.getElementById('lb-listwrap').innerHTML = App.lbRenderList();
    });
  };

  /* extra actions merged into the lorebook screen */
  const scr = App.screens.lorebook;
  scr.actions.trig = (el) => el.classList.toggle('on');
  scr.onSeg = function (key, v) {
    const e = window.DATA.book.entries.find((x) => x.uid === window.LB.sel);
    if (key === 'lamp') { e.constant = v === 'const'; e.vectorized = v === 'vec'; App.lbRefresh(false); }
    if (key === 'scan') { const n = document.getElementById('scan-num'); n.disabled = v === 'null'; if (v !== 'null') n.focus(); }
  };
  scr.onInput = function (t) {
    if (t.classList.contains('title-input')) {
      const e = window.DATA.book.entries.find((x) => x.uid === window.LB.sel);
      e.comment = t.value;
      const r = document.querySelector('.lb-row.on .lb-title'); if (r) r.firstChild.textContent = t.value || '（无标题）';
    }
  };
})();
