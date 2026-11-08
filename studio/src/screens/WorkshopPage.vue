<script setup>
// 预设工坊: compare the prompts of two chat-completion presets and move prompts between them.
//   来源  a workspace preset (now or in a version, read-only), a tavern preset (ST/TT, read without checkout), or 收藏
//   目标  a workspace or tavern preset
// Four columns: 来源 | 目标 | 来源条目 | 目标条目; each side has its own selection and detail. Edits are buffered
// (lib/workshopState.js) until 保存修改: workspace presets are written to the workspace; a tavern preset is checked out
// first (or edited where it is already checked out) and synced back to that tavern. The collection saves itself.
// 对比模式 marks prompts whose content or name differs, selects the counterpart on the other side and highlights the
// differences in both details. When both sides are the same preset, the two selected prompts are compared instead.
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import MiniSelect from '../components/MiniSelect.vue';
import SearchSelect from '../components/SearchSelect.vue';
import Toggle from '../components/Toggle.vue';
import PromptRowActions from '../components/PromptRowActions.vue';
import PromptDetail from '../editors/PromptDetail.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { api, errorText } from '../api.js';
import { displayName, relTime } from '../lib/status.js';
import { workshop as W, workshopDirty, saveCollectionSoon } from '../lib/workshopState.js';
import {
  FILTER_TIPS, PROMPT_FILTERS, deleteBlock, duplicatePrompt, ensureGlobalOrder, filterPrompts, orderedPrompts, promptsOf, removePrompts, roleOf
} from '../lib/presetPrompts.js';

const app = useApp();
const ui = useUi();
const src = W.src, tgt = W.tgt, col = W.col;
const KEY = 'cs.workshop';

const presets = computed(() => app.items.filter((/** @type {any} */ i) => i.kind === 'preset'));
const nameOf = (/** @type {string} */ path) => displayName(app.item(path) || { path });
/** Taverns whose presets can be read: connected, or reachable through their data folder. */
const taverns = computed(() => app.targets.filter((/** @type {any} */ t) => t.live || t.offline));
const isTavern = (/** @type {string} */ loc) => loc !== 'ws' && loc !== 'col';
function locOptions(/** @type {boolean} */ withCol) {
  return [
    { value: 'ws', label: '工作区' },
    ...taverns.value.map((/** @type {any} */ t) => ({ value: t.id, label: app.targetName(t.id) + (t.live ? '' : '（离线）') })),
    ...(withCol ? [{ value: 'col', label: '收藏' }] : [])
  ];
}

// ---- tavern preset lists -----------------------------------------------------------
/** @type {Record<string, {items: any[]|null, err: string}>} */
const catalogs = reactive({});
async function loadCatalog(/** @type {string} */ id, force = false) {
  if (!force && catalogs[id]?.items) return;
  if (!catalogs[id]) catalogs[id] = { items: null, err: '' };
  try {
    const r = await api.catalog({ target: id, kind: 'preset', limit: 500 });
    catalogs[id] = { items: (r.items || []).filter((/** @type {any} */ i) => i.apiId === 'openai'), err: '' };
  } catch (e) {
    catalogs[id] = { items: [], err: errorText(e) };
  }
}
function idOptions(/** @type {any} */ s) {
  if (s.loc === 'ws') return presets.value.map((/** @type {any} */ p) => ({ value: p.path, label: nameOf(p.path) }));
  if (s.loc === 'col') return [];
  return (catalogs[s.loc]?.items || []).map((i) => ({ value: i.id, label: i.name }));
}
const pickPlaceholder = (/** @type {any} */ s) => (isTavern(s.loc) && !catalogs[s.loc]?.items ? '正在读取…' : '选择预设…');

// ---- loading / saving one side ---------------------------------------------------------
async function load(/** @type {any} */ s) {
  const seq = ++s.seq;
  s.err = '';
  s.dirty = false;
  if (s.loc === 'col' || !s.id) { s.data = null; s.path = ''; return; }
  s.loading = true;
  try {
    let r, path = '', readonly = false;
    if (s.loc === 'ws') {
      r = s.rev ? await api.itemAt(s.rev, s.id) : await api.item(s.id);
      path = s.rev ? '' : s.id;
      readonly = !!s.rev;
    } else {
      const t = await api.tavernItem(s.loc, 'preset', s.id);
      // already checked out: edit the workspace copy, so the workspace's own changes are not overwritten
      if (t.checkedOut) { r = await api.item(t.checkedOut); path = t.checkedOut; } else r = t;
    }
    if (seq !== s.seq) return;
    s.data = r.data;
    s.hash = r.hash;
    s.path = path;
    s.readonly = readonly;
  } catch (e) {
    if (seq === s.seq) { s.data = null; s.err = errorText(e); }
  } finally {
    if (seq === s.seq) s.loading = false;
  }
}
const plain = (/** @type {any} */ v) => JSON.parse(JSON.stringify(v));
async function saveSide(/** @type {any} */ s) {
  if (!s.dirty || s.readonly || !s.data) return '';
  let path = s.path;
  let hash = s.hash;
  if (isTavern(s.loc) && !path) {
    const co = await api.checkout(s.loc, 'preset', s.id);
    path = co.path;
    s.path = path;
    loadCatalog(s.loc, true);
    if (co.hash !== s.hash) throw new Error('酒馆里的这个预设在此期间被修改了（已取出到工作区）；点「取消」重新读取后再改');
    hash = (await api.item(path)).hash;
  }
  const r = await api.putItem(path, plain(s.data), hash);
  s.hash = r.hash;
  s.dirty = false;
  if (isTavern(s.loc)) {
    try { await api.sync(path, s.loc); } catch (e) { return '已写入工作区，同步到酒馆失败：' + errorText(e); }
  }
  return '';
}

async function loadCollection() {
  try {
    const r = await api.collection();
    col.prompts = Array.isArray(r.collection?.prompts) ? r.collection.prompts : [];
    col.hash = r.hash;
    col.err = '';
    col.loaded = true;
  } catch (e) {
    col.err = errorText(e);
  }
}

/**
 * Source and target are the same preset as it is now (picked the same way, or a tavern preset that is checked out to
 * the workspace item on the other side): both show and edit one copy, the target's.
 */
const sameBuf = computed(() => src.loc !== 'col' && !!src.id && !src.rev
  && ((src.loc === tgt.loc && src.id === tgt.id) || (!!src.path && src.path === tgt.path)));
