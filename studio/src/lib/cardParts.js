// 文件提取 for character cards: the parts a user takes out to edit. Same ids and order as CHARACTER_PARTS in
// companion/src/codec/character.js. An extracted part gets its own files and is loaded by the card editor; a part
// that is not extracted stays inside card.json and is not loaded (item layout `exclude` lists those).

/** @typedef {{id: string, label: string, tip: string, file: string, optional?: boolean}} CardPart */

/** @type {CardPart[]} */
export const CARD_PARTS = [
  { id: 'greetings', label: '开场白', tip: '第一条消息与其他开场：first_mes.md、alternate_greetings/NN.md', file: 'alternate_greetings' },
  { id: 'regex', label: '角色正则', tip: '在「角色正则」页编辑；文件为 regex/NN-名称.json + 替换文本', file: 'regex' },
  { id: 'xiaobaix', label: '小白X脚本及变量', tip: '小白X的定时任务、模板与变量：xiaobaix/tasks/NN-名称.json + .txt、xiaobaix/template.html、xiaobaix/variables.json，在「文件」页编辑', file: 'xiaobaix', optional: true },
  { id: 'helper', label: '酒馆助手脚本及变量', tip: '酒馆助手脚本与变量：scripts/NN-名称.json + .js、variables.json，在「文件」页编辑', file: 'scripts', optional: true },
  { id: 'character_book', label: '角色世界书', tip: '绑定的世界书一起取出到工作区，在「世界书」页编辑；内嵌条目为 character_book/NNNN-备注.md', file: 'character_book' }
];

/**
 * Parts offered for an item: optional parts (小白X / 酒馆助手) only when the card has such data (status `parts`),
 * so a card without them shows no checkbox that would only extract blank files.
 * @param {any} item @returns {CardPart[]}
 */
export function partsOf(item) {
  const present = new Set(item?.parts || []);
  return CARD_PARTS.filter((p) => !p.optional || present.has(p.id));
}

/** Always extracted and always shown in the form. */
export const BASE_SECTIONS = '名称与标签、角色描述、提示词覆盖、角色设定、角色备注、创作者的元数据、群聊';

/** Parts that are extracted, from an item's layout. @param {any} item @returns {Set<string>} */
export function extractedOf(item) {
  const exclude = new Set(item?.layout?.exclude || []);
  return new Set(CARD_PARTS.map((p) => p.id).filter((id) => !exclude.has(id)));
}

/** Layout `exclude` for a set of extracted parts. @param {Set<string>} extracted */
export function excludeFor(extracted) {
  return CARD_PARTS.map((p) => p.id).filter((id) => !extracted.has(id));
}

const KEY = 'cs.extract';
/** The extraction picked last time in the checkout dialog (first time: 开场白 only). @returns {Set<string>} */
export function lastExtraction() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (Array.isArray(v)) return new Set(v.filter((id) => CARD_PARTS.some((p) => p.id === id)));
  } catch { /* ignore a broken value */ }
  return new Set(['greetings']);
}
/** @param {Set<string>} extracted */
export function rememberExtraction(extracted) {
  localStorage.setItem(KEY, JSON.stringify([...extracted]));
}
