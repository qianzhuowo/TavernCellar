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

/** Whether entry group `g` is `path` or inside it. @param {string} g @param {string} path */
export const inGroup = (g, path) => g === path || g.startsWith(path + '/');

/** Default depth ST gives @D entries (world_info depth default). */
export const DEFAULT_DEPTH = 4;

/** Sets the insert position; entries moved to @D without a depth get the default depth. @param {any} e @param {number} pos */
export function setPosition(e, pos) {
  e.position = pos;
  if (pos === 4 && typeof e.depth !== 'number') e.depth = DEFAULT_DEPTH;
}

/** ST's world-info sort options (index.html #world_info_sort_order, minus the search-only rule). */
export const SORTS = [
  { value: 'priority', label: '优先级' },
  { value: 'custom', label: '自定义' },
  { value: 'title-asc', label: '标题 A-Z' },
  { value: 'title-desc', label: '标题 Z-A' },
  { value: 'len-asc', label: '字数 ↗' },
  { value: 'len-desc', label: '字数 ↘' },
  { value: 'depth-asc', label: '深度 ↗' },
  { value: 'depth-desc', label: '深度 ↘' },
  { value: 'order-asc', label: '顺序 ↗' },
  { value: 'order-desc', label: '顺序 ↘' },
  { value: 'uid-asc', label: 'UID ↗' },
  { value: 'uid-desc', label: 'UID ↘' },
  { value: 'prob-asc', label: '触发% ↗' },
  { value: 'prob-desc', label: '触发% ↘' }
];
export const isSort = (/** @type {string} */ v) => SORTS.some((s) => s.value === v);

/** ST fills a missing displayIndex with the uid when it loads a book. @param {any} e */
export const displayIndexOf = (e) => (typeof e.displayIndex === 'number' ? e.displayIndex : Number(e.uid) || 0);

const FIELD = { title: 'comment', len: 'content', depth: 'depth', order: 'order', uid: 'uid', prob: 'probability' };

/** Primary comparator of a sort rule, as in ST sortWorldInfoEntries. @param {string} rule */
function primary(rule) {
  if (rule === 'custom') return (/** @type {any} */ a, /** @type {any} */ b) => displayIndexOf(a) - displayIndexOf(b);
  if (rule === 'priority') {
    const rank = (/** @type {any} */ e) => (e.disable ? 2 : e.constant ? 0 : 1);
    return (/** @type {any} */ a, /** @type {any} */ b) => rank(a) - rank(b);
  }
  const [name, dir] = rule.split('-');
  const field = FIELD[name];
  const sign = dir === 'asc' ? 1 : -1;
  return (/** @type {any} */ a, /** @type {any} */ b) => {
    const x = a[field], y = b[field];
    if (typeof x === 'string' && typeof y === 'string') return sign * (name === 'len' ? x.length - y.length : x.localeCompare(y));
    return sign * ((Number(x) || 0) - (Number(y) || 0));
  };
}

/** Sorts entries in place like ST: primary rule, then order descending, then uid ascending. @param {any[]} list @param {string} rule */
export function sortEntries(list, rule) {
  const p = primary(isSort(rule) ? rule : 'order-desc');
  return list.sort((a, b) => p(a, b) || (Number(b.order) || 0) - (Number(a.order) || 0) || (Number(a.uid) || 0) - (Number(b.uid) || 0));
}