const S = computed(() => (sameBuf.value ? tgt : src));

const dirty = computed(() => workshopDirty());
const saving = ref(false);
async function saveAll() {
  saving.value = true;
  const notes = [];
  for (const s of sameBuf.value ? [tgt] : [tgt, src]) {
    try { const n = await saveSide(s); if (n) notes.push(n); } catch (e) { notes.push(errorText(e)); }
  }
  saving.value = false;
  await app.refreshStatus();
  if (notes.length) ui.toast(notes.join('；'), 'alert'); else ui.toast('已保存修改', 'check');
}
async function cancelAll() {
  await Promise.all([src.dirty ? load(src) : null, tgt.dirty ? load(tgt) : null]);
  ui.toast('已放弃未保存的修改');
}

/** Changes what a side shows; unsaved edits on it are dropped only after asking. */
function change(/** @type {any} */ s, /** @type {any} */ patch) {
  if (s.dirty && !window.confirm('这一侧有未保存的修改，切换会放弃它们。继续吗？')) return;
  Object.assign(s, patch);
  s.dirty = false;
  if (isTavern(s.loc)) loadCatalog(s.loc);
  load(s);
  persist();
}
const val = (/** @type {Event} */ e) => /** @type {any} */ (e.target).value;
function persist() {
  localStorage.setItem(KEY, JSON.stringify({ src: { loc: src.loc, id: src.id }, tgt: { loc: tgt.loc, id: tgt.id }, compare: W.compare }));
}

// versions of the source (workspace only)
/** @type {import('vue').Ref<any[]>} */
const versions = ref([]);
async function loadVersions() {
  versions.value = [];
  if (src.loc !== 'ws' || !src.id) return;
  try {
    const h = await api.history({ path: src.id, limit: 60 });
    versions.value = (h.versions || []).filter((/** @type {any} */ v) => !v.draft);
  } catch { /* no history yet */ }
}
watch(() => [src.loc, src.id], loadVersions);
/** 来源版本 picker: the current files, then the item's recorded versions */
const versionOptions = computed(() => [{ value: '', label: '当前（工作区里的样子）' },
  ...versions.value.map((v) => ({ value: v.id, label: `${v.id.slice(0, 8)} · ${relTime(v.time)} · ${v.message}` }))]);
const revTitle = computed(() => (src.rev
  ? `正在看历史版本：${versionOptions.value.find((o) => o.value === src.rev)?.label || src.rev.slice(0, 8)}（只读）。点击换一个版本，或选「当前」`
  : '选择历史版本做新旧对比'));
/** The workspace item a side edits (a tavern preset only once it is checked out), for 「在预设编辑器中打开」. */
const editorPath = (/** @type {any} */ s) => (s.loc === 'ws' ? s.id : s.loc === 'col' ? '' : s.path);
const editorTitle = (/** @type {any} */ s) => (editorPath(s) ? '在预设编辑器中打开'
  : isTavern(s.loc) && s.id ? '这个酒馆预设还没取出到工作区：保存一次修改，或在资料库取出后才能在编辑器中打开' : '先选择预设');

/** 交换来源与目标. The target is edited, so it cannot be the collection or a recorded version. */
const swapBlock = computed(() => (src.loc === 'col' ? '收藏不能作为目标'
  : src.rev ? '来源是历史版本（只读），不能作为目标；先把来源版本换回「当前」'
  : !src.id && !tgt.id ? '先选择预设' : ''));
function swapSides() {
  if (swapBlock.value) return;
  if (dirty.value) { ui.toast('有未保存的修改：请先「保存修改」或「取消」，再交换来源与目标', 'alert'); return; }
  const a = { loc: src.loc, id: src.id }, b = { loc: tgt.loc, id: tgt.id };
  Object.assign(src, b, { rev: '' });
  Object.assign(tgt, a);
  for (const s of [src, tgt]) {
    if (isTavern(s.loc)) loadCatalog(s.loc);
    load(s);
  }
  persist();
}

// workspace items changed elsewhere: reload sides without unsaved edits
for (const s of [src, tgt]) {
  watch(() => (s.path ? app.item(s.path)?.hash : undefined), (h) => { if (h && h !== s.hash && !s.dirty && !s.loading && !s.rev) load(s); });
}

onMounted(() => {
  if (!col.loaded) loadCollection();
  if (W.inited) {
    for (const s of [src, tgt]) if (isTavern(s.loc)) loadCatalog(s.loc, true);
    loadVersions();
    return;
  }
  W.inited = true;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* default */ }
  const ok = (/** @type {any} */ x, /** @type {boolean} */ withCol) => x && (x.loc === 'ws' ? presets.value.some((/** @type {any} */ p) => p.path === x.id) : x.loc === 'col' ? withCol : taverns.value.some((/** @type {any} */ t) => t.id === x.loc));
  W.compare = !!(/** @type {any} */ (saved).compare);
  for (const [s, x, withCol] of /** @type {[any, any, boolean][]} */ ([[src, /** @type {any} */ (saved).src, true], [tgt, /** @type {any} */ (saved).tgt, false]])) {
    if (ok(x, withCol)) { s.loc = x.loc; s.id = x.id || ''; }
    if (isTavern(s.loc)) loadCatalog(s.loc);
    load(s);
  }
  loadVersions();
});
onBeforeUnmount(() => { if (workshopDirty()) ui.toast('预设工坊有未保存的修改，回到工坊可保存或取消', 'alert'); });

// ---- rows, matching ----------------------------------------------------------------
const fS = ref('default'), fT = ref('default'), qS = ref(''), qT = ref('');
/** @typedef {{p: any, o: any, n: number, key: string, c?: any}} Row */
/** @type {import('vue').ComputedRef<Row[]>} */
const srcAll = computed(() => (src.loc === 'col'
  ? col.prompts.map((c, i) => ({ p: c.prompt, o: { enabled: !!c.enabled }, n: i + 1, key: c.id, c }))
  : orderedPrompts(S.value.data).map((r) => ({ ...r, key: r.p.identifier }))));
/** @type {import('vue').ComputedRef<Row[]>} */
const tgtAll = computed(() => orderedPrompts(tgt.data).map((r) => ({ ...r, key: r.p.identifier })));

