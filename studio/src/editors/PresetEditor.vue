<script setup>
// Preset editor (kind 'preset', data = the preset file). Chat-completion presets: prompts (with the global prompt
// order's on/off), preset regex (extensions.regex_scripts, RegexList) and the remaining parameters; other preset
// types show their parameters only. Values are edited in place; unknown fields are kept as they are.
import { ref, computed, watch, toRef } from 'vue';
import { useItem } from '../lib/useItem.js';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import Icon from '../components/Icon.vue';
import MiniSelect from '../components/MiniSelect.vue';
import Seg from '../components/Seg.vue';
import Toggle from '../components/Toggle.vue';
import CardText from '../components/card/CardText.vue';
import RegexList from './RegexList.vue';
import PromptDetail from './PromptDetail.vue';
import { presetRef } from '../lib/status.js';
import { api, errorText } from '../api.js';
import { FILTER_TIPS, PROMPT_FILTERS, filterPrompts, globalOrderOf, orderedPrompts, promptsOf } from '../lib/presetPrompts.js';

const props = defineProps({ path: { type: String, required: true } });
const it = useItem(toRef(props, 'path'));
const app = useApp();
const ui = useUi();

const rev = ref(0);
watch(it.version, () => { rev.value++; });
const data = computed(() => { void rev.value; return it.data.value; });
const ref0 = computed(() => presetRef(app.item(props.path)?.bindings?.[0]?.id));
const isChat = computed(() => ref0.value?.apiId === 'openai' || Array.isArray(data.value?.prompts));
const saveState = computed(() => (it.saving.value ? 'saving' : it.dirty.value && !it.externalChange.value ? 'dirty' : 'saved'));
function edited() { rev.value++; it.touch(); }

const tab = ref('prompts');
const TABS = computed(() => (isChat.value
  ? [{ value: 'prompts', label: '提示词' }, { value: 'regex', label: '预设正则' }, { value: 'params', label: '参数' }]
  : [{ value: 'params', label: '参数' }]));
watch(isChat, (c) => { if (!c) tab.value = 'params'; }, { immediate: true });

// ---- prompts ----------------------------------------------------------------
// `data` is mutated in place (same object): depend on rev so these follow edits
const prompts = computed(() => { void rev.value; return promptsOf(data.value); });
/** The global prompt order (character_id 100001) decides order and on/off in ST's prompt manager. */
const globalOrder = computed(() => { void rev.value; return globalOrderOf(data.value); });
const ordered = computed(() => { void rev.value; return orderedPrompts(data.value); });
const selectedId = ref('');
const pq = ref('');
/** 默认 hides the prompts that are not in the order (未插入), as ST's prompt manager does. */
const pfilter = ref('default');
const shownPrompts = computed(() => filterPrompts(ordered.value, pfilter.value, pq.value));
const hiddenCount = computed(() => ordered.value.length - shownPrompts.value.length);
const current = computed(() => prompts.value.find((p) => p.identifier === selectedId.value) || null);
const currentOrder = computed(() => (globalOrder.value || []).find((/** @type {any} */ o) => o.identifier === selectedId.value) || null);
watch(shownPrompts, (l) => { if (l.length && !l.some(({ p }) => p.identifier === selectedId.value)) selectedId.value = l[0].p.identifier; }, { immediate: true });
/** Puts a 未插入 prompt at the end of the order, off (as ST's "insert" does, but without turning it on). */
function insertPrompt() {
  const p = current.value;
  if (!p || currentOrder.value) return;
  let list = globalOrder.value;
  if (!list) {
    if (!Array.isArray(data.value.prompt_order)) data.value.prompt_order = [];
    list = [];
    data.value.prompt_order.push({ character_id: 100001, order: list });
  }
  list.push({ identifier: p.identifier, enabled: false });
  edited();
}

