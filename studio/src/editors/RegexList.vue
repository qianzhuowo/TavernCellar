<script setup>
// Regex script list + detail editor, shared by the global regex list (RegexEditor) and preset regex (PresetEditor).
// Fields follow ST's regex editor (public/scripts/extensions/regex/editor.html, char-data.js RegexScriptData);
// unknown fields are kept as they are. `scripts` is mutated in place; every change emits `edited`.
import { ref, computed, watch } from 'vue';
import Icon from '../components/Icon.vue';
import Seg from '../components/Seg.vue';
import Toggle from '../components/Toggle.vue';
import CardText from '../components/card/CardText.vue';

const props = defineProps({
  scripts: { type: Array, required: true },
  /** footer save state: 'saving' | 'dirty' | 'saved' */
  saveState: { type: String, default: 'saved' },
  emptyText: { type: String, default: '还没有正则 · 点「新建」添加' }
});
const emit = defineEmits(['edited']);

/** regex_placement in ST's regex/engine.js (0 = deprecated Markdown display, 4 = legacy sendAs: kept, not offered). */
const PLACEMENTS = [
  { value: 1, label: '用户输入' },
  { value: 2, label: 'AI 输出' },
  { value: 3, label: '快捷命令' },
  { value: 5, label: '世界信息' },
  { value: 6, label: '推理' }
];
const SUBSTITUTE = [
  { value: 0, label: '不替换' },
  { value: 1, label: '原样' },
  { value: 2, label: '转义' }
];
/** Defaults of a new script, as ST's editor saves them. */
const NEW_SCRIPT = {
  scriptName: '新正则', findRegex: '', replaceString: '', trimStrings: [], placement: [2], disabled: false,
  markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null
};

const rev = ref(0);
/** @type {import('vue').ComputedRef<any[]>} */
// The scripts array may be plain (not reactive) data: every computed reading it also reads `rev`, which edits bump.
const list = computed(() => { void rev.value; return /** @type {any[]} */ (props.scripts); });
const selectedId = ref('');
const query = ref('');
const shown = computed(() => {
  void rev.value;
  const all = list.value.map((s, i) => ({ s, i }));
  const q = query.value.trim().toLowerCase();
  return q ? all.filter(({ s }) => String(s.scriptName || '').toLowerCase().includes(q) || String(s.findRegex || '').toLowerCase().includes(q)) : all;
});
const current = computed(() => { void rev.value; return list.value.find((s) => s.id === selectedId.value) || null; });
watch([list, rev], ([l]) => {
  if (l.length && !l.some((s) => s.id === selectedId.value)) selectedId.value = l[0].id;
}, { immediate: true });

function edited() { rev.value++; emit('edited'); }
/** @param {string} key @param {any} value */
function set(key, value) {
  if (!current.value) return;
  current.value[key] = value;
  edited();
}
/** @param {number} p @param {boolean} on */
function setPlacement(p, on) {
  const cur = Array.isArray(current.value?.placement) ? current.value.placement : [];
  set('placement', on ? [...cur.filter((/** @type {number} */ x) => x !== p), p].sort((a, b) => a - b) : cur.filter((/** @type {number} */ x) => x !== p));
}
/** Depth fields: empty means "no limit" (null), as ST stores it. @param {'minDepth'|'maxDepth'} key @param {string} v */
function setDepth(key, v) {
  const n = parseInt(v, 10);
  set(key, v.trim() === '' || !Number.isFinite(n) ? null : n);
}
const trimText = computed(() => { void rev.value; return Array.isArray(current.value?.trimStrings) ? current.value.trimStrings.join('\n') : ''; });
function setTrim(/** @type {string} */ v) { set('trimStrings', v.split('\n').filter((x) => x !== '')); }

function add() {
  const s = { id: crypto.randomUUID(), ...structuredClone(NEW_SCRIPT) };
  props.scripts.push(s);
  selectedId.value = s.id;
  query.value = '';
  edited();
}
function remove(/** @type {number} */ i) {
  const l = /** @type {any[]} */ (props.scripts);
  const [gone] = l.splice(i, 1);
  if (gone && gone.id === selectedId.value) selectedId.value = l[Math.min(i, l.length - 1)]?.id || '';
  edited();
}
function move(/** @type {number} */ i, /** @type {number} */ d) {
  const l = props.scripts;
  if (i + d < 0 || i + d >= l.length) return;
  const [x] = l.splice(i, 1);
  l.splice(i + d, 0, x);
  edited();
}
function toggleEnabled(/** @type {any} */ s) { s.disabled = !s.disabled; edited(); }

/** Flags shown after the name in the list. */
const PLACEMENT_SHORT = { 1: '输入', 2: '输出', 3: '命令', 5: '世界', 6: '推理' };
const placeText = (/** @type {any} */ s) => (Array.isArray(s.placement) ? s.placement.map((/** @type {number} */ p) => PLACEMENT_SHORT[/** @type {1} */ (p)] || p).join('·') : '');

