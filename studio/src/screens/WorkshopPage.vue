<script setup>
// 预设工坊: compare the prompts of two chat-completion presets and move prompts between them.
//   来源  any workspace preset, as it is now or as it was in a version (read-only) — 新旧对比
//   目标  a workspace preset, edited in place (useItem); it then syncs the usual way
//   收藏  saved prompts (workshop/prompts.json, versioned with the workspace) to insert later
// Prompts are matched by identifier, then by name. Drag a prompt onto the target list to copy it there (or into the
// collection to keep it); drag inside the target list to reorder. Every drag has a button alternative.
import { ref, shallowRef, computed, watch, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import Toggle from '../components/Toggle.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { useItem } from '../lib/useItem.js';
import { api, errorText } from '../api.js';
import { displayName, relTime } from '../lib/status.js';
import { diffText } from '../lib/diff.js';
import { FILTER_TIPS, PROMPT_FILTERS, filterPrompts, globalOrderOf, orderedPrompts, promptsOf, roleOf } from '../lib/presetPrompts.js';

const app = useApp();
const ui = useUi();

const ROLE_LABEL = { system: '系统', user: '用户', assistant: 'AI' };
const KEY = 'cs.workshop';
const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } })();

const presets = computed(() => app.items.filter((/** @type {any} */ i) => i.kind === 'preset'));
const nameOf = (/** @type {string} */ path) => displayName(app.item(path) || { path });

// ---- 来源 --------------------------------------------------------------------
const srcPath = ref('');
/** '' = the workspace as it is now; otherwise a version id */
const srcRev = ref('');
const srcData = shallowRef(/** @type {any} */ (null));
const srcErr = ref('');
const srcLoading = ref(false);
/** @type {import('vue').Ref<any[]>} */
const versions = ref([]);

async function loadVersions() {
  versions.value = [];
  if (!srcPath.value) return;
  try {
    const h = await api.history({ path: srcPath.value, limit: 60 });
    versions.value = (h.versions || []).filter((/** @type {any} */ v) => !v.draft);
  } catch { /* no history yet: only 当前 */ }
}
let srcSeq = 0;
async function loadSource() {
  const seq = ++srcSeq;
  srcErr.value = '';
  if (!srcPath.value) { srcData.value = null; return; }
  srcLoading.value = true;
  try {
    const r = srcRev.value ? await api.itemAt(srcRev.value, srcPath.value) : await api.item(srcPath.value);
    if (seq === srcSeq) srcData.value = r.data;
  } catch (e) {
    if (seq === srcSeq) { srcData.value = null; srcErr.value = errorText(e); }
  } finally {
    if (seq === srcSeq) srcLoading.value = false;
  }
}
watch(srcPath, () => { srcRev.value = ''; loadVersions(); });
watch([srcPath, srcRev], loadSource);
// the workspace source follows edits made elsewhere
watch(() => app.item(srcPath.value)?.hash, () => { if (!srcRev.value && !sameLive.value) loadSource(); });

// ---- 目标 --------------------------------------------------------------------
const tgtPath = ref('');
const tgt = useItem(tgtPath);
const rev = ref(0);
watch(tgt.version, () => { rev.value++; });
const tdata = computed(() => { void rev.value; return tgtPath.value ? tgt.data.value : null; });
function edited() { rev.value++; tgt.touch(); }
const saveState = computed(() => (tgt.saving.value ? 'saving' : tgt.dirty.value && !tgt.externalChange.value ? 'dirty' : 'saved'));

/** Source and target are the same preset as it is now: the source shows the live target. */
const sameLive = computed(() => !!srcPath.value && srcPath.value === tgtPath.value && !srcRev.value);
const sdata = computed(() => { void rev.value; return sameLive.value ? tdata.value : srcData.value; });

async function pickTarget(/** @type {string} */ p) {
  await tgt.save();
  tgtPath.value = p;
}
function persist() { localStorage.setItem(KEY, JSON.stringify({ src: srcPath.value, tgt: tgtPath.value })); }
watch([srcPath, tgtPath], persist);

onMounted(() => {
  const has = (/** @type {string} */ p) => presets.value.some((/** @type {any} */ i) => i.path === p);
  if (saved.src && has(saved.src)) srcPath.value = saved.src;
  if (saved.tgt && has(saved.tgt)) tgtPath.value = saved.tgt;
  loadCollection();
});

// ---- rows, matching ----------------------------------------------------------
const fS = ref('default'), fT = ref('default'), qS = ref(''), qT = ref('');
// data objects are mutated in place: depend on rev so the lists follow edits
const srcAll = computed(() => { void rev.value; return orderedPrompts(sdata.value); });
const tgtAll = computed(() => { void rev.value; return orderedPrompts(tdata.value); });