/** @param {string} key @param {any} value */
function setPrompt(key, value) { if (!current.value) return; current.value[key] = value; edited(); }
function toggleOrder(/** @type {any} */ o) { o.enabled = !o.enabled; edited(); }
function addPrompt() {
  if (!data.value) return;
  if (!Array.isArray(data.value.prompts)) data.value.prompts = [];
  const p = { identifier: crypto.randomUUID(), name: '新提示词', system_prompt: false, role: 'system', content: '', injection_position: 0, injection_depth: 4, forbid_overrides: false };
  data.value.prompts.push(p);
  if (globalOrder.value) globalOrder.value.push({ identifier: p.identifier, enabled: true });
  selectedId.value = p.identifier;
  edited();
}
function removePrompt() {
  const p = current.value;
  if (!p || p.system_prompt || p.marker) return;
  data.value.prompts.splice(data.value.prompts.indexOf(p), 1);
  for (const po of Array.isArray(data.value.prompt_order) ? data.value.prompt_order : []) {
    if (Array.isArray(po?.order)) po.order = po.order.filter((/** @type {any} */ o) => o.identifier !== p.identifier);
  }
  selectedId.value = '';
  edited();
}
function movePrompt(/** @type {number} */ d) {
  const list = globalOrder.value;
  if (!list) return;
  const i = list.findIndex((/** @type {any} */ o) => o.identifier === selectedId.value);
  if (i < 0 || i + d < 0 || i + d >= list.length) return;
  const [x] = list.splice(i, 1);
  list.splice(i + d, 0, x);
  edited();
}

// ---- preset regex -----------------------------------------------------------
const regexScripts = computed(() => { void rev.value; const s = data.value?.extensions?.regex_scripts; return Array.isArray(s) ? s : null; });
function startRegex() {
  if (!data.value) return;
  if (!data.value.extensions || typeof data.value.extensions !== 'object') data.value.extensions = {};
  data.value.extensions.regex_scripts = [];
  edited();
}

// ---- parameters -------------------------------------------------------------
const HIDDEN = new Set(['prompts', 'prompt_order', 'extensions']);
const pf = ref('');
const params = computed(() => {
  const d = data.value;
  if (!d || typeof d !== 'object') return [];
  const q = pf.value.trim().toLowerCase();
  return Object.keys(d).filter((k) => !(isChat.value && HIDDEN.has(k)) && (!q || k.toLowerCase().includes(q))).map((k) => ({ k, v: d[k], t: d[k] === null ? 'null' : Array.isArray(d[k]) ? 'json' : typeof d[k] }));
});
/** @type {import('vue').Ref<Record<string, string>>} */
const jsonErr = ref({});
/** @param {string} k @param {any} v */
function setParam(k, v) { data.value[k] = v; edited(); }
/** @param {string} k @param {string} text */
function setJson(k, text) {
  try { data.value[k] = JSON.parse(text); const e = { ...jsonErr.value }; delete e[k]; jsonErr.value = e; edited(); }
  catch (e) { jsonErr.value = { ...jsonErr.value, [k]: String(/** @type {any} */ (e).message || e) }; }
}
const longText = (/** @type {string} */ v) => typeof v === 'string' && (v.length > 60 || v.includes('\n'));

const keeping = ref(false);
async function keepMine() {
  keeping.value = true;
  try {
    const r = await api.item(props.path);
    it.hash.value = r.hash;
    it.externalChange.value = false;
    it.touch();
    await it.save();
  } catch (e) {
    ui.toast('写入失败：' + errorText(e), 'alert');
  } finally {
    keeping.value = false;
  }
}
</script>