/** Compared fields, normalized the way ST reads them. @param {any} p */
const norm = (p) => ({
  name: String(p?.name ?? ''), role: roleOf(p), content: String(p?.content ?? ''),
  position: Number(p?.injection_position) || 0, depth: Number(p?.injection_depth ?? 4), forbid: !!p?.forbid_overrides
});
const samePrompt = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
/** Counterpart: same identifier, else same name, else (not a placeholder) the same content. */
function pairOf(/** @type {any} */ p, /** @type {Row[]} */ rows) {
  const m = rows.find((r) => r.p.identifier === p?.identifier) || (p?.name ? rows.find((r) => r.p.name === p.name) : undefined);
  if (m) return { m, by: 'id' };
  const c = String(p?.content ?? '');
  if (p?.marker || !c.trim()) return null;
  const byContent = rows.find((r) => !r.p.marker && String(r.p.content ?? '') === c);
  return byContent ? { m: byContent, by: 'content' } : null;
}
/** 'only' | 'same' | 'diff' (content differs) | 'renamed' (same content, other name) */
function stateOf(/** @type {Row} */ row, /** @type {Row[]} */ other) {
  const x = pairOf(row.p, other);
  if (!x) return 'only';
  if (x.by === 'content') return 'renamed';
  if (!samePrompt(row.p, x.m.p)) return samePrompt({ ...row.p, name: x.m.p.name }, x.m.p) ? 'renamed' : 'diff';
  return !!row.o?.enabled === !!x.m.o?.enabled && !!row.o === !!x.m.o ? 'same' : 'diff';
}
/** Rows are marked only when comparing two different presets (the same preset matches itself everywhere). */
const marking = computed(() => W.compare && !sameBuf.value && !!tgt.data && (src.loc === 'col' || !!S.value.data));
const srcRows = computed(() => filterPrompts(srcAll.value, fS.value, qS.value).map((r) => ({ ...r, st: marking.value ? stateOf(r, tgtAll.value) : '' })));
const tgtRows = computed(() => filterPrompts(tgtAll.value, fT.value, qT.value).map((r) => ({ ...r, st: marking.value ? stateOf(r, srcAll.value) : '' })));
const counts = computed(() => {
  const c = { same: 0, diff: 0, renamed: 0, onlySrc: 0, onlyTgt: 0 };
  if (!marking.value) return c;
  for (const r of srcAll.value) { const s = stateOf(r, tgtAll.value); if (s === 'only') c.onlySrc++; else c[/** @type {'same'} */ (s)]++; }
  for (const r of tgtAll.value) if (!pairOf(r.p, srcAll.value)) c.onlyTgt++;
  return c;
});
const ST_LABEL = { src: { only: '目标没有', same: '相同', diff: '内容不同', renamed: '名称不同' }, tgt: { only: '来源没有', same: '相同', diff: '内容不同', renamed: '名称不同' } };

// ---- selection (one per side), details -------------------------------------------------
const selS = ref(''), selT = ref('');
/** @type {import('vue').Ref<'src'|'tgt'>} side clicked last: 对比模式 pairs from it when turned on */
const lastSide = ref(/** @type {'src'|'tgt'} */ ('src'));
const checkedS = ref(/** @type {Set<string>} */ (new Set()));
const checkedT = ref(/** @type {Set<string>} */ (new Set()));
watch(() => [src.loc, src.id, src.rev], () => { checkedS.value = new Set(); selS.value = ''; });
watch(() => [tgt.loc, tgt.id], () => { checkedT.value = new Set(); selT.value = ''; });
const rowsOf = (/** @type {'src'|'tgt'} */ side) => (side === 'src' ? srcAll.value : tgtAll.value);
const rowS = computed(() => srcAll.value.find((r) => r.key === selS.value) || null);
const rowT = computed(() => tgtAll.value.find((r) => r.key === selT.value) || null);
const readonlyOf = (/** @type {'src'|'tgt'} */ side) => side === 'src' && src.loc !== 'col' && S.value.readonly;

function toggleCheck(/** @type {'src'|'tgt'} */ side, /** @type {string} */ key) {
  const box = side === 'src' ? checkedS : checkedT;
  const s = new Set(box.value);
  if (s.has(key)) s.delete(key); else s.add(key);
  box.value = s;
}
/** 对比模式 between two presets: the other side follows to the counterpart (none = nothing selected there). */
function pairFrom(/** @type {'src'|'tgt'} */ side) {
  if (!W.compare || sameBuf.value) return;
  const mine = side === 'src' ? rowS.value : rowT.value;
  if (!mine) return;
  const x = pairOf(mine.p, side === 'src' ? tgtAll.value : srcAll.value);
  if (side === 'src') selT.value = x?.m.key ?? ''; else selS.value = x?.m.key ?? '';
}
function select(/** @type {'src'|'tgt'} */ side, /** @type {string} */ key) {
  if (side === 'src') selS.value = key; else selT.value = key;
  lastSide.value = side;
  pairFrom(side);
}
function clickRow(/** @type {'src'|'tgt'} */ side, /** @type {string} */ key, /** @type {MouseEvent} */ ev) {
  if (ev.ctrlKey || ev.metaKey) { toggleCheck(side, key); return; }
  select(side, key);
}
watch(() => W.compare, () => { persist(); pairFrom(lastSide.value); });

/** Applies a field edit from PromptDetail and marks the side it belongs to. */
function setField(/** @type {'src'|'tgt'} */ side, /** @type {Row} */ row, /** @type {string} */ key, /** @type {any} */ value) {
  if (readonlyOf(side)) return;
  row.p[key] = value;
  if (side === 'src' && src.loc === 'col') {
    if (key === 'name' && row.c) row.c.title = value;
    saveCollectionSoon();
  } else (side === 'src' ? S.value : tgt).dirty = true;
}
function insertRow(/** @type {'src'|'tgt'} */ side, /** @type {Row} */ row) {
  const s = side === 'src' ? S.value : tgt;
  if (!s.data || readonlyOf(side)) return;
  ensureGlobalOrder(s.data).push({ identifier: row.p.identifier, enabled: false });
  s.dirty = true;
}

/** 对比模式: both selected prompts, compared (content diff in the details, differing fields marked). */
const cmp = computed(() => {
  const a = rowS.value, b = rowT.value;
  if (!W.compare || !a || !b || a.p.marker || b.p.marker) return null;
  const na = norm(a.p), nb = norm(b.p);
  const changed = ['name', 'role', 'position', 'forbid'].filter((k) => (k === 'position'
    ? na.position !== nb.position || (na.position === 1 && na.depth !== nb.depth)
    : na[/** @type {'name'} */ (k)] !== nb[/** @type {'name'} */ (k)]));
  return { a, b, changed };
});
const otherText = (/** @type {'src'|'tgt'} */ side) => (cmp.value ? String((side === 'src' ? cmp.value.b : cmp.value.a).p.content ?? '') : null);

