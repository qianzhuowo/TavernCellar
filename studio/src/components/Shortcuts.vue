<script setup>
// Global shortcuts (docs/studio-design.md §3): Ctrl+P quick open, Ctrl+S write now (+ sync prompt for manual bindings),
// Ctrl+Shift+S sync the current item to every reachable tavern, Ctrl+F focus the search box of the current screen.
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi, hrefOf } from '../stores/ui.js';
import { itemName, displayName, uiStatus, isConflict } from '../lib/status.js';
import { flushItem } from '../lib/useItem.js';
import { kindOf } from '../lib/kinds.js';
import { runBindingOp, canReach } from '../lib/syncOps.js';

const app = useApp();
const ui = useUi();

// ---- quick open ----------------------------------------------------------
const SCREENS = [
  { key: 'library', label: '资料库', icon: 'library' },
  { key: 'sync', label: '同步', icon: 'sync' },
  { key: 'history', label: '历史', icon: 'history' },
  { key: 'settings', label: '设置', icon: 'settings' }
];
const paletteOpen = ref(false);
const q = ref('');
const cursor = ref(0);
const input = ref(/** @type {HTMLInputElement|null} */ (null));

const entries = computed(() => {
  const items = app.items.map((/** @type {any} */ it) => ({
    key: 'item:' + it.path, label: displayName(it), sub: it.path + '/', icon: kindOf(it.kind).icon
  }));
  const all = [...items, ...SCREENS.map((s) => ({ ...s, sub: '' }))];
  const s = q.value.trim().toLowerCase();
  if (!s) return all;
  // label hits first, then path hits
  const score = (/** @type {any} */ e) => (e.label.toLowerCase().startsWith(s) ? 0 : e.label.toLowerCase().includes(s) ? 1 : e.sub.toLowerCase().includes(s) ? 2 : 9);
  return all.map((e) => ({ e, r: score(e) })).filter((x) => x.r < 9).sort((a, b) => a.r - b.r).map((x) => x.e);
});

async function openPalette() {
  paletteOpen.value = true;
  q.value = '';
  cursor.value = 0;
  await nextTick();
  input.value?.focus();
}
function pick(/** @type {any} */ e) {
  if (!e) return;
  paletteOpen.value = false;
  ui.go(hrefOf(e.key));
}
function paletteKey(/** @type {KeyboardEvent} */ ev) {
  const n = entries.value.length;
  if (ev.key === 'ArrowDown') { cursor.value = n ? (cursor.value + 1) % n : 0; ev.preventDefault(); }
  else if (ev.key === 'ArrowUp') { cursor.value = n ? (cursor.value - 1 + n) % n : 0; ev.preventDefault(); }
  else if (ev.key === 'Enter') { pick(entries.value[cursor.value]); ev.preventDefault(); }
  else if (ev.key === 'Escape') { paletteOpen.value = false; ev.preventDefault(); }
}

// ---- save / sync ---------------------------------------------------------
/** Item path the current tab is about ('' for library, sync, ...). */
const currentPath = () => (ui.route.name === 'item' ? ui.route.arg : '');

/** Bindings of an item with local edits that can be written to their tavern now (pinned ones never are). */
function syncable(/** @type {any} */ it, { manualOnly = false } = {}) {
  return (it?.bindings || []).filter((/** @type {any} */ b) => !b.pinned && uiStatus(b.status) === 'local'
    && canReach(app.modeOf(b)) && !(manualOnly && b.autoSync));
}

/** @type {import('vue').Ref<null | {path: string, bindings: any[], busy: boolean}>} */
const confirm = ref(null);

async function saveNow() {
  const path = currentPath();
  if (!path) return;
  await flushItem(path);
  await app.refreshStatus();
  const it = app.item(path);
  const list = syncable(it, { manualOnly: true });
  if (!list.length) {
    const conflicted = (it?.bindings || []).some((/** @type {any} */ b) => isConflict(uiStatus(b.status)));
    ui.toast(conflicted ? '已写入工作区；有冲突需要处理' : '已写入工作区', conflicted ? 'alert' : 'check');
    return;
  }
  confirm.value = { path, bindings: list, busy: false };
}