/** Compared fields, normalized the way ST reads them. @param {any} p */
const norm = (p) => ({
  name: String(p?.name ?? ''), role: roleOf(p), content: String(p?.content ?? ''),
  position: Number(p?.injection_position) || 0, depth: Number(p?.injection_depth ?? 4), forbid: !!p?.forbid_overrides
});
const samePrompt = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/** Counterpart in `rows`: same identifier, else same (non-empty) name. @param {any} p @param {import('../lib/presetPrompts.js').PromptRow[]} rows */
function match(p, rows) {
  return rows.find((r) => r.p.identifier === p?.identifier) || (p?.name ? rows.find((r) => r.p.name === p.name) : undefined) || null;
}
/** 'only' | 'same' | 'diff' for a row against the other side. */
function stateOf(/** @type {any} */ row, /** @type {any[]} */ other) {
  const m = match(row.p, other);
  if (!m) return 'only';
  return samePrompt(row.p, m.p) && !!row.o?.enabled === !!m.o?.enabled && !!row.o === !!m.o ? 'same' : 'diff';
}
const srcRows = computed(() => filterPrompts(srcAll.value, fS.value, qS.value).map((r) => ({ ...r, st: stateOf(r, tgtAll.value) })));
const tgtRows = computed(() => filterPrompts(tgtAll.value, fT.value, qT.value).map((r) => ({ ...r, st: stateOf(r, srcAll.value) })));
const counts = computed(() => {
  const c = { same: 0, diff: 0, onlySrc: 0, onlyTgt: 0 };
  for (const r of srcAll.value) { const s = stateOf(r, tgtAll.value); if (s === 'same') c.same++; else if (s === 'diff') c.diff++; else c.onlySrc++; }
  for (const r of tgtAll.value) if (!match(r.p, srcAll.value)) c.onlyTgt++;
  return c;
});
const ST_LABEL = { src: { only: '目标没有', same: '相同', diff: '不同' }, tgt: { only: '来源没有', same: '相同', diff: '不同' } };

