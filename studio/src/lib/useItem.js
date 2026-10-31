// Shared item loading / auto-save for the editors (S2 card, S3 lorebook). docs/studio-design.md §5.1-5.2.
// The workspace files are the source of truth: edits are written after a short pause, guarded by the workspace hash;
// changes made elsewhere (VS Code, a pull from the tavern) reload the editor when it has nothing unsaved.
import { ref, shallowRef, watch, onBeforeUnmount } from 'vue';
import { api, errorText } from '../api.js';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';

const SAVE_DELAY = 600;

/**
 * @param {import('vue').Ref<string>} pathRef
 */
export function useItem(pathRef) {
  const app = useApp();
  const ui = useUi();
  /** @type {import('vue').ShallowRef<any>} structured data; mutate it, then call touch() */
  const data = shallowRef(null);
  const hash = ref('');
  /** @type {import('vue').Ref<any>} lorebooks: template for new entries */
  const entryTemplate = ref(null);
  const loading = ref(false);
  const saving = ref(false);
  const dirty = ref(false);
  const error = ref('');
  /** Files changed elsewhere while this editor had unsaved edits. */
  const externalChange = ref(false);
  /** Bumped on every (re)load so views can reset local UI state derived from data. */
  const version = ref(0);
  let timer = 0;

  async function load() {
    clearTimeout(timer);
    loading.value = true;
    error.value = '';
    try {
      const r = await api.item(pathRef.value);
      data.value = r.data;
      hash.value = r.hash;
      entryTemplate.value = r.entryTemplate ?? null;
      dirty.value = false;
      externalChange.value = false;
      version.value++;
    } catch (e) {
      error.value = errorText(e);
    } finally {
      loading.value = false;
    }
  }

  /** Marks `data` as edited and schedules the write. */
  function touch() {
    dirty.value = true;
    clearTimeout(timer);
    timer = window.setTimeout(save, SAVE_DELAY);
  }

  async function save() {
    clearTimeout(timer);
    if (!dirty.value || saving.value || !data.value) return;
    saving.value = true;
    dirty.value = false;
    try {
      const r = await api.putItem(pathRef.value, data.value, hash.value);
      hash.value = r.hash;
    } catch (e) {
      dirty.value = true;
      if (/** @type {any} */ (e).code === 'conflict') externalChange.value = true;
      else ui.toast('写入工作区失败：' + errorText(e), 'alert');
    } finally {
      saving.value = false;
      if (dirty.value && !externalChange.value) touch();
    }
  }

  /**
   * Lorebook entry operations (single, batch and group edits); pending field edits are saved first so both apply.
   * @param {any[]} ops
   * @returns {Promise<{created: number[]}|null>}
   */
  async function entryOps(ops) {
    await save();
    if (externalChange.value) { ui.toast('文件在别处被修改，请先重新加载', 'alert'); return null; }
    saving.value = true;
    try {
      const r = await api.editEntries(pathRef.value, hash.value, ops);
      hash.value = r.hash;
      const fresh = await api.item(pathRef.value);
      data.value = fresh.data;
      hash.value = fresh.hash;
      return { created: r.created };
    } catch (e) {
      if (/** @type {any} */ (e).code === 'conflict') externalChange.value = true;
      ui.toast(errorText(e), 'alert');
      return null;
    } finally {
      saving.value = false;
    }
  }

  // Reload when the workspace hash moves without us (files edited elsewhere or a pull wrote them).
  watch(() => app.item(pathRef.value)?.hash, (h) => {
    if (!h || !hash.value || h === hash.value || saving.value) return;
    if (dirty.value) externalChange.value = true;
    else load();
  });
  watch(pathRef, () => { if (dirty.value) save(); load(); }, { immediate: true });
  onBeforeUnmount(() => { if (dirty.value) save(); });

  return { data, hash, entryTemplate, loading, saving, dirty, error, externalChange, version, load, touch, save, entryOps };
}
