// Binding operations shared by the inspector and the sync matrix: sync / pull / auto-sync / unbind with the same
// conflict handling everywhere (a conflict status or a conflict error opens the conflict page).
import { api, errorText } from '../api.js';
import { uiStatus, isConflict } from './status.js';
import { useLibrary } from '../stores/library.js';
import { flushItem } from './useItem.js';
import { warningText } from './warnings.js';

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
 * Ends a pin (docs/versioning.md §3): the binding follows the workspace again; auto-sync bindings sync right away.
 * @param {any} app @param {any} ui @param {string} path @param {any} b
 * @returns {Promise<boolean>}
 */
export async function followBinding(app, ui, path, b) {
  try {
    const r = /** @type {any} */ (await api.follow(path, b.target));
    ui.toast(r.error ? `已改为跟随最新，但同步失败：${r.error}` : r.sync ? '已改为跟随最新并同步' : '已改为跟随最新', r.error ? 'alert' : 'check');
    await app.refreshStatus();
    return true;
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    return false;
  }
}

/** One-line description of a pinned binding, e.g. "固定在 v1.0，工作区已更新". */
export const pinText = (/** @type {any} */ p) => `固定在 ${p.name}${p.ahead ? '，工作区已更新' : ''}`;
export const PIN_TIP = '这个酒馆停在推送的版本，工作区的新修改不会同步过去；「跟随最新」后恢复正常同步';

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

/**
 * Takes an item out of the workspace (the taverns keep their copy; earlier versions stay in the history).
 * Closes its tabs, refreshes the item list and un-marks it in the 资料库.
 * @param {any} app @param {any} ui @param {string} path @param {boolean} keepFiles
 * @returns {Promise<boolean>}
 */
export async function removeItem(app, ui, path, keepFiles) {
  try {
    const r = await api.remove(path, keepFiles);
    ui.closeTab('conflict:' + path);
    ui.closeTab('item:' + path);
    for (const e of useLibrary().items) if (e.checkedOut === path) e.checkedOut = null;
    await app.refreshStatus();
    ui.toast('已从工作区移除 ' + path + (r.kept && r.kept.length ? '（保留了你自己的 ' + r.kept.length + ' 个文件）' : ''));
    return true;
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    return false;
  }
}

const EDIT_DONE = { undo: '已撤回', redo: '已取消撤回', revert: '已撤销当前的修改，恢复成上一个版本' };

/**
 * Moves an item to a project folder ('' = back to its kind folder). Pending editor edits are written first; tabs,
 * the open page and the 资料库 mark follow the new path.
 * @param {any} app @param {any} ui @param {string} path @param {string} folder
 * @returns {Promise<boolean>}
 */
export async function moveItem(app, ui, path, folder) {
  try {
    await flushItem(path);
    const r = /** @type {any} */ (await api.moveItem(path, folder));
    if (r.result === 'moved') {
      ui.itemMoved(r.from, r.path);
      for (const e of useLibrary().items) if (e.checkedOut === r.from) e.checkedOut = r.path;
    }
    await app.refreshStatus();
    ui.toast(r.result === 'moved' ? '已移到 ' + r.path : '它已经在这个文件夹里');
    return true;
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    return false;
  }
}

/**
 * Why 「改名…」 cannot run for an item now ('' = it can): every bound tavern must be running with a Cellar Link that
 * supports renaming. Other preconditions (in sync, not pinned) are the companion's and come back as its error.
 * @param {any} app @param {any} it status item
 * @returns {string}
 */
export function renameBlocked(app, it) {
  for (const b of it.bindings) {
    const t = app.target(b.target);
    const name = app.targetName(b.target);
    if (!t.live) return name + ' 没有在运行：改名需要酒馆在运行（打开酒馆后再试）';
    if (!(t.rename >= 1)) return name + ' 的 Cellar Link 太旧，不支持改名；请更新插件';
  }
  return '';
}

