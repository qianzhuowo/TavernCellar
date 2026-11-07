// Thin client for the companion HTTP API (same origin; the HttpOnly cookie set when
// /studio/ is served authenticates every call, so no token handling here).

export class ApiError extends Error {
  /** @param {string} code @param {string} message @param {any} [details] @param {number} [status] */
  constructor(code, message, details, status) {
    super(message || code);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

/**
 * @param {'GET'|'POST'|'PUT'} method
 * @param {string} path
 * @param {any} [body]
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [opt]
 *   signal: caller cancels (navigation / newer query) -> ApiError('aborted'), which callers ignore.
 *   timeoutMs: client-side ceiling so a hung request never pins UI state forever.
 */
async function call(method, path, body, opt = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; ctl.abort(); }, opt.timeoutMs || 45000);
  const onAbort = () => ctl.abort();
  if (opt.signal) {
    if (opt.signal.aborted) ctl.abort();
    else opt.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: ctl.signal
      });
    } catch (e) {
      if (timedOut) throw new ApiError('timeout', '请求超时：伴侣程序或酒馆没有及时响应');
      if (ctl.signal.aborted) throw new ApiError('aborted', '已取消');
      throw new ApiError('network', '无法连接 TavernCellar');
    }
    let json = null;
    try { json = await res.json(); } catch (e) {
      if (ctl.signal.aborted) throw new ApiError(timedOut ? 'timeout' : 'aborted', timedOut ? '请求超时' : '已取消');
    }
    if (!json) throw new ApiError('bad_response', `伴侣程序返回了无法识别的响应（HTTP ${res.status}）`, null, res.status);
    if (!json.ok) {
      const err = json.error || {};
      throw new ApiError(err.code || 'error', err.message || '请求失败', err.details, res.status);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
    if (opt.signal) opt.signal.removeEventListener('abort', onAbort);
  }
}

/** True for errors produced by our own cancellation; never show these. */
export const isAborted = (/** @type {any} */ e) => e instanceof ApiError && e.code === 'aborted';