// ---- writing into the target ---------------------------------------------------------
/** Index in the order where a drop/insert lands. @param {{id: string, after: boolean}|null} anchor */
function anchorIndex(/** @type {any[]} */ order, anchor) {
  if (!anchor) return order.length;
  const i = order.findIndex((o) => o.identifier === anchor.id);
  return i < 0 ? order.length : i + (anchor.after ? 1 : 0);
}
/** @typedef {{p: any, enabled: boolean}} Incoming */
/** @type {import('vue').Ref<{items: Incoming[], anchor: any, clashes: string[]}|null>} */
const pending = ref(null);
/** Copies prompts into the target at `anchor`; asks first when the target has the same identifier with other content. */
function copyIn(/** @type {Incoming[]} */ items, /** @type {any} */ anchor) {
  if (!tgt.data || !items.length) return;
  const have = promptsOf(tgt.data);
  const clashes = items.filter(({ p }) => !p.marker && have.some((x) => x.identifier === p.identifier && !samePrompt(x, p))).map(({ p }) => p.name || p.identifier);
  if (clashes.length) { pending.value = { items, anchor, clashes }; return; }
  applyCopy(items, anchor, 'replace');
}
/** @param {'replace'|'copy'} mode what to do with a prompt whose identifier the target already has */
function applyCopy(/** @type {Incoming[]} */ items, /** @type {any} */ anchor, mode) {
  pending.value = null;
  const d = tgt.data;
  if (!Array.isArray(d.prompts)) d.prompts = [];
  const order = ensureGlobalOrder(d);
  let at = anchorIndex(order, anchor);
  let last = '';
  for (const { p, enabled } of items) {
    const existing = d.prompts.find((/** @type {any} */ x) => x.identifier === p.identifier);
    let id = p.identifier;
    if (!existing) d.prompts.push(plain(p));
    else if (p.marker || samePrompt(existing, p) || mode === 'replace') {
      if (!p.marker && existing !== p) { const next = plain(p); for (const k of Object.keys(existing)) delete existing[k]; Object.assign(existing, next); }
    } else {
      id = crypto.randomUUID();
      d.prompts.push({ ...plain(p), identifier: id, system_prompt: false });
    }
    const oi = order.findIndex((/** @type {any} */ o) => o.identifier === id);
    if (oi >= 0) { order.splice(oi, 1); if (oi < at) at--; }
    order.splice(at++, 0, { identifier: id, enabled: !!enabled });
    last = id;
  }
  tgt.dirty = true;
  if (last) { selT.value = last; lastSide.value = 'tgt'; }
  ui.toast(`已复制到目标：${items.length} 条（保存修改后写入）`, 'check');
}
function moveIn(/** @type {string[]} */ ids, /** @type {any} */ anchor) {
  const order = ensureGlobalOrder(tgt.data);
  if (anchor && ids.includes(anchor.id)) return;
  const moving = ids.map((id) => order.find((/** @type {any} */ o) => o.identifier === id) || { identifier: id, enabled: false });
  for (const m of moving) { const i = order.indexOf(m); if (i >= 0) order.splice(i, 1); }
  order.splice(anchorIndex(order, anchor), 0, ...moving);
  tgt.dirty = true;
}
function toggleOrder(/** @type {any} */ o) { o.enabled = !o.enabled; tgt.dirty = true; }
/** Copies one target prompt right below itself. */
function duplicateTgt(/** @type {string} */ id) {
  const copy = duplicatePrompt(tgt.data, id);
  if (!copy) return;
  tgt.dirty = true;
  selT.value = copy;
}
/** Deletes target prompts (built-in ones and placeholders are kept). */
function removeTgt(/** @type {string[]} */ ids) {
  const n = removePrompts(tgt.data, ids);
  if (!n) { ui.toast('选中的都是内置或占位条目，不能删除', 'alert'); return; }
  tgt.dirty = true;
  if (ids.includes(selT.value)) selT.value = '';
  checkedT.value = new Set([...checkedT.value].filter((k) => !ids.includes(k)));
  if (n < ids.length) ui.toast(`已删除 ${n} 条；内置或占位条目不能删除，已跳过 ${ids.length - n} 条`, 'alert');
}
const checkedTgt = computed(() => tgtAll.value.filter((r) => checkedT.value.has(r.key)));
const deletableChecked = computed(() => checkedTgt.value.filter((r) => !deleteBlock(r.p)).length);
const armedBulk = ref(false);
function removeChecked() {
  if (!armedBulk.value) { armedBulk.value = true; return; }
  armedBulk.value = false;
  removeTgt(checkedTgt.value.map((r) => r.key));
}

const picked = computed(() => {
  const keys = checkedS.value.size ? [...checkedS.value] : selS.value ? [selS.value] : [];
  return srcAll.value.filter((r) => keys.includes(r.key));
});
const incoming = (/** @type {Row[]} */ rows) => rows.map((r) => ({ p: r.p, enabled: !!r.o?.enabled }));
function copyPicked() {
  copyIn(incoming(picked.value), rowT.value?.o ? { id: selT.value, after: true } : null);
  checkedS.value = new Set();
}

// ---- drag & drop ------------------------------------------------------------------
/** @type {import('vue').Ref<{from: 'src'|'tgt', keys: string[]}|null>} */
const drag = ref(null);
const dropAt = ref(/** @type {{id: string, after: boolean}|null} */ (null));
function dragStart(/** @type {'src'|'tgt'} */ from, /** @type {string} */ key, /** @type {DragEvent} */ ev) {
  const box = from === 'src' ? checkedS.value : checkedT.value;
  const keys = box.has(key) ? rowsOf(from).filter((r) => box.has(r.key)).map((r) => r.key) : [key];
  drag.value = { from, keys };
  ev.dataTransfer?.setData('text/plain', keys.join('\n'));
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = from === 'tgt' ? 'copyMove' : 'copy';
}
function dragEnd() { drag.value = null; dropAt.value = null; }
function overRow(/** @type {string} */ id, /** @type {DragEvent} */ ev) {
  if (!drag.value || !tgt.data) return;
  ev.preventDefault();
  const r = /** @type {HTMLElement} */ (ev.currentTarget).getBoundingClientRect();
  dropAt.value = { id, after: ev.clientY > r.top + r.height / 2 };
}
function overEnd(/** @type {DragEvent} */ ev) {
  if (!drag.value || !tgt.data) return;
  ev.preventDefault();
  if (!dropAt.value || dropAt.value.id !== '$end') dropAt.value = { id: '$end', after: true };
}
function anchorFor(/** @type {{id: string, after: boolean}|null} */ at) {
  if (!at || at.id === '$end') return null;
  return tgtAll.value.find((r) => r.key === at.id)?.o ? at : null;
}
function dropTarget(/** @type {DragEvent} */ ev) {
  ev.preventDefault();
  const d = drag.value, anchor = anchorFor(dropAt.value);
  dragEnd();
  if (!d || !tgt.data) return;
  if (d.from === 'tgt') moveIn(d.keys, anchor);
  else { copyIn(incoming(srcAll.value.filter((r) => d.keys.includes(r.key))), anchor); checkedS.value = new Set(); }
}

