// Presentation rules shared by every screen: status vocabulary, colors, tavern access modes.

/** UI status keys map 1:1 to the CSS classes .st.<key> and the color tokens --st-*. */
export const STATUS = {
  synced: { label: '已同步', icon: 'check' },
  local: { label: '本地有修改', icon: 'dot' },
  remote: { label: '酒馆有修改', icon: 'arrowDown' },
  both: { label: '两边都有修改', icon: 'alert' },
  conflict: { label: '冲突', icon: 'alert' },
  invalid: { label: '无法读取', icon: 'alert' },
  unbound: { label: '未绑定', icon: 'minus' },
  closed: { label: '已关闭', icon: 'minus' }
};

/** CSS class used for a UI status (both/invalid reuse the conflict color). */
export const STATUS_CLASS = { synced: 'synced', local: 'local', remote: 'remote', both: 'conflict', conflict: 'conflict', invalid: 'conflict', unbound: 'unbound', closed: 'closed' };

const FROM_API = {
  'in-sync': 'synced',
  'local-changes': 'local',
  'tavern-changes': 'remote',
  'both-changed': 'both',
  conflict: 'conflict',
  invalid: 'invalid'
};

/** @param {string} apiStatus */
export const uiStatus = (apiStatus) => FROM_API[apiStatus] || 'invalid';

const SEVERITY = ['conflict', 'both', 'invalid', 'remote', 'local', 'synced', 'unbound', 'closed'];

/** Worst status of an item across its bindings (drives tab color bars and tree order). */
export function worstStatus(/** @type {any} */ item) {
  if (item.error) return 'invalid';
  const vals = (item.bindings || []).map((b) => uiStatus(b.status));
  return SEVERITY.find((s) => vals.includes(s)) || 'unbound';
}

export const isDirty = (/** @type {string} */ s) => s === 'local' || s === 'remote' || s === 'both' || s === 'conflict';
export const isConflict = (/** @type {string} */ s) => s === 'conflict' || s === 'both';

export const HOST = {
  st: { name: 'SillyTavern', mark: 'ST' },
  tt: { name: 'TauriTavern', mark: 'tt' }
};

export const OFF_MODE = {
  wait: { label: '等酒馆启动再同步', short: '等启动再同步', hint: '只改工作区，不动酒馆文件；酒馆启动后，开了随时同步的项会自动同步。' },
  write: { label: '不开酒馆也同步', short: '不开酒馆也同步', hint: '直接写入酒馆数据目录，写入前先备份原文件；仅在酒馆未运行时进行。' }
};

export const PLUGIN_HINT = '在酒馆的扩展 → 安装扩展中填入仓库地址';
export const ONCE_HINT = '需在该酒馆中启用过一次 Cellar Link（用于识别同一酒馆）';
export const CLOSED_HINT = '已在设置中关闭此酒馆';
export const REPO_URL = 'https://github.com/qianzhuowo/TavernCellar';

/**
 * Access mode of a binding / target:
 * online (Cellar Link connected) | offline (tavern not running, data folder usable) | closed (接受连接 off) | none.
 */
export function bindingMode(/** @type {any} */ b, /** @type {string|undefined} */ host, /** @type {{st:boolean,tt:boolean}} */ taverns) {
  if (host && taverns && taverns[host] === false) return 'closed';
  if (b.connected) return 'online';
  if (b.offline) return 'offline';
  return 'none';
}

export const MODE_LABEL = { online: '已连接', offline: '离线', closed: '已关闭', none: '未连接' };
export const MODE_TIP = {
  online: 'Cellar Link 已连接',
  offline: '酒馆未运行 · 直接读写数据目录',
  closed: CLOSED_HINT,
  none: '酒馆未连接，且没有可用的数据目录'
};

/** Stable hue from a string, for gradient placeholders. */
export function hueOf(/** @type {string} */ s) {
  let h = 0;
  for (const ch of String(s || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/** First meaningful character of a name, skipping leading punctuation/brackets. */
export function initialOf(/** @type {string} */ name) {
  const t = String(name || '').replace(/^[\s_\-~·.、,，《》「」『』【】\[\]()（）<>"'“”‘’!！?？*#@]+/u, '');
  const first = Array.from(t || String(name || '?'))[0] || '?';
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}

/** Relative time in Chinese for a ms timestamp. */
export function relTime(/** @type {number|undefined} */ ms) {
  if (!ms) return '从未';
  const d = Date.now() - ms;
  if (d < 0) return '刚刚';
  const min = Math.floor(d / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 7) return day + ' 天前';
  if (day < 30) return Math.floor(day / 7) + ' 周前';
  if (day < 365) return Math.floor(day / 30) + ' 个月前';
  return Math.floor(day / 365) + ' 年前';
}

/** Display name of a workspace item = last path segment. */
export const itemName = (/** @type {string} */ path) => String(path).split('/').pop() || path;
