// 预设工坊 state, kept at module level: edits are buffered until 保存修改, and leaving the page must not drop them.
// The collection (收藏, workshop/prompts.json) is not buffered: every change is written right away (edits after a
// short pause), so it never counts as an unsaved change.
import { reactive } from 'vue';
import { api, errorText } from '../api.js';
import { useUi } from '../stores/ui.js';

/**
 * One side of the workshop. loc: 'ws' (workspace item, id = item path), a tavern target id (id = preset id such as
 * 'openai/name'), or 'col' (the collection, source only). `data` is a working copy; `dirty` until saved or cancelled.
 * `path` is the workspace item the data came from (a tavern preset that is already checked out is edited there).
 */
function side() {
  return { loc: 'ws', id: '', rev: '', data: /** @type {any} */ (null), hash: '', path: '', readonly: false, dirty: false, loading: false, err: '', seq: 0 };
}

export const workshop = reactive({
  inited: false,
  compare: false,
  src: side(),
  tgt: side(),
  /** saved prompts (workshop/prompts.json); `saving` while a write is pending or running */
  col: { prompts: /** @type {any[]} */ ([]), hash: '', err: '', loaded: false, saving: false }
});

export const workshopDirty = () => workshop.src.dirty || workshop.tgt.dirty;

const SAVE_DELAY = 600;
let timer = 0;
let scheduled = 0;
/** @type {Promise<void>} writes run one after another so each uses the hash the previous one returned */
let chain = Promise.resolve();

/** Writes the collection now (add / delete) or after a pause (typing in a saved prompt). */
export function saveCollectionSoon(delay = SAVE_DELAY) {
  const col = workshop.col;
  const mine = ++scheduled;
  col.saving = true;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    chain = chain.then(async () => {
      try {
        const r = await api.saveCollection({ version: 1, prompts: JSON.parse(JSON.stringify(col.prompts)) }, col.hash);
        col.hash = r.hash;
        col.err = '';
      } catch (e) {
        col.err = '收藏没有保存：' + errorText(e);
        useUi().toast(col.err, 'alert');
      } finally {
        if (mine === scheduled) col.saving = false;
      }
    });
  }, delay);
}
