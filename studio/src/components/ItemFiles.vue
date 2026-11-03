<script setup>
// The files an item is made of (split parts and the user's own files), with a plain text editor for one of them.
// It edits the same files VS Code would: a save writes one file (guarded by that file's hash) and the companion
// re-reads the item exactly as after an external edit, so the form view, status and auto-sync follow.
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { api, errorText } from '../api.js';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { joinPath, openExternalEditor } from '../lib/desktop.js';

const props = defineProps({
  path: { type: String, required: true },
  /** file to select first (item-relative), e.g. from the inspector */
  initial: { type: String, default: '' },
  /** the page already shows the item's read error */
  hideItemError: { type: Boolean, default: false }
});
const app = useApp();
const ui = useUi();

/** Folder labels; anything else shows its own name. Order = order of the groups. */
const FOLDERS = {
  '': '卡片字段',
  alternate_greetings: '其他开场',
  character_book: '内嵌世界书',
  regex: '角色正则',
  scripts: '酒馆助手脚本',
  entries: '条目',
  prompts: '提示词'
};
/** What each top-level file of a card holds (shown under the name). */
const FILE_HINT = {
  'card.json': '其余字段（未拆出的部分都在这里）',
  'cellar-item.json': 'TavernCellar 的记录，只读',
  'description.md': '角色描述',
  'first_mes.md': '第一条消息',
  'personality.md': '角色设定摘要',
  'scenario.md': '情景',
  'mes_example.md': '对话示例',
  'system_prompt.md': '主要提示词',
  'post_history_instructions.md': '后续历史指令',
  'creator_notes.md': '创作者的注释',
  'depth_prompt.md': '角色备注',
  'variables.json': '酒馆助手变量'
};

/** @type {import('vue').Ref<{rel:string, size:number, owned:boolean, readOnly:boolean}[]>} */
const files = ref([]);
const listError = ref('');
const sel = ref('');
const text = ref('');
const loadedText = ref('');
const hash = ref('');
const loading = ref(false);
const saving = ref(false);
const changedElsewhere = ref(false);
/** the item no longer parses after the last save (message from the companion) */
const itemError = ref('');
const filter = ref('');

const dirty = computed(() => !!sel.value && text.value !== loadedText.value);
const current = computed(() => files.value.find((f) => f.rel === sel.value) || null);
const groups = computed(() => {
  const q = filter.value.trim().toLowerCase();
  /** @type {Map<string, {key:string, label:string, files:any[]}>} */
  const m = new Map();
  for (const key of Object.keys(FOLDERS)) m.set(key, { key, label: FOLDERS[/** @type {keyof typeof FOLDERS} */ (key)], files: [] });
  for (const f of files.value) {
    if (q && !f.rel.toLowerCase().includes(q)) continue;
    const top = f.rel.includes('/') ? f.rel.slice(0, f.rel.indexOf('/')) : '';
    if (!m.has(top)) m.set(top, { key: top, label: top, files: [] });
    /** @type {any} */ (m.get(top)).files.push(f);
  }
  return [...m.values()].filter((g) => g.files.length);
});
const isCode = computed(() => /\.(json|js|txt|ya?ml)$/i.test(sel.value));
const shortName = (/** @type {string} */ rel) => rel.slice(rel.lastIndexOf('/') + 1);
const sizeText = (/** @type {number} */ n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB');

async function loadList() {
  try {
    const r = await api.itemFiles(props.path);
    files.value = r.files;
    listError.value = '';
    if (!sel.value || !files.value.some((f) => f.rel === sel.value)) {
      const first = (props.initial && files.value.find((f) => f.rel === props.initial || f.rel.startsWith(props.initial + '/'))) || files.value.find((f) => f.rel !== 'cellar-item.json');
      if (first) open(first.rel);
      else { sel.value = ''; text.value = loadedText.value = ''; }
    }
  } catch (e) {
    listError.value = errorText(e);
  }
}

async function open(/** @type {string} */ rel) {
  if (rel === sel.value) return;
  if (dirty.value && !(await save())) return;
  sel.value = rel;
  setTimeout(() => document.querySelector('.itf-file.on')?.scrollIntoView({ block: 'nearest' }), 0);
  await readCurrent();
}

async function readCurrent() {
  if (!sel.value) return;
  loading.value = true;
  try {
    const r = await api.itemFile(props.path, sel.value);
    text.value = loadedText.value = r.text;
    hash.value = r.hash;
    changedElsewhere.value = false;
  } catch (e) {
    ui.toast('无法读取文件：' + errorText(e), 'alert');
  } finally {
    loading.value = false;
  }
}

/** @returns {Promise<boolean>} true when nothing is left unsaved */
async function save(force = false) {
  if (!dirty.value || current.value?.readOnly) return true;
  if (changedElsewhere.value && !force) return false;
  saving.value = true;
  try {
    if (force) hash.value = (await api.itemFile(props.path, sel.value)).hash;
    const sent = text.value;
    const r = await api.putItemFile(props.path, sel.value, sent, hash.value);
    hash.value = r.hash;
    loadedText.value = sent;
    changedElsewhere.value = false;
    itemError.value = r.error || '';
    if (r.error) ui.toast('已写入，但这个资料项现在无法读取：' + r.error, 'alert');
    return true;
  } catch (e) {
    if (/** @type {any} */ (e).code === 'conflict') changedElsewhere.value = true;
    else ui.toast('写入失败：' + errorText(e), 'alert');
    return false;
  } finally {
    saving.value = false;
  }
}

function onKey(/** @type {KeyboardEvent} */ e) {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    e.stopPropagation();
    save();
  }
}

