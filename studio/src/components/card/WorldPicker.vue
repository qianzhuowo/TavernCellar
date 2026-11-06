<script setup>
// 角色世界书 binding (data.extensions.world): workspace lorebooks + this card's tavern lorebooks.
// A searchable dropdown; picking a different book (or 不绑定) only stages it — 确认换绑 / 确认解绑 applies it, 取消
// drops it, so a stray click never rebinds the card. A tavern-only book gets 一起取出 (checkout into the workspace).
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../Icon.vue';
import { api, errorText } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { useUi } from '../../stores/ui.js';
import { itemName } from '../../lib/status.js';
import { fuzzyScore } from '../../lib/fuzzy.js';

const props = defineProps({
  modelValue: { type: [String, null], default: null },
  /** first binding of the card: { target, ... } or null */
  binding: { type: Object, default: null }
});
const emit = defineEmits(['update:modelValue']);
const app = useApp();
const ui = useUi();

const target = computed(() => props.binding?.target || '');
const mode = computed(() => (props.binding ? app.modeOf(props.binding) : 'none'));
const tavernUsable = computed(() => mode.value === 'online' || mode.value === 'offline');
const tavernLabel = computed(() => (target.value ? app.targetName(target.value) : ''));

/**
 * workspace lorebooks: name = binding id for this card's tavern, else any binding id, else folder name.
 * Several workspace books can carry the same name (the same book taken from two taverns, e.g. X and X-2):
 * the one bound to this card's tavern wins, the same rule the companion uses for status `world.path`.
 */
const wsBooks = computed(() => {
  /** @type {Map<string, {name: string, path: string, own: boolean}>} */
  const byName = new Map();
  for (const i of app.items) {
    if (i.kind !== 'lorebook') continue;
    const own = i.bindings.find((x) => x.target === target.value);
    const b = own || i.bindings[0];
    const book = { name: (b && b.id) || itemName(i.path), path: i.path, own: !!own };
    const prev = byName.get(book.name);
    if (!prev || (book.own && !prev.own)) byName.set(book.name, book);
  }
  return [...byName.values()];
});

const tavernBooks = ref(/** @type {string[]} */ ([]));
const loadingCat = ref(false);
const catError = ref('');
let seq = 0;
async function loadCatalog() {
  const my = ++seq;
  tavernBooks.value = [];
  catError.value = '';
  if (!target.value || !tavernUsable.value) return;
  loadingCat.value = true;
  try {
    const r = await api.catalog({ target: target.value, kind: 'lorebook', limit: 1000 });
    if (my === seq) tavernBooks.value = r.items.map((/** @type {any} */ e) => e.name || e.id);
  } catch (e) {
    if (my === seq) catError.value = errorText(e);
  } finally {
    if (my === seq) loadingCat.value = false;
  }
}
watch([target, tavernUsable], loadCatalog, { immediate: true });

const wsNames = computed(() => new Set(wsBooks.value.map((b) => b.name)));
const tavernOnly = computed(() => tavernBooks.value.filter((n) => !wsNames.value.has(n)));
const current = computed(() => props.modelValue || '');
const inWs = computed(() => wsBooks.value.find((b) => b.name === current.value) || null);
const inTavern = computed(() => tavernBooks.value.includes(current.value));
const unknown = computed(() => !!current.value && !inWs.value && !inTavern.value && !loadingCat.value);

const tip = computed(() => (inWs.value
  ? `「${current.value}」是工作区中的独立世界书资料项，在这里编辑即修改它；它单独同步，同步状态见左侧「世界书」分组或同步页。`
  : '角色世界书即这张卡绑定的主要知识书（extensions.world）。绑定的书是工作区中的独立世界书资料项，取出到工作区后在这里编辑；它单独同步，同步状态见左侧「世界书」分组或同步页。'));

// ---- staged choice: null = nothing staged; '' = 不绑定 ----
const pending = ref(/** @type {string|null} */ (null));
const staged = computed(() => pending.value !== null && pending.value !== current.value);
watch(current, () => { pending.value = null; });
const shown = computed(() => (staged.value ? /** @type {string} */ (pending.value) : current.value));
function confirm() {
  if (!staged.value) return;
  emit('update:modelValue', pending.value);
  pending.value = null;
}
const confirmLabel = computed(() => (pending.value === '' ? '确认解绑' : current.value ? '确认换绑' : '确认绑定'));

// ---- dropdown with fuzzy search ----
const open = ref(false);
const query = ref('');
const active = ref(0);
const root = ref(/** @type {HTMLElement|null} */ (null));
const search = ref(/** @type {HTMLInputElement|null} */ (null));
const listEl = ref(/** @type {HTMLElement|null} */ (null));

/** @typedef {{value: string, label: string, group: string, note?: string}} Opt */
const options = computed(() => {
  const q = query.value.trim();
  /** @param {string[]} names @param {string} group @returns {Opt[]} */
  const rank = (names, group) => {
    const list = names.map((n) => ({ n, s: q ? fuzzyScore(q, n) : 0 })).filter((x) => x.s >= 0);
    if (q) list.sort((a, b) => b.s - a.s);
    return list.map((x) => ({ value: x.n, label: x.n, group }));
  };
  /** @type {Opt[]} */
  const out = [];
  if (!q) out.push({ value: '', label: '— 不绑定 —', group: '' });
  if (unknown.value && (!q || fuzzyScore(q, current.value) >= 0)) out.push({ value: current.value, label: current.value, group: '', note: '未找到' });
  out.push(...rank(wsBooks.value.map((b) => b.name), '工作区'));
  out.push(...rank(tavernOnly.value, '酒馆 · ' + tavernLabel.value));
  return out;
});
const groupStart = (/** @type {number} */ i) => !!options.value[i].group && (i === 0 || options.value[i - 1].group !== options.value[i].group);

