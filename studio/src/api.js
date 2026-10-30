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
 */
async function call(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
  } catch (e) {
    throw new ApiError('network', '无法连接 TavernCellar');
  }
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  if (!json) throw new ApiError('bad_response', `伴侣程序返回了无法识别的响应（HTTP ${res.status}）`, null, res.status);
  if (!json.ok) {
    const err = json.error || {};
    throw new ApiError(err.code || 'error', err.message || '请求失败', err.details, res.status);
  }
  return json.result;
}

export const api = {
  status: () => call('GET', '/api/status'),
  detect: () => call('GET', '/api/detect'),
  settings: () => call('GET', '/api/settings'),
  /** @param {{ui?: object}} patch */
  putSettings: (patch) => call('PUT', '/api/settings', patch),
  /** @param {string} dir */
  setWorkspace: (dir) => call('POST', '/api/workspace', { dir }),
  /** @param {{st?: boolean, tt?: boolean}} v */
  setTaverns: (v) => call('POST', '/api/taverns', v),
  locations: () => call('GET', '/api/taverns/locations'),
  /** @param {{st: any[], tt: any[]}} locations */
  setLocations: (locations) => call('POST', '/api/taverns/locations', locations),
  /** @param {string} key @param {'wait'|'write'} mode */
  setOfflineSync: (key, mode) => call('POST', '/api/taverns/offline-sync', { key, mode }),
  /** @param {{target: string, kind: string, query?: string, offset?: number, limit?: number}} q */
  catalog: (q) => call('POST', '/api/catalog', q),
  /** @param {string} target @param {string} kind @param {string} id */
  checkout: (target, kind, id) => call('POST', '/api/checkout', { target, kind, id }),
  /** @param {string} path @param {string} [target] */
  sync: (path, target) => call('POST', '/api/sync', { path, target }),
  /** @param {string} path @param {string} [target] */
  pull: (path, target) => call('POST', '/api/pull', { path, target }),
  /** @param {string} path @param {string} target @param {boolean} enabled */
  autoSync: (path, target, enabled) => call('POST', '/api/auto-sync', { path, target, enabled })
};

/** Human message for an API error, keyed by the contract's error codes. */
export function errorText(e) {
  if (!(e instanceof ApiError)) return String((e && e.message) || e);
  switch (e.code) {
    case 'conflict': return '存在冲突，冲突处理将在后续开放';
    case 'waiting_for_tavern': return '酒馆未运行：修改已留在工作区，酒馆启动后再同步';
    case 'tavern_running': return '酒馆正在运行：请在酒馆中启用 Cellar Link 后同步';
    case 'not_connected': return '酒馆未连接';
    case 'unauthorized': return '未授权：请从伴侣程序重新打开 Studio';
    case 'not_found': return e.message || '找不到该资料项';
    default: return e.message || e.code;
  }
}
