// Chat-completion preset prompts as ST's prompt manager shows them: the global prompt order (character_id 100001)
// decides order and on/off; prompts that are not in it are "未插入" (ST lists them only in its "insert" picker).
// Shared by the preset editor and 预设工坊.

/** @typedef {{p: any, o: any|null, n: number}} PromptRow  o = order entry (null = 未插入); n = 1-based place in the order (0 = 未插入) */

/** @param {any} data @returns {any[]} */
export function promptsOf(data) {
  return Array.isArray(data?.prompts) ? data.prompts : [];
}

/** The global prompt order list (mutable, inside `data`), or null. @param {any} data @returns {any[]|null} */
export function globalOrderOf(data) {
  const po = data?.prompt_order;
  const g = Array.isArray(po) ? po.find((/** @type {any} */ x) => String(x?.character_id) === '100001') : null;
  return Array.isArray(g?.order) ? g.order : null;
}

/** Prompts in global order, then the ones not in it. @param {any} data @returns {PromptRow[]} */
export function orderedPrompts(data) {
  const prompts = promptsOf(data);
  const byId = new Map(prompts.map((p) => [p.identifier, p]));
  /** @type {PromptRow[]} */
  const out = [];
  const seen = new Set();
  for (const o of globalOrderOf(data) || []) {
    const p = byId.get(o?.identifier);
    if (p && !seen.has(p)) { out.push({ p, o, n: out.length + 1 }); seen.add(p); }
  }
  for (const p of prompts) if (!seen.has(p)) out.push({ p, o: null, n: 0 });
  return out;
}

/** List filter: 默认 = the prompts in the order (what ST's prompt manager lists, on or off). */
export const PROMPT_FILTERS = [
  { value: 'default', label: '默认' },
  { value: 'all', label: '全部' },
  { value: 'on', label: '启用' },
  { value: 'off', label: '禁用' },
  { value: 'system', label: '系统' },
  { value: 'user', label: '用户' },
  { value: 'assistant', label: '助手' }
];
export const FILTER_TIPS = {
  default: '已插入提示词顺序的条目（启用与停用）',
  all: '所有条目，包括未插入提示词顺序的',
  on: '已插入且启用的条目',
  off: '已插入但停用的条目',
  system: '角色为系统的条目（含未插入的）',
  user: '角色为用户的条目（含未插入的）',
  assistant: '角色为 AI 助手的条目（含未插入的）'
};

/** Role of a prompt as ST reads it (missing = system). @param {any} p */
export const roleOf = (p) => (p?.role === 'user' || p?.role === 'assistant' ? p.role : 'system');

/**
 * @param {PromptRow[]} rows @param {string} filter one of PROMPT_FILTERS @param {string} [query] name/content search
 * @returns {PromptRow[]}
 */
export function filterPrompts(rows, filter, query = '') {
  const q = query.trim().toLowerCase();
  return rows.filter(({ p, o }) => {
    if (filter === 'default' && !o) return false;
    if (filter === 'on' && !o?.enabled) return false;
    if (filter === 'off' && (!o || o.enabled)) return false;
    if ((filter === 'system' || filter === 'user' || filter === 'assistant') && roleOf(p) !== filter) return false;
    return !q || String(p.name || '').toLowerCase().includes(q) || String(p.content || '').toLowerCase().includes(q);
  });
}
