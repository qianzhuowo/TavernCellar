// View state: hash route, open tabs, panels, toasts. Theme/density are applied to <html>.
import { defineStore } from 'pinia';

const ls = {
  get(/** @type {string} */ k, /** @type {any} */ d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(/** @type {string} */ k, /** @type {any} */ v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
};

/**
 * Routes (hash): #/library[/<kind>]  #/workspace (no document open)  #/item/<encoded path>  #/conflict/<encoded path>  #/sync  #/history[/<encoded item path>|/all]  #/workshop  #/preview  #/settings[/<section>]  #/wizard
 * (#/history alone opens what the history showed last.)
 * Tab keys: 'item:<path>' | 'conflict:<path>' — only documents open as tabs; the activity-bar pages (资料库, 同步, 预览,
 * 预设工坊, 历史, 设置) are switched from the activity bar and never become tabs.
 */
export function parseHash(/** @type {string} */ hash) {
  const h = hash.replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : '';
  if ((name === 'item' || name === 'conflict') && arg) return { name, arg, key: name + ':' + arg };
  if (['workspace', 'sync', 'preview', 'workshop', 'wizard'].includes(name)) return { name, arg: '', key: name };
  if (name === 'settings' || name === 'library' || name === 'history') return { name, arg, key: name };
  return { name: 'library', arg: '', key: 'library' };
}

/** Workspace item path of an item or conflict tab key, or '' for fixed tabs. */
export const pathOfKey = (/** @type {string} */ key) => (/^(item|conflict):/.test(key) ? key.slice(key.indexOf(':') + 1) : '');
const isDocKey = (/** @type {string} */ key) => !!pathOfKey(key);

export const hrefOf = (/** @type {string} */ key) => {
  const m = /^(item|conflict):(.*)$/s.exec(key);
  return m ? `#/${m[1]}/` + encodeURIComponent(m[2]) : '#/' + key;
};

/** Version history, optionally showing only one item. */
export const historyHref = (/** @type {string} */ path = '') => (path ? '#/history/' + encodeURIComponent(path) : '#/history');
/** History route argument for "all items" (item paths always contain a slash, so it cannot be one). */
export const HISTORY_ALL = 'all';

let toastSeq = 0;

export const useUi = defineStore('ui', {
  state: () => ({
    route: parseHash(location.hash),
    /** @type {string[]} */
    tabs: ls.get('cs.tabs', []).filter(isDocKey),
    lastItem: ls.get('cs.lastItem', ''),
    /** what the version history showed last: an item path or HISTORY_ALL ('' = never opened) */
    lastHistory: ls.get('cs.lastHistory', ''),
    inspector: ls.get('cs.inspector', true),
    /** inspector shown as an overlay drawer on narrow windows */
    inspectorDrawer: false,
    side: ls.get('cs.side', true),
    /** @type {{id:number, text:string, icon:string}[]} */
    toasts: [],
    /** global regex item that should get a new script when its editor opens (工作区「+」) */
    newScriptFor: '',
    /** @type {Record<string, boolean>} */
    collapsed: ls.get('cs.collapsed', {}),
    /** Per item: card editor showing the form or the files it is made of (and which file to select). */
    /** @type {Record<string, {view: 'form'|'files', file?: string}>} */
    itemView: {},
    /** Lorebook entry to select once its editor shows (set by the preview page). @type {{path: string, uid: number}|null} */
    focusEntry: null,
    /** item whose 「从工作区移除」 confirmation dialog is open (RemoveDialog in App.vue) */
    removeAsk: ''
  }),

  actions: {
    syncRoute() {
      this.route = parseHash(location.hash);
      const r = this.route;
      if (r.name === 'wizard') return;
      if (isDocKey(r.key) && !this.tabs.includes(r.key)) { this.tabs.push(r.key); ls.set('cs.tabs', this.tabs); }
      if (r.name === 'item') { this.lastItem = r.arg; ls.set('cs.lastItem', r.arg); }
      if (r.name === 'history' && r.arg) { this.lastHistory = r.arg; ls.set('cs.lastHistory', r.arg); }
      this.inspectorDrawer = false;
    },
    /** @param {string} hash */
    go(hash) { if (location.hash === hash) this.syncRoute(); else location.hash = hash; },
    /** Like go(), without a new browser history entry (redirects). @param {string} hash */
    replace(hash) { if (location.hash === hash) this.syncRoute(); else location.replace(hash); },
    /** @param {string} path */
    openItem(path) { this.go(hrefOf('item:' + path)); },
    /** @param {string} path */
    openConflict(path) { this.go(hrefOf('conflict:' + path)); },
    /** @param {string} key */
    closeTab(key) {
      const i = this.tabs.indexOf(key);
      if (i < 0) return;
      this.tabs.splice(i, 1);
      ls.set('cs.tabs', this.tabs);
      // the next tab, or the empty 工作区 page once the last one is closed (the other pages stay where they are)
      if (this.route.key === key) this.go(hrefOf(this.tabs[Math.min(i, this.tabs.length - 1)] || 'workspace'));
    },
    /** Drop tabs of items that no longer exist in the workspace. @param {string[]} paths */
    pruneTabs(paths) {
      const keep = this.tabs.filter((k) => !pathOfKey(k) || paths.includes(pathOfKey(k)));
      if (keep.length !== this.tabs.length) { this.tabs = keep; ls.set('cs.tabs', keep); }
      if (this.lastItem && !paths.includes(this.lastItem)) { this.lastItem = ''; ls.set('cs.lastItem', ''); }
    },
    toggleInspector() {
      if (window.innerWidth < 1100) { this.inspectorDrawer = !this.inspectorDrawer; return; }
      this.inspector = !this.inspector; ls.set('cs.inspector', this.inspector);
    },
    toggleSide() { this.side = !this.side; ls.set('cs.side', this.side); },
    /** @param {string} path @param {'form'|'files'} view @param {string} [file] item-relative file or folder to select */
    setItemView(path, view, file = '') { this.itemView = { ...this.itemView, [path]: { view, file } }; },
    /** @param {string} key */
    toggleGroup(key) { this.collapsed = { ...this.collapsed, [key]: !this.collapsed[key] }; ls.set('cs.collapsed', this.collapsed); },
    /** @param {string} text @param {string} [icon] */
    toast(text, icon) {
      const id = ++toastSeq;
      this.toasts = [{ id, text, icon: icon || 'check' }];
      setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); }, icon === 'alert' ? 4200 : 2600);
    },
    /** @param {{theme?:string, density?:string, font?:string, fontSize?:number, wordCount?:boolean}} [ui] */
    applyPrefs(ui) {
      if (!ui) return;
      const r = document.documentElement;
      if (ui.theme) { r.dataset.theme = ui.theme; ls.set('cs.theme', ui.theme); try { localStorage.setItem('cs.theme', ui.theme); } catch (e) { /* ignore */ } }
      if (ui.density) r.dataset.density = ui.density;
      if (ui.font) r.dataset.font = ui.font;
      if (ui.fontSize) r.style.setProperty('--fs-editor', ui.fontSize + 'px');
      if (ui.wordCount !== undefined) r.dataset.wordcount = ui.wordCount ? 'on' : 'off';
    }
  }
});