// ---- selection & comparison --------------------------------------------------
/** @type {import('vue').Ref<{side: 'src'|'tgt'|'col', id: string}|null>} */
const sel = ref(null);
/** checked source rows (multi-select for 复制 / 收藏) */
const checked = ref(/** @type {Set<string>} */ (new Set()));
watch([srcPath, srcRev], () => { checked.value = new Set(); });
function toggleCheck(/** @type {string} */ id) {
  const s = new Set(checked.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  checked.value = s;
}
function clickRow(/** @type {'src'|'tgt'|'col'} */ side, /** @type {string} */ id, /** @type {MouseEvent} */ ev) {
  if (side === 'src' && (ev.ctrlKey || ev.metaKey)) { toggleCheck(id); return; }
  sel.value = { side, id };
}

const pair = computed(() => {
  const s = sel.value;
  if (!s) return null;
  if (s.side === 'col') {
    const c = collection.value.prompts.find((x) => x.id === s.id);
    if (!c) return null;
    const m = match(c.prompt, tgtAll.value);
    return { a: c.prompt, ao: { enabled: !!c.enabled }, b: m?.p ?? null, bo: m?.o ?? null, aLabel: '收藏', title: c.title || c.prompt.name };
  }
  const mine = (s.side === 'src' ? srcAll.value : tgtAll.value).find((r) => r.p.identifier === s.id);
  if (!mine) return null;
  const other = match(mine.p, s.side === 'src' ? tgtAll.value : srcAll.value);
  const [a, b] = s.side === 'src' ? [mine, other] : [other, mine];
  return { a: a?.p ?? null, ao: a?.o ?? null, b: b?.p ?? null, bo: b?.o ?? null, aLabel: '来源', title: mine.p.name || mine.p.identifier };
});
const fieldRows = computed(() => {
  const p = pair.value;
  if (!p || !p.a || !p.b) return [];
  const a = norm(p.a), b = norm(p.b);
  const pos = (/** @type {any} */ n) => (n.position === 1 ? `聊天中 @${n.depth}` : '相对');
  const out = [];
  if (a.name !== b.name) out.push({ k: '名称', a: a.name, b: b.name });
  if (a.role !== b.role) out.push({ k: '角色', a: ROLE_LABEL[/** @type {'system'} */ (a.role)], b: ROLE_LABEL[/** @type {'system'} */ (b.role)] });
  if (pos(a) !== pos(b)) out.push({ k: '位置', a: pos(a), b: pos(b) });
  if (a.forbid !== b.forbid) out.push({ k: '禁止角色卡覆盖', a: a.forbid ? '是' : '否', b: b.forbid ? '是' : '否' });
  const en = (/** @type {any} */ o) => (o ? (o.enabled ? '启用' : '停用') : '未插入');
  if (en(p.ao) !== en(p.bo)) out.push({ k: '开关', a: en(p.ao), b: en(p.bo) });
  return out;
});
const contentParts = computed(() => {
  const p = pair.value;
  if (!p) return [];
  return diffText(String(p.a?.content ?? ''), String(p.b?.content ?? ''));
});

// ---- writing into the target -------------------------------------------------
/** The target's global order, created when missing (a preset that never had one). */
function ensureOrder() {
  const d = tdata.value;
  let list = globalOrderOf(d);
  if (!list) {
    if (!Array.isArray(d.prompt_order)) d.prompt_order = [];
    list = [];
    d.prompt_order.push({ character_id: 100001, order: list });
  }
  return list;
}
/** Index in the order where a drop/insert lands. @param {{id: string, after: boolean}|null} anchor */
function anchorIndex(/** @type {any[]} */ order, anchor) {
  if (!anchor) return order.length;
  const i = order.findIndex((o) => o.identifier === anchor.id);
  return i < 0 ? order.length : i + (anchor.after ? 1 : 0);
}
const clone = (/** @type {any} */ v) => JSON.parse(JSON.stringify(v));

/** @typedef {{p: any, enabled: boolean}} Incoming */
/** @type {import('vue').Ref<{items: Incoming[], anchor: any, clashes: string[]}|null>} */
const pending = ref(null);

/** Copies prompts into the target at `anchor`; asks first when the target has the same identifier with other content. */
function copyIn(/** @type {Incoming[]} */ items, /** @type {any} */ anchor) {
  if (!tdata.value || !items.length) return;
  const have = promptsOf(tdata.value);
  const clashes = items.filter(({ p }) => !p.marker && have.some((x) => x.identifier === p.identifier && !samePrompt(x, p))).map(({ p }) => p.name || p.identifier);
  if (clashes.length) { pending.value = { items, anchor, clashes }; return; }
  applyCopy(items, anchor, 'replace');
}
/** @param {'replace'|'copy'} mode what to do with a prompt whose identifier the target already has */
function applyCopy(/** @type {Incoming[]} */ items, /** @type {any} */ anchor, mode) {
  pending.value = null;
  const d = tdata.value;
  if (!Array.isArray(d.prompts)) d.prompts = [];
  const order = ensureOrder();
  let at = anchorIndex(order, anchor);
  let last = '';
  for (const { p, enabled } of items) {
    const existing = d.prompts.find((/** @type {any} */ x) => x.identifier === p.identifier);
    let id = p.identifier;
    if (!existing) d.prompts.push(clone(p));
    else if (p.marker || samePrompt(existing, p) || mode === 'replace') {
      if (!p.marker) { for (const k of Object.keys(existing)) delete existing[k]; Object.assign(existing, clone(p)); }
    } else {
      id = crypto.randomUUID();
      d.prompts.push({ ...clone(p), identifier: id, system_prompt: false });
    }
    const oi = order.findIndex((/** @type {any} */ o) => o.identifier === id);
    if (oi >= 0) { order.splice(oi, 1); if (oi < at) at--; }
    order.splice(at++, 0, { identifier: id, enabled: !!enabled });
    last = id;
  }
  edited();
  if (last) sel.value = { side: 'tgt', id: last };
  ui.toast(`已写入目标：${items.length} 条`, 'check');
}
/** Moves target prompts within the order (a 未插入 prompt dragged in gets inserted, off). */
function moveIn(/** @type {string[]} */ ids, /** @type {any} */ anchor) {
  const order = ensureOrder();
  if (anchor && ids.includes(anchor.id)) return;
  const moving = ids.map((id) => order.find((/** @type {any} */ o) => o.identifier === id) || { identifier: id, enabled: false });
  for (const m of moving) { const i = order.indexOf(m); if (i >= 0) order.splice(i, 1); }
  order.splice(anchorIndex(order, anchor), 0, ...moving);
  edited();
}
function toggleOrder(/** @type {any} */ o) { o.enabled = !o.enabled; edited(); }

/** Source prompts to copy: the checked rows, else the selected one. */
const picked = computed(() => {
  const ids = checked.value.size ? [...checked.value] : sel.value?.side === 'src' ? [sel.value.id] : [];
  return srcAll.value.filter((r) => ids.includes(r.p.identifier));
});
/** 复制到目标: after the selected target prompt, else at the end. */
function copyPicked() {
  const anchor = sel.value?.side === 'tgt' ? { id: sel.value.id, after: true } : null;
  copyIn(picked.value.map((r) => ({ p: r.p, enabled: !!r.o?.enabled })), anchor);
  checked.value = new Set();
}

// ---- drag & drop -------------------------------------------------------------
/** @type {import('vue').Ref<{from: 'src'|'tgt'|'col', ids: string[]}|null>} */
const drag = ref(null);
/** drop indicator: target row id + before/after, or '$end' / '$col' */
const dropAt = ref(/** @type {{id: string, after: boolean}|null} */ (null));
function dragStart(/** @type {'src'|'tgt'|'col'} */ from, /** @type {string} */ id, /** @type {DragEvent} */ ev) {
  const ids = from === 'src' && checked.value.has(id) ? [...checked.value] : [id];
  drag.value = { from, ids };
  ev.dataTransfer?.setData('text/plain', ids.join('\n'));
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = from === 'tgt' ? 'copyMove' : 'copy';
}
function dragEnd() { drag.value = null; dropAt.value = null; }
function overRow(/** @type {string} */ id, /** @type {DragEvent} */ ev) {
  if (!drag.value || !tdata.value) return;
  ev.preventDefault();
  const el = /** @type {HTMLElement} */ (ev.currentTarget);
  const r = el.getBoundingClientRect();
  dropAt.value = { id, after: ev.clientY > r.top + r.height / 2 };
}
function overEnd(/** @type {DragEvent} */ ev) {
  if (!drag.value || !tdata.value) return;
  ev.preventDefault();
  if (!dropAt.value || dropAt.value.id !== '$end') dropAt.value = { id: '$end', after: true };
}
/** Rows dropped on a 未插入 target row go to the end of the order. */
function anchorFor(/** @type {{id: string, after: boolean}|null} */ at) {
  if (!at || at.id === '$end') return null;
  return tgtAll.value.find((r) => r.p.identifier === at.id)?.o ? at : null;
}
function dropTarget(/** @type {DragEvent} */ ev) {
  ev.preventDefault();
  const d = drag.value, anchor = anchorFor(dropAt.value);
  dragEnd();
  if (!d || !tdata.value) return;
  if (d.from === 'tgt') moveIn(d.ids, anchor);
  else if (d.from === 'src') copyIn(srcAll.value.filter((r) => d.ids.includes(r.p.identifier)).map((r) => ({ p: r.p, enabled: !!r.o?.enabled })), anchor);
  else copyIn(collection.value.prompts.filter((c) => d.ids.includes(c.id)).map((c) => ({ p: c.prompt, enabled: !!c.enabled })), anchor);
  checked.value = new Set();
}
const colOver = ref(false);
function overCol(/** @type {DragEvent} */ ev) { if (drag.value && drag.value.from !== 'col') { ev.preventDefault(); colOver.value = true; } }
function dropCol(/** @type {DragEvent} */ ev) {
  ev.preventDefault();
  colOver.value = false;
  const d = drag.value;
  dragEnd();
  if (!d || d.from === 'col') return;
  const rows = (d.from === 'src' ? srcAll.value : tgtAll.value).filter((r) => d.ids.includes(r.p.identifier));
  collect(rows, d.from === 'src' ? srcLabel.value : nameOf(tgtPath.value));
  checked.value = new Set();
}

// ---- 收藏 --------------------------------------------------------------------
/** @typedef {{id: string, title: string, from?: string, savedAt?: string, enabled?: boolean, prompt: any}} Saved */
const collection = ref(/** @type {{version: number, prompts: Saved[]}} */ ({ version: 1, prompts: [] }));
const colHash = ref('');
const colErr = ref('');
async function loadCollection() {
  try {
    const r = await api.collection();
    collection.value = { version: 1, ...r.collection, prompts: Array.isArray(r.collection?.prompts) ? r.collection.prompts : [] };
    colHash.value = r.hash;
    colErr.value = '';
  } catch (e) {
    colErr.value = errorText(e);
  }
}
async function saveCollection(/** @type {Saved[]} */ prompts) {
  const next = { ...collection.value, prompts };
  try {
    const r = await api.saveCollection(next, colHash.value);
    collection.value = next;
    colHash.value = r.hash;
    return true;
  } catch (e) {
    ui.toast('收藏没有保存：' + errorText(e), 'alert');
    if (/** @type {any} */ (e).code === 'conflict') await loadCollection();
    return false;
  }
}
const srcLabel = computed(() => nameOf(srcPath.value) + (srcRev.value ? ' @' + srcRev.value.slice(0, 8) : ''));
async function collect(/** @type {any[]} */ rows, /** @type {string} */ from) {
  const add = rows.filter((r) => !r.p.marker).map((r) => ({ id: crypto.randomUUID(), title: r.p.name || r.p.identifier, from, savedAt: new Date().toISOString(), enabled: !!r.o?.enabled, prompt: clone(r.p) }));
  if (rows.length && !add.length) { ui.toast('占位提示词由酒馆生成内容，不能收藏', 'alert'); return; }
  if (add.length && await saveCollection([...collection.value.prompts, ...add])) ui.toast(`已收藏 ${add.length} 条`, 'check');
}
function collectPicked() { collect(picked.value, srcLabel.value); checked.value = new Set(); }
const renaming = ref('');
const renameText = ref('');
function startRename(/** @type {Saved} */ c) { renaming.value = c.id; renameText.value = c.title; }
async function finishRename() {
  const id = renaming.value;
  renaming.value = '';
  const title = renameText.value.trim();
  const c = collection.value.prompts.find((x) => x.id === id);
  if (!c || !title || title === c.title) return;
  await saveCollection(collection.value.prompts.map((x) => (x.id === id ? { ...x, title } : x)));
}
const armedDelete = ref('');
async function removeSaved(/** @type {string} */ id) {
  if (armedDelete.value !== id) { armedDelete.value = id; return; }
  armedDelete.value = '';
  if (sel.value?.side === 'col' && sel.value.id === id) sel.value = null;
  await saveCollection(collection.value.prompts.filter((x) => x.id !== id));
}
function insertSaved(/** @type {Saved} */ c) {
  const anchor = sel.value?.side === 'tgt' ? { id: sel.value.id, after: true } : null;
  copyIn([{ p: c.prompt, enabled: !!c.enabled }], anchor);
}

const preview = (/** @type {any} */ p) => (p.marker ? '占位（内容由酒馆生成）' : String(p.content || '').slice(0, 80) || '（空）');
</script>

<template>
  <div class="wk">
    <div class="wk-head">
      <h2><Icon name="workshop" />预设工坊</h2>
      <p class="muted">对比两个预设的提示词：把来源的条目拖到目标列表中的位置即可复制，在目标列表内拖动可调整顺序；拖到「收藏」保存起来，以后再插入。来源可以选某个历史版本，用来做新旧对比。目标写入工作区后照常同步。</p>
    </div>

    <div v-if="!presets.length" class="empty grow">
      <Icon name="sliders" /><h3>工作区里还没有预设</h3>
      <p class="muted">先在资料库取出要对比的对话补全预设。</p>
      <a class="btn" href="#/library/preset"><Icon name="library" size="sm" />去资料库</a>
    </div>

    <template v-else>
      <div class="wk-main" :class="{ 'has-diff': !!pair }">
        <!-- 来源 -->
        <section class="wk-col">
          <div class="wk-col-head">
            <span class="wk-tag src">来源</span>
            <select v-model="srcPath" class="input wk-pick" aria-label="来源预设">
              <option value="">选择预设…</option>
              <option v-for="p in presets" :key="p.path" :value="p.path">{{ nameOf(p.path) }}</option>
            </select>
            <select v-model="srcRev" class="input wk-rev" :disabled="!srcPath" aria-label="来源版本" title="选择历史版本做新旧对比">
              <option value="">当前（工作区）</option>
              <option v-for="v in versions" :key="v.id" :value="v.id">{{ v.id.slice(0, 8) }} · {{ relTime(v.time) }} · {{ v.message }}</option>
            </select>
          </div>
          <div class="wk-tools">
            <label class="search grow"><Icon name="search" size="sm" /><input v-model="qS" class="input" placeholder="搜索名称或内容" /></label>
            <label class="mini-select" :class="{ active: fS !== 'default' }" :title="FILTER_TIPS[fS]"><span>显示</span>
              <select v-model="fS"><option v-for="x in PROMPT_FILTERS" :key="x.value" :value="x.value">{{ x.label }}</option></select><Icon name="chevDown" size="sm" />
            </label>
          </div>
          <div class="wk-rows">
            <div v-if="srcErr" class="sync-note err wk-note">{{ srcErr }}</div>
            <div v-else-if="!srcPath" class="faint wk-note">选择来源预设</div>
            <div v-else-if="srcLoading && !srcData" class="faint wk-note"><Icon name="spin" size="sm" /> 正在读取…</div>
            <div
              v-for="r in srcRows"
              :key="r.p.identifier"
              class="wk-row"
              :class="{ on: sel?.side === 'src' && sel.id === r.p.identifier, off: r.o && !r.o.enabled, out: !r.o, checked: checked.has(r.p.identifier) }"
              draggable="true"
              tabindex="0"
              @dragstart="dragStart('src', r.p.identifier, $event)"
              @dragend="dragEnd"
              @click="clickRow('src', r.p.identifier, $event)"
              @keydown.enter="sel = { side: 'src', id: r.p.identifier }"
              @keydown.space.prevent="toggleCheck(r.p.identifier)"
            >
              <input type="checkbox" class="wk-check" :checked="checked.has(r.p.identifier)" title="多选" @click.stop="toggleCheck(r.p.identifier)" />
              <span class="wk-no mono faint">{{ r.n || '–' }}</span>
              <div class="grow wk-row-main">
                <div class="wk-name">{{ r.p.name || r.p.identifier }}<span v-if="!r.o" class="wk-out">未插入</span></div>
                <div class="wk-sub faint">{{ preview(r.p) }}</div>
              </div>
              <span v-if="tgtPath" class="wk-st" :class="r.st">{{ ST_LABEL.src[r.st] }}</span>
            </div>
            <div v-if="srcPath && sdata && !srcRows.length" class="faint wk-note">没有匹配的提示词</div>
          </div>
          <div class="wk-foot">
            <button class="btn sm" type="button" :disabled="!picked.length || !tdata" :title="sel?.side === 'tgt' ? '插到目标中所选条目之后' : '插到目标末尾'" @click="copyPicked"><Icon name="copyPlus" size="sm" />复制到目标{{ picked.length > 1 ? `（${picked.length}）` : '' }}</button>
            <button class="btn sm ghost" type="button" :disabled="!picked.length" @click="collectPicked"><Icon name="bookmarkPlus" size="sm" />收藏</button>
            <span class="spacer" />
            <span class="faint">Ctrl+点击 多选</span>
          </div>
        </section>

        <!-- 目标 -->
        <section class="wk-col">
          <div class="wk-col-head">
            <span class="wk-tag tgt">目标</span>
            <select class="input wk-pick" :value="tgtPath" aria-label="目标预设" @change="pickTarget(/** @type {any} */ ($event.target).value)">
              <option value="">选择预设…</option>
              <option v-for="p in presets" :key="p.path" :value="p.path">{{ nameOf(p.path) }}</option>
            </select>
            <a v-if="tgtPath" class="icon-btn" :href="'#/item/' + encodeURIComponent(tgtPath)" title="在预设编辑器中打开"><Icon name="external" size="sm" /></a>
          </div>
          <div class="wk-tools">
            <label class="search grow"><Icon name="search" size="sm" /><input v-model="qT" class="input" placeholder="搜索名称或内容" /></label>
            <label class="mini-select" :class="{ active: fT !== 'default' }" :title="FILTER_TIPS[fT]"><span>显示</span>
              <select v-model="fT"><option v-for="x in PROMPT_FILTERS" :key="x.value" :value="x.value">{{ x.label }}</option></select><Icon name="chevDown" size="sm" />
            </label>
          </div>
          <div v-if="tgt.externalChange.value" class="banner warn wk-banner">
            <Icon name="alert" /><div class="grow">目标在别处被修改，暂停写入。</div>
            <button class="btn sm" type="button" @click="tgt.load()">重新加载</button>
          </div>
          <div class="wk-rows" :class="{ dropping: !!drag && !!tdata }" @dragover="overEnd" @drop="dropTarget" @dragleave.self="dropAt = null">
            <div v-if="!tgtPath" class="faint wk-note">选择目标预设（会被修改）</div>
            <div v-else-if="tgt.error.value && !tgt.data.value" class="sync-note err wk-note">{{ tgt.error.value }}</div>
            <div v-else-if="!tdata" class="faint wk-note"><Icon name="spin" size="sm" /> 正在读取…</div>
            <div
              v-for="r in tgtRows"
              :key="r.p.identifier"
              class="wk-row"
              :class="{ on: sel?.side === 'tgt' && sel.id === r.p.identifier, off: r.o && !r.o.enabled, out: !r.o, 'drop-before': dropAt?.id === r.p.identifier && !dropAt.after, 'drop-after': dropAt?.id === r.p.identifier && dropAt.after }"
              draggable="true"
              tabindex="0"
              @dragstart="dragStart('tgt', r.p.identifier, $event)"
              @dragend="dragEnd"
              @dragover.stop="overRow(r.p.identifier, $event)"
              @click="clickRow('tgt', r.p.identifier, $event)"
              @keydown.enter="sel = { side: 'tgt', id: r.p.identifier }"
            >
              <Icon name="grip" size="sm" class="wk-grip" />
              <span class="wk-no mono faint">{{ r.n || '–' }}</span>
              <div class="grow wk-row-main">
                <div class="wk-name">{{ r.p.name || r.p.identifier }}<span v-if="!r.o" class="wk-out">未插入</span></div>
                <div class="wk-sub faint">{{ preview(r.p) }}</div>
              </div>
              <span v-if="srcPath && r.st !== 'same'" class="wk-st" :class="r.st">{{ ST_LABEL.tgt[r.st] }}</span>
              <Toggle v-if="r.o" :model-value="!!r.o.enabled" :title="r.o.enabled ? '已启用' : '已停用'" @click.stop @update:model-value="toggleOrder(r.o)" />
            </div>
            <div v-if="tdata" class="wk-end" :class="{ 'drop-after': dropAt?.id === '$end' }">{{ drag ? '放到这里：插到末尾' : tgtRows.length ? '' : '没有匹配的提示词' }}</div>
          </div>
          <div class="wk-foot faint">
            <span class="ce-save" :class="{ busy: saveState !== 'saved' }">
              <template v-if="saveState === 'saving'"><Icon name="spin" size="sm" />正在写入…</template>
              <template v-else-if="saveState === 'dirty'"><Icon name="dot" size="sm" />未写入</template>
              <template v-else-if="tgtPath"><Icon name="check" size="sm" />已写入工作区</template>
            </span>
            <span class="spacer" />
            <span v-if="srcPath && tgtPath">相同 {{ counts.same }} · 不同 {{ counts.diff }} · 仅来源 {{ counts.onlySrc }} · 仅目标 {{ counts.onlyTgt }}</span>
          </div>
        </section>

        <!-- 收藏 -->
        <section class="wk-col wk-colx" :class="{ over: colOver }" @dragover="overCol" @dragleave.self="colOver = false" @drop="dropCol">
          <div class="wk-col-head"><Icon name="bookmark" size="sm" /><b>收藏</b><span class="faint">{{ collection.prompts.length }}</span></div>
          <div class="faint wk-col-hint">把条目拖到这里收藏；拖到目标列表插入。保存在工作区 workshop/prompts.json。</div>
          <div class="wk-rows">
            <div v-if="colErr" class="sync-note err wk-note">{{ colErr }}</div>
            <div v-else-if="!collection.prompts.length" class="faint wk-note">还没有收藏</div>
            <div
              v-for="c in collection.prompts"
              :key="c.id"
              class="wk-row"
              :class="{ on: sel?.side === 'col' && sel.id === c.id }"
              draggable="true"
              tabindex="0"
              @dragstart="dragStart('col', c.id, $event)"
              @dragend="dragEnd"
              @click="clickRow('col', c.id, $event)"
              @keydown.enter="sel = { side: 'col', id: c.id }"
            >
              <div class="grow wk-row-main">
                <input v-if="renaming === c.id" v-model="renameText" class="input wk-rename" autofocus @click.stop @keydown.enter="finishRename" @keydown.esc="renaming = ''" @blur="finishRename" />
                <div v-else class="wk-name" title="双击重命名" @dblclick.stop="startRename(c)">{{ c.title }}</div>
                <div class="wk-sub faint">{{ c.from || '' }}{{ c.prompt.name && c.prompt.name !== c.title ? ' · ' + c.prompt.name : '' }}</div>
              </div>
              <button class="icon-btn" type="button" :disabled="!tdata" :title="sel?.side === 'tgt' ? '插到目标中所选条目之后' : '插到目标末尾'" @click.stop="insertSaved(c)"><Icon name="copyPlus" size="sm" /></button>
              <button class="icon-btn" type="button" :class="{ danger: armedDelete === c.id }" :title="armedDelete === c.id ? '再点一次删除' : '删除收藏'" @click.stop="removeSaved(c.id)" @blur="armedDelete = ''"><Icon :name="armedDelete === c.id ? 'alert' : 'trash'" size="sm" /></button>
            </div>
          </div>
        </section>

        <!-- 对比 -->
        <section v-if="pair" class="wk-diff">
          <div class="wk-diff-head">
            <b>{{ pair.title }}</b>
            <span v-if="!pair.b" class="faint">目标中没有对应的条目</span>
            <span v-else-if="!pair.a" class="faint">来源中没有对应的条目</span>
            <span v-else-if="!fieldRows.length && !contentParts.some((x) => x[0] !== '=')" class="faint">两边相同</span>
            <span v-else class="faint">{{ pair.aLabel }} → 目标：<del>删除线</del>是只在{{ pair.aLabel }}中的文字，<ins>下划线</ins>是只在目标中的</span>
            <span class="spacer" />
            <button class="icon-btn" type="button" title="关闭对比" @click="sel = null"><Icon name="x" size="sm" /></button>
          </div>
          <div v-if="fieldRows.length" class="wk-fields">
            <div v-for="f in fieldRows" :key="f.k" class="wk-field"><span class="faint">{{ f.k }}</span><del>{{ f.a }}</del><Icon name="next" size="sm" /><ins>{{ f.b }}</ins></div>
          </div>
          <div class="cf-text long wk-text"><template v-for="(p, i) in contentParts" :key="i"><ins v-if="p[0] === '+'">{{ p[1] }}</ins><del v-else-if="p[0] === '-'">{{ p[1] }}</del><span v-else>{{ p[1] }}</span></template><span v-if="!contentParts.length" class="faint">（内容为空）</span></div>
        </section>
      </div>
    </template>

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
.wk { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: var(--sp-4) var(--sp-5) var(--sp-4); box-sizing: border-box; gap: var(--sp-3); }
.wk-head h2 { margin: 0 0 4px; font-size: var(--fs-xl); font-weight: 600; display: flex; align-items: center; gap: var(--sp-2); }
.wk-head p { margin: 0; font-size: var(--fs-sm); line-height: 1.6; max-width: 900px; }
.wk-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 260px; grid-template-rows: minmax(0, 1fr); gap: var(--sp-3); }
.wk-main.has-diff { grid-template-rows: minmax(0, 1fr) minmax(160px, 38%); }
.wk-col { display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--line); border-radius: var(--r-md, 8px); background: var(--bg-2); overflow: hidden; }
.wk-colx { grid-row: 1 / -1; grid-column: 3; }
.wk-colx.over { border-color: var(--accent); background: var(--accent-soft); }
.wk-col-head { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--line); }
.wk-col-hint { font-size: var(--fs-xs); padding: var(--sp-2) var(--sp-3) 0; line-height: 1.5; }
.wk-tag { font-size: var(--fs-xs); padding: 1px 8px; border-radius: var(--r-pill); flex: none; }
.wk-tag.src { background: var(--bg-3); color: var(--text-2); }
.wk-tag.tgt { background: var(--accent-soft); color: var(--accent-text); }
.wk-pick { flex: 1; min-width: 0; }
.wk-rev { width: 34%; min-width: 0; }
.wk-tools { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); }
.wk-tools .search { min-width: 0; }
.wk-banner { margin: 0 var(--sp-3) var(--sp-2); }
.wk-rows { flex: 1; overflow: auto; min-height: 0; }
.wk-rows.dropping { outline: 1px dashed var(--accent-line); outline-offset: -3px; }
.wk-note { padding: var(--sp-4); font-size: var(--fs-sm); }
.wk-row { display: flex; align-items: center; gap: var(--sp-2); padding: 5px var(--sp-3); cursor: pointer; border-left: 2px solid transparent; position: relative; }
.wk-row:hover { background: var(--bg-3); }
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
.wk-grip { color: var(--text-3); flex: none; cursor: grab; }
.wk-no { width: 22px; text-align: right; font-size: var(--fs-xs); flex: none; }
.wk-row-main { min-width: 0; flex: 1; }
.wk-name, .wk-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk-name { font-size: var(--fs-sm); }
.wk-sub { font-size: 11px; }
.wk-out { margin-left: 6px; font-size: 10px; padding: 0 5px; border-radius: var(--r-pill); border: 1px dashed var(--line-strong); color: var(--text-3); text-decoration: none; display: inline-block; }
.wk-st { font-size: 10px; padding: 1px 6px; border-radius: var(--r-pill); flex: none; }
.wk-st.same { color: var(--text-3); }
.wk-st.diff { background: color-mix(in srgb, var(--st-warn) 18%, transparent); color: var(--st-warn); }
.wk-st.only { background: var(--accent-soft); color: var(--accent-text); }
.wk-rename { height: 24px; font-size: var(--fs-sm); width: 100%; }
.icon-btn.danger { color: var(--st-conflict); }
.wk-foot { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--line); font-size: var(--fs-xs); }
.wk-foot .spacer, .wk-diff-head .spacer { flex: 1; }
.wk-diff { grid-column: 1 / 3; grid-row: 2; display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--line); border-radius: var(--r-md, 8px); background: var(--bg-2); overflow: hidden; }
.wk-diff-head { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--line); font-size: var(--fs-sm); }
.wk-fields { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-5); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--line); font-size: var(--fs-sm); }
.wk-field { display: flex; align-items: center; gap: 6px; }
.wk-text { flex: 1; overflow: auto; margin: 0; padding: var(--sp-3); white-space: pre-wrap; border-radius: 0; }
.wk-modal { max-width: 460px; }
.modal-back { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--bg-0) 60%, transparent); }
.modal { background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: var(--r-lg, 10px); padding: var(--sp-5); box-shadow: 0 12px 40px rgba(0, 0, 0, .35); }
.modal h3 { margin: 0 0 var(--sp-2); font-size: var(--fs-lg); }
.modal p { margin: 0; line-height: 1.6; font-size: var(--fs-sm); }
.wk-fields ins, .wk-diff-head ins { text-decoration: none; background: var(--diff-add); border-radius: 3px; padding: 0 3px; box-shadow: inset 0 -1px 0 var(--st-synced); }
.wk-fields del, .wk-diff-head del { background: var(--diff-del); color: var(--text-2); border-radius: 3px; text-decoration-color: var(--st-conflict); padding: 0 3px; }
.wk-modal-btns { display: flex; gap: var(--sp-2); justify-content: flex-end; margin-top: var(--sp-4); }
.grow { flex: 1; min-width: 0; }
.empty.grow { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); }
</style>
