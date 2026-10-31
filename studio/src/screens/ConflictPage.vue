<script setup>
// S4: field-level conflict resolution (docs/studio-design.md §4.5).
// Every conflicting slot starts unchosen; "应用并同步" writes the choices to the workspace, takes the reviewed
// tavern version as the new base and syncs (the companion re-checks the tavern and merges newer edits).
import { ref, reactive, computed, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import Seg from '../components/Seg.vue';
import Toggle from '../components/Toggle.vue';
import SlotDiff from '../components/SlotDiff.vue';
import { api, errorText } from '../api.js';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { uiStatus, isConflict, itemName } from '../lib/status.js';
import { kindOf } from '../lib/slot-view.js';
import { isEntrySlot } from '../lib/entryNoise.js';

const app = useApp();
const ui = useUi();
const path = computed(() => ui.route.arg);
const item = computed(() => app.item(path.value));
const name = computed(() => itemName(path.value));
const conflictTargets = computed(() => (item.value ? item.value.bindings.filter((b) => isConflict(uiStatus(b.status))).map((b) => b.target) : []));

const target = ref('');
/** @type {import('vue').Ref<any>} */
const details = ref(null);
const loading = ref(false);
const applying = ref(false);
const error = ref('');
const showBase = ref(false);
/** Lorebook entry template of this item (defaults ST fills in); folds normalisation noise in entry diffs. */
const entryTemplate = ref(/** @type {any} */ (null));
/** @type {Record<string, 'workspace'|'tavern'|'merge'>} */
const choices = reactive({});
/** @type {Record<string, string>} */
const merged = reactive({});

const rows = computed(() => (details.value ? details.value.slots.map((/** @type {any} */ s) => ({ ...s, kind: s.slot === '*' ? 'whole' : kindOf(s) })) : []));
const chosenCount = computed(() => rows.value.filter((/** @type {any} */ r) => choices[r.slot]).length);
const count = (/** @type {string} */ v) => rows.value.filter((/** @type {any} */ r) => choices[r.slot] === v).length;
const targetLabel = computed(() => (target.value ? app.targetName(target.value) : ''));
const CHOSEN_CLASS = { workspace: 'chosen-ws', tavern: 'chosen-tv', merge: 'chosen-merge' };

function options(/** @type {any} */ r) {
  if (r.slot === '*') return [{ value: 'workspace', label: '整项用工作区' }, { value: 'tavern', label: '整项用酒馆' }];
  return [
    { value: 'workspace', label: r.workspace.present ? '用工作区' : '删除（同工作区）' },
    { value: 'tavern', label: r.tavern.present ? '用酒馆' : '删除（同酒馆）' },
    { value: 'merge', label: '手动合并' }
  ];
}

function choose(/** @type {any} */ r, /** @type {'workspace'|'tavern'|'merge'} */ v) {
  choices[r.slot] = v;
  if (v === 'merge' && merged[r.slot] === undefined) {
    const src = r.workspace.present ? r.workspace.value : r.tavern.value;
    merged[r.slot] = r.kind === 'text' ? src : JSON.stringify(src, null, 2);
  }
}

function chooseAll(/** @type {'workspace'|'tavern'} */ v) { for (const r of rows.value) choices[r.slot] = v; }

async function load() {
  if (!target.value || !conflictTargets.value.includes(target.value)) target.value = conflictTargets.value[0] || '';
  for (const k of Object.keys(choices)) delete choices[k];
  for (const k of Object.keys(merged)) delete merged[k];
  if (!target.value) { details.value = null; return; }
  loading.value = true;
  error.value = '';
  try {
    let d = await api.conflict(path.value, target.value);
    if (!d.slots.length) {
      // Both sides changed but nothing recorded yet (e.g. tavern offline): pulling merges and records the slots.
      try { await api.pull(path.value, target.value); } catch (e) { if (!e || /** @type {any} */ (e).code !== 'conflict') throw e; }
      await app.refreshStatus();
      d = await api.conflict(path.value, target.value);
      if (!d.slots.length) ui.toast('两边的修改已自动合并，没有需要处理的冲突');
    }
    details.value = d;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}

async function apply() {
  /** @type {Record<string, any>} */
  const payload = {};
  for (const r of rows.value) {
    const c = choices[r.slot];
    if (c !== 'merge') { payload[r.slot] = c; continue; }
    if (r.kind === 'text') { payload[r.slot] = { value: merged[r.slot] }; continue; }
    try { payload[r.slot] = { value: JSON.parse(merged[r.slot]) }; } catch (e) {
      ui.toast(`「${r.label}」的合并结果不是有效的 JSON`, 'alert');
      return;
    }
  }
  applying.value = true;
  try {
    const res = await api.resolveConflict(path.value, target.value, payload);
    ui.toast(res.pending ? '已写入工作区；酒馆可写入时再同步'
      : res.result === 'up-to-date' ? '冲突已解决，工作区与酒馆一致'
        : '已写入工作区并同步到 ' + targetLabel.value);
    await app.refreshStatus();
    ui.closeTab('conflict:' + path.value);
    ui.openItem(path.value);
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    await app.refreshStatus();
    if (/** @type {any} */ (e).code === 'conflict') await load(); // the tavern changed the same place again
  } finally {
    applying.value = false;
  }
}

function switchTarget(/** @type {string} */ t) { target.value = t; load(); }

const since = computed(() => {
  if (!details.value || !details.value.at) return '';
  const d = new Date(details.value.at);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
});

onMounted(load);
</script>

<template>
  <div v-if="!item" class="page">
    <div class="empty">
      <Icon name="alert" />
      <h3>工作区里找不到这个资料项</h3>
      <p class="muted mono">{{ path }}</p>
      <a class="btn" href="#/library">去资料库</a>
    </div>
  </div>

  <div v-else class="page cf">
    <div class="page-head">
      <div>
        <div class="crumb faint"><a href="#" @click.prevent="ui.openItem(path)"><Icon name="back" size="sm" />返回 {{ name }}</a></div>
        <h2><Icon name="alert" />处理冲突 · {{ name }}</h2>
        <p class="muted">
          工作区和「{{ targetLabel || '酒馆' }}」在上次同步后都修改了下列位置。逐项选择保留哪一边；应用后写入工作区，并以你看到的酒馆版本为基准写回酒馆。<template v-if="since">发现于 {{ since }}。</template>
        </p>
      </div>
      <div class="page-actions">
        <Toggle v-model="showBase" label="显示基准版本" />
      </div>
    </div>

    <div v-if="conflictTargets.length > 1" class="cf-targets">
      <span class="faint">酒馆</span>
      <Seg :model-value="target" :options="conflictTargets.map((t) => ({ value: t, label: app.targetName(t) }))" @update:model-value="switchTarget" />
    </div>

    <div v-if="loading" class="empty"><Icon name="spin" /><p class="muted">正在读取冲突…</p></div>
    <div v-else-if="error" class="banner conflict">
      <Icon name="alert" /><div class="grow">{{ error }}</div>
      <button class="btn sm" @click="load()"><Icon name="refresh" size="sm" />重试</button>
    </div>
    <div v-else-if="!rows.length" class="empty">
      <Icon name="ok" />
      <h3>没有待处理的冲突</h3>
      <button class="btn" @click="ui.openItem(path)"><Icon name="back" size="sm" />返回 {{ name }}</button>
    </div>

    <template v-else>
      <div class="cf-summary">
        <div class="cf-prog">
          <div><b>{{ chosenCount }}</b> / {{ rows.length }} 项已选定</div>
          <div class="bar"><span :style="{ width: (chosenCount / rows.length) * 100 + '%' }" /></div>
        </div>
        <div class="cf-counts">
          <span><Icon name="folder" size="sm" />用工作区 {{ count('workspace') }}</span>
          <span><Icon name="wine" size="sm" />用酒馆 {{ count('tavern') }}</span>
          <span><Icon name="code" size="sm" />手动合并 {{ count('merge') }}</span>
        </div>
        <span style="flex: 1" />
        <button class="btn sm ghost" :disabled="applying" @click="chooseAll('workspace')">全部用工作区</button>
        <button class="btn sm ghost" :disabled="applying" @click="chooseAll('tavern')">全部用酒馆</button>
        <button class="btn primary" :disabled="applying || chosenCount < rows.length" :title="chosenCount < rows.length ? '还有未选定的项' : ''" @click="apply()">
          <Icon :name="applying ? 'spin' : 'sync'" size="sm" />应用并同步
        </button>
      </div>

      <div class="cf-list">
        <div v-for="r in rows" :key="r.slot" class="cf-field" :class="choices[r.slot] ? CHOSEN_CLASS[choices[r.slot]] : ''">
          <div class="cf-head">
            <div class="cf-label">
              <Icon v-if="choices[r.slot]" name="check" size="sm" /><span v-else class="pending-dot" />
              <b>{{ r.label }}</b><span v-if="r.slot !== '*'" class="mono faint">{{ r.slot }}</span>
            </div>
            <Seg class="choice" :model-value="choices[r.slot] || null" :options="options(r)" :disabled="applying" @update:model-value="(v) => choose(r, v)" />
          </div>

          <template v-if="r.kind === 'whole'">
            <div class="cf-note faint">
              <Icon name="info" size="sm" />这一项在启用按字段合并之前同步过，没有可比对的基准，只能整项选择一边。下面列出两边不同的 {{ r.differences.length }} 处；之后的冲突会按字段列出。
            </div>
            <div v-for="d in r.differences" :key="d.slot" class="cf-diff">
              <div class="cf-diff-h"><b>{{ d.label }}</b><span class="mono faint">{{ d.slot }}</span></div>
              <SlotDiff :slot-view="d" :target-label="targetLabel" :fold-noise="isEntrySlot(d.slot)" :noise-template="entryTemplate" />
            </div>
            <div v-if="!r.differences.length" class="cf-note faint">两边内容相同，任选一边即可。</div>
          </template>
          <SlotDiff v-else :slot-view="r" :show-base="showBase" :target-label="targetLabel" :fold-noise="isEntrySlot(r.slot)" :noise-template="entryTemplate" />

          <div v-if="choices[r.slot] === 'merge'" class="cf-merge">
            <div class="cf-side-h"><Icon name="code" size="sm" />合并结果（可编辑{{ r.kind === 'text' ? '' : '，JSON' }}）</div>
            <textarea v-model="merged[r.slot]" class="textarea" :class="{ mono: r.kind !== 'text' }" :rows="Math.min(16, Math.max(3, (merged[r.slot] || '').split('\n').length + 1))" spellcheck="false" />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
