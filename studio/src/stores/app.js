// Companion state: settings, workspace status, tavern detection/locations, connection health.
import { defineStore } from 'pinia';
import { api, errorText } from '../api.js';
import { uiStatus, isDirty, isConflict, bindingMode, worstStatus } from '../lib/status.js';
import { baseName } from '../lib/desktop.js';
import { useUi } from './ui.js';

/**
 * Single-flight with one trailing rerun: while a run is in flight, further calls coalesce into
 * exactly one more run after it. Keeps SSE-driven refreshes (one per companion log line) from
 * stacking up requests and exhausting the browser's per-host connection pool.
 * @param {() => Promise<void>} fn
 */
function coalesced(fn) {
  /** @type {Promise<void>|null} */
  let running = null;
  let again = false;
  const run = () => {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await fn(); } while (again);
      } finally { running = null; }
    })();
    return running;
  };
  return run;
}

let statusRun = /** @type {null | (() => Promise<void>)} */ (null);
let tavernsRun = /** @type {null | (() => Promise<void>)} */ (null);

export const useApp = defineStore('app', {
  state: () => ({
    /** companion reachable (initial load succeeded and SSE stream up) */
    online: false,
    /** first successful load done */
    ready: false,
    /** @type {{port:number, workspace:string, ui:{theme:string, density:string, wizardDone:boolean}}|null} */
    settings: null,
    /** @type {any} /api/status result */
    status: null,
    /** @type {any} /api/detect result */
    detect: null,
    /** @type {any} /api/taverns/locations result */
    locations: null,
    detecting: false
  }),

  getters: {
    workspace: (s) => (s.status && s.status.workspace) || (s.settings && s.settings.workspace) || '',
    workspaceName() { return baseName(this.workspace) || '未选择工作区'; },
    port: (s) => (s.settings && s.settings.port) || Number(location.port) || 7349,
    taverns: (s) => (s.status && s.status.taverns) || { st: true, tt: true },
    items: (s) => (s.status && s.status.items) || [],

    /** Every known target: live first, then offline-capable, then ids only seen in bindings. */
    targets(s) {
      /** @type {Map<string, any>} */
      const m = new Map();
      const st = s.status || {};
      for (const t of st.targets || []) m.set(t.id, { ...t, live: true });
      for (const t of st.offlineTargets || []) if (!m.has(t.id)) m.set(t.id, { ...t, live: false, offline: true });
      // remembered by the workspace (connected before): only names taverns that still have bindings
      const known = new Map((st.knownTargets || []).map((t) => [t.id, t]));
      for (const it of st.items || []) {
        for (const b of it.bindings || []) {
          if (m.has(b.target)) continue;
          const k = known.get(b.target);
          m.set(b.target, k ? { ...k, live: false } : { id: b.target, host: undefined, label: '未连接的酒馆', live: false, unknown: true });
        }
      }
      return [...m.values()];
    },

    /** @returns {(id: string) => any} */
    target() { return (id) => this.targets.find((t) => t.id === id) || { id, label: '未连接的酒馆', unknown: true }; },

    /** Short name for a target: label, disambiguated with host mark when two share a label. */
    targetName() {
      return (/** @type {string} */ id) => {
        const t = this.target(id);
        const same = this.targets.filter((x) => x.label === t.label).length > 1;
        return t.unknown ? '酒馆 ' + id.slice(0, 6) : same && t.origin ? `${t.label} (${t.origin.replace(/^https?:\/\//, '')})` : t.label;
      };
    },

    /** Per-host connection summary for title/status bars: online | stale | offline | closed | none. */
    hostState(s) {
      const out = {};
      for (const host of ['st', 'tt']) {
        const st = s.status || {};
        const live = (st.targets || []).filter((t) => t.host === host);
        if (this.taverns[host] === false) out[host] = 'closed';
        else if (live.some((t) => t.responsive !== false)) out[host] = 'online';
        else if (live.length) out[host] = 'stale';
        else if ((st.offlineTargets || []).some((t) => t.host === host)) out[host] = 'offline';
        else out[host] = 'none';
      }
      return out;
    },

    /** @returns {(id: string) => boolean} live target whose page stopped answering */
    isStale() { return (id) => { const t = this.target(id); return !!t.live && t.responsive === false; }; },

    dirtyCount() { return this.items.filter((i) => i.bindings.some((b) => isDirty(uiStatus(b.status)))).length; },
    conflictCount() { return this.items.filter((i) => i.bindings.some((b) => isConflict(uiStatus(b.status)))).length; },

    /** @returns {(path: string) => any} */
    item() { return (path) => this.items.find((i) => i.path === path) || null; },

    /** @returns {(b: any) => string} */
    modeOf() {
      return (b) => bindingMode(b, this.target(b.target), this.taverns);
    },

    worst() { return (/** @type {any} */ it) => worstStatus(it); }
  },

  actions: {
    async loadAll() {
      const [settings, status] = await Promise.all([api.settings(), api.status()]);
      this.settings = settings;
      this.status = status;
      this.ready = true;
      this.online = true;
      const ui = useUi();
      ui.applyPrefs(settings.ui);
      ui.pruneTabs(this.items.map((i) => i.path));
      // detection/locations are slower (they probe ports / read folders): don't block the first paint
      this.refreshTaverns();
    },

    refreshStatus() {
      if (!statusRun) {
        statusRun = coalesced(async () => {
          try {
            this.status = await api.status();
            useUi().pruneTabs(this.items.map((i) => i.path));
          } catch (e) { /* the SSE stream decides online/offline */ }
        });
      }
      return statusRun();
    },

    refreshTaverns() {
      if (!tavernsRun) {
        tavernsRun = coalesced(async () => {
          this.detecting = true;
          try {
            const [detect, locations] = await Promise.all([api.detect(), api.locations()]);
            this.detect = detect;
            this.locations = locations;
          } catch (e) {
            useUi().toast(errorText(e), 'alert');
          } finally {
            this.detecting = false;
          }
        });
      }
      return tavernsRun();
    },

    /** @param {Partial<{theme:string, density:string, wizardDone:boolean}>} patch */
    async saveUi(patch) {
      const ui = useUi();
      if (this.settings) this.settings = { ...this.settings, ui: { ...this.settings.ui, ...patch } };
      ui.applyPrefs(this.settings ? this.settings.ui : patch);
      try {
        this.settings = await api.putSettings({ ui: patch });
      } catch (e) {
        ui.toast('设置未保存：' + errorText(e), 'alert');
      }
    },

    /** @param {string} dir */
    async switchWorkspace(dir) {
      const r = await api.setWorkspace(dir);
      if (this.settings) this.settings.workspace = r.workspace;
      // don't hold the caller (button spinner) on the status refetch
      this.refreshStatus();
      return r.workspace;
    },

    /** @param {'st'|'tt'} host @param {boolean} on */
    async setAccept(host, on) {
      await api.setTaverns({ [host]: on });
      await Promise.all([this.refreshStatus(), this.refreshTaverns()]);
    },

    /** @param {{st:any[], tt:any[]}} locations */
    async saveLocations(locations) {
      await api.setLocations(locations);
      await Promise.all([this.refreshStatus(), this.refreshTaverns()]);
    },

    /** @param {string} key @param {'wait'|'write'} mode */
    async setOfflineSync(key, mode) {
      await api.setOfflineSync(key, mode);
      await Promise.all([this.refreshStatus(), this.refreshTaverns()]);
    }
  }
});
