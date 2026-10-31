// Lorebook entry helpers shared by the list and the detail pane (docs/studio-design.md §4.4, appendix A).

/** ST world_info_position 0-7; short form for the list, label for the selector (ST wording). */
export const POS = [
  { short: '↑Char', label: '角色定义之前' },
  { short: '↓Char', label: '角色定义之后' },
  { short: '↑AN', label: '作者注释之前' },
  { short: '↓AN', label: '作者注释之后' },
  { short: '@D', label: '指定深度' },
  { short: '↑EM', label: '示例消息之前' },
  { short: '↓EM', label: '示例消息之后' },
  { short: 'Outlet', label: 'Outlet' }
];
export const ROLE_SHORT = ['⚙', '👤', '🤖'];

/** @param {any} e */
export const lampOf = (e) => (e.constant ? 'const' : e.vectorized ? 'vec' : 'key');
export const LAMP_LABEL = { const: '永久', key: '关键词', vec: '向量化' };

/** @param {any} e */
export function posShort(e) {
  const p = POS[e.position]?.short ?? String(e.position ?? '–');
  return e.position === 4 ? p + (ROLE_SHORT[e.role] ?? '') : p;
}

/** Normalizes a group path: '/'-separated, trimmed, no empty segments. @param {unknown} g */
export function normGroup(g) {
  return typeof g === 'string' ? g.split('/').map((s) => s.trim()).filter(Boolean).join('/') : '';
}

/** Cellar group of an entry (extensions.cellar.group); '' when ungrouped. @param {any} e */
export const groupOf = (e) => normGroup(e?.extensions?.cellar?.group);

/** @param {any} e @param {string} g */
export function setGroup(e, g) {
  g = normGroup(g);
  if (g) {
    e.extensions ??= {};
    e.extensions.cellar ??= {};
    e.extensions.cellar.group = g;
    return;
  }
  const c = e.extensions?.cellar;
  if (!c) return;
  delete c.group;
  if (!Object.keys(c).length) delete e.extensions.cellar;
}

/** ST inclusion groups (comma separated `group`). @param {any} e @returns {string[]} */
export const inclusionGroups = (e) => String(e.group ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const SORTS = [
  { value: 'custom', label: '自定义' },
  { value: 'order', label: '顺序' },
  { value: 'depth', label: '深度' },
  { value: 'title', label: '名称' },
  { value: 'uid', label: 'uid' },
  { value: 'trigger', label: '触发 %' }
];

/** Comparators; `idx` is the entry's position in the book (ST custom order falls back to it). */
export const SORT_FN = {
  /** @param {any} a @param {any} b */
  custom: (a, b) => (a.e.displayIndex ?? Infinity) - (b.e.displayIndex ?? Infinity) || a.idx - b.idx,
  order: (a, b) => (b.e.order ?? 0) - (a.e.order ?? 0) || a.e.uid - b.e.uid,
  depth: (a, b) => (b.e.depth ?? 0) - (a.e.depth ?? 0) || (b.e.order ?? 0) - (a.e.order ?? 0) || a.e.uid - b.e.uid,
  title: (a, b) => String(a.e.comment ?? '').localeCompare(String(b.e.comment ?? ''), 'zh') || a.e.uid - b.e.uid,
  uid: (a, b) => a.e.uid - b.e.uid,
  trigger: (a, b) => (b.e.probability ?? 100) - (a.e.probability ?? 100) || a.e.uid - b.e.uid
};