// Live test: JavaScript RegExp from "/pattern/flags" (ST's own parsing; macros are not expanded here).
const sample = ref('');
const test = computed(() => {
  void rev.value;
  const s = current.value;
  if (!s || !s.findRegex) return { out: '', error: '' };
  const m = /^\/([\w\W]+?)\/([gimsuyd]*)$/.exec(s.findRegex);
  try {
    const re = m ? new RegExp(m[1], m[2]) : new RegExp(s.findRegex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    let out = sample.value.replace(re, (/** @type {string[]} */ ...args) => {
      const groups = args.slice(0, -2).filter((x) => typeof x === 'string' || x === undefined);
      return String(s.replaceString ?? '').replace(/\{\{match\}\}/gi, '$0').replace(/\$(\d+)/g, (_, n) => groups[Number(n)] ?? '');
    });
    for (const t of Array.isArray(s.trimStrings) ? s.trimStrings : []) out = out.split(t).join('');
    return { out, error: '' };
  } catch (e) {
    return { out: '', error: String(/** @type {any} */ (e).message || e) };
  }
});
</script>

<template>
  <aside class="rx-list">
    <div class="rx-list-head">
      <label class="search grow">
        <Icon name="search" size="sm" />
        <input v-model="query" class="input" data-find placeholder="搜索名称或表达式" />
      </label>
      <button class="btn sm primary" type="button" title="新建正则" @click="add"><Icon name="plus" size="sm" />新建</button>
    </div>
    <div class="rx-rows">
      <div
        v-for="{ s, i } in shown"
        :key="s.id || i"
        class="rx-row"
        :class="{ on: s.id === selectedId, off: s.disabled }"
        tabindex="0"
        @click="selectedId = s.id"
        @keydown.enter="selectedId = s.id"
      >
        <span class="rx-no mono faint">{{ i + 1 }}</span>
        <div class="grow rx-row-main">
          <div class="rx-name">{{ s.scriptName || '（未命名）' }}</div>
          <div class="rx-sub mono faint">{{ s.findRegex }}</div>
        </div>
        <span class="rx-place faint">{{ placeText(s) }}</span>
        <Toggle :model-value="!s.disabled" :title="s.disabled ? '已停用' : '已启用'" @click.stop @update:model-value="toggleEnabled(s)" />
      </div>
      <div v-if="!shown.length" class="faint rx-empty">{{ query ? '没有匹配的正则' : emptyText }}</div>
    </div>
    <div class="rx-foot faint">
      <span class="ce-save" :class="{ busy: saveState !== 'saved' }">
        <template v-if="saveState === 'saving'"><Icon name="spin" size="sm" />正在写入…</template>
        <template v-else-if="saveState === 'dirty'"><Icon name="dot" size="sm" />未写入</template>
        <template v-else><Icon name="check" size="sm" />已写入工作区</template>
      </span>
      <span class="spacer" />{{ shown.length === list.length ? list.length : shown.length + ' / ' + list.length }} 条 · 按顺序执行
    </div>
  </aside>

  <section v-if="current" class="rx-detail">
    <div class="rx-detail-head">
      <input class="input ce-name" :value="current.scriptName" placeholder="正则名称" aria-label="名称" @input="set('scriptName', /** @type {any} */ ($event.target).value)" />
      <button class="icon-btn" type="button" title="上移" :disabled="list.indexOf(current) === 0" @click="move(list.indexOf(current), -1)"><Icon name="arrowUp" size="sm" /></button>
      <button class="icon-btn" type="button" title="下移" :disabled="list.indexOf(current) === list.length - 1" @click="move(list.indexOf(current), 1)"><Icon name="arrowDown" size="sm" /></button>
      <button class="icon-btn" type="button" title="删除这条正则" @click="remove(list.indexOf(current))"><Icon name="trash" size="sm" /></button>
    </div>

    <CardText class="rx-find" label="查找（正则表达式）" code :rows="1" :model-value="current.findRegex" @update:model-value="set('findRegex', $event)">
      <template #label>查找（正则表达式）<span class="hint"> · 写成 /表达式/标志，例如 /&lt;think&gt;[\s\S]*?&lt;\/think&gt;/g</span></template>
    </CardText>
    <CardText label="替换为" code :rows="3" hint="可用 {{match}} 或 $1 引用匹配内容" :model-value="current.replaceString" @update:model-value="set('replaceString', $event)" />
    <CardText label="修剪掉" code :rows="2" hint="每行一个，替换前从匹配内容中删去" :model-value="trimText" @update:model-value="setTrim($event)" />

    <div class="rx-grid">
      <div class="field">
        <label>作用范围</label>
        <div class="rx-checks">
          <label v-for="p in PLACEMENTS" :key="p.value" class="check">
            <input type="checkbox" :checked="Array.isArray(current.placement) && current.placement.includes(p.value)" @change="setPlacement(p.value, /** @type {any} */ ($event.target).checked)" />{{ p.label }}
          </label>
        </div>
      </div>
      <div class="field">
        <label>其他选项</label>
        <div class="rx-checks">
          <label class="check"><input type="checkbox" :checked="!!current.disabled" @change="set('disabled', /** @type {any} */ ($event.target).checked)" />已停用</label>
          <label class="check"><input type="checkbox" :checked="!!current.runOnEdit" @change="set('runOnEdit', /** @type {any} */ ($event.target).checked)" />编辑时运行</label>
        </div>
      </div>
      <div class="field">
        <label>短暂性 <span class="hint">· 都不勾选时同时修改聊天记录</span></label>
        <div class="rx-checks">
          <label class="check"><input type="checkbox" :checked="!!current.markdownOnly" @change="set('markdownOnly', /** @type {any} */ ($event.target).checked)" />仅格式显示</label>
          <label class="check"><input type="checkbox" :checked="!!current.promptOnly" @change="set('promptOnly', /** @type {any} */ ($event.target).checked)" />仅格式提示词</label>
        </div>
      </div>
      <div class="field">
        <label>查找中的宏</label>
        <Seg :model-value="Number(current.substituteRegex) || 0" :options="SUBSTITUTE" @update:model-value="set('substituteRegex', $event)" />
      </div>
      <div class="field">
        <label>深度范围 <span class="hint">· 留空为不限</span></label>
        <div class="rx-depth">
          <input class="input num" type="number" min="-1" placeholder="最小" :value="current.minDepth ?? ''" @change="setDepth('minDepth', /** @type {any} */ ($event.target).value)" />
          <span class="faint">至</span>
          <input class="input num" type="number" min="0" placeholder="最大" :value="current.maxDepth ?? ''" @change="setDepth('maxDepth', /** @type {any} */ ($event.target).value)" />
        </div>
      </div>
    </div>

    <div class="card rx-test">
      <div class="field-label">试一试 <span class="hint">· 只在这里试，不写入；宏不展开</span></div>
      <textarea v-model="sample" class="textarea code" rows="3" spellcheck="false" placeholder="输入一段文本查看替换结果" />
      <div v-if="test.error" class="rx-test-err"><Icon name="alert" size="sm" />{{ test.error }}</div>
      <pre v-else-if="sample" class="rx-test-out mono">{{ test.out }}</pre>
    </div>
  </section>
  <section v-else class="rx-detail empty"><Icon name="regex" /><h3>选择一条正则</h3></section>
</template>

<style scoped>
.rx-list { width: 340px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; height: 100%; }
.rx-list-head { display: flex; gap: var(--sp-2); padding: var(--sp-3); align-items: center; }
.rx-list-head .search { flex: 1; min-width: 0; }
.rx-rows { flex: 1; overflow: auto; }
.rx-row { display: flex; align-items: center; gap: var(--sp-2); padding: 6px var(--sp-3); cursor: pointer; border-left: 2px solid transparent; }
.rx-row:hover { background: var(--bg-3); }
.rx-row.on { background: var(--accent-soft); border-left-color: var(--accent); }
.rx-row.off .rx-name { color: var(--text-3); text-decoration: line-through; }
.rx-no { width: 22px; text-align: right; font-size: var(--fs-xs); flex: none; }
.rx-row-main { min-width: 0; flex: 1; }
.rx-name, .rx-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rx-name { font-size: var(--fs-sm); }
.rx-sub { font-size: 11px; }
.rx-place { font-size: var(--fs-xs); white-space: nowrap; }
.rx-empty { padding: var(--sp-4); font-size: var(--fs-sm); }
.rx-foot { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--line); font-size: var(--fs-xs); }
.rx-foot .spacer { flex: 1; }
.rx-detail { flex: 1; min-width: 0; overflow: auto; padding: var(--sp-5) var(--sp-6); display: flex; flex-direction: column; gap: var(--sp-4); height: 100%; box-sizing: border-box; }
.rx-detail.empty { align-items: center; justify-content: center; color: var(--text-3); }
.rx-detail-head { display: flex; align-items: center; gap: var(--sp-2); }
.rx-detail-head .ce-name { flex: 1; }
.rx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--sp-4); }
.rx-checks { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); }
.rx-depth { display: flex; align-items: center; gap: var(--sp-2); }
.rx-test { padding: var(--sp-3) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); }
.rx-test-out { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; padding: var(--sp-2); background: var(--bg-input); border-radius: var(--r-md); }
.rx-detail :deep(.textarea.code) { white-space: pre-wrap; overflow-wrap: anywhere; }
.rx-find :deep(.textarea) { min-height: 0; }
.rx-test-err { color: var(--st-conflict); display: flex; gap: 6px; align-items: center; font-size: var(--fs-sm); }
.grow { flex: 1; min-width: 0; }
</style>
