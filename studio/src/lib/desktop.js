// Native helpers exposed by the desktop shell's preload (window.cellarDesktop).
// In a plain browser they are absent: pickers fall back to text input, open buttons become 「复制路径」.

/** @returns {{pickDirectory?: () => Promise<string|null>, showInFolder?: (p: string) => any, openInEditor?: (p: string) => any} | null} */
const native = () => /** @type {any} */ (window).cellarDesktop || null;

export const desktop = {
  get available() { return !!native(); },
  /** @returns {Promise<string|null>} */
  async pickDirectory() { const n = native(); return n && n.pickDirectory ? n.pickDirectory() : null; },
  /** Selects the path in the system file manager. @param {string} p @returns {Promise<boolean>} false = not done */
  showInFolder(p) { return callNative('showInFolder', p); },
  /** Opens the file / folder with the system default app. @param {string} p @returns {Promise<boolean>} */
  openInEditor(p) { return callNative('openInEditor', p); }
};

/** The shell answers false when it refused or the OS could not open the path; a missing helper counts as false. */
async function callNative(/** @type {'showInFolder'|'openInEditor'} */ name, /** @type {string} */ p) {
  const n = native();
  if (!n || typeof n[name] !== 'function') return false;
  try { return (await n[name](p)) !== false; } catch (e) { return false; }
}

/**
 * Runs a native open action and never fails silently: on failure the path is copied and the user is told so.
 * @param {'showInFolder'|'openInEditor'} name @param {string} p @param {(msg: string, icon?: string) => void} toast
 */
export async function openNative(name, p, toast) {
  if (await callNative(name, p)) return true;
  const copied = await copyText(p);
  toast(copied ? `无法打开「${baseName(p)}」，已复制路径` : `无法打开「${baseName(p)}」：${p}`, 'alert');
  return false;
}

/** @param {string} text @returns {Promise<boolean>} */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}

/** Copies a path and says what happened; when the clipboard is unavailable the toast shows the path itself. */
export async function copyPathToast(/** @type {string} */ p, /** @type {(msg: string, icon?: string) => void} */ toast) {
  const ok = await copyText(p);
  toast(ok ? '已复制路径' : `无法写入剪贴板，请手动复制：${p}`, ok ? 'copy' : 'alert');
  return ok;
}

/** Absolute path of a workspace item (workspace is a native path, item path uses '/'). */
export function joinPath(/** @type {string} */ root, /** @type {string} */ rel) {
  if (!root) return rel;
  const sep = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
}

/** Last path segment, for showing a folder name. */
export function baseName(/** @type {string} */ p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}