// ---- 收藏 (saved at once) ------------------------------------------------------------
const srcLabel = computed(() => {
  if (src.loc === 'ws') return nameOf(src.id) + (src.rev ? ' @' + src.rev.slice(0, 8) : '');
  return (idOptions(src).find((o) => o.value === src.id)?.label || src.id) + ' · ' + app.targetName(src.loc);
});
const tgtLabel = computed(() => (tgt.loc === 'ws' ? nameOf(tgt.id) : (idOptions(tgt).find((o) => o.value === tgt.id)?.label || tgt.id) + ' · ' + app.targetName(tgt.loc)));
function collect(/** @type {Row[]} */ rows, /** @type {string} */ from) {
  const add = rows.filter((r) => !r.p.marker).map((r) => ({ id: crypto.randomUUID(), title: r.p.name || r.p.identifier, from, savedAt: new Date().toISOString(), enabled: !!r.o?.enabled, prompt: plain(r.p) }));
  if (rows.length && !add.length) { ui.toast('占位提示词由酒馆生成内容，不能收藏', 'alert'); return; }
  if (!add.length) return;
  col.prompts.push(...add);
  saveCollectionSoon(0);
  ui.toast(`已加入收藏 ${add.length} 条`, 'check');
}
function collectPicked() { collect(picked.value, srcLabel.value); checkedS.value = new Set(); }
function collectTarget() {
  collect(checkedTgt.value.length ? checkedTgt.value : rowT.value ? [rowT.value] : [], tgtLabel.value);
  checkedT.value = new Set();
}
const armedDelete = ref('');
function removeSaved(/** @type {string} */ id) {
  if (armedDelete.value !== id) { armedDelete.value = id; return; }
  armedDelete.value = '';
  if (selS.value === id) selS.value = '';
  col.prompts = col.prompts.filter((x) => x.id !== id);
  saveCollectionSoon(0);
}

const preview = (/** @type {any} */ p) => (p.marker ? '占位（内容由酒馆生成）' : String(p.content || '').slice(0, 80) || '（空）');
const infoOpen = ref(false);
const noSource = computed(() => !presets.value.length && !taverns.value.length);
/** The two detail columns. */
const DETAILS = /** @type {const} */ (['src', 'tgt']);
const detailRow = (/** @type {'src'|'tgt'} */ side) => (side === 'src' ? rowS.value : rowT.value);
</script>