<template>
  <div class="pe">
    <div v-if="it.externalChange.value" class="banner warn">
      <Icon name="alert" />
      <div class="grow"><b>文件在别处被修改</b><span class="muted"> · 暂停写入。重新加载会丢弃这里尚未写入的修改；保留我的修改会覆盖那些改动。</span></div>
      <button class="btn sm" type="button" :disabled="keeping" @click="it.load()"><Icon name="refresh" size="sm" />重新加载</button>
      <button class="btn sm" type="button" :disabled="keeping" @click="keepMine"><Icon :name="keeping ? 'spin' : 'check'" size="sm" />保留我的修改</button>
    </div>
    <div v-if="it.error.value && !it.data.value" class="banner conflict">
      <Icon name="alert" /><div class="grow">无法读取预设：{{ it.error.value }}</div>
      <button class="btn sm" type="button" @click="it.load()">重试</button>
    </div>
    <div v-else-if="!data" class="ce-loading faint"><Icon name="spin" /> 正在读取预设…</div>

    <template v-else>
      <div class="pe-head">
        <Icon name="sliders" />
        <div class="grow">
          <div class="pe-title">{{ ref0?.name || path }}</div>
          <div class="faint pe-sub">{{ ref0?.type || '预设' }} · 同步酒馆正在使用的预设时，酒馆会重新载入它，面板里未保存的修改会丢失</div>
        </div>
        <Seg v-if="TABS.length > 1" v-model="tab" :options="TABS" />
      </div>

      <!-- prompts -->
      <div v-if="tab === 'prompts'" class="pe-body">
        <aside class="rx-list">
          <div class="rx-list-head">
            <label class="search grow"><Icon name="search" size="sm" /><input v-model="pq" class="input" data-find placeholder="搜索名称或内容" /></label>
            <button class="btn sm primary" type="button" @click="addPrompt"><Icon name="plus" size="sm" />新建</button>
          </div>
          <div class="pe-filter">
            <MiniSelect v-model="pfilter" label="显示" :active="pfilter !== 'default'" :title="FILTER_TIPS[pfilter]" :options="PROMPT_FILTERS" />
            <span v-if="hiddenCount" class="faint pe-hidden">另有 {{ hiddenCount }} 条未显示</span>
          </div>
          <div class="rx-rows">
            <div
              v-for="({ p, o, n }, i) in shownPrompts"
              :key="p.identifier || i"
              class="rx-row"
              :class="{ on: p.identifier === selectedId, off: o && !o.enabled, out: !o }"
              tabindex="0"
              @click="selectedId = p.identifier"
              @keydown.enter="selectedId = p.identifier"
            >
              <span class="rx-no mono faint">{{ n || '–' }}</span>
              <div class="grow rx-row-main">
                <div class="rx-name">{{ p.name || p.identifier }}<span v-if="!o" class="pe-out">未插入</span></div>
                <div class="rx-sub faint">{{ p.marker ? '占位（内容由酒馆生成）' : (p.content || '').slice(0, 80) || '（空）' }}</div>
              </div>
              <Toggle v-if="o" :model-value="!!o.enabled" :title="o.enabled ? '已启用' : '已停用'" @click.stop @update:model-value="toggleOrder(o)" />
            </div>
            <div v-if="!shownPrompts.length" class="faint rx-empty">{{ pq || (ordered.length && pfilter !== 'all') ? '没有匹配的提示词' : '这个预设没有提示词' }}</div>
          </div>
          <div class="rx-foot faint">
            <span class="ce-save" :class="{ busy: saveState !== 'saved' }">
              <template v-if="saveState === 'saving'"><Icon name="spin" size="sm" />正在写入…</template>
              <template v-else-if="saveState === 'dirty'"><Icon name="dot" size="sm" />未写入</template>
              <template v-else><Icon name="check" size="sm" />已写入工作区</template>
            </span>
            <span class="spacer" />{{ prompts.length }} 条 · 顺序与开关按全局提示词顺序
          </div>
        </aside>
        <section v-if="current" class="rx-detail">
          <PromptDetail :prompt="current" :order="currentOrder" @set="setPrompt" @insert="insertPrompt">
            <template #actions>
              <button class="icon-btn" type="button" title="上移" :disabled="!currentOrder" @click="movePrompt(-1)"><Icon name="arrowUp" size="sm" /></button>
              <button class="icon-btn" type="button" title="下移" :disabled="!currentOrder" @click="movePrompt(1)"><Icon name="arrowDown" size="sm" /></button>
              <button class="icon-btn" type="button" :title="current.system_prompt || current.marker ? '内置提示词不能删除' : '删除这条提示词'" :disabled="current.system_prompt || current.marker" @click="removePrompt"><Icon name="trash" size="sm" /></button>
            </template>
          </PromptDetail>
        </section>
        <section v-else class="rx-detail empty"><Icon name="sliders" /><h3>选择一条提示词</h3></section>
      </div>

      <!-- preset regex -->
      <div v-else-if="tab === 'regex'" class="pe-body">
        <RegexList v-if="regexScripts" :key="it.version.value" :scripts="regexScripts" :save-state="saveState" empty-text="这个预设还没有正则 · 点「新建」添加" @edited="edited" />
        <div v-else class="empty grow">
          <Icon name="regex" /><h3>这个预设没有附带正则</h3>
          <p class="muted">预设正则随预设一起切换，保存在预设文件的 extensions.regex_scripts 里。</p>
          <button class="btn" type="button" @click="startRegex"><Icon name="plus" size="sm" />添加预设正则</button>
        </div>
      </div>

      <!-- parameters -->
      <div v-else class="pe-params">
        <label class="search pe-pf"><Icon name="search" size="sm" /><input v-model="pf" class="input" data-find placeholder="筛选参数名" /></label>
        <div class="pe-grid">
          <div v-for="x in params" :key="x.k" class="field" :class="{ wide: x.t === 'json' || (x.t === 'object') || longText(x.v) }">
            <label class="mono">{{ x.k }}</label>
            <Toggle v-if="x.t === 'boolean'" :model-value="x.v" @update:model-value="setParam(x.k, $event)" />
            <input v-else-if="x.t === 'number'" class="input num" type="number" step="any" :value="x.v" @change="setParam(x.k, Number(/** @type {any} */ ($event.target).value))" />
            <CardText v-else-if="x.t === 'string' && longText(x.v)" :label="''" code :rows="3" :model-value="x.v" @update:model-value="setParam(x.k, $event)" />
            <input v-else-if="x.t === 'string'" class="input" :value="x.v" @input="setParam(x.k, /** @type {any} */ ($event.target).value)" />
            <template v-else>
              <textarea class="textarea code" rows="3" spellcheck="false" :value="JSON.stringify(x.v, null, 2)" @change="setJson(x.k, /** @type {any} */ ($event.target).value)" />
              <div v-if="jsonErr[x.k]" class="pe-err"><Icon name="alert" size="sm" />不是有效的 JSON：{{ jsonErr[x.k] }}</div>
            </template>
          </div>
        </div>
        <div class="faint pe-foot">{{ params.length }} 项参数<template v-if="isChat"> · 提示词、提示词顺序与扩展数据在其他页或文件中编辑</template></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pe { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.pe > .banner { margin: var(--sp-3) var(--sp-4) 0; }
.pe-head { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--line); }
.pe-head > svg { color: var(--text-3); }
.pe-title { font-weight: 600; }
.pe-sub { font-size: var(--fs-xs); }
.pe-body { flex: 1; min-height: 0; display: flex; }
.pe-body > .empty { flex: 1; }
.pe-id { font-size: 11px; margin-top: calc(-1 * var(--sp-3)); }
.rx-list { width: 340px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; }
.rx-list-head { display: flex; gap: var(--sp-2); padding: var(--sp-3); align-items: center; }
.rx-list-head .search { flex: 1; min-width: 0; }
.rx-rows { flex: 1; overflow: auto; }
.rx-row { display: flex; align-items: center; gap: var(--sp-2); padding: 6px var(--sp-3); cursor: pointer; border-left: 2px solid transparent; }
.rx-row:hover { background: var(--bg-3); }
.rx-row.on { background: var(--accent-soft); border-left-color: var(--accent); }
.rx-row.off .rx-name { color: var(--text-3); text-decoration: line-through; }
.pe-filter { display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-3) var(--sp-2); }
.pe-hidden { font-size: var(--fs-xs); }
.rx-row.out .rx-name { color: var(--text-3); }
.pe-out { margin-left: 6px; font-size: 10px; padding: 0 5px; border-radius: var(--r-pill); border: 1px dashed var(--line-strong); color: var(--text-3); }
.rx-no { width: 22px; text-align: right; font-size: var(--fs-xs); flex: none; }
.rx-row-main { min-width: 0; flex: 1; }
.rx-name, .rx-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rx-name { font-size: var(--fs-sm); }
.rx-sub { font-size: 11px; }
.rx-empty { padding: var(--sp-4); font-size: var(--fs-sm); }
.rx-foot { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--line); font-size: var(--fs-xs); }
.rx-foot .spacer { flex: 1; }
.rx-detail { flex: 1; min-width: 0; overflow: auto; padding: var(--sp-5) var(--sp-6); display: flex; flex-direction: column; gap: var(--sp-4); box-sizing: border-box; }
.rx-detail.empty { align-items: center; justify-content: center; color: var(--text-3); }
.rx-detail-head { display: flex; align-items: center; gap: var(--sp-2); }
.rx-detail-head .ce-name { flex: 1; }
.rx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--sp-4); }
.pe-params { flex: 1; overflow: auto; padding: var(--sp-4) var(--sp-6); display: flex; flex-direction: column; gap: var(--sp-3); }
.pe-pf { max-width: 320px; }
.pe-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--sp-3) var(--sp-4); }
.pe-grid .wide { grid-column: 1 / -1; }
.pe-grid > .field { min-width: 0; }
.pe-grid label.mono { font-size: 12px; overflow-wrap: anywhere; }
/* numbers fill their cell like the text inputs (the global .input.num is a short fixed width) */
.pe-grid .input.num { width: 100%; text-align: left; }
.pe-err { color: var(--st-conflict); font-size: var(--fs-xs); display: flex; gap: 6px; align-items: center; }
.pe-foot { font-size: var(--fs-xs); }
.grow { flex: 1; min-width: 0; }
</style>
