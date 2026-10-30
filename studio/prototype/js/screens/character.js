/* #character — character editor (§4.3) */
(function () {
  const D = window.DATA;
  const E = UI.esc;

  function greetRow(g, i, open) {
    const first = (g.split('\n').find((l) => l.trim()) || '（空）').replace(/[*"]/g, '');
    return '<div class="greet' + (open ? ' open' : '') + '" draggable="false" data-i="' + i + '">' +
      '<div class="greet-head">' +
      '<span class="grip" title="拖动排序" data-grip>' + icon('grip', 'sm') + '</span>' +
      '<span class="greet-no">#' + (i + 1) + '</span>' +
      '<button class="greet-preview" data-act="greet-toggle">' + E(first) + '</button>' +
      '<span class="wc faint" data-wc-for="greet-' + i + '">' + UI.fmtN(UI.wordCount(g)) + ' 字</span>' +
      '<button class="icon-btn" title="删除" data-act="greet-del">' + icon('trash', 'sm') + '</button>' +
      '<button class="icon-btn" data-act="greet-toggle" title="展开/收起"><span class="chev">' + icon('chevDown', 'sm') + '</span></button></div>' +
      '<div class="greet-body"><textarea class="textarea" id="greet-' + i + '" rows="4" data-wc data-autogrow spellcheck="false">' + E(g) + '</textarea></div></div>';
  }

  function sub(title, desc, body) {
    return '<div class="adv-block"><div class="adv-title"><h3>' + title + '</h3>' + (desc ? '<p>' + desc + '</p>' : '') + '</div><div class="adv-body">' + body + '</div></div>';
  }

  function advanced(c, id) {
    const roleSeg = UI.seg([['system', '系统'], ['user', '用户'], ['assistant', '助手']], c.depth_prompt.role);
    const tk = Math.round(c.talkativeness * 100);
    const worldLink = c.world
      ? '<div class="world-link">' + icon('book') + '<div class="grow"><div><b>' + E(c.world) + '</b></div><div class="faint" style="font-size:12px">' +
        icon('check', 'sm') + ' 已在工作区 · 40 个条目</div></div><button class="btn sm" data-act="go" data-href="#lorebook/frost">打开' + icon('chevRight', 'sm') + '</button></div>'
      : '<div class="world-link">' + icon('book') + '<div class="grow faint">未绑定世界书</div><button class="btn sm" data-act="go" data-href="#library">从资料库取出</button></div>';
    return '<div class="adv">' +
      sub('提示词覆盖', '可插入 <code>{{original}}</code> 引用全局设置中的原文', UI.textField('sp', '主要提示词', c.system_prompt, { rows: 3, expand: false }) +
        UI.textField('phi', '后续历史指令', c.post_history_instructions, { rows: 2, expand: false })) +
      sub('角色设定', null, UI.textField('pers', '角色设定摘要', c.personality, { rows: 2, expand: false }) +
        UI.textField('scen', '情景', c.scenario, { rows: 2, expand: false }) +
        UI.textField('mes', '对话示例', c.mes_example, { rows: 6, code: true, hint: '每段以 <START> 开头' })) +
      sub('角色备注', '按深度插入到聊天记录中', UI.textField('dp', '角色备注', c.depth_prompt.prompt, { rows: 2, expand: false }) +
        '<div class="field-row"><div class="field"><label>@ 深度</label><input class="input num" type="number" min="0" value="' + c.depth_prompt.depth + '"></div>' +
        '<div class="field"><label>角色</label>' + roleSeg + '</div></div>') +
      sub('创作者的元数据', null, '<div class="grid-2"><div class="field"><label>创作者</label><input class="input" value="' + E(c.creator) + '"></div>' +
        '<div class="field"><label>角色版本</label><input class="input mono" value="' + E(c.character_version) + '"></div></div>' +
        UI.textField('cn', '创作者的注释', c.creator_notes, { rows: 3, hint: '不随 AI 提示词发送', expand: false })) +
      sub('群聊', null, '<div class="field"><label>发言频率</label><div class="talk"><span>低</span><input type="range" min="0" max="100" value="' + tk +
        '" class="range" data-talk><span>高</span><output class="badge" id="talk-out">' + (c.talkativeness).toFixed(2) + '</output></div>' +
        '<div class="talk-marks"><span>低</span><span>正常</span><span>高</span></div></div>') +
      sub('世界书', null, '<div class="field"><label>主要知识书</label>' + worldLink + '</div>') +
      sub('其他字段', '原样保留，可在 card.json 中编辑', c.extras.length
        ? '<div class="extras">' + c.extras.map((x) => '<div class="extra-row"><span class="mono">' + E(x[0]) + '</span><span class="faint mono">' + E(x[1]) + '</span></div>').join('') + '</div>'
        : '<div class="faint">没有其他字段</div>') +
      '</div>';
  }

  function render(r) {
    const it = App.item(r.arg), c = D.chars[r.arg];
    const st = it.status.st;
    const banner = st === 'conflict'
      ? '<div class="banner conflict">' + icon('alert') + '<div class="grow"><b>与「我的 SillyTavern」存在冲突</b><span class="muted"> · 工作区与酒馆都修改了 5 个字段，暂不会同步。</span></div>' +
        '<button class="btn primary sm" data-act="go" data-href="#conflict/' + it.id + '">处理冲突</button></div>'
      : st === 'remote'
        ? '<div class="banner info">' + icon('arrowDown') + '<div class="grow"><b>酒馆有修改</b><span class="muted"> · 「我的 SillyTavern」中的版本比工作区新。</span></div>' +
          '<button class="btn sm" data-act="fake" data-msg="已从酒馆取回到工作区">' + icon('download', 'sm') + '取回</button></div>' : '';
    const greets = c.alternate_greetings.map((g, i) => greetRow(g, i, i === 0)).join('');
    return '<div class="doc">' + banner +
      '<div class="char-head">' +
        '<div class="char-avatar">' + UI.avatar(c.avatar.text, c.avatar.hue, 96, '14px') + '<span class="faint">换头像请在酒馆中操作</span></div>' +
        '<div class="char-meta">' +
          '<div class="name-row"><input class="input name-input" value="' + E(c.name) + '" placeholder="为这个角色命名" aria-label="名称">' +
          '<button class="fav' + (c.fav ? ' on' : '') + '" data-act="fav" title="添加到收藏夹" aria-pressed="' + c.fav + '">' + icon('star') + '</button></div>' +
          '<div class="field"><label>嵌入的标签</label><div class="chip-input" data-cls="tag">' + UI.chips(c.tags, 'tag', true) + '<input data-chip-input placeholder="添加标签…"></div></div>' +
          '<div class="char-sub faint">' + icon('user', 'sm') + E(c.creator) + '<span>·</span>v' + E(c.character_version) +
          (c.world ? '<span>·</span>' + icon('book', 'sm') + '<a href="#lorebook/frost">' + E(c.world) + '</a>' : '') + '</div>' +
        '</div></div>' +
      UI.textField('desc', '角色描述', c.description, { rows: 9, cls: 'big' }) +
      UI.textField('first', '第一条消息', c.first_mes, { rows: 8, cls: 'big' }) +
      '<div class="field"><div class="field-label">其他开场<span class="badge">' + c.alternate_greetings.length + '</span><span style="flex:1"></span>' +
        '<button class="btn sm" data-act="greet-add">' + icon('plus', 'sm') + '新增开场</button></div>' +
        '<div class="greets" id="greets">' + greets + '</div></div>' +
      UI.collapse('adv-' + it.id, '高级定义', advanced(c, it.id), { defaultClosed: true, cls: 'adv-wrap card', meta: '提示词覆盖 · 角色设定 · 角色备注 · 创作者的元数据 · 群聊 · 世界书' }) +
      '<div style="height:40px"></div></div>';
  }

  function renumber() {
    document.querySelectorAll('#greets .greet').forEach((g, i) => { g.dataset.i = i; g.querySelector('.greet-no').textContent = '#' + (i + 1); });
    const b = document.querySelector('#greets').closest('.field').querySelector('.badge');
    b.textContent = document.querySelectorAll('#greets .greet').length;
  }

  function mount() {
    document.querySelectorAll('textarea[data-autogrow], .tf.big textarea').forEach((t) => { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; });
    /* drag & drop reorder via the grip handle */
    const list = document.getElementById('greets');
    let dragEl = null;
    list.addEventListener('mousedown', (e) => { const g = e.target.closest('[data-grip]'); if (g) g.closest('.greet').draggable = true; });
    list.addEventListener('dragstart', (e) => { dragEl = e.target.closest('.greet'); dragEl.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    list.addEventListener('dragend', () => { if (dragEl) { dragEl.classList.remove('dragging'); dragEl.draggable = false; } dragEl = null; renumber(); });
    list.addEventListener('dragover', (e) => {
      if (!dragEl) return; e.preventDefault();
      const after = [...list.querySelectorAll('.greet:not(.dragging)')].find((el) => e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2);
      after ? list.insertBefore(dragEl, after) : list.appendChild(dragEl);
    });
  }

  App.register('character', {
    item: true, render, mount,
    inspectorExtra(it) {
      const c = D.chars[it.id];
      const total = [c.description, c.first_mes].concat(c.alternate_greetings).reduce((n, t) => n + UI.wordCount(t), 0);
      return '<div class="insp-sec"><h4>' + icon('info', 'sm') + '本项参数</h4><dl class="kv"><dt>类型</dt><dd>角色卡 · V3</dd><dt>正文字数</dt><dd>' + UI.fmtN(total) +
        '</dd><dt>其他开场</dt><dd>' + c.alternate_greetings.length + ' 条</dd><dt>标签</dt><dd>' + c.tags.length + ' 个</dd><dt>主要知识书</dt><dd>' + (E(c.world) || '—') + '</dd></dl></div>';
    },
    onInput(t) {
      if (t.matches('[data-talk]')) document.getElementById('talk-out').textContent = (t.value / 100).toFixed(2);
      if (t.tagName === 'TEXTAREA') {
        const f = t.closest('.field');
        let w = f.querySelector('.clear-warn');
        if (t.value === '' && !w) {
          w = document.createElement('div'); w.className = 'clear-warn';
          w.innerHTML = icon('alert', 'sm') + '<span>酒馆会保留原值以外的内容……清空字段在同步时不会删除酒馆中的原值，可在同步结果中查看警告。</span>';
          f.appendChild(w);
        } else if (t.value !== '' && w) w.remove();
        const g = t.closest('.greet');
        if (g) g.querySelector('.greet-preview').textContent = (t.value.split('\n').find((l) => l.trim()) || '（空）').replace(/[*"]/g, '');
      }
    },
    actions: {
      fav(el) { el.classList.toggle('on'); el.setAttribute('aria-pressed', el.classList.contains('on')); },
      'greet-toggle'(el) { el.closest('.greet').classList.toggle('open'); },
      'greet-del'(el) { el.closest('.greet').remove(); renumber(); UI.toast('已删除开场（可 Ctrl+Z 撤销）', 'trash'); },
      'greet-add'() {
        const list = document.getElementById('greets'), n = list.children.length;
        list.insertAdjacentHTML('beforeend', greetRow('', n, true)); renumber();
        list.lastElementChild.querySelector('textarea').focus();
      }
    }
  });
})();
