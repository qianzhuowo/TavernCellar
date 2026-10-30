// Native helpers exposed by the desktop shell's preload (window.cellarDesktop).
// In a plain browser they are absent: pickers fall back to text input, open buttons become 「复制路径」.

/** @returns {{pickDirectory?: () => Promise<string|null>, showInFolder?: (p: string) => any, openInEditor?: (p: string) => any} | null} */
const native = () => /** @type {any} */ (window).cellarDesktop || null;

export const desktop = {
  get available() { return !!native(); },
  /** @returns {Promise<string|null>} */
  async pickDirectory() { const n = native(); return n && n.pickDirectory ? n.pickDirectory() : null; },
  /** @param {string} p */
  showInFolder(p) { const n = native(); if (n && n.showInFolder) n.showInFolder(p); },
  /** @param {string} p */
  openInEditor(p) { const n = native(); if (n && n.openInEditor) n.openInEditor(p); }
};

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
