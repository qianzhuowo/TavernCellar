<script setup>
// Searchable dropdown for long lists (预设工坊 preset pickers): the trigger looks like an input; the panel has a search box
// with fuzzy matching (lib/fuzzy.js), ↑/↓ + Enter to pick, Esc or a click outside to close. The panel is teleported
// to <body> so scrolling or clipping containers do not cut it off. Picking only emits update:modelValue; the parent
// may refuse the change by keeping its value.
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { fuzzyScore } from '../lib/fuzzy.js';

const props = defineProps({
  modelValue: { type: String, default: '' },
  /** @type {import('vue').PropType<{value: string, label: string}[]>} */
  options: { type: Array, required: true },
  placeholder: { type: String, default: '选择…' },
  /** shown in place of the list when it is empty (e.g. 正在读取…) */
  emptyText: { type: String, default: '没有可选项' },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' }
});
const emit = defineEmits(['update:modelValue']);

const open = ref(false);
const q = ref('');
const active = ref(0);
const trigger = ref(/** @type {HTMLElement|null} */ (null));
const panel = ref(/** @type {HTMLElement|null} */ (null));
const input = ref(/** @type {HTMLInputElement|null} */ (null));
const pos = ref({ left: 0, top: 0, width: 0, maxHeight: 320 });

const current = computed(() => props.options.find((/** @type {any} */ o) => o.value === props.modelValue));
const shown = computed(() => {
  const opts = /** @type {{value: string, label: string}[]} */ (props.options);
  if (!q.value.trim()) return opts;
  return opts.map((o) => ({ o, s: fuzzyScore(q.value, o.label) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.o);
});

function place() {
  const r = trigger.value?.getBoundingClientRect();
  if (!r) return;
  const below = window.innerHeight - r.bottom - 12;
  const up = below < 220 && r.top > below;
  const maxHeight = Math.min(360, up ? r.top - 12 : below);
  pos.value = { left: r.left, top: up ? r.top - 4 - maxHeight : r.bottom + 4, width: Math.max(r.width, 260), maxHeight };
}
function onDocDown(/** @type {MouseEvent} */ ev) {
  const t = /** @type {Node} */ (ev.target);
  if (!panel.value?.contains(t) && !trigger.value?.contains(t)) close();
}
function onScroll(/** @type {Event} */ ev) {
  if (!panel.value?.contains(/** @type {Node} */ (ev.target))) close();
}
async function show() {
  if (props.disabled || open.value) return;
  q.value = '';
  open.value = true;
  place();
  const i = shown.value.findIndex((o) => o.value === props.modelValue);
  active.value = i < 0 ? 0 : i;
  document.addEventListener('mousedown', onDocDown, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', onScroll, true);
  await nextTick();
  input.value?.focus();
  scrollActive();
}
function close() {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener('mousedown', onDocDown, true);
  window.removeEventListener('resize', close);
  window.removeEventListener('scroll', onScroll, true);
}
function pick(/** @type {{value: string}} */ o) {
  close();
  trigger.value?.focus();
  if (o.value !== props.modelValue) emit('update:modelValue', o.value);
}
function scrollActive() {
  nextTick(() => panel.value?.querySelector('.ss-opt.active')?.scrollIntoView({ block: 'nearest' }));
}
function key(/** @type {KeyboardEvent} */ ev) {
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const n = shown.value.length;
    if (n) active.value = (active.value + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
    scrollActive();
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    const o = shown.value[active.value];
    if (o) pick(o);
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    close();
    trigger.value?.focus();
  }
}
function onInput() { active.value = 0; }
onBeforeUnmount(close);
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="input ss-trigger"
    :class="{ open, placeholder: !current }"
    :disabled="disabled"
    :aria-label="ariaLabel || undefined"
    :title="current ? current.label : ''"
    aria-haspopup="listbox"
    :aria-expanded="open"
    @click="open ? close() : show()"
    @keydown.down.prevent="show"
  >
    <span class="ss-value">{{ current ? current.label : placeholder }}</span>
    <Icon name="chevDown" size="sm" />
  </button>
  <Teleport to="body">
    <div v-if="open" ref="panel" class="ss-panel" :style="{ left: pos.left + 'px', top: pos.top + 'px', width: pos.width + 'px', maxHeight: pos.maxHeight + 'px' }">
      <label class="search ss-search"><Icon name="search" size="sm" /><input ref="input" v-model="q" class="input" placeholder="搜索（支持模糊匹配）" @keydown="key" @input="onInput" /></label>
      <div class="ss-list" role="listbox">
        <div
          v-for="(o, i) in shown"
          :key="o.value"
          class="ss-opt"
          role="option"
          :aria-selected="o.value === modelValue"
          :class="{ active: i === active, sel: o.value === modelValue }"
          @mousemove="active = i"
          @click="pick(o)"
        >
          <span class="ss-label">{{ o.label }}</span>
          <Icon v-if="o.value === modelValue" name="check" size="sm" />
        </div>
        <div v-if="!shown.length" class="ss-empty faint">{{ options.length ? '没有匹配项' : emptyText }}</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ss-trigger { display: inline-flex; align-items: center; gap: 6px; text-align: left; cursor: pointer; min-width: 0; }
.ss-trigger.placeholder .ss-value { color: var(--text-3); }
.ss-trigger:disabled { cursor: default; opacity: .6; }
.ss-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-panel { position: fixed; z-index: 60; display: flex; flex-direction: column; background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: var(--r-md, 8px); box-shadow: 0 10px 30px rgba(0, 0, 0, .35); overflow: hidden; }
.ss-search { margin: var(--sp-2); }
.ss-list { overflow: auto; padding-bottom: 4px; }
.ss-opt { display: flex; align-items: center; gap: 6px; padding: 6px var(--sp-3); font-size: var(--fs-sm); cursor: pointer; }
.ss-opt.active { background: var(--bg-3); }
.ss-opt.sel { color: var(--accent-text); }
.ss-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-empty { padding: var(--sp-3); font-size: var(--fs-sm); }
</style>
