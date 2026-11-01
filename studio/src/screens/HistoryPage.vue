<script setup>
// Version history (docs/versioning.md, docs/studio-design.md §4.7). The draft @ collects every change on its own;
// "记录版本" gives it a description and finishes it. Selecting a version shows its field-level changes against the
// previous version (or any other version picked for comparison); an item can be restored from there.
import { ref, computed, watch, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import SlotDiff from '../components/SlotDiff.vue';
import { api, errorText } from '../api.js';
import { useApp } from '../stores/app.js';
import { useUi, hrefOf } from '../stores/ui.js';
import { itemName, relTime } from '../lib/status.js';

const UNDESCRIBED = '(未写说明)';
const app = useApp();
const ui = useUi();

const filter = ref('');
/** @type {import('vue').Ref<any>} */
const hist = ref(null);
const loading = ref(false);
const error = ref('');
const message = ref('');
const busy = ref('');
const selected = ref('');
/** version to compare the selected one with ('' = its previous version) */
const compareWith = ref('');
/** @type {import('vue').Ref<any>} */
const diff = ref(null);
const diffLoading = ref(false);
const tagName = ref('');
const armedRestore = ref('');

const isItemPath = (/** @type {string} */ p) => p.includes('/');
const versions = computed(() => (hist.value ? hist.value.versions : []));
const draft = computed(() => (hist.value ? hist.value.draft : null));
const draftItems = computed(() => (draft.value && draft.value.items ? draft.value.items.filter(isItemPath) : []));
const sel = computed(() => versions.value.find((/** @type {any} */ v) => v.id === selected.value) || null);
const short = (/** @type {string} */ id) => (id ? id.slice(0, 8) : '');
const deployedAt = (/** @type {string} */ id) => (hist.value ? hist.value.deployed.filter((/** @type {any} */ d) => d.rev === id || d.shownAt === id) : []);
const label = (/** @type {any} */ v) => (v.message === UNDESCRIBED ? '' : v.message);
const versionName = (/** @type {string} */ id) => {
  const v = versions.value.find((/** @type {any} */ x) => x.id === id);
  return v ? (label(v) || short(id)) : short(id);
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const next = await api.history({ path: filter.value || undefined, limit: 200 });
    // Status events arrive for every log line: only redo the diff when the history itself changed.
    const sig = JSON.stringify([next.versions.map((/** @type {any} */ v) => v.id + v.message + v.tags.join()), next.draft && next.draft.id, next.deployed]);
    const changed = sig !== lastSig;
    lastSig = sig;
    hist.value = next;
    if (selected.value && !versions.value.some((/** @type {any} */ v) => v.id === selected.value)) selected.value = '';
    if (!selected.value && versions.value.length) select(versions.value[0].id);
    else if (selected.value && changed) loadDiff();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}
let lastSig = '';

function select(/** @type {string} */ id) {
  if (selected.value === id) return;
  selected.value = id;
  compareWith.value = '';
  armedRestore.value = '';
  diff.value = null;
  loadDiff();
}

async function loadDiff() {
  const v = sel.value;
  if (!v) { diff.value = null; return; }
  const ticket = ++diffTicket;
  diffLoading.value = true;
  try {
    const from = compareWith.value || v.parents[0] || null;
    const d = await api.diffVersions(from, v.id, filter.value || undefined);
    if (ticket === diffTicket) diff.value = d;
  } catch (e) {
    if (ticket === diffTicket) diff.value = { error: errorText(e), items: [] };
  } finally {
    if (ticket === diffTicket) diffLoading.value = false;
  }
}
let diffTicket = 0;

async function act(/** @type {string} */ kind, /** @type {() => Promise<any>} */ fn, /** @type {string} */ done) {
  busy.value = kind;
  try {
    await fn();
    if (done) ui.toast(done, 'check');
    await load();
    await app.refreshStatus();
  } catch (e) {
    ui.toast(errorText(e), 'alert');
  } finally {
    busy.value = '';
  }
}

const describe = () => act('describe', () => api.describeDraft(message.value), '草稿说明已保存');
const record = () => act('record', async () => {
  const r = await api.recordVersion(message.value);
  message.value = '';
  selected.value = r.id;
}, '已记录版本');
const tag = () => act('tag', async () => { await api.tagVersion(tagName.value.trim(), selected.value); tagName.value = ''; }, '已打标签');

function restore(/** @type {string} */ path) {
  if (armedRestore.value !== path) { armedRestore.value = path; return; }
  armedRestore.value = '';
  act('restore', () => api.restoreVersion(selected.value, path), `${itemName(path)} 已恢复到这个版本，同步后酒馆中也会变回这样`);
}

const statusText = { added: '新增', removed: '删除', changed: '修改', unreadable: '无法读取' };
const slotView = (/** @type {any} */ s) => ({ ...s, workspace: s.to, tavern: s.from, base: { value: null, present: false } });
const itemPaths = computed(() => app.items.map((/** @type {any} */ i) => i.path));

watch(filter, load);
watch(compareWith, loadDiff);
// The companion announces history changes (snapshots, syncs, pulls) through status events.
watch(() => app.status, () => { if (!busy.value) load(); });
onMounted(load);
</script>

<template>
  <div class="page vh">
    <div class="page-head">
      <div>
        <h2><Icon name="history" />版本历史</h2>
        <p class="muted">修改会自动进入「草稿」。写上说明并「记录版本」，就能随时对比、恢复。标记了酒馆名的版本，就是该酒馆里现在的样子。</p>
      </div>
      <div class="page-actions">
        <select v-model="filter" class="input vh-filter" aria-label="只看某一项">
          <option value="">全部资料项</option>
          <option v-for="p in itemPaths" :key="p" :value="p">{{ itemName(p) }}</option>
        </select>
      </div>
    </div>

    <div v-if="error" class="sync-note err">{{ error }}</div>

    <section class="card vh-draft" :class="{ empty: !draftItems.length }">
      <div class="vh-draft-h">
        <span class="vh-at">@</span>
        <strong>草稿</strong>
        <span v-if="draftItems.length" class="muted">{{ draftItems.length }} 项有修改：</span>
        <span v-else class="faint">没有未记录的修改</span>
        <a v-for="p in draftItems" :key="p" class="chip vh-item" :href="hrefOf({ name: 'item', arg: p })">{{ itemName(p) }}</a>
      </div>
      <div v-if="draftItems.length" class="vh-draft-f">
        <input v-model="message" class="input" :placeholder="draft && draft.message && draft.message !== UNDESCRIBED ? draft.message : '这次改了什么？（可不写）'" @keydown.enter="record" />
        <button class="btn" :disabled="!!busy || !message.trim()" @click="describe">只写说明</button>
        <button class="btn primary" :disabled="!!busy" @click="record"><Icon name="check" size="sm" />记录版本</button>
      </div>
    </section>

    <div class="vh-main">
      <ol class="vh-list" aria-label="版本列表">
        <li v-if="loading && !versions.length" class="faint vh-empty">载入中…</li>
        <li v-else-if="!versions.length" class="faint vh-empty">还没有版本</li>
        <li v-for="v in versions" :key="v.id">
          <button class="vh-row" :class="{ on: v.id === selected, draft: v.draft }" @click="select(v.id)">
            <span class="vh-dot" />
            <span class="vh-msg">
              <span v-if="v.draft" class="vh-at sm">@</span>
              <span :class="{ faint: !label(v) }">{{ label(v) || (v.draft ? '草稿（未写说明）' : '未写说明') }}</span>
            </span>
            <span class="vh-meta faint"><span class="mono">{{ short(v.id) }}</span> · {{ relTime(v.time) }}</span>
            <span class="vh-tags">
              <span v-for="t in v.tags" :key="t" class="badge vh-tag"><Icon name="tag" size="sm" />{{ t }}</span>
              <span v-for="d in deployedAt(v.id)" :key="d.target + d.path" class="badge vh-dep" :class="{ earlier: d.earlier }" :title="d.earlier ? `${d.label} 中的 ${itemName(d.path)} 是这个版本较早的状态（${short(d.rev)}），之后又有修改` : `${d.label} 中的 ${itemName(d.path)} 是这个版本`">{{ d.label }} · {{ itemName(d.path) }}{{ d.earlier ? '（较早状态）' : '' }}</span>
            </span>
            <span class="vh-items faint">{{ v.items.filter(isItemPath).map(itemName).join('、') || '（工作区设置）' }}</span>
          </button>
        </li>
      </ol>

      <section v-if="sel" class="card vh-detail">
        <div class="vh-detail-h">
          <div class="vh-title">
            <strong>{{ label(sel) || '未写说明' }}</strong>
            <span class="faint"><span class="mono">{{ short(sel.id) }}</span> · {{ new Date(sel.time).toLocaleString() }}</span>
          </div>
          <label class="vh-cmp">对比
            <select v-model="compareWith" class="input">
              <option value="">上一个版本</option>
              <option v-for="v in versions.filter((x) => x.id !== sel.id)" :key="v.id" :value="v.id">{{ short(v.id) }} · {{ label(v) || '未写说明' }}</option>
            </select>
          </label>
          <div class="vh-tagbox">
            <input v-model="tagName" class="input" placeholder="标签名，如 v1.0" @keydown.enter="tagName.trim() && tag()" />
            <button class="btn" :disabled="!!busy || !tagName.trim()" @click="tag"><Icon name="tag" size="sm" />打标签</button>
          </div>
        </div>

        <div v-if="diffLoading && !diff" class="faint vh-empty">比较中…</div>
        <div v-else-if="diff && diff.error" class="sync-note err">{{ diff.error }}</div>
        <div v-else-if="diff && !diff.items.length" class="faint vh-empty">与{{ compareWith ? ' ' + versionName(compareWith) + ' ' : '上一个版本' }}相比，资料内容没有变化</div>
        <template v-else-if="diff">
          <div v-for="it in diff.items" :key="it.path" class="vh-ditem">
            <div class="vh-ditem-h">
              <Icon :name="it.kind === 'lorebook' ? 'book' : 'user'" size="sm" />
              <strong>{{ itemName(it.path) }}</strong>
              <span class="badge">{{ statusText[it.status] }}</span>
              <span v-if="it.slots.length" class="faint">{{ it.slots.length }} 处</span>
              <span class="grow" />
              <button v-if="it.status !== 'removed' && app.item(it.path)" class="btn sm" :class="{ danger: armedRestore === it.path }" :disabled="!!busy" @click="restore(it.path)">
                <Icon name="history" size="sm" />{{ armedRestore === it.path ? '确定恢复？工作区的这项会被替换' : '把这项恢复成这个版本' }}
              </button>
            </div>
            <div v-if="it.error" class="sync-note err">{{ it.error }}</div>
            <div v-for="s in it.slots" :key="s.slot" class="vh-slot">
              <div class="vh-slot-h">{{ s.label }}<span v-if="s.eolOnly" class="faint">（只有换行符不同，内容相同）</span></div>
              <SlotDiff v-if="!s.eolOnly" :slot-view="slotView(s)" :sides="{ workspace: '此版本', tavern: compareWith ? versionName(compareWith) : '上一个版本' }" />
            </div>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>
