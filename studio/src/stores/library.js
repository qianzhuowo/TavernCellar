// 资料库 state: chosen tavern, kind, query, loaded catalog page(s).
import { defineStore } from 'pinia';
import { api, errorText, isAborted } from '../api.js';
import { useApp } from './app.js';
import { useUi } from './ui.js';

const PAGE = 120;
/** In-flight catalog request; aborted whenever the query changes or the library is left. */
/** @type {AbortController|null} */
let inflight = null;

export const useLibrary = defineStore('library', {
  state: () => ({
    target: localStorage.getItem('cs.lib.target') || '',
    /** @type {'character'|'lorebook'} */
    kind: /** @type {any} */ (localStorage.getItem('cs.lib.kind') || 'character'),
    query: '',
    sort: 'recent',
    /** @type {string} */
    tag: '',
    /** @type {any[]} */
    items: [],
    total: 0,
    loading: false,
    /** loading has taken long enough to explain why */
    slow: false,
    error: '',
    errorCode: '',
    /** @type {Record<string, boolean>} */
    busy: {},
    seq: 0
  }),

  getters: {
    /** Taverns that can be browsed: connected live targets and offline-ready ones. */
    sources() {
      const app = useApp();
      return app.targets.filter((t) => !t.unknown && app.taverns[t.host] !== false);
    },
    current() { return this.sources.find((t) => t.id === this.target) || null; },
    tags() {
      const set = new Map();
      for (const it of this.items) for (const t of it.tags || []) set.set(t, (set.get(t) || 0) + 1);
      return [...set.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map((x) => x[0]);
    },
    shown() {
      let list = this.items;
      if (this.tag) list = list.filter((i) => (i.tags || []).includes(this.tag));
      if (this.kind === 'character' && this.sort === 'recent') list = [...list].sort((a, b) => (b.dateLastChat || 0) - (a.dateLastChat || 0));
      else if (this.sort === 'name') list = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
      return list;
    },
    hasMore() { return this.items.length < this.total; }
  },

  actions: {
    ensureTarget() {
      if (!this.current) {
        const live = this.sources.find((t) => t.live) || this.sources[0];
        this.target = live ? live.id : '';
      }
    },
    /** @param {string} id */
    setTarget(id) { this.target = id; localStorage.setItem('cs.lib.target', id); this.tag = ''; this.reload(); },
    /** @param {'character'|'lorebook'} k */
    setKind(k) { this.kind = k; localStorage.setItem('cs.lib.kind', k); this.tag = ''; this.reload(); },
    /** Drop any pending page load (old tavern/kind/query, or the page was left). */
    cancel() {
      if (inflight) { inflight.abort(); inflight = null; }
      this.seq++;
      this.loading = false;
      this.slow = false;
    },
    async reload() {
      this.cancel();
      this.ensureTarget();
      this.items = [];
      this.total = 0;
      this.error = '';
      if (!this.target) return;
      await this.loadMore();
    },
    async loadMore() {
      if (this.loading || !this.target) return;
      const seq = ++this.seq;
      const ctl = new AbortController();
      inflight = ctl;
      this.loading = true;
      this.slow = false;
      const slowTimer = setTimeout(() => { if (seq === this.seq) this.slow = true; }, 6000);
      this.error = '';
      this.errorCode = '';
      try {
        const r = await api.catalog({ target: this.target, kind: this.kind, query: this.query || undefined, offset: this.items.length, limit: PAGE }, ctl.signal);
        if (seq !== this.seq) return;
        this.items = this.items.concat(r.items || []);
        this.total = r.total || 0;
      } catch (e) {
        if (seq === this.seq && !isAborted(e)) {
          this.error = errorText(e);
          this.errorCode = /** @type {any} */ (e).code || '';
          // a timeout usually means the tavern page went to sleep: let the status pills catch up
          if (/** @type {any} */ (e).code === 'timeout') useApp().refreshStatus();
        }
      } finally {
        clearTimeout(slowTimer);
        if (inflight === ctl) inflight = null;
        if (seq === this.seq) { this.loading = false; this.slow = false; }
      }
    },
    /** @param {any} entry */
    async checkout(entry) {
      const ui = useUi();
      const app = useApp();
      this.busy = { ...this.busy, [entry.id]: true };
      try {
        const r = await api.checkout(this.target, this.kind, entry.id);
        entry.checkedOut = r.path;
        await app.refreshStatus();
        ui.toast('已取出到工作区：' + r.path);
        if (r.warnings && r.warnings.length) setTimeout(() => ui.toast(r.warnings.join('；'), 'alert'), 1200);
        return r.path;
      } catch (e) {
        ui.toast('取出失败：' + errorText(e), 'alert');
        return null;
      } finally {
        const b = { ...this.busy }; delete b[entry.id]; this.busy = b;
      }
    }
  }
});
