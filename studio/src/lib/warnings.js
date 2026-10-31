// Sync / checkout warnings come from the companion and Cellar Link as { code, ...params }; this is the one place
// that words them, in the language chosen in Settings (ui.messageLang, default Chinese). Plain strings (older
// Cellar Link versions, or warnings stored before codes existed) are shown as written.

const fields = (/** @type {string[]|undefined} */ paths, /** @type {'zh'|'en'} */ lang) =>
  paths && paths.length ? paths.join(', ') : lang === 'zh' ? '（仅键顺序不同）' : '(key order only)';

/** @type {Record<string, Record<'zh'|'en', (w: any) => string>>} */
const TEXT = {
  normalized: {
    zh: (w) => `酒馆保存时改写了这些字段：${fields(w.paths, 'zh')}`,
    en: (w) => `Tavern normalized the saved data: ${fields(w.paths, 'en')}`
  },
  'kept-deleted': {
    zh: (w) => `酒馆保留了已删除的字段：${fields(w.paths, 'zh')}`,
    en: (w) => `Tavern kept deleted fields: ${fields(w.paths, 'en')}`
  },
  'workspace-updated': {
    zh: () => '工作区已更新为酒馆实际保存的内容',
    en: () => 'Workspace updated to match the tavern'
  },
  'offline-written': {
    zh: (w) => `已离线写入 ${w.file}（备份：${w.backup}）`,
    en: (w) => `Written offline to ${w.file} (backup: ${w.backup})`
  },
  'round-trip': {
    zh: (w) => `工作区文件不能逐字还原酒馆数据，不同的字段：${fields(w.paths, 'zh')}`,
    en: (w) => `Workspace files do not round-trip to the tavern data exactly; differing fields: ${fields(w.paths, 'en')}`
  },
  'world-checkout-failed': {
    zh: (w) => `绑定的世界书「${w.name}」未能取出：${w.detail}`,
    en: (w) => `The linked lorebook "${w.name}" could not be checked out: ${w.detail}`
  }
};

/** @param {any} w @param {string} [lang] @returns {string} */
export function warningText(w, lang = 'zh') {
  if (typeof w === 'string') return w;
  const l = lang === 'en' ? 'en' : 'zh';
  const t = w && TEXT[w.code];
  if (t) return t[l](w);
  return l === 'zh' ? `未知提示：${JSON.stringify(w)}` : `Unknown warning: ${JSON.stringify(w)}`;
}