export const api = {
  status: () => call('GET', '/api/status'),
  detect: () => call('GET', '/api/detect'),
  settings: () => call('GET', '/api/settings'),
  /** @param {{ui?: object}} patch */
  putSettings: (patch) => call('PUT', '/api/settings', patch),
  /** @param {string} dir */
  setWorkspace: (dir) => call('POST', '/api/workspace', { dir }),
  /** Copies the whole workspace to an empty folder and switches to it. @param {string} dir @param {boolean} removeOld */
  moveWorkspace: (dir, removeOld) => call('POST', '/api/workspace/move', { dir, removeOld }),
  /** @param {{st?: boolean, tt?: boolean}} v */
  setTaverns: (v) => call('POST', '/api/taverns', v),
  locations: () => call('GET', '/api/taverns/locations'),
  /** @param {{st: any[], tt: any[]}} locations */
  setLocations: (locations) => call('POST', '/api/taverns/locations', locations),
  /** @param {string} key @param {'wait'|'write'} mode */
  setOfflineSync: (key, mode) => call('POST', '/api/taverns/offline-sync', { key, mode }),
  /** @param {{target: string, kind: string, query?: string, offset?: number, limit?: number}} q @param {AbortSignal} [signal] */
  catalog: (q, signal) => call('POST', '/api/catalog', q, { signal }),
  /** @param {string} target @param {string} kind @param {string} id */
  /** @param {{exclude?: string[], withWorld?: boolean}} [opts] characters: parts not extracted; also take the bound lorebook */
  checkout: (target, kind, id, opts = {}) => call('POST', '/api/checkout', { target, kind, id, ...opts }),
  /** @param {string} path @param {string} [target] */
  sync: (path, target) => call('POST', '/api/sync', { path, target }),
  /** @param {string} path @param {string} [target] */
  pull: (path, target) => call('POST', '/api/pull', { path, target }),
  /** @param {string} path @param {string} target @param {boolean} enabled */
  autoSync: (path, target, enabled) => call('POST', '/api/auto-sync', { path, target, enabled }),
  unbind: (path, target) => call('POST', '/api/unbind', { path, target }),
  remove: (path, keepFiles) => call('POST', '/api/remove', { path, keepFiles }),
  bind: (path, target, id) => call('POST', '/api/bind', { path, target, id }),
  /** One item read from a tavern without checking it out (预设工坊). */
  tavernItem: (target, kind, id) => call('POST', '/api/tavern/item', { target, kind, id }),
  /** New unbound workspace item made in Cellar. @param {string} kind @param {string} [name] */
  createItem: (kind, name) => call('POST', '/api/create', { kind, name }),
  /** Creates an unbound item in a tavern and binds it there. */
  publish: (path, target, name) => call('POST', '/api/publish', { path, target, name }),
  /** Conflicting slots of one binding. @param {string} path @param {string} [target] */
  conflict: (path, target) => call('POST', '/api/conflict', { path, target }),
  /**
   * @param {string} path @param {string} target
   * @param {Record<string, 'workspace'|'tavern'|{value:any}|{delete:true}>} choices one per conflicting slot
   */
  resolveConflict: (path, target, choices) => call('POST', '/api/conflict/resolve', { path, target, choices }),
  // Editors (S2/S3): structured item data guarded by the workspace hash.
  item: (path) => call('POST', '/api/item', { path }),
  /** @param {string[]} [omitted] character parts the editor did not load (from item()); kept as stored */
  putItem: (path, data, hash, omitted) => call('PUT', '/api/item', { path, data, hash, omitted }),
  editEntries: (path, hash, ops) => call('POST', '/api/item/entries', { path, hash, ops }),
  /** Character parts kept in card.json instead of their own files. @param {string} path @param {string[]} exclude */
  setLayout: (path, exclude) => call('POST', '/api/layout', { path, exclude }),
  /** Files an item folder is made of (split parts and the user's own files). @param {string} path */
  itemFiles: (path) => call('POST', '/api/item/files', { path }),
  /** @param {string} path @param {string} file item-relative, "/"-separated */
  itemFile: (path, file) => call('POST', '/api/item/file', { path, file }),
  /** Replaces one file when it still has `hash`; the result's `error` says when the item no longer parses. */
  putItemFile: (path, file, text, hash) => call('PUT', '/api/item/file', { path, file, text, hash }),
  /** Version history (docs/versioning.md). @param {{path?: string, limit?: number}} [q] */
  history: (q = {}) => call('POST', '/api/history', q),
  describeDraft: (message) => call('POST', '/api/history/describe', { message }),
  recordVersion: (message) => call('POST', '/api/history/commit', { message }),
  tagVersion: (name, rev) => call('POST', '/api/history/tag', { name, rev }),
  diffVersions: (from, to, path) => call('POST', '/api/history/diff', { from, to, path }),
    restoreVersion: (rev, path) => call('POST', '/api/history/restore', { rev, path }),
  /** One item's data in a version (预设工坊). */
  itemAt: (rev, path) => call('POST', '/api/history/item', { rev, path }),
  collection: () => call('POST', '/api/workshop/collection', {}),
  saveCollection: (collection, hash) => call('PUT', '/api/workshop/collection', { collection, hash }),
    /** Deploy a version to one tavern and pin the bindings there; the workspace is not changed. */
    pushVersion: (rev, target, { paths, force } = {}) => call('POST', '/api/push', { rev, target, paths, force }),
    /** End a pin: the binding follows the workspace again. */
    follow: (path, target) => call('POST', '/api/follow', { path, target }),
    /**
     * Prompt preview (phase 5): the tavern dry-runs the next reply of the chat open in it. A dry run may tokenize a
     * long chat, so the client waits a little longer than the companion's own 120 s limit.
     * @param {string} target @param {string} [input] test text, added as the quiet prompt
     */
    preview: (target, input) => call('POST', '/api/preview', { target, input: input || undefined }, { timeoutMs: 130000 })
};

/** Shown when a tavern page stops answering (usually a backgrounded, frozen browser tab). */
export const UNRESPONSIVE_TEXT = '酒馆页面没有响应：可能被浏览器置于后台休眠。切换到酒馆页面后会自动恢复。';

/** Human message for an API error, keyed by the contract's error codes. */
export function errorText(e) {
  if (!(e instanceof ApiError)) return String((e && e.message) || e);
  switch (e.code) {
    case 'conflict': return (e.message && /[\u4e00-\u9fff]/.test(e.message) ? e.message.replace(/^.*?与酒馆/, '与酒馆') : '存在冲突') + '。请在「处理冲突」中逐项选择';
    case 'waiting_for_tavern': return '酒馆未运行：修改已留在工作区，酒馆启动后再同步';
    case 'tavern_running': return '酒馆正在运行：请在酒馆中启用 Cellar Link 后同步';
    case 'not_connected': return '酒馆未连接';
    case 'unauthorized': return '未授权：请从伴侣程序重新打开 Studio';
    case 'not_found': return e.message || '找不到该资料项';
    case 'timeout': return /[\u4e00-\u9fff]/.test(e.message || '') ? e.message : UNRESPONSIVE_TEXT;
    case 'no_chat': return e.message || '酒馆里没有打开角色聊天';
    case 'busy': return e.message || '酒馆正忙，稍后再试';
    default: return e.message || e.code;
  }
}
