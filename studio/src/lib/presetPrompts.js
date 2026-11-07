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

/** The global order list, created (empty) when the preset has none. @param {any} data @returns {any[]} */
export function ensureGlobalOrder(data) {
  const have = globalOrderOf(data);
  if (have) return have;
  if (!Array.isArray(data.prompt_order)) data.prompt_order = [];
  data.prompt_order.push({ character_id: 100001, order: [] });
  return /** @type {any[]} */ (globalOrderOf(data));
}

/** Why a prompt cannot be copied, or ''. Placeholders (marker) get their content from the tavern. @param {any} p */
export const copyBlock = (p) => (p?.marker ? '占位条目的内容由酒馆生成，不能复制' : '');
/** Why a prompt cannot be deleted, or ''. ST recreates its built-in prompts (system_prompt) and placeholders. @param {any} p */
export const deleteBlock = (p) => (p?.marker ? '占位条目不能删除' : p?.system_prompt ? '酒馆内置的条目不能删除' : '');

/**
 * Copies a prompt right below itself: same name and content, a new identifier, not built-in; in the global order it
 * follows the original with the same on/off (a 未插入 prompt gives a 未插入 copy). Returns the new identifier, or ''.
 * @param {any} data @param {string} identifier
 */
export function duplicatePrompt(data, identifier) {
  const prompts = promptsOf(data);
  const i = prompts.findIndex((p) => p.identifier === identifier);
  if (i < 0 || copyBlock(prompts[i])) return '';
  const id = crypto.randomUUID();
  prompts.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(prompts[i])), identifier: id, system_prompt: false });
  const order = globalOrderOf(data);
  const oi = order ? order.findIndex((/** @type {any} */ o) => o?.identifier === identifier) : -1;
  if (order && oi >= 0) order.splice(oi + 1, 0, { identifier: id, enabled: !!order[oi].enabled });
  return id;
}

/** Deletes prompts (skipping the ones deleteBlock refuses) from the list and from every prompt order. Returns how many. @param {any} data @param {string[]} ids */
export function removePrompts(data, ids) {
  const prompts = promptsOf(data);
  const gone = new Set(prompts.filter((p) => ids.includes(p.identifier) && !deleteBlock(p)).map((p) => p.identifier));
  if (!gone.size) return 0;
  data.prompts = prompts.filter((p) => !gone.has(p.identifier));
  for (const po of Array.isArray(data.prompt_order) ? data.prompt_order : []) {
    if (Array.isArray(po?.order)) po.order = po.order.filter((/** @type {any} */ o) => !gone.has(o?.identifier));
  }
  return gone.size;
}

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