function openExternal() {
  const abs = joinPath(app.workspace, props.path + '/' + sel.value);
  openExternalEditor(abs, app.settings?.ui?.externalEditor || 'system', ui.toast);
}

// The item changed on disk (VS Code, a pull, the form view, a re-layout): refresh the list; the open file follows
// unless it holds unsaved text, which then waits for an explicit choice.
const item = computed(() => app.item(props.path));
watch(() => [item.value?.hash, JSON.stringify(item.value?.layout || null), item.value?.error].join('|'), async () => {
  if (saving.value) return;
  await loadList();
  if (!sel.value) return;
  const r = await api.itemFile(props.path, sel.value).catch(() => null);
  if (!r || r.hash === hash.value) return;
  if (dirty.value) changedElsewhere.value = true;
  else { text.value = loadedText.value = r.text; hash.value = r.hash; }
});
watch(() => props.path, () => { sel.value = ''; loadList(); }, { immediate: true });
// A new request from the inspector / outline (a fresh object each time, so the same file can be asked for twice).
watch(() => ui.itemView[props.path], (v) => { const want = v?.file; if (want) { const f = files.value.find((x) => x.rel === want || x.rel.startsWith(want + '/')); if (f) open(f.rel); } });
onBeforeUnmount(() => { if (dirty.value && !changedElsewhere.value) save(); });

defineExpose({ save, dirty });
</script>

