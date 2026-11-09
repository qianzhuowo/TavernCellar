<script setup>
// Version history (docs/versioning.md, docs/studio-design.md §4.7). The draft @ collects every change (edits,
// checkouts, pulls, merges, restores); only "记录版本" or tagging the draft finishes it, as in jj. Selecting a version shows its field-level changes against the
// previous version (or any other version picked for comparison); an item can be restored from there.
import { ref, computed, watch, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import SlotDiff from '../components/SlotDiff.vue';
import Toggle from '../components/Toggle.vue';
import LazyMount from '../components/LazyMount.vue';
import { api, errorText } from '../api.js';
import { useApp } from '../stores/app.js';
import { useUi, hrefOf, historyHref, HISTORY_ALL } from '../stores/ui.js';
import { itemName, relTime } from '../lib/status.js';
import { kindOf } from '../lib/kinds.js';

const UNDESCRIBED = '(未写说明)';
const app = useApp();
const ui = useUi();

/**
 * Item shown alone ('' = all items). The route #/history/<path> (or #/history/all) holds it, so links can open one
 * item's history; a bare #/history is redirected to what was shown last (see resolveBare).
 */
const filter = computed({
  get: () => (ui.route.name === 'history' && ui.route.arg !== HISTORY_ALL ? ui.route.arg : ''),
  set: (p) => ui.go(historyHref(p || HISTORY_ALL)),
});
/** The route names what to show (a bare #/history waits for the redirect). */
const routed = computed(() => ui.route.name === 'history' && !!ui.route.arg);
/**
 * #/history without an item: the choice made last time; the first time (or when that item is gone) the item being
 * edited, else the first item. "All items" is only shown when chosen, as it is the slowest view.
 */
function resolveBare() {
  if (ui.route.name !== 'history' || ui.route.arg) return;
  const has = (/** @type {string} */ p) => !!p && app.items.some((/** @type {any} */ i) => i.path === p);
  const last = ui.lastHistory;
  const next = last === HISTORY_ALL || has(last) ? last
    : has(ui.lastItem) ? ui.lastItem
    : app.items.length ? app.items[0].path : HISTORY_ALL;
  ui.replace(historyHref(next));
}
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
/** draft items left out of the next 存档 (all view; every item is ticked by default) */
const unchecked = ref(/** @type {string[]} */ ([]));
/** editing the selected version's description: the text, or null when not editing */
const editText = ref(/** @type {string | null} */ (null));

const isItemPath = (/** @type {string} */ p) => p.includes('/');
const versions = computed(() => (hist.value ? hist.value.versions : []));
const draft = computed(() => (hist.value ? hist.value.draft : null));
const draftItems = computed(() => (draft.value && draft.value.items ? draft.value.items.filter(isItemPath) : []));
/**
 * What "记录版本" saves: the item shown alone (when it has unsaved changes), or the ticked draft items. The other
 * items' changes stay in the draft (docs/versioning.md §2).
 */
const recordPaths = computed(() => (filter.value
  ? draftItems.value.filter((p) => p === filter.value)
  : draftItems.value.filter((p) => !unchecked.value.includes(p))));
const draftOthers = computed(() => draftItems.value.filter((p) => !recordPaths.value.includes(p)).length);
function toggleRecord(/** @type {string} */ p) {
  unchecked.value = unchecked.value.includes(p) ? unchecked.value.filter((x) => x !== p) : [...unchecked.value, p];
}
/** tags shown on a version: only the item's own when one item is shown */
const tagsOf = (/** @type {any} */ v) => (filter.value ? v.tags.filter((/** @type {any} */ t) => t.path === filter.value) : v.tags);
const tagText = (/** @type {any} */ t) => (filter.value ? t.name : `${itemName(t.path)} · ${t.name}`);
const sel = computed(() => versions.value.find((/** @type {any} */ v) => v.id === selected.value) || null);
const short = (/** @type {string} */ id) => (id ? id.slice(0, 8) : '');
const deployedAt = (/** @type {string} */ id) => (hist.value ? hist.value.deployed.filter((/** @type {any} */ d) => d.rev === id || d.shownAt === id) : []);
const label = (/** @type {any} */ v) => (v.message === UNDESCRIBED ? '' : v.message);
const versionName = (/** @type {string} */ id) => {
  const v = versions.value.find((/** @type {any} */ x) => x.id === id);
  return v ? (label(v) || short(id)) : short(id);
};

async function load() {
  if (!routed.value) return;
  loading.value = true;
  error.value = '';
  try {
    const next = await api.history({ path: filter.value || undefined, limit: 200 });
    // Status events arrive for every log line: only redo the diff when the history itself changed.
    const sig = JSON.stringify([next.versions.map((/** @type {any} */ v) => v.id + v.message + v.tags.map((/** @type {any} */ t) => t.path + ':' + t.name).join()), next.draft && next.draft.id, next.deployed]);
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
  editText.value = null;
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

const record = () => {
  const paths = recordPaths.value;
  if (!paths.length) return;
  return act('record', async () => {
    const r = await api.recordVersion(message.value, paths);
    message.value = '';
    unchecked.value = [];
    selected.value = r.id;
  }, `已存档：${paths.map(itemName).join('、')}`);
};
// A tag belongs to one item. Tagging the draft saves that item first with the description typed above
// (companion vcs.tag); the new version replaces the draft in the list.
const tag = () => act('tag', async () => {
  const wasDraft = sel.value && sel.value.draft;
  const r = await api.tagVersion(tagName.value.trim(), filter.value, selected.value, wasDraft ? message.value : undefined);
  tagName.value = '';
  if (wasDraft) { message.value = ''; selected.value = r.id; }
}, '已贴上标签');
const untag = (/** @type {any} */ t) => act('tag', () => api.untagVersion(t.name, t.path), `已删除标签 ${t.name}`);
// Descriptions live outside the version (git notes): changing one keeps the id and every pointer to it.
const saveDescription = () => act('describe', async () => {
  const v = sel.value;
  await api.describeDraft(editText.value || '', v.draft ? undefined : v.id);
  editText.value = null;
}, '说明已修改');

// ---- push a version to one tavern (docs/versioning.md §3): the workspace stays, the bindings get pinned ----
const pushTarget = ref('');
/** {target, results, name} of the last push, shown under the header (failures need a decision) */
const pushed = ref(/** @type {any} */ (null));
/**
 * What a push writes: the item shown alone, or (all items) the items the selected version saved. A version holds
 * the whole workspace's files, so pushing everything bound would also pin items the user never touched.
 */
const pushScope = computed(() => {
  const v = sel.value;
  if (!v) return [];
  return filter.value ? [filter.value] : v.items.filter(isItemPath);
});
const boundTo = (/** @type {string} */ path, /** @type {string} */ target) =>
  ((app.item(path) || {}).bindings || []).some((/** @type {any} */ b) => b.target === target);
/** taverns bound to at least one item of the push scope */
const pushTargets = computed(() => app.targets.filter((/** @type {any} */ t) =>
  (t.live || t.offline) && pushScope.value.some((p) => boundTo(p, t.id))));
/** items of the scope bound to the chosen tavern: exactly what "推送到酒馆" writes */
const pushPaths = computed(() => pushScope.value.filter((p) => boundTo(p, pushTarget.value)));
watch(pushTargets, (list) => {
  if (!list.some((/** @type {any} */ t) => t.id === pushTarget.value)) pushTarget.value = list.length ? list[0].id : '';
}, { immediate: true });
const pushedText = { pushed: '已推送', 'tavern-changed': '酒馆里有新的修改，未推送', failed: '失败' };
function push(/** @type {boolean} */ force = false, /** @type {string[]} */ paths = pushPaths.value) {
  const target = pushTarget.value;
  if (!paths.length) return;
  return act('push', async () => {
    const r = await api.pushVersion(selected.value, target, { force, paths });
    // A retry of some items (paths) updates their rows; the other rows of the same push stay.
    const keep = pushed.value && pushed.value.rev === r.rev && pushed.value.target === r.target
      ? pushed.value.results.filter((/** @type {any} */ x) => !paths.includes(x.path)) : [];
    const results = [...keep, ...r.results];
    pushed.value = { ...r, results, label: app.targetName(target) };
    const bad = r.results.filter((/** @type {any} */ x) => x.result !== 'pushed').length;
    if (bad) throw new Error(`${bad} 项没有推送，见下方说明`);
  }, `已把 ${versionName(selected.value)} 中的 ${paths.map(itemName).join('、')} 推送到 ${app.targetName(target)}，并固定在这个版本`);
}
watch(selected, () => { pushed.value = null; });

function restore(/** @type {string} */ path) {
  if (armedRestore.value !== path) { armedRestore.value = path; return; }
  armedRestore.value = '';
  act('restore', () => api.restoreVersion(selected.value, path), `${itemName(path)} 已恢复成「${versionName(selected.value)}」中的内容，同步后酒馆中也会变回这样`);
}

const statusText = { added: '新增', removed: '删除', changed: '修改', unreadable: '无法读取' };
const slotView = (/** @type {any} */ s) => ({ ...s, workspace: s.to, tavern: s.from, base: { value: null, present: false } });
/** 「完整文件」: both versions side by side instead of the changed lines (remembered). */
const fullFile = ref(localStorage.getItem('cs.history.fullFile') === '1');
watch(fullFile, (v) => localStorage.setItem('cs.history.fullFile', v ? '1' : '0'));
const itemPaths = computed(() => app.items.map((/** @type {any} */ i) => i.path));

watch(() => (routed.value ? ui.route.arg : ''), (arg) => {
  if (!arg) return;
  // another item (or all): start from its newest version (the draft, when the draft touches it)
  selected.value = '';
  diff.value = null;
  load();
});
watch(() => ui.route.arg, resolveBare);
watch(compareWith, loadDiff);
// The companion announces history changes (snapshots, syncs, pulls) through status events.
watch(() => app.status, () => { if (!busy.value) load(); });
onMounted(() => { resolveBare(); load(); });
</script>

<template>
  <div class="page vh">
    <div class="page-head">
      <div>
        <h2><Icon name="history" />版本历史</h2>
        <p class="muted">改动会先放在「草稿」里（还没存档）。<b>记录版本</b>就是存档，可以只存其中几项；<b>打标签</b>只是给某一项的存档贴上名字（如 v1.0），方便以后找到；说明和标签随时可改，存档本身不变。存档后可以对比、<b>恢复</b>（把工作区改回去），或<b>推送</b>（只把某个存档放进一个酒馆）。版本上写着酒馆名，表示该酒馆里现在就是这个存档；带 📌 表示酒馆固定在那里。</p>
      </div>
    </div>

    <div v-if="error" class="sync-note err">{{ error }}</div>

    <section class="card vh-draft" :class="{ empty: !draftItems.length }">
      <div class="vh-draft-h">
        <span class="vh-at">@</span>
        <strong>草稿</strong>
        <span v-if="draftItems.length" class="muted">{{ draftItems.length }} 项有未存档的修改{{ filter ? '：' : '，勾选要存档的项：' }}</span>
        <span v-else class="faint">没有未存档的修改</span>
        <template v-if="filter">
          <a v-for="p in draftItems" :key="p" class="chip vh-item" :class="{ on: p === filter }" :href="historyHref(p)" :title="`查看「${itemName(p)}」的版本历史`"><span class="ell">{{ itemName(p) }}</span></a>
        </template>
        <template v-else>
          <span v-for="p in draftItems" :key="p" class="chip vh-item vh-pick" :class="{ off: unchecked.includes(p) }">
            <input type="checkbox" :checked="!unchecked.includes(p)" :aria-label="`存档「${itemName(p)}」`" @change="toggleRecord(p)" />
            <a class="ell" :href="historyHref(p)" :title="`查看「${itemName(p)}」的版本历史`">{{ itemName(p) }}</a>
          </span>
        </template>
      </div>
      <div v-if="draftItems.length" class="vh-draft-f">
        <input v-model="message" class="input" :placeholder="draft && draft.message && draft.message !== UNDESCRIBED ? draft.message : '这次改了什么？（可不写）'" @keydown.enter="record" />
        <button class="btn primary" :disabled="!!busy || !recordPaths.length" :title="recordPaths.length ? `存档：${recordPaths.map(itemName).join('、')}` : ''" @click="record"><Icon name="check" size="sm" />{{ filter ? '存档这一项' : recordPaths.length === draftItems.length ? '记录版本' : `存档 ${recordPaths.length} 项` }}</button>
      </div>
      <div v-if="draftItems.length && (filter ? !recordPaths.length : false)" class="faint vh-draft-note">这一项没有未存档的修改。</div>
      <div v-else-if="draftItems.length && draftOthers" class="faint vh-draft-note">其他 {{ draftOthers }} 项的修改会继续留在草稿里。</div>
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
              <span :class="{ faint: !label(v) }" class="ell">{{ label(v) || (v.draft ? '草稿（未写说明）' : '未写说明') }}</span>
            </span>
            <span class="vh-meta faint"><span class="mono">{{ short(v.id) }}</span> · {{ relTime(v.time) }}</span>
            <span class="vh-tags">
              <span v-for="t in tagsOf(v)" :key="t.path + ':' + t.name" class="badge vh-tag" :title="`${itemName(t.path)} 的标签 ${t.name}`"><Icon name="tag" size="sm" /><span class="ell">{{ tagText(t) }}</span></span>
              <span v-for="d in deployedAt(v.id)" :key="d.target + d.path" class="badge vh-dep" :class="{ earlier: d.earlier, pinned: d.pinned }" :title="(d.pinned ? `${d.label} 中的 ${itemName(d.path)} 固定在这个版本，工作区的新修改不会同步过去。` : '') + (d.earlier ? `${d.label} 中的 ${itemName(d.path)} 是这个版本较早的状态（${short(d.rev)}），之后又有修改` : `${d.label} 中的 ${itemName(d.path)} 是这个版本`)"><Icon v-if="d.pinned" name="pin" size="sm" /><span class="ell">{{ d.label }} · {{ itemName(d.path) }}{{ d.earlier ? '（较早状态）' : '' }}</span></span>
            </span>
            <span class="vh-items faint" :title="v.items.filter(isItemPath).map(itemName).join('、')">{{ v.items.filter(isItemPath).map(itemName).join('、') || '（工作区设置）' }}</span>
          </button>
        </li>
      </ol>
      </div>

      <section v-if="sel" class="card vh-detail">
        <div class="vh-detail-h">
          <div class="vh-title">
            <div v-if="editText !== null" class="vh-edit">
              <input v-model="editText" class="input" placeholder="写点说明（可不写）" @keydown.enter="saveDescription" @keydown.esc="editText = null" />
              <button class="btn sm primary" :disabled="!!busy" @click="saveDescription">保存</button>
              <button class="btn sm" @click="editText = null">取消</button>
            </div>
            <div v-else class="vh-edit">
              <strong>{{ label(sel) || '未写说明' }}</strong>
              <button class="btn sm ghost" :disabled="!!busy" title="修改说明：存档本身和它的编号不变" @click="editText = label(sel)"><Icon name="edit" size="sm" />修改说明</button>
            </div>
            <span class="faint"><span class="mono">{{ short(sel.id) }}</span> · {{ new Date(sel.time).toLocaleString() }}</span>
            <span v-if="tagsOf(sel).length" class="vh-tags">
              <span v-for="t in tagsOf(sel)" :key="t.path + ':' + t.name" class="badge vh-tag"><Icon name="tag" size="sm" /><span class="ell">{{ tagText(t) }}</span><button class="vh-untag" :disabled="!!busy" :title="`删除标签 ${t.name}（存档不受影响）`" @click="untag(t)">×</button></span>
            </span>
          </div>
          <label class="vh-cmp">对比
            <select v-model="compareWith" class="input">
              <option value="">上一个版本</option>
              <option v-for="v in versions.filter((x) => x.id !== sel.id)" :key="v.id" :value="v.id">{{ short(v.id) }} · {{ label(v) || '未写说明' }}</option>
            </select>
          </label>
          <div v-if="filter && (!sel.draft || recordPaths.length)" class="vh-tagbox">
            <input v-model="tagName" class="input" placeholder="标签名，如 v1.0" @keydown.enter="tagName.trim() && tag()" />
            <button class="btn" :disabled="!!busy || !tagName.trim()" :title="sel.draft ? `用上方写的说明存档「${itemName(filter)}」，再给这个存档贴上标签` : `给「${itemName(filter)}」的这个存档贴上名字`" @click="tag"><Icon name="tag" size="sm" />{{ sel.draft ? '存档并打标签' : '打标签' }}</button>
          </div>
          <span v-else-if="!filter" class="faint vh-taghint" title="标签属于某一项：在左上角选择一项后就能给它打标签">打标签请先在左上角选一项</span>
          <div v-if="pushTargets.length" class="vh-pushbox" :title="`把这个版本中的 ${pushPaths.map(itemName).join('、')} 写到所选酒馆，工作区不变；之后${pushPaths.length > 1 ? '这些项' : '它'}在该酒馆固定在此版本，直到改为跟随最新。${filter ? '' : '只包括这个版本存档的、且绑定了该酒馆的项；要推送别的项，请先在左上角切换到那一项。'}`">
            <select v-model="pushTarget" class="input" aria-label="推送到哪个酒馆">
              <option v-for="t in pushTargets" :key="t.id" :value="t.id">{{ app.targetName(t.id) }}</option>
            </select>
            <button class="btn primary" :disabled="!!busy || !pushPaths.length" @click="push()"><Icon name="upload" size="sm" />{{ pushPaths.length > 1 ? `推送 ${pushPaths.length} 项到酒馆` : '推送到酒馆' }}</button>
          </div>
        </div>

        <div v-if="pushed && pushed.rev === sel.id" class="vh-pushed">
          <div v-for="x in pushed.results" :key="x.path" class="vh-pushed-row" :class="x.result">
            <Icon :name="x.result === 'pushed' ? 'check' : 'alert'" size="sm" />
            <strong>{{ itemName(x.path) }}</strong>
            <span>{{ pushedText[x.result] || x.result }}{{ x.result === 'pushed' ? `，${pushed.label} 固定在 ${pushed.name}` : '' }}</span>
            <span v-if="x.result === 'failed'" class="faint">{{ x.error }}</span>
            <span class="grow" />
            <button v-if="x.result === 'failed'" class="btn sm" :disabled="!!busy" @click="push(false, [x.path])">重试</button>
            <template v-if="x.result === 'tavern-changed'">
              <a class="btn sm" :href="hrefOf('sync')">去同步页取回</a>
              <button class="btn sm danger" :disabled="!!busy" @click="push(true, [x.path])">覆盖酒馆的修改</button>
            </template>
          </div>
        </div>

        <div v-if="diff && diff.items && diff.items.length" class="vh-diffbar">
          <span class="grow" />
          <Toggle v-model="fullFile" label="完整文件" title="并排显示两个版本的全部内容；关闭时只显示改动的行" />
        </div>
        <div v-if="diffLoading && !diff" class="faint vh-empty">比较中…</div>
        <div v-else-if="diff && diff.error" class="sync-note err">{{ diff.error }}</div>
        <div v-else-if="diff && !diff.items.length" class="faint vh-empty">与{{ compareWith ? ' ' + versionName(compareWith) + ' ' : '上一个版本' }}相比，资料内容没有变化</div>
        <template v-else-if="diff">
          <div v-for="it in diff.items" :key="it.path" class="vh-ditem">
            <div class="vh-ditem-h">
              <Icon :name="kindOf(it.kind).icon" size="sm" />
              <strong class="ell" :title="itemName(it.path)">{{ itemName(it.path) }}</strong>
              <span class="badge">{{ statusText[it.status] }}</span>
              <span v-if="it.slots.length" class="faint">{{ it.slots.length }} 处</span>
              <span class="grow" />
              <button v-if="!sel.draft && it.status !== 'removed' && app.item(it.path)" class="btn sm" :class="{ danger: armedRestore === it.path }" :disabled="!!busy" :title="`把工作区里的「${itemName(it.path)}」换成「${versionName(sel.id)}」中的内容（不是对比的那个版本）；之后照常同步`" @click="restore(it.path)">
                <Icon name="history" size="sm" />{{ armedRestore === it.path ? '确定恢复？工作区的这项会被替换' : '恢复成所选版本' }}<span class="mono faint">{{ short(sel.id) }}</span>
              </button>
            </div>
            <div v-if="it.error" class="sync-note err">{{ it.error }}</div>
            <LazyMount v-for="s in it.slots" :key="s.slot" class="vh-slot" :min-height="s.eolOnly ? 20 : 90">
              <div class="vh-slot-h">{{ s.label }}<span v-if="s.eolOnly" class="faint">（只有换行符不同，内容相同）</span></div>
              <SlotDiff v-if="!s.eolOnly" :slot-view="slotView(s)" :compact="!fullFile" :sides="{ workspace: '此版本', tavern: compareWith ? versionName(compareWith) : '上一个版本' }" />
            </LazyMount>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>
