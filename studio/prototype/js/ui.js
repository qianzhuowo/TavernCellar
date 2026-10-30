/* UI helpers: escaping, status badges, controls, word count, actions. */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STATUS = {
    synced:   { label: '已同步', icon: 'check' },
    local:    { label: '本地有修改', icon: 'dotfill' },
    remote:   { label: '酒馆有修改', icon: 'arrowDown' },
    conflict: { label: '冲突', icon: 'alert' },
    unbound:  { label: '未绑定', icon: 'minus' },
    closed:   { label: '已关闭', icon: 'minus' }
  };
  const ORDER = ['conflict', 'remote', 'local', 'synced', 'unbound', 'closed'];

  /* opts: iconOnly, label, title, cls (e.g. 'is-off' = offline marker styling) */
  function stBadge(st, opts) {
    opts = opts || {};
    const s = STATUS[st], cls = 'st ' + st + (opts.cls ? ' ' + opts.cls : '');
    if (opts.iconOnly) return '<span class="' + cls + ' icon-only" title="' + (opts.title || opts.label || s.label) + '">' + icon(s.icon) + '</span>';
    return '<span class="' + cls + '"' + (opts.title ? ' title="' + opts.title + '"' : '') + '>' + icon(s.icon) + (opts.label || s.label) + '</span>';
  }
  /* worst status across taverns — used for tab color bars */
  function worst(item) {
    const vals = Object.values(item.status);
    return ORDER.find((o) => vals.includes(o)) || 'synced';
  }

  function toggle(checked, label, attrs, cls) {
    return '<label class="toggle ' + (cls || '') + '"><input type="checkbox" ' + (checked ? 'checked ' : '') + (attrs || '') +
      '><span class="track"></span>' + (label ? '<span class="tlabel">' + label + '</span>' : '') + '</label>';
  }
  function check(checked, label, attrs) {
    return '<label class="check"><input type="checkbox" ' + (checked ? 'checked ' : '') + (attrs || '') + '>' + label + '</label>';
  }
  /* options: [[value, label, extraClass?]] ; value compared with String() so null works */
  function seg(options, value, attrs, cls) {
    return '<div class="seg ' + (cls || '') + '" role="radiogroup" ' + (attrs || '') + '>' + options.map((o) =>
      '<button type="button" role="radio" data-act="seg" data-v="' + esc(String(o[0])) + '" class="' +
      (String(o[0]) === String(value) ? 'on ' : '') + (o[2] || '') + '" aria-checked="' + (String(o[0]) === String(value)) + '">' + o[1] + '</button>'
    ).join('') + '</div>';
  }
  /* three-state: null = 使用全局设置 */
  function tri(value, attrs) {
    return seg([['null', '使用全局设置', 'null'], ['true', '是'], ['false', '否']], value === null || value === undefined ? 'null' : value, attrs);
  }

  function chips(list, cls, removable) {
    return list.map((k) => {
      const rx = /^\/.*\/[a-z]*$/.test(k);
      return '<span class="chip ' + (cls || '') + (rx ? ' regex' : '') + '">' + esc(k) +
        (removable ? '<span class="cx" data-act="chip-x">' + icon('x', 'sm') + '</span>' : '') + '</span>';
    }).join('');
  }
  function chipInput(list, placeholder, cls) {
    return '<div class="chip-input">' + chips(list, cls, true) +
      '<input data-chip-input placeholder="' + esc(placeholder || '输入后回车') + '"></div>';
  }

  /* 字数：CJK 字符逐字计数，其余按词计数 */
  function wordCount(t) {
    t = t || '';
    const cjk = (t.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) || []).length;
    const words = (t.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g, ' ').match(/[A-Za-z0-9_{}]+/g) || []).length;
    return cjk + words;
  }
  const fmtN = (n) => n.toLocaleString('zh-CN');

  function avatar(text, hue, size, radius) {
    size = size || 40;
    return '<div class="avatar" style="width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.42) + 'px;' +
      (radius ? 'border-radius:' + radius + ';' : '') +
      'background:linear-gradient(140deg,hsl(' + hue + ' 42% 46%),hsl(' + ((hue + 40) % 360) + ' 38% 26%))">' + esc(text) + '</div>';
  }

  /* textarea with label row + footer word count */
  function textField(id, label, value, o) {
    o = o || {};
    const rows = o.rows || 6;
    return '<div class="field tf' + (o.cls ? ' ' + o.cls : '') + '" data-field="' + id + '">' +
      '<div class="field-label">' + label + (o.hint ? '<span class="hint">' + o.hint + '</span>' : '') +
      '<span style="flex:1"></span>' +
      (o.expand !== false ? '<button class="icon-btn" title="展开编辑器" data-act="expand" data-target="' + id + '">' + icon('maximize', 'sm') + '</button>' : '') +
      '</div>' +
      '<textarea class="textarea' + (o.code ? ' code' : '') + '" id="' + id + '" rows="' + rows + '" data-wc spellcheck="false"' +
      (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + '>' + esc(value) + '</textarea>' +
      '<div class="field-foot">' + (o.foot || '') + '<span class="spacer"></span><span class="wc" data-wc-for="' + id + '">' +
      fmtN(wordCount(value)) + ' 字</span></div></div>';
  }

  function collapse(key, title, body, o) {
    o = o || {};
    const closed = App.isCollapsed(key, o.defaultClosed);
    return '<section class="collapsible ' + (o.cls || '') + (closed ? ' collapsed' : '') + '" data-key="' + key + '">' +
      '<button class="collapse-head" data-act="collapse" aria-expanded="' + !closed + '">' +
      '<span class="chev">' + icon('chevDown') + '</span>' + title +
      (o.meta ? '<span class="meta">' + o.meta + '</span>' : '') + '</button>' +
      '<div class="collapse-body">' + body + '</div></section>';
  }

  const POS = ['↑Char', '↓Char', '↑AN', '↓AN', '@D', '↑EM', '↓EM', '➡️Outlet'];
  const POS_LABEL = ['角色定义之前', '角色定义之后', '作者注释之前', '作者注释之后', '指定深度', '示例消息之前', '示例消息之后', '输出到 Outlet'];
  const ROLE_ICON = ['⚙', '👤', '🤖'];
  function posShort(e) { return e.position === 4 ? '@D' + ROLE_ICON[e.role] : POS[e.position]; }
  function lampOf(e) { return e.constant ? 'const' : e.vectorized ? 'vec' : 'key'; }
  const LAMP_LABEL = { const: '永久', key: '关键词', vec: '向量化' };

  let toastTimer;
  function toast(msg, ic) {
    let el = document.getElementById('toast');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status');
    el.innerHTML = icon(ic || 'check') + '<span>' + msg + '</span>';
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2400);
  }

  window.UI = { esc, STATUS, stBadge, worst, toggle, check, seg, tri, chips, chipInput, wordCount, fmtN, avatar,
    textField, collapse, POS, POS_LABEL, ROLE_ICON, posShort, lampOf, LAMP_LABEL, toast };
})();
