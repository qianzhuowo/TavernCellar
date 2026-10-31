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

/**
 * Binds an existing workspace item to a tavern item (the way back from unbind). Identical data comes back in sync;
 * different data is a whole-item conflict, which opens the conflict page.
 * @param {any} app @param {any} ui @param {string} path @param {string} target @param {string} id
 * @returns {Promise<'in-sync'|'conflict'|'error'>}
 */
export async function bindItem(app, ui, path, target, id) {
  try {
    const r = /** @type {any} */ (await api.bind(path, target, id));
    await app.refreshStatus();
    if (r.result === 'conflict') {
      ui.toast('已绑定到 ' + app.targetName(target) + '：两边内容不同，请选择保留哪一边', 'alert');
      ui.openConflict(path);
      return 'conflict';
    }
    ui.toast('已绑定到 ' + app.targetName(target) + '：两边一致');
    return 'in-sync';
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    return 'error';
  }
}