/**
 * Renames a bound character / lorebook in its taverns (POST /api/rename). Pending editor edits are written first;
 * tabs, the open page and the 资料库 mark follow a folder that was renamed with it (the card's lorebook too).
 * @param {any} app @param {any} ui @param {string} path @param {string} name @param {boolean} withWorld
 * @returns {Promise<boolean>}
 */
export async function renameItem(app, ui, path, name, withWorld) {
  try {
    await flushItem(path);
    const r = /** @type {any} */ (await api.renameItem(path, name, withWorld));
    const moves = [[r.from, r.path], ...(r.world && r.world.renamed ? [[r.world.from, r.world.path]] : [])];
    for (const [from, to] of moves) {
      if (from === to) continue;
      ui.itemMoved(from, to);
      for (const e of useLibrary().items) if (e.checkedOut === from) e.checkedOut = to;
    }
    await app.refreshStatus();
    const notes = (r.warnings || []).map((/** @type {any} */ w) => warningText(w, app.settings?.ui?.messageLang));
    const done = '已改名为「' + name + '」' + (r.world && r.world.renamed ? '（连同世界书）' : '');
    ui.toast(notes.length ? done + '；' + notes.join('；') : done, notes.length ? 'alert' : 'check');
    return true;
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    await app.refreshStatus();
    return false;
  }
}

/**
 * Why 「更换头像…」 cannot run for a card now ('' = it can): it must be bound, and every bound tavern reachable for
 * writing — running with a Cellar Link that supports avatars, or closed and set to 不开酒馆也同步.
 * @param {any} app @param {any} it status item
 * @returns {string}
 */
export function avatarBlocked(app, it) {
  if (!it || !it.bindings.length) return '头像存在酒馆里：先发布到酒馆再换头像';
  for (const b of it.bindings) {
    const t = app.target(b.target);
    const name = app.targetName(b.target);
    if (t.live && !(t.avatar >= 1)) return name + ' 的 Cellar Link 太旧，不支持换头像；请更新插件';
    if (!t.live && !t.offline) return name + ' 没有连接，也没有设置离线访问：打开酒馆后再换头像';
    if (!t.live && t.offlineSync !== 'write') return name + ' 没有在运行，并且设为等酒馆启动再同步：打开酒馆后再换头像';
  }
  return '';
}

/**
 * Replaces a bound card's avatar in its taverns (POST /api/avatar); every Avatar of it reloads.
 * @param {any} app @param {any} ui @param {any} it status item @param {string} image base64 PNG
 * @returns {Promise<boolean>}
 */
export async function setAvatar(app, ui, it, image) {
  try {
    const r = /** @type {any} */ (await api.setAvatar(it.path, image));
    for (const [target, file] of Object.entries(r.ids)) app.avatarAt[target + '/' + file] = r.avatarAt;
    ui.toast('已更换头像', 'check');
    return true;
  } catch (e) {
    // A partial failure may have changed some taverns: reload the image anyway.
    for (const b of it.bindings) app.avatarAt[b.target + '/' + b.id] = Date.now();
    ui.toast(errorText(e), 'alert');
    return false;
  } finally {
    await app.refreshStatus();
  }
}

/**
 * 撤回 / 取消撤回 / 撤销当前的修改 of one item (the companion keeps the steps, docs/versioning.md §6). Pending
 * editor edits are written first so they are part of what is undone; the open editor reloads from the new files.
 * @param {any} app @param {any} ui @param {string} path @param {'undo'|'redo'|'revert'} op
 * @returns {Promise<boolean>}
 */
export async function editStep(app, ui, path, op) {
  try {
    await flushItem(path);
    const r = await (op === 'undo' ? api.undoItem(path) : op === 'redo' ? api.redoItem(path) : api.revertItem(path));
    await app.refreshStatus();
    ui.toast(op === 'revert' && r && r.origin ? '已撤销当前的修改，恢复成刚取出 / 新建时的样子' : EDIT_DONE[op], 'check');
    return true;
  } catch (e) {
    await app.refreshStatus();
    ui.toast(errorText(e), 'alert');
    return false;
  }
}
