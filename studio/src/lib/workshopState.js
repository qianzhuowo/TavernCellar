// 预设工坊 state, kept at module level: edits are buffered until 保存修改, and leaving the page must not drop them.
import { reactive } from 'vue';

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
  /** saved prompts (workshop/prompts.json) */
  col: { prompts: /** @type {any[]} */ ([]), hash: '', dirty: false, err: '', loaded: false }
});

export const workshopDirty = () => workshop.src.dirty || workshop.tgt.dirty || workshop.col.dirty;
