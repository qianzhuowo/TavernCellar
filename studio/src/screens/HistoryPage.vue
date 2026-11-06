<script setup>
// Version history (docs/versioning.md, docs/studio-design.md §4.7). The draft @ collects every change (edits,
// checkouts, pulls, merges, restores); only "记录版本" or tagging the draft finishes it, as in jj. Selecting a version shows its field-level changes against the
// previous version (or any other version picked for comparison); an item can be restored from there.
import { ref, computed, watch, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import SlotDiff from '../components/SlotDiff.vue';
import { api, errorText } from '../api.js';
import { useApp } from '../stores/app.js';
import { useUi, hrefOf, historyHref } from '../stores/ui.js';
import { itemName, relTime } from '../lib/status.js';
import { kindOf } from '../lib/kinds.js';

const UNDESCRIBED = '(未写说明)';
const app = useApp();
const ui = useUi();

/** item shown alone ('' = all): the route #/history/<path> holds it, so links can open one item's history */
const filter = computed({
  get: () => (ui.route.name === 'history' ? ui.route.arg : ''),
  set: (p) => ui.go(historyHref(p)),
});
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

const record = () => act('record', async () => {
  const r = await api.recordVersion(message.value);
  message.value = '';
  selected.value = r.id;
}, '已记录版本');
// Tagging the draft records it first (companion vcs.tag); the finished version replaces the draft in the list.
const tag = () => act('tag', async () => {
  const wasDraft = sel.value && sel.value.draft;
  const r = await api.tagVersion(tagName.value.trim(), selected.value);
  tagName.value = '';
  if (wasDraft) { message.value = ''; selected.value = r.id; }
}, '已打标签');

// ---- push a version to one tavern (docs/versioning.md §3): the workspace stays, the bindings get pinned ----
const pushTarget = ref('');
/** {target, results, name} of the last push, shown under the header (failures need a decision) */
const pushed = ref(/** @type {any} */ (null));
/** taverns with at least one item that exists in the selected version */
const pushTargets = computed(() => {
  const ids = new Set();
  for (const it of app.items) for (const b of it.bindings || []) ids.add(b.target);
  return app.targets.filter((/** @type {any} */ t) => ids.has(t.id) && (t.live || t.offline));
});
watch(pushTargets, (list) => {
  if (!list.some((/** @type {any} */ t) => t.id === pushTarget.value)) pushTarget.value = list.length ? list[0].id : '';
}, { immediate: true });
const pushedText = { pushed: '已推送', 'tavern-changed': '酒馆里有新的修改，未推送', failed: '失败' };
function push(/** @type {boolean} */ force = false, /** @type {string[]|undefined} */ paths = undefined) {
  const target = pushTarget.value;
  return act('push', async () => {
    const r = await api.pushVersion(selected.value, target, { force, paths });
    // A retry of some items (paths) updates their rows; the other rows of the same push stay.
    const keep = paths && pushed.value && pushed.value.rev === r.rev && pushed.value.target === r.target
      ? pushed.value.results.filter((/** @type {any} */ x) => !paths.includes(x.path)) : [];
    const results = [...keep, ...r.results];
    pushed.value = { ...r, results, label: app.targetName(target) };
    const bad = r.results.filter((/** @type {any} */ x) => x.result !== 'pushed').length;
    if (bad) throw new Error(`${bad} 项没有推送，见下方说明`);
  }, `已把 ${versionName(selected.value)} 推送到 ${app.targetName(target)}，并固定在这个版本`);
}
watch(selected, () => { pushed.value = null; });

function restore(/** @type {string} */ path) {
  if (armedRestore.value !== path) { armedRestore.value = path; return; }
  armedRestore.value = '';
  act('restore', () => api.restoreVersion(selected.value, path), `${itemName(path)} 已恢复成「${versionName(selected.value)}」中的内容，同步后酒馆中也会变回这样`);
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
        <p class="muted">修改、取出、从酒馆取回的内容都先进入「草稿」，直到你「记录版本」或给草稿打标签，才成为一个版本；记录后就能随时对比、恢复，或把某个版本推送到一个酒馆。标记了酒馆名的版本，就是该酒馆里现在的样子；带 📌 的表示该酒馆固定在那个版本。</p>
      </div>
    </div>

    <div v-if="error" class="sync-note err">{{ error }}</div>

    <section class="card vh-draft" :class="{ empty: !draftItems.length }">
      <div class="vh-draft-h">
        <span class="vh-at">@</span>
        <strong>草稿</strong>
        <span v-if="draftItems.length" class="muted">{{ draftItems.length }} 项有修改：</span>
        <span v-else class="faint">没有未记录的修改</span>
        <a v-for="p in draftItems" :key="p" class="chip vh-item" :href="hrefOf('item:' + p)">{{ itemName(p) }}</a>
      </div>
      <div v-if="draftItems.length" class="vh-draft-f">
        <input v-model="message" class="input" :placeholder="draft && draft.message && draft.message !== UNDESCRIBED ? draft.message : '这次改了什么？（可不写）'" @keydown.enter="record" />
        <button class="btn primary" :disabled="!!busy" @click="record"><Icon name="check" size="sm" />记录版本</button>
      </div>
    </section>

    <div class="vh-main">
      <div class="vh-side">
      <select v-model="filter" class="input vh-filter" aria-label="只看某一项" title="切换要查看的资料项">
        <option value="">全部资料项</option>
        <option v-for="p in itemPaths" :key="p" :value="p">{{ itemName(p) }}</option>
      </select>
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
              <span v-for="d in deployedAt(v.id)" :key="d.target + d.path" class="badge vh-dep" :class="{ earlier: d.earlier, pinned: d.pinned }" :title="(d.pinned ? `${d.label} 中的 ${itemName(d.path)} 固定在这个版本，工作区的新修改不会同步过去。` : '') + (d.earlier ? `${d.label} 中的 ${itemName(d.path)} 是这个版本较早的状态（${short(d.rev)}），之后又有修改` : `${d.label} 中的 ${itemName(d.path)} 是这个版本`)"><Icon v-if="d.pinned" name="pin" size="sm" />{{ d.label }} · {{ itemName(d.path) }}{{ d.earlier ? '（较早状态）' : '' }}</span>
            </span>
            <span class="vh-items faint">{{ v.items.filter(isItemPath).map(itemName).join('、') || '（工作区设置）' }}</span>
          </button>
        </li>
      </ol>
      </div>

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
            <button class="btn" :disabled="!!busy || !tagName.trim()" :title="sel.draft ? '把草稿记录为版本，并给它打上这个标签' : ''" @click="tag"><Icon name="tag" size="sm" />{{ sel.draft ? '记录并打标签' : '打标签' }}</button>
          </div>
          <div v-if="pushTargets.length" class="vh-pushbox" title="把这个版本写到所选酒馆（只包括绑定了该酒馆的项），工作区不变；之后这些项在该酒馆固定在此版本，直到改为跟随最新">
            <select v-model="pushTarget" class="input" aria-label="推送到哪个酒馆">
              <option v-for="t in pushTargets" :key="t.id" :value="t.id">{{ app.targetName(t.id) }}</option>
            </select>
            <button class="btn primary" :disabled="!!busy || !pushTarget" @click="push()"><Icon name="upload" size="sm" />推送到酒馆</button>
          </div>
        </div>

        <div v-if="pushed && pushed.rev === sel.id" class="vh-pushed">
          <div v-for="x in pushed.results" :key="x.path" class="vh-pushed-row" :class="x.result">
            <Icon :name="x.result === 'pushed' ? 'check' : 'alert'" size="sm" />
            <strong>{{ itemName(x.path) }}</strong>
            <span>{{ pushedText[x.result] || x.result }}{{ x.result === 'pushed' ? `，${pushed.label} 固定在 ${pushed.name}` : '' }}</span>
            <span v-if="x.result === 'failed'" class="faint">{{ x.error }}</span>
            <span class="grow" />
            <template v-if="x.result === 'tavern-changed'">
              <a class="btn sm" :href="hrefOf('sync')">去同步页取回</a>
              <button class="btn sm danger" :disabled="!!busy" @click="push(true, [x.path])">覆盖酒馆的修改</button>
            </template>
          </div>
        </div>

        <div v-if="diffLoading && !diff" class="faint vh-empty">比较中…</div>
        <div v-else-if="diff && diff.error" class="sync-note err">{{ diff.error }}</div>
        <div v-else-if="diff && !diff.items.length" class="faint vh-empty">与{{ compareWith ? ' ' + versionName(compareWith) + ' ' : '上一个版本' }}相比，资料内容没有变化</div>
        <template v-else-if="diff">
          <div v-for="it in diff.items" :key="it.path" class="vh-ditem">
            <div class="vh-ditem-h">
              <Icon :name="kindOf(it.kind).icon" size="sm" />
              <strong>{{ itemName(it.path) }}</strong>
              <span class="badge">{{ statusText[it.status] }}</span>
              <span v-if="it.slots.length" class="faint">{{ it.slots.length }} 处</span>
              <span class="grow" />
              <button v-if="!sel.draft && it.status !== 'removed' && app.item(it.path)" class="btn sm" :class="{ danger: armedRestore === it.path }" :disabled="!!busy" :title="`把工作区里的「${itemName(it.path)}」换成「${versionName(sel.id)}」中的内容（不是对比的那个版本）；之后照常同步`" @click="restore(it.path)">
                <Icon name="history" size="sm" />{{ armedRestore === it.path ? '确定恢复？工作区的这项会被替换' : '恢复成所选版本' }}<span class="mono faint">{{ short(sel.id) }}</span>
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