<template>
  <div class="wk">
    <div class="wk-head">
      <h2><Icon name="workshop" />预设工坊</h2>
      <span class="wk-info" :class="{ open: infoOpen }" tabindex="0" role="button" aria-label="说明" @click="infoOpen = !infoOpen" @blur="infoOpen = false">
        <Icon name="info" size="sm" />
        <span class="wk-tip" role="tooltip">
          把来源的条目拖到目标列表中的位置即可复制，在目标列表内拖动可调整顺序；Ctrl+点击或勾选可多选。来源可以是工作区或酒馆（ST/TT）中的预设、某个历史版本，或「收藏」；目标可以是工作区或酒馆中的预设。<br />
          修改先留在这里，点「保存修改」才写入：工作区预设写入工作区；酒馆预设会先取出到工作区，再同步回那个酒馆。收藏的改动立即保存。<br />
          开启「对比模式」后，内容不同、或内容相同但名称不同的条目会高亮；选中一边的条目时另一边会选中对应条目，两边的内容框标出差异并可直接修改。来源与目标是同一个预设时，对比两边各自选中的条目。
        </span>
      </span>
      <label class="wk-cmp"><Toggle v-model="W.compare" />对比模式</label>
      <button class="btn sm ghost" type="button" :disabled="!!swapBlock || saving" :title="swapBlock || '交换来源与目标预设'" @click="swapSides"><Icon name="swap" size="sm" />交换来源与目标</button>
      <span class="spacer" />
      <span v-if="col.saving" class="faint wk-colsave"><Icon name="spin" size="sm" />正在保存收藏…</span>
      <span v-if="dirty" class="wk-dirty"><Icon name="dot" size="sm" />有未保存的修改</span>
      <button class="btn sm" type="button" :disabled="!dirty || saving" @click="cancelAll">取消</button>
      <button class="btn sm primary" type="button" :disabled="!dirty || saving" @click="saveAll"><Icon :name="saving ? 'spin' : 'save'" size="sm" />保存修改</button>
    </div>

    <div v-if="noSource" class="empty grow">
      <Icon name="sliders" /><h3>没有可用的预设</h3>
      <p class="muted">连接 ST/TT、设置酒馆数据目录，或先在资料库取出对话补全预设。</p>
      <a class="btn" href="#/library/preset"><Icon name="library" size="sm" />去资料库</a>
    </div>

    <div v-else class="wk-main">
      <!-- 来源 -->
      <section class="wk-col">
        <div class="wk-col-head">
          <span class="wk-tag src">来源</span>
          <select class="input wk-loc" :value="src.loc" aria-label="来源位置" @change="change(src, { loc: val($event), id: '', rev: '' }); /** @type {any} */ ($event.target).value = src.loc">
            <option v-for="o in locOptions(true)" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <div v-if="src.loc !== 'col'" class="wk-pickrow">
            <a v-if="editorPath(src)" class="icon-btn" :href="'#/item/' + encodeURIComponent(editorPath(src))" :title="editorTitle(src)"><Icon name="external" size="sm" /></a>
            <button v-else class="icon-btn" type="button" disabled :title="editorTitle(src)"><Icon name="external" size="sm" /></button>
            <SearchSelect class="wk-pick" :model-value="src.id" :options="idOptions(src)" :placeholder="pickPlaceholder(src)" aria-label="来源预设" @update:model-value="change(src, { id: $event, rev: '' })" />
            <SearchSelect v-if="src.loc === 'ws' && src.id && versions.length" icon="history" :model-value="src.rev" :options="versionOptions" :title="revTitle" aria-label="来源版本" @update:model-value="change(src, { rev: $event })" />
          </div>
          <span v-else class="faint wk-colcount">{{ col.prompts.length }} 条 · workshop/prompts.json · 改动立即保存</span>
        </div>
        <div class="wk-tools">
          <label class="search grow"><Icon name="search" size="sm" /><input v-model="qS" class="input" placeholder="搜索名称或内容" /></label>
          <MiniSelect v-if="src.loc !== 'col'" v-model="fS" label="显示" :active="fS !== 'default'" :title="FILTER_TIPS[fS]" :options="PROMPT_FILTERS" />
        </div>
        <div v-if="isTavern(src.loc) && src.path" class="faint wk-hint">已取出到工作区，这里编辑的是工作区中的这一项。</div>
        <div v-if="sameBuf" class="faint wk-hint">与目标是同一个预设：两边编辑同一份；对比模式比较两边各自选中的条目。</div>
        <div class="wk-rows">
          <div v-if="isTavern(src.loc) && catalogs[src.loc]?.err" class="sync-note err wk-note">{{ catalogs[src.loc].err }}</div>
          <div v-if="S.err && src.loc !== 'col'" class="sync-note err wk-note">{{ S.err }}</div>
          <div v-else-if="src.loc === 'col' && col.err" class="sync-note err wk-note">{{ col.err }}</div>
          <div v-else-if="src.loc !== 'col' && !src.id" class="faint wk-note">选择来源预设</div>
          <div v-else-if="src.loc !== 'col' && S.loading && !S.data" class="faint wk-note"><Icon name="spin" size="sm" /> 正在读取…</div>
          <div
            v-for="r in srcRows"
            :key="r.key"
            class="wk-row"
            :class="['st-' + r.st, { on: selS === r.key, off: r.o && !r.o.enabled, out: !r.o, checked: checkedS.has(r.key) }]"
            draggable="true"
            tabindex="0"
            @dragstart="dragStart('src', r.key, $event)"
            @dragend="dragEnd"
            @click="clickRow('src', r.key, $event)"
            @keydown.enter="select('src', r.key)"
            @keydown.space.prevent="toggleCheck('src', r.key)"
          >
            <input type="checkbox" class="wk-check" :checked="checkedS.has(r.key)" title="多选" @click.stop="toggleCheck('src', r.key)" />
            <span class="wk-no mono faint">{{ r.n || '–' }}</span>
            <div class="grow wk-row-main">
              <div class="wk-name">{{ r.c ? r.c.title : r.p.name || r.p.identifier }}<span v-if="!r.o" class="wk-out">未插入</span></div>
              <div class="wk-sub faint">{{ r.c ? (r.c.from || '') : preview(r.p) }}</div>
            </div>
            <span v-if="r.st && r.st !== 'same'" class="wk-st" :class="r.st">{{ ST_LABEL.src[/** @type {'same'} */ (r.st)] }}</span>
            <button v-if="r.c" class="icon-btn" type="button" :class="{ danger: armedDelete === r.key }" :title="armedDelete === r.key ? '再点一次删除' : '删除收藏'" @click.stop="removeSaved(r.key)" @blur="armedDelete = ''"><Icon :name="armedDelete === r.key ? 'alert' : 'trash'" size="sm" /></button>
          </div>
          <div v-if="src.loc === 'col' && !col.prompts.length && !col.err" class="faint wk-note">还没有收藏 · 在来源或目标中选中条目，点「收藏」</div>
          <div v-else-if="(src.loc === 'col' || S.data) && srcAll.length && !srcRows.length" class="faint wk-note">没有匹配的提示词</div>
        </div>
        <div class="wk-foot">
          <button class="btn sm" type="button" :disabled="!picked.length || !tgt.data" :title="rowT?.o ? '插到目标中所选条目之后' : '插到目标末尾'" @click="copyPicked"><Icon name="copyPlus" size="sm" />复制到目标{{ picked.length > 1 ? `（${picked.length}）` : '' }}</button>
          <button v-if="src.loc !== 'col'" class="btn sm ghost" type="button" :disabled="!picked.length" @click="collectPicked"><Icon name="bookmarkPlus" size="sm" />收藏</button>
          <span class="spacer" />
          <span v-if="src.dirty && !sameBuf" class="wk-dirty"><Icon name="dot" size="sm" />未保存</span>
          <span v-else-if="S.readonly && src.loc !== 'col'" class="faint">历史版本 · 只读</span>
          <span v-else class="faint">Ctrl+点击 多选</span>
        </div>
      </section>

      <!-- 目标 -->
      <section class="wk-col">
        <div class="wk-col-head">
          <span class="wk-tag tgt">目标</span>
          <select class="input wk-loc" :value="tgt.loc" aria-label="目标位置" @change="change(tgt, { loc: val($event), id: '' }); /** @type {any} */ ($event.target).value = tgt.loc">
            <option v-for="o in locOptions(false)" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <div class="wk-pickrow">
            <a v-if="editorPath(tgt)" class="icon-btn" :href="'#/item/' + encodeURIComponent(editorPath(tgt))" :title="editorTitle(tgt)"><Icon name="external" size="sm" /></a>
            <button v-else class="icon-btn" type="button" disabled :title="editorTitle(tgt)"><Icon name="external" size="sm" /></button>
            <SearchSelect class="wk-pick" :model-value="tgt.id" :options="idOptions(tgt)" :placeholder="pickPlaceholder(tgt)" aria-label="目标预设" @update:model-value="change(tgt, { id: $event })" />
          </div>
        </div>
        <div class="wk-tools">
          <label class="search grow"><Icon name="search" size="sm" /><input v-model="qT" class="input" placeholder="搜索名称或内容" /></label>
          <MiniSelect v-model="fT" label="显示" :active="fT !== 'default'" :title="FILTER_TIPS[fT]" :options="PROMPT_FILTERS" />
        </div>
        <div v-if="isTavern(tgt.loc) && tgt.data && !tgt.path" class="faint wk-hint">保存时会先把它取出到工作区，再同步回{{ app.targetName(tgt.loc) }}。</div>
        <div v-else-if="isTavern(tgt.loc) && tgt.path" class="faint wk-hint">已取出到工作区，这里编辑的是工作区中的这一项；保存后同步回{{ app.targetName(tgt.loc) }}。</div>
        <div class="wk-rows" :class="{ dropping: !!drag && !!tgt.data }" @dragover="overEnd" @drop="dropTarget" @dragleave.self="dropAt = null">
          <div v-if="isTavern(tgt.loc) && catalogs[tgt.loc]?.err" class="sync-note err wk-note">{{ catalogs[tgt.loc].err }}</div>
          <div v-if="!tgt.id" class="faint wk-note">选择目标预设（会被修改）</div>
          <div v-else-if="tgt.err" class="sync-note err wk-note">{{ tgt.err }}</div>
          <div v-else-if="!tgt.data" class="faint wk-note"><Icon name="spin" size="sm" /> 正在读取…</div>
          <div
            v-for="r in tgtRows"
            :key="r.key"
            class="wk-row"
            :class="['st-' + r.st, { on: selT === r.key, off: r.o && !r.o.enabled, out: !r.o, checked: checkedT.has(r.key), 'drop-before': dropAt?.id === r.key && !dropAt.after, 'drop-after': dropAt?.id === r.key && dropAt.after }]"
            draggable="true"
            tabindex="0"
            @dragstart="dragStart('tgt', r.key, $event)"
            @dragend="dragEnd"
            @dragover.stop="overRow(r.key, $event)"
            @click="clickRow('tgt', r.key, $event)"
            @keydown.enter="select('tgt', r.key)"
            @keydown.space.prevent="toggleCheck('tgt', r.key)"
          >
            <input type="checkbox" class="wk-check" :checked="checkedT.has(r.key)" title="多选" @click.stop="toggleCheck('tgt', r.key)" />
            <span class="wk-no mono faint">{{ r.n || '–' }}</span>
            <div class="grow wk-row-main">
              <div class="wk-name">{{ r.p.name || r.p.identifier }}<span v-if="!r.o" class="wk-out">未插入</span></div>
              <div class="wk-sub faint">{{ preview(r.p) }}</div>
            </div>
            <span v-if="r.st && r.st !== 'same'" class="wk-st" :class="r.st">{{ ST_LABEL.tgt[/** @type {'same'} */ (r.st)] }}</span>
            <PromptRowActions :prompt="r.p" @copy="duplicateTgt(r.key)" @remove="removeTgt([r.key])" />
            <Toggle v-if="r.o" :model-value="!!r.o.enabled" :title="r.o.enabled ? '已启用' : '已停用'" @click.stop @update:model-value="toggleOrder(r.o)" />
          </div>
          <div v-if="tgt.data" class="wk-end" :class="{ 'drop-after': dropAt?.id === '$end' }">{{ drag ? '放到这里：插到末尾' : tgtRows.length ? '' : '没有匹配的提示词' }}</div>
        </div>
        <div class="wk-foot faint">
          <button class="btn sm ghost" type="button" :disabled="!checkedTgt.length && !rowT" @click="collectTarget"><Icon name="bookmarkPlus" size="sm" />收藏{{ checkedTgt.length > 1 ? `（${checkedTgt.length}）` : '' }}</button>
          <button v-if="checkedTgt.length" class="btn sm ghost" type="button" :class="{ danger: armedBulk }" :disabled="!deletableChecked" @click="removeChecked" @blur="armedBulk = false"><Icon :name="armedBulk ? 'alert' : 'trash'" size="sm" />{{ armedBulk ? `再点一次删除 ${deletableChecked} 条` : `删除（${deletableChecked}）` }}</button>
          <span v-if="tgt.dirty" class="wk-dirty"><Icon name="dot" size="sm" />未保存</span>
          <span class="spacer" />
          <span v-if="marking">相同 {{ counts.same }} · 内容不同 {{ counts.diff }} · 名称不同 {{ counts.renamed }} · 仅来源 {{ counts.onlySrc }} · 仅目标 {{ counts.onlyTgt }}</span>
          <span v-else-if="tgt.data">{{ tgtAll.length }} 条</span>
        </div>
      </section>

      <!-- 来源条目 / 目标条目 -->
      <section v-for="side in DETAILS" :key="side" class="wk-col wk-detail">
        <div class="wk-col-head">
          <span class="wk-tag" :class="side">{{ side === 'src' ? (src.loc === 'col' ? '收藏' : '来源') : '目标' }}</span><b>条目</b>
          <span v-if="cmp && side === 'src'" class="faint"><del>红色</del>：只在来源中</span>
          <span v-if="cmp && side === 'tgt'" class="faint"><ins>绿色</ins>：只在目标中</span>
          <span v-if="readonlyOf(side)" class="faint">只读</span>
        </div>
        <div class="wk-detail-body">
          <PromptDetail
            v-if="detailRow(side)"
            :prompt="/** @type {any} */ (detailRow(side)).p"
            :order="/** @type {any} */ (detailRow(side)).o"
            :has-order="!(/** @type {any} */ (detailRow(side)).c)"
            :readonly="readonlyOf(side)"
            :other="otherText(side)"
            :side="side === 'src' ? 'a' : 'b'"
            :changed="cmp ? cmp.changed : []"
            @set="(k, v) => detailRow(side) && setField(side, /** @type {any} */ (detailRow(side)), k, v)"
            @insert="detailRow(side) && insertRow(side, /** @type {any} */ (detailRow(side)))"
          />
          <div v-else-if="W.compare && !sameBuf && (side === 'src' ? rowT : rowS)" class="faint wk-note">{{ side === 'src' ? '来源' : '目标' }}中没有对应的条目</div>
          <div v-else class="faint wk-note">在{{ side === 'src' ? '来源' : '目标' }}列表中选择一条提示词，在这里查看和编辑</div>
        </div>
      </section>
    </div>

    <!-- same identifier, other content -->
    <div v-if="pending" class="modal-back" @click.self="pending = null">
      <div class="modal wk-modal">
        <h3>目标中已有同一条目</h3>
        <p class="muted">目标里已有这些条目（同一 ID），内容不同：{{ pending.clashes.join('、') }}。</p>
        <div class="wk-modal-btns">
          <button class="btn primary" type="button" @click="applyCopy(pending.items, pending.anchor, 'replace')">替换内容</button>
          <button class="btn" type="button" @click="applyCopy(pending.items, pending.anchor, 'copy')">作为副本插入</button>
          <button class="btn ghost" type="button" @click="pending = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wk { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: var(--sp-3) var(--sp-4); box-sizing: border-box; gap: var(--sp-3); }
