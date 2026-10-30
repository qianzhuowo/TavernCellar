// View state: hash route, open tabs, panels, toasts. Theme/density are applied to <html>.
import { defineStore } from 'pinia';

const ls = {
  get(/** @type {string} */ k, /** @type {any} */ d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(/** @type {string} */ k, /** @type {any} */ v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
};

/**
 * Routes (hash): #/library  #/item/<encoded path>  #/sync  #/history  #/settings[/<section>]  #/wizard
 * Tab keys: 'library' | 'sync' | 'history' | 'settings' | 'item:<path>'
 */
export function parseHash(/** @type {string} */ hash) {
  const h = hash.replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : '';
  if (name === 'item' && arg) return { name: 'item', arg, key: 'item:' + arg };
  if (['library', 'sync', 'history', 'wizard'].includes(name)) return { name, arg: '', key: name };
  if (name === 'settings') return { name, arg, key: 'settings' };
  return { name: 'library', arg: '', key: 'library' };
}

export const hrefOf = (/** @type {string} */ key) =>
  key.startsWith('item:') ? '#/item/' + encodeURIComponent(key.slice(5)) : '#/' + key;

let toastSeq = 0;

export const useUi = defineStore('ui', {
  state: () => ({
    route: parseHash(location.hash),
    /** @type {string[]} */
    tabs: ls.get('cs.tabs', ['library']),
    lastItem: ls.get('cs.lastItem', ''),
    inspector: ls.get('cs.inspector', true),
    /** inspector shown as an overlay drawer on narrow windows */
    inspectorDrawer: false,
    side: ls.get('cs.side', true),
    /** @type {{id:number, text:string, icon:string}[]} */
    toasts: [],
    /** @type {Record<string, boolean>} */
    collapsed: ls.get('cs.collapsed', {})
  }),

  actions: {
    syncRoute() {
      this.route = parseHash(location.hash);
      const r = this.route;
      if (r.name === 'wizard') return;
      if (!this.tabs.includes(r.key)) { this.tabs.push(r.key); ls.set('cs.tabs', this.tabs); }
      if (r.name === 'item') { this.lastItem = r.arg; ls.set('cs.lastItem', r.arg); }
      this.inspectorDrawer = false;
    },
    /** @param {string} hash */
    go(hash) { if (location.hash === hash) this.syncRoute(); else location.hash = hash; },
    /** @param {string} path */
    openItem(path) { this.go(hrefOf('item:' + path)); },
    /** @param {string} key */
    closeTab(key) {
      const i = this.tabs.indexOf(key);
      if (i < 0) return;
      this.tabs.splice(i, 1);
      ls.set('cs.tabs', this.tabs);
      if (this.route.key === key) this.go(hrefOf(this.tabs[Math.min(i, this.tabs.length - 1)] || 'library'));
    },
    /** Drop tabs of items that no longer exist in the workspace. @param {string[]} paths */
    pruneTabs(paths) {
      const keep = this.tabs.filter((k) => !k.startsWith('item:') || paths.includes(k.slice(5)));
      if (keep.length !== this.tabs.length) { this.tabs = keep; ls.set('cs.tabs', keep); }
      if (this.lastItem && !paths.includes(this.lastItem)) this.lastItem = '';
    },
    toggleInspector() {
      if (window.innerWidth < 1100) { this.inspectorDrawer = !this.inspectorDrawer; return; }
      this.inspector = !this.inspector; ls.set('cs.inspector', this.inspector);
    },
    toggleSide() { this.side = !this.side; ls.set('cs.side', this.side); },
    /** @param {string} key */
    toggleGroup(key) { this.collapsed = { ...this.collapsed, [key]: !this.collapsed[key] }; ls.set('cs.collapsed', this.collapsed); },
    /** @param {string} text @param {string} [icon] */
    toast(text, icon) {
      const id = ++toastSeq;
      this.toasts = [{ id, text, icon: icon || 'check' }];
      setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); }, icon === 'alert' ? 4200 : 2600);
    },
    /** @param {{theme?:string, density?:string}} [ui] */
    applyPrefs(ui) {
      if (!ui) return;
      const r = document.documentElement;
      if (ui.theme) { r.dataset.theme = ui.theme; ls.set('cs.theme', ui.theme); try { localStorage.setItem('cs.theme', ui.theme); } catch (e) { /* ignore */ } }
      if (ui.density) r.dataset.density = ui.density;
    }
  }
});
