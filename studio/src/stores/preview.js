// Prompt preview (phase 5, docs/studio-design.md §4.8): the last preview per session, the tavern it ran in, and the
// one-click "sync local edits, then preview". Preview always shows the tavern's content; it never injects edits.
import { defineStore } from 'pinia';
import { api, errorText } from '../api.js';
import { useApp } from './app.js';
import { useUi } from './ui.js';
import { uiStatus } from '../lib/status.js';
import { runBindingOp } from '../lib/syncOps.js';
import { flushAll } from '../lib/useItem.js';

const TARGET_KEY = 'cs.preview.target';

export const usePreview = defineStore('preview', {
  state: () => ({
    /** tavern chosen on the preview page (kept across sessions) */
    chosen: localStorage.getItem(TARGET_KEY) || '',
    /** optional test text, sent as the tavern's quiet prompt */
    input: '',
    /** '' | 'sync' | 'preview' */
    running: '',
    sync: { done: 0, total: 0 },
    /** @type {any} last /api/preview result */
    result: null,
    error: ''
  }),

  getters: {
    /** Connected taverns (a dry run needs the tavern page), each flagged when its Cellar Link can preview. */
    sources() {
      const app = useApp();
      return app.targets.filter((/** @type {any} */ t) => t.live).map((/** @type {any} */ t) => ({ ...t, name: app.targetName(t.id), can: Number(t.preview) > 0 }));
    },
    /** @returns {any} the tavern previews run in: the chosen one while connected, else the first that can preview */
    target() {
      const list = /** @type {any[]} */ (this.sources);
      return list.find((t) => t.id === this.chosen) || list.find((t) => t.can) || list[0] || null;
    },
    /** @returns {(id: string) => {local: any[], blocked: any[]}} items with edits not in that tavern yet */
    pending() {
      return (id) => {
        const app = useApp();
        const local = [];
        const blocked = [];
        for (const it of app.items) {
          const b = (it.bindings || []).find((/** @type {any} */ x) => x.target === id);
          if (!b || b.pinned) continue;
          const s = uiStatus(b.status);
          if (s === 'local') local.push({ it, b });
          else if (s === 'both' || s === 'conflict') blocked.push({ it, b });
        }
        return { local, blocked };
      };
    },
    /** @returns {(path: string) => Set<number>} uids of a workspace lorebook's entries that fired in the last preview */
    triggered() {
      return (path) => new Set(((this.result && this.result.worldInfo && this.result.worldInfo.entries) || [])
        .filter((/** @type {any} */ e) => e.path === path).map((/** @type {any} */ e) => e.uid));
    }
  },

  actions: {
    /** @param {string} id */
    choose(id) { this.chosen = id; localStorage.setItem(TARGET_KEY, id); },

    /**
     * Previews in the current tavern. With syncFirst, local edits bound to that tavern are synced first (conflicts are
     * left alone and reported), so the preview reflects the workspace.
     * @param {{syncFirst?: boolean}} [opt]
     */
    async run(opt = {}) {
      const app = useApp();
      const ui = useUi();
      const t = this.target;
      if (!t || this.running) return;
      this.error = '';
      try {
        if (opt.syncFirst) {
          // edits still waiting in an open editor count too: write them, then re-read the sync status
          this.running = 'sync';
          await flushAll();
          await app.refreshStatus();
          const { local } = this.pending(t.id);
          if (local.length) {
            this.running = 'sync';
            this.sync = { done: 0, total: local.length };
            const n = { ok: 0, conflict: 0, error: 0 };
            for (const { it, b } of local) {
              n[await runBindingOp(app, ui, it.path, b, 'sync', { quiet: true })]++;
              this.sync.done++;
            }
            await app.refreshStatus();
            if (n.conflict || n.error) ui.toast(`同步到 ${t.name}：${n.ok} 已同步${n.conflict ? `，${n.conflict} 冲突` : ''}${n.error ? `，${n.error} 失败` : ''}；预览用的是酒馆里的内容`, 'alert');
          }
        }
        this.running = 'preview';
        this.result = await api.preview(t.id, this.input.trim());
      } catch (e) {
        this.error = errorText(e);
      } finally {
        this.running = '';
      }
    }
  }
});