async function syncBindings(/** @type {string} */ path, /** @type {any[]} */ list) {
  const results = [];
  for (const b of list) results.push(await runBindingOp(app, ui, path, b, 'sync', { quiet: true }));
  await app.refreshStatus();
  const ok = results.filter((r) => r === 'ok').length;
  const conflicts = results.filter((r) => r === 'conflict').length;
  if (conflicts) { ui.toast(`同步 ${ok} 个酒馆，${conflicts} 个有冲突`, 'alert'); ui.openConflict(path); }
  else if (ok < results.length) ui.toast(`同步 ${ok} / ${results.length} 个酒馆，其余失败，详见同步页`, 'alert');
  else ui.toast('已同步到 ' + list.map((b) => app.targetName(b.target)).join('、'));
}

async function confirmSync() {
  const c = confirm.value;
  if (!c || c.busy) return;
  c.busy = true;
  try { await syncBindings(c.path, c.bindings); } finally { confirm.value = null; }
}

async function syncAll() {
  const path = currentPath();
  if (!path) return;
  await flushItem(path);
  await app.refreshStatus();
  const list = syncable(app.item(path));
  if (!list.length) { ui.toast('没有可以同步的本地修改（固定的绑定与未连接的酒馆不包含在内）', 'info'); return; }
  await syncBindings(path, list);
}

// ---- find ----------------------------------------------------------------
function focusFind() {
  const el = /** @type {HTMLInputElement|null} */ ([...document.querySelectorAll('#editor [data-find]')].find((x) => /** @type {HTMLElement} */ (x).offsetParent) || null);
  if (!el) return false;
  el.focus();
  el.select();
  return true;
}

// ---- dispatcher ----------------------------------------------------------
function onKey(/** @type {KeyboardEvent} */ ev) {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === 'p' && !ev.shiftKey) { ev.preventDefault(); paletteOpen.value ? (paletteOpen.value = false) : openPalette(); return; }
  if (k === 's') { ev.preventDefault(); if (!confirm.value) (ev.shiftKey ? syncAll() : saveNow()); return; }
  if (k === 'f' && focusFind()) ev.preventDefault();
}
function confirmKey(/** @type {KeyboardEvent} */ ev) {
  if (ev.key === 'Escape') confirm.value = null;
  else if (ev.key === 'Enter') confirmSync();
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <template v-if="paletteOpen">
    <div class="drawer-scrim qo-scrim" @click="paletteOpen = false" />
    <div class="qo" role="dialog" aria-label="快速打开">
      <label class="qo-input"><Icon name="search" size="sm" /><input ref="input" v-model="q" class="input" placeholder="输入资料项名称或页面（Esc 关闭）" spellcheck="false" @input="cursor = 0" @keydown="paletteKey" /></label>
      <div class="qo-list">
        <button v-for="(e, i) in entries.slice(0, 50)" :key="e.key" class="qo-row" :class="{ on: i === cursor }" @mousemove="cursor = i" @click="pick(e)">
          <Icon :name="e.icon" size="sm" /><span class="qo-label">{{ e.label }}</span><span class="faint mono qo-sub">{{ e.sub }}</span>
        </button>
        <div v-if="!entries.length" class="qo-empty faint">没有匹配的资料项</div>
      </div>
    </div>
  </template>

  <template v-if="confirm">
    <div class="drawer-scrim qo-scrim" @click="confirm = null" />
    <div class="qo qo-confirm" role="alertdialog" aria-label="同步确认" tabindex="-1" @keydown="confirmKey">
      <div class="qo-head"><Icon name="upload" size="sm" /><b>已写入工作区。同步到酒馆？</b></div>
      <p class="faint">{{ itemName(confirm.path) }} 在下列酒馆是手动同步，有本地修改：</p>
      <ul class="qo-targets"><li v-for="b in confirm.bindings" :key="b.target">{{ app.targetName(b.target) }}</li></ul>
      <div class="qo-foot">
        <button class="btn ghost" @click="confirm = null">先不同步</button>
        <span class="grow" />
        <button v-focus class="btn primary" :disabled="confirm.busy" @click="confirmSync"><Icon :name="confirm.busy ? 'spin' : 'upload'" size="sm" />同步</button>
      </div>
    </div>
  </template>
</template>

<script>
export default { directives: { focus: { mounted: (/** @type {HTMLElement} */ el) => el.focus() } } };
</script>