.wk-head { display: flex; align-items: center; gap: var(--sp-3); }
.wk-head h2 { margin: 0; font-size: var(--fs-xl); font-weight: 600; display: flex; align-items: center; gap: var(--sp-2); }
.wk-head .spacer, .wk-foot .spacer { flex: 1; }
.wk-info { position: relative; display: inline-flex; color: var(--text-3); cursor: help; outline: none; border-radius: 50%; }
.wk-info:hover, .wk-info:focus-visible, .wk-info.open { color: var(--accent-text); }
.wk-tip { display: none; position: absolute; left: -8px; top: calc(100% + 8px); z-index: 40; width: 440px; padding: 10px 12px; background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: var(--r-md, 8px); box-shadow: 0 8px 24px rgba(0, 0, 0, .35); font-size: var(--fs-sm); line-height: 1.7; color: var(--text-2); cursor: default; }
.wk-info:hover .wk-tip, .wk-info:focus .wk-tip, .wk-info.open .wk-tip { display: block; }
.wk-cmp { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--text-2); cursor: pointer; }
.wk-colsave { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); }
.wk-dirty { white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; color: var(--st-warn); font-size: var(--fs-xs); }
.wk-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, .9fr) minmax(0, 1.1fr) minmax(0, 1.1fr); grid-template-rows: minmax(0, 1fr); gap: var(--sp-3); }
.wk-col { display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--line); border-radius: var(--r-md, 8px); background: var(--bg-2); overflow: hidden; }
.wk-col-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--line); font-size: var(--fs-sm); min-width: 0; }
.wk-col-head .icon-btn, .wk-col-head .wk-tag { flex: none; }
/* 「在预设编辑器中打开」+ 预设选择栏 + 「选择历史版本」 stay on one line; in a narrow column they move below 位置 together */
.wk-pickrow { display: flex; align-items: center; gap: 6px; flex: 1 1 220px; min-width: 0; }
.wk-tag { font-size: var(--fs-xs); padding: 1px 8px; border-radius: var(--r-pill); flex: none; }
.wk-tag.src { background: var(--bg-3); color: var(--text-2); }
.wk-tag.tgt { background: var(--accent-soft); color: var(--accent-text); }
.wk-loc { flex: 1 0 108px; min-width: 0; }
/* SearchSelect has two roots, so the scope id does not reach its trigger: :deep */
.wk-pickrow :deep(.wk-pick) { flex: 1 1 0; min-width: 0; }
.wk-colcount { font-size: var(--fs-xs); }
.wk-tools { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); }
.wk-tools .search { flex: 1; min-width: 0; }
.wk-tools .search .input { width: 100%; min-width: 0; }
.wk-hint { font-size: var(--fs-xs); padding: 0 var(--sp-3) var(--sp-2); }
.wk-rows { flex: 1; overflow: auto; min-height: 0; }
.wk-rows.dropping { outline: 1px dashed var(--accent-line); outline-offset: -3px; }
.wk-note { padding: var(--sp-4); font-size: var(--fs-sm); }
.wk-row { display: flex; align-items: center; gap: var(--sp-2); padding: 5px var(--sp-3); cursor: pointer; border-left: 2px solid transparent; position: relative; }
.wk-row:hover { background: var(--bg-3); }
.wk-row.st-diff, .wk-row.st-renamed { background: color-mix(in srgb, var(--st-warn) 8%, transparent); }
.wk-row.st-only { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.wk-row.on { background: var(--accent-soft); border-left-color: var(--accent); }
.wk-row.checked { background: var(--bg-3); }
.wk-row.off .wk-name { color: var(--text-3); text-decoration: line-through; }
.wk-row.out .wk-name { color: var(--text-3); }
.wk-row.drop-before::before, .wk-row.drop-after::after, .wk-end.drop-after::before { content: ''; position: absolute; left: 0; right: 0; height: 2px; background: var(--accent); }
.wk-row.drop-before::before { top: -1px; }
.wk-row.drop-after::after { bottom: -1px; }
.wk-end { position: relative; min-height: 36px; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-3); }
.wk-end.drop-after::before { top: 0; }
.wk-check { margin: 0; flex: none; }
.wk-no { width: 22px; text-align: right; font-size: var(--fs-xs); flex: none; }
.wk-row-main { min-width: 0; flex: 1; }
.wk-name, .wk-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk-name { font-size: var(--fs-sm); }
.wk-sub { font-size: 11px; }
.wk-out { margin-left: 6px; font-size: 10px; padding: 0 5px; border-radius: var(--r-pill); border: 1px dashed var(--line-strong); color: var(--text-3); text-decoration: none; display: inline-block; }
.wk-st { font-size: 10px; padding: 1px 6px; border-radius: var(--r-pill); flex: none; }
.wk-st.diff, .wk-st.renamed { background: color-mix(in srgb, var(--st-warn) 18%, transparent); color: var(--st-warn); }
.wk-st.only { background: var(--accent-soft); color: var(--accent-text); }
.icon-btn.danger { color: var(--st-conflict); }
.wk-foot { flex-wrap: wrap; display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--line); font-size: var(--fs-xs); }
.wk-detail-body { flex: 1; min-height: 0; overflow: auto; padding: var(--sp-4); }
.wk-col-head ins { text-decoration: none; background: var(--diff-add); border-radius: 3px; padding: 0 3px; box-shadow: inset 0 -1px 0 var(--st-synced); }
.wk-col-head del { background: var(--diff-del); color: var(--text-2); border-radius: 3px; text-decoration-color: var(--st-conflict); padding: 0 3px; }
.wk-modal { max-width: 460px; }
.modal-back { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--bg-0) 60%, transparent); }
.modal { background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: var(--r-lg, 10px); padding: var(--sp-5); box-shadow: 0 12px 40px rgba(0, 0, 0, .35); }
.modal h3 { margin: 0 0 var(--sp-2); font-size: var(--fs-lg); }
.modal p { margin: 0; line-height: 1.6; font-size: var(--fs-sm); }
.wk-modal-btns { display: flex; gap: var(--sp-2); justify-content: flex-end; margin-top: var(--sp-4); }
.grow { flex: 1; min-width: 0; }
.empty.grow { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); }
</style>