async function toggle() {
  if (open.value) { open.value = false; return; }
  open.value = true;
  query.value = '';
  active.value = Math.max(0, options.value.findIndex((o) => o.value === shown.value));
  await nextTick();
  search.value?.focus();
  scrollActive();
}
function choose(/** @type {Opt} */ o) {
  pending.value = o.value === current.value ? null : o.value;
  open.value = false;
}
function scrollActive() { nextTick(() => listEl.value?.querySelector('.wp-opt.active')?.scrollIntoView({ block: 'nearest' })); }
watch(query, () => { active.value = 0; });
function onKey(/** @type {KeyboardEvent} */ e) {
  const n = options.value.length;
  if (e.key === 'ArrowDown') { e.preventDefault(); if (n) active.value = (active.value + 1) % n; scrollActive(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) active.value = (active.value - 1 + n) % n; scrollActive(); }
  else if (e.key === 'Enter') { e.preventDefault(); const o = options.value[active.value]; if (o) choose(o); }
  else if (e.key === 'Escape') { e.preventDefault(); open.value = false; }
}
function onDoc(/** @type {MouseEvent} */ e) { if (open.value && root.value && !root.value.contains(/** @type {Node} */ (e.target))) open.value = false; }
onMounted(() => document.addEventListener('mousedown', onDoc));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc));

const busy = ref(false);
async function takeOut() {
  busy.value = true;
  try {
    await api.checkout(target.value, 'lorebook', current.value);
    await app.refreshStatus();
    ui.toast(`已取出「${current.value}」到工作区`, 'check');
  } catch (e) {
    ui.toast('取出失败：' + errorText(e), 'alert');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="wp">
    <div class="wp-title">
      <h3>角色世界书</h3>
      <span class="wp-info" tabindex="0" aria-label="说明"><Icon name="info" size="sm" /><span class="wp-tip" role="tooltip">{{ tip }}</span></span>
      <span class="wp-help faint">
        <template v-if="!target">此卡未绑定酒馆，只列出工作区中的世界书。</template>
        <template v-else-if="!tavernUsable">「{{ tavernLabel }}」当前不可用，只列出工作区中的世界书。</template>
        <template v-else-if="loadingCat"><Icon name="spin" size="sm" /> 正在读取「{{ tavernLabel }}」的世界书…</template>
        <template v-else-if="catError">读取「{{ tavernLabel }}」的世界书失败（{{ catError }}），只列出工作区中的世界书。<a href="#" @click.prevent="loadCatalog">重试</a></template>
        <template v-else>列出工作区与「{{ tavernLabel }}」中的世界书。</template>
      </span>
    </div>

    <div class="wp-row">
      <div ref="root" class="wp-combo" :class="{ open }">
        <button class="wp-trigger" :class="{ staged, none: !shown }" type="button" aria-haspopup="listbox" :aria-expanded="open" aria-label="角色世界书" @click="toggle">
          <Icon name="book" size="sm" />
          <span class="wp-val">{{ shown ? '「' + shown + '」' : '— 不绑定 —' }}</span>
          <span v-if="staged" class="wp-tag">待确认</span>
          <span v-else-if="unknown" class="wp-tag warn">未找到</span>
          <Icon name="chevDown" size="sm" />
        </button>
        <div v-if="open" class="wp-pop">
          <div class="wp-search">
            <Icon name="search" size="sm" />
            <input ref="search" v-model="query" class="input" placeholder="搜索世界书（支持模糊匹配）" spellcheck="false" @keydown="onKey">
          </div>
          <div ref="listEl" class="wp-list" role="listbox">
            <template v-for="(o, i) in options" :key="o.group + '|' + o.value">
              <div v-if="groupStart(i)" class="wp-group">{{ o.group }}</div>
              <button
                type="button"
                class="wp-opt"
                role="option"
                :class="{ active: i === active, on: o.value === shown, none: !o.value }"
                :aria-selected="o.value === shown"
                @mouseenter="active = i"
                @click="choose(o)"
              >
                <span class="wp-opt-t">{{ o.label }}</span>
                <span v-if="o.note" class="faint">{{ o.note }}</span>
                <span v-else-if="o.value && o.value === current" class="faint">当前</span>
              </button>
            </template>
            <div v-if="!options.length" class="wp-empty faint">没有匹配的世界书</div>
          </div>
        </div>
      </div>

      <template v-if="staged">
        <button class="btn sm" :class="pending === '' ? 'danger' : 'primary'" type="button" @click="confirm"><Icon :name="pending === '' ? 'x' : 'check'" size="sm" />{{ confirmLabel }}</button>
        <button class="btn sm" type="button" @click="pending = null">取消</button>
      </template>
      <template v-else-if="current && !inWs && inTavern">
        <span class="faint wp-state">只在「{{ tavernLabel }}」中</span>
        <button class="btn sm" type="button" :disabled="busy" @click="takeOut"><Icon :name="busy ? 'spin' : 'download'" size="sm" />一起取出</button>
      </template>
    </div>
  </div>
</template>
