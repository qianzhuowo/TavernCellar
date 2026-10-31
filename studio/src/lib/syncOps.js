// Binding operations shared by the inspector and the sync matrix: sync / pull / auto-sync / unbind with the same
// conflict handling everywhere (a conflict status or a conflict error opens the conflict page).
import { api, errorText } from '../api.js';
import { uiStatus, isConflict } from './status.js';

/**
 * Sync (workspace -> tavern) or pull (tavern -> workspace) one binding, then refresh the store.
 * @param {any} app pinia app store
 * @param {any} ui pinia ui store
 * @param {string} path
 * @param {any} b binding
 * @param {'sync'|'pull'} op
 * @param {{quiet?: boolean}} [opt] quiet: no toasts and no navigation (batch runs report a summary instead)
 * @returns {Promise<'ok'|'conflict'|'error'>}
 */
export async function runBindingOp(app, ui, path, b, op, opt = {}) {
  if (isConflict(uiStatus(b.status))) {
    if (!opt.quiet) ui.openConflict(path);
    return 'conflict';
  }
  try {
    await (op === 'sync' ? api.sync(path, b.target) : api.pull(path, b.target));
    if (!opt.quiet) ui.toast((op === 'sync' ? '已同步到 ' : '已从酒馆取回：') + app.targetName(b.target));
    return 'ok';
  } catch (e) {
    const conflict = /** @type {any} */ (e).code === 'conflict';
    if (!opt.quiet) {
      ui.toast(errorText(e), 'alert');
      if (conflict) ui.openConflict(path);
    }
    return conflict ? 'conflict' : 'error';
  } finally {
    if (!opt.quiet) await app.refreshStatus();
  }
}

/**
 * @param {any} app @param {any} ui @param {string} path @param {any} b @param {boolean} on
 * @returns {Promise<boolean>} success
 */
export async function setAutoSync(app, ui, path, b, on) {
  try {
    await api.autoSync(path, b.target, on);
    b.autoSync = on;
    ui.toast(on ? '已开启随时同步' : '已关闭随时同步');
    await app.refreshStatus();
    return true;
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    return false;
  }
}

/**
 * Removes the binding record only: workspace files and the tavern's copy stay.
 * @param {any} app @param {any} ui @param {string} path @param {any} b
 * @returns {Promise<boolean>}
 */
export async function unbindBinding(app, ui, path, b) {
  try {
    await api.unbind(path, b.target);
    ui.toast('已解除与 ' + app.targetName(b.target) + ' 的绑定（文件与酒馆内容都保留）');
    await app.refreshStatus();
    return true;
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    return false;
  }
}

/** Whether sync / pull can reach the tavern right now (Cellar Link connected or offline data folder). */
export const canReach = (/** @type {string} */ mode) => mode === 'online' || mode === 'offline';
