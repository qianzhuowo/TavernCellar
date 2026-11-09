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
  },
  'world-not-in-workspace': {
    zh: (w) => `链接的世界书「${w.name}」不在工作区里，没有一起处理`,
    en: (w) => `The linked lorebook "${w.name}" is not in the workspace and was left alone`
  },
  'world-name-differs': {
    zh: (w) => `链接的世界书「${w.name}」与角色卡原名不同，没有改名，链接保持不变`,
    en: (w) => `The linked lorebook "${w.name}" is named differently from the card; it kept its name and the link`
  },
  'rename-confirmed-late': {
    zh: () => '酒馆回应超时，但回读确认已经改名，绑定已更新到新名称'
  },
  'world-rename-failed': {
    zh: (w) => `角色卡已改名，但世界书「${w.name}」未能改名：${w.detail}`,
    en: (w) => `The card was renamed, but the lorebook "${w.name}" was not: ${w.detail}`
  },
  'world-link-not-synced': {
    zh: (w) => `${w.path} 的世界书链接已在工作区更新，还没同步到 ${w.label}${w.detail ? `：${w.detail}` : '（它在那里有未同步的修改或酒馆未运行，处理后再同步）'}`,
    en: (w) => `The lorebook link of ${w.path} was updated in the workspace but not synced to ${w.label}${w.detail ? `: ${w.detail}` : ' (it has unsynced changes there or the tavern is not running; sync it afterwards)'}`
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
