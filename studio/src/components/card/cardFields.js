// Card field access for the S2 editor. Edits go to `data.*`; a root-level copy of the same field (V1 mirrors and
// the copies ST / TauriTavern keep at the top level) is updated with it, but only when that copy already exists.
// Unknown fields are never touched, and `null` stays `null` until the user edits that field.

/** data-relative path -> root keys that mirror it */
const MIRRORS = {
  name: ['name'],
  description: ['description'],
  personality: ['personality'],
  scenario: ['scenario'],
  first_mes: ['first_mes'],
  mes_example: ['mes_example'],
  system_prompt: ['system_prompt'],
  post_history_instructions: ['post_history_instructions'],
  creator_notes: ['creator_notes', 'creatorcomment'],
  creator: ['creator'],
  character_version: ['character_version'],
  tags: ['tags'],
  'extensions.talkativeness': ['talkativeness'],
  'extensions.fav': ['fav']
};

/** data.extensions keys and data keys that have a form in the editor (everything else is listed as "其他字段"). */
export const KNOWN_EXT = new Set(['talkativeness', 'fav', 'world', 'depth_prompt']);
export const KNOWN_DATA = new Set([
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions',
  'creator_notes', 'creator', 'character_version', 'tags', 'alternate_greetings', 'extensions'
]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** V1 cards have no `data`: their fields live at the root. */
const hasData = (card) => isObj(card && card.data);

/**
 * @param {any} card
 * @param {string} path data-relative, dot separated ("extensions.depth_prompt.depth")
 */
export function getField(card, path) {
  if (!card) return undefined;
  let cur = hasData(card) ? card.data : card;
  for (const k of path.split('.')) {
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[k];
  }
  if (cur === undefined && !hasData(card)) return undefined;
  return cur;
}

/**
 * Sets a data field, creating parent objects as needed, and keeps existing root mirrors equal.
 * @param {any} card
 * @param {string} path
 * @param {any} value
 */
export function setField(card, path, value) {
  if (hasData(card) || !(path in MIRRORS && Object.prototype.hasOwnProperty.call(card, MIRRORS[path][0]))) {
    if (!hasData(card)) card.data = {};
    const keys = path.split('.');
    let cur = card.data;
    for (const k of keys.slice(0, -1)) {
      if (!isObj(cur[k])) cur[k] = {};
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
  }
  for (const key of MIRRORS[path] || []) {
    if (Object.prototype.hasOwnProperty.call(card, key)) card[key] = Array.isArray(value) ? [...value] : value;
  }
}

/** Short read-only summary of a value for the "其他字段" list. */
export function summarize(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.length} 项]`;
  if (isObj(v)) {
    const n = Object.keys(v).length;
    if (Array.isArray(v.entries)) return `{ ${v.entries.length} 个条目 }`;
    return `{ ${n} 个字段 }`;
  }
  if (typeof v === 'string') return v.length > 48 ? JSON.stringify(v.slice(0, 48)) + '…' : JSON.stringify(v);
  return String(v);
}

/** Fields of the card that Studio has no form for: [label path, summary]. */
export function extraFields(card) {
  const out = [];
  if (!hasData(card)) return out;
  const ext = card.data.extensions;
  if (isObj(ext)) for (const k of Object.keys(ext)) if (!KNOWN_EXT.has(k)) out.push(['data.extensions.' + k, summarize(ext[k])]);
  for (const k of Object.keys(card.data)) if (!KNOWN_DATA.has(k)) out.push(['data.' + k, summarize(card.data[k])]);
  return out;
}

/** Character count shown under text areas (code points, so CJK and emoji count as one). */
export const countChars = (/** @type {string|null|undefined} */ t) => (t ? Array.from(t).length : 0);