<template>
  <div class="itf">
    <aside class="itf-list">
      <div class="itf-search"><Icon name="search" size="sm" /><input v-model="filter" class="input" placeholder="筛选文件" spellcheck="false" /></div>
      <div v-if="listError" class="faint itf-empty">{{ listError }}</div>
      <div v-for="g in groups" :key="g.key" class="itf-group">
        <div class="itf-gh">{{ g.label }}<span class="count">{{ g.files.length }}</span></div>
        <button
          v-for="f in g.files"
          :key="f.rel"
          type="button"
          class="itf-file"
          :class="{ on: f.rel === sel, mine: !f.owned }"
          :title="f.rel + (f.owned ? '' : '（你自己的文件，TavernCellar 不读取）')"
          @click="open(f.rel)"
        >
          <Icon :name="/\.(js|json)$/i.test(f.rel) ? 'code' : 'file'" size="sm" />
          <span class="itf-name">
            <span>{{ shortName(f.rel) }}</span>
            <span v-if="!g.key && FILE_HINT[f.rel]" class="faint itf-hint">{{ FILE_HINT[f.rel] }}</span>
          </span>
          <span v-if="f.rel === sel && dirty" class="itf-dirty" title="未保存">●</span>
          <span class="faint itf-size">{{ sizeText(f.size) }}</span>
        </button>
      </div>
    </aside>

    <section class="itf-main">
      <div v-if="!sel" class="faint itf-empty">选择左侧的文件查看或编辑。</div>
      <template v-else>
        <div class="itf-head">
          <span class="mono itf-path" :title="path + '/' + sel">{{ sel }}</span>
          <span v-if="current && !current.owned" class="badge" title="TavernCellar 不读取这个文件，也不会同步它">你的文件</span>
          <span v-if="current?.readOnly" class="badge">只读</span>
          <span class="spacer" />
          <span class="faint itf-state">
            <template v-if="saving"><Icon name="spin" size="sm" />正在写入…</template>
            <template v-else-if="dirty">未保存 · Ctrl+S</template>
            <template v-else>已写入工作区</template>
          </span>
          <button class="btn sm ghost" type="button" title="用外部编辑器打开这个文件" @click="openExternal"><Icon name="external" size="sm" />外部编辑器</button>
          <button class="btn sm ghost" type="button" :disabled="!dirty || saving" @click="text = loadedText">撤销修改</button>
          <button class="btn sm primary" type="button" :disabled="!dirty || saving || current?.readOnly || changedElsewhere" @click="save()"><Icon name="save" size="sm" />保存</button>
        </div>
        <div v-if="changedElsewhere" class="banner warn itf-banner">
          <Icon name="alert" />
          <div class="grow"><b>文件在别处被修改</b><span class="muted"> · 重新加载会丢弃这里的修改；覆盖会用这里的内容替换那些改动。</span></div>
          <button class="btn sm" type="button" @click="readCurrent">重新加载</button>
          <button class="btn sm" type="button" @click="save(true)">覆盖</button>
        </div>
        <div v-if="!hideItemError && (itemError || item?.error)" class="banner conflict itf-banner">
          <Icon name="alert" />
          <div class="grow">这个资料项现在无法读取：{{ itemError || item?.error }}<span class="muted"> · 修好文件之前不会同步。</span></div>
        </div>
        <div v-if="loading" class="faint itf-empty"><Icon name="spin" size="sm" /> 正在读取…</div>
        <textarea
          v-else
          v-model="text"
          class="textarea itf-text"
          :class="{ code: isCode }"
          :readonly="current?.readOnly"
          spellcheck="false"
          :aria-label="sel"
          @keydown="onKey"
        />
      </template>
    </section>
  </div>
</template>

<style scoped>
.itf { display: grid; grid-template-columns: minmax(200px, 260px) 1fr; gap: var(--sp-3); min-height: 520px; height: calc(100vh - 230px); }
.itf-list { overflow: auto; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--bg-2); padding: 6px; }
.itf-search { display: flex; align-items: center; gap: 6px; padding: 2px 4px 6px; color: var(--text-3); }
.itf-search .input { height: 28px; flex: 1; min-width: 0; }
.itf-group + .itf-group { margin-top: 6px; }
.itf-gh { display: flex; align-items: center; padding: 4px 6px; font-size: var(--fs-xs); color: var(--text-3); text-transform: none; }
.itf-gh .count { margin-left: auto; }
.itf-file {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 6px; border: 0; border-radius: var(--r-md);
  background: transparent; color: var(--text-2); font: inherit; font-size: var(--fs-sm); text-align: left; cursor: pointer;
}
.itf-file:hover { background: var(--bg-3); color: var(--text); }
.itf-file.on { background: var(--accent-soft, var(--bg-3)); color: var(--text); }
.itf-file.mine { font-style: italic; }
.itf-file > svg { flex: none; color: var(--text-3); }
.itf-name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.itf-name > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.itf-hint { font-size: var(--fs-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.itf-size { font-size: var(--fs-xs); flex: none; }
.itf-dirty { color: var(--st-warn); font-size: 10px; }
.itf-main { display: flex; flex-direction: column; min-width: 0; gap: var(--sp-2); }
.itf-head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.itf-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%; }
.itf-state { font-size: var(--fs-sm); display: inline-flex; align-items: center; gap: 4px; }
.itf-banner { margin: 0; }
.itf-text { flex: 1; min-height: 300px; resize: none; font-size: var(--fs-editor, 15px); line-height: 1.6; }
.itf-text.code { font-family: var(--font-mono); font-size: calc(var(--fs-editor, 15px) - 1px); white-space: pre; tab-size: 4; }
.itf-empty { padding: var(--sp-4); }
.spacer { flex: 1; }
</style>
