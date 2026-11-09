<script setup>
// 「查看差异」 of a binding that shows 本地有修改 / 酒馆有修改 (POST /api/changes): every slot changed since the last
// sync, as the compact line diff 上次同步 -> 工作区 and/or 上次同步 -> 酒馆, with the binding's 同步 / 取回.
// Opened by setting ui.changesAsk from the inspector and the sync matrix.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import SlotDiff from './SlotDiff.vue';
import { api, errorText } from '../api.js';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { runBindingOp, canReach } from '../lib/syncOps.js';
import { uiStatus, displayName } from '../lib/status.js';

const props = defineProps({ path: { type: String, required: true }, target: { type: String, required: true } });
const app = useApp();
const ui = useUi();
const it = computed(() => app.item(props.path));
const binding = computed(() => (it.value ? it.value.bindings.find((/** @type {any} */ b) => b.target === props.target) : null));
const tavern = computed(() => app.targetName(props.target));
const status = computed(() => (binding.value ? uiStatus(binding.value.status) : ''));

/** @type {import('vue').Ref<any>} */
const details = ref(null);
const error = ref('');
const busy = ref('');

const ABSENT = { value: null, present: false };
const SIDE = { workspace: '工作区', tavern: '酒馆' };
/** One diff per side that moved since the last sync; without a base, the tavern against the workspace. */
function views(/** @type {any} */ r) {
  if (r.base.unknown) return [{ key: 'both', view: { ...r, base: ABSENT }, sides: { tavern: '酒馆', workspace: '工作区' } }];
  return r.changed.map((/** @type {'workspace'|'tavern'} */ s) => ({ key: s, view: { ...r, workspace: r[s], tavern: r.base, base: ABSENT }, sides: { tavern: '上次同步', workspace: SIDE[s] } }));
}
const rows = computed(() => (details.value ? details.value.slots.map((/** @type {any} */ r) => ({ ...r, views: views(r) })) : []));

async function load() {
  error.value = '';
  try { details.value = await api.changes(props.path, props.target); } catch (e) { error.value = errorText(e); }
}

function close() { if (!busy.value) ui.changesAsk = null; }
async function run(/** @type {'sync'|'pull'} */ op) {
  if (!binding.value) return;
  busy.value = op;
  try {
    const r = await runBindingOp(app, ui, props.path, binding.value, op);
    if (r !== 'error') ui.changesAsk = null;
  } finally { busy.value = ''; }
}
const reachable = computed(() => !!binding.value && canReach(app.modeOf(binding.value)));

const onKey = (/** @type {KeyboardEvent} */ ev) => { if (ev.key === 'Escape') close(); };
onMounted(() => { document.addEventListener('keydown', onKey); load(); });
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div class="drawer-scrim qo-scrim" @click="close" />
    <div class="dlg dlg-wide chg" role="dialog" aria-modal="true" aria-labelledby="chg-dlg-title">
      <h3 id="chg-dlg-title"><Icon name="sync" />「{{ it ? displayName(it) : path }}」与 {{ tavern }} 的差异</h3>
      <p class="faint">
        <template v-if="status === 'local'">工作区在上次同步后改了下面这些地方；「同步」会把它们写入 {{ tavern }}。</template>
        <template v-else-if="status === 'remote'">{{ tavern }} 在上次同步后改了下面这些地方；「取回」会把它们带进工作区。</template>
        <template v-else>上次同步之后两边改动的地方。</template>
      </p>
      <div class="chg-list">
        <div v-if="error" class="banner conflict"><Icon name="alert" /><div class="grow">{{ error }}</div><button class="btn sm" @click="load()"><Icon name="refresh" size="sm" />重试</button></div>
        <div v-else-if="!details" class="faint chg-empty"><Icon name="spin" size="sm" />正在比较…</div>
        <div v-else-if="!rows.length" class="faint chg-empty">没有内容上的差异（可能只是保存格式不同），同步或取回后即一致。</div>
        <div v-for="r in rows" :key="r.slot" class="chg-slot">
          <div class="vh-slot-h">{{ r.label }}<span class="mono faint">{{ r.slot }}</span><span v-if="r.eolOnly" class="faint">（只有换行符不同，内容相同）</span></div>
          <template v-if="!r.eolOnly"><SlotDiff v-for="v in r.views" :key="v.key" :slot-view="v.view" :sides="v.sides" compact /></template>
        </div>
      </div>
      <div class="dlg-btns">
        <span class="grow" />
        <button class="btn sm" type="button" :disabled="!!busy" @click="close">关闭</button>
        <button class="btn sm" :class="{ primary: status === 'remote' }" :disabled="!!busy || !reachable" title="从酒馆取回，覆盖工作区" @click="run('pull')">
          <Icon :name="busy === 'pull' ? 'spin' : 'download'" size="sm" />取回
        </button>
        <button v-if="binding && !binding.pinned" class="btn sm" :class="{ primary: status === 'local' }" :disabled="!!busy || !reachable" title="把工作区写入酒馆" @click="run('sync')">
          <Icon :name="busy === 'sync' ? 'spin' : 'upload'" size="sm" />同步
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style>
.dlg.dlg-wide { top: 6vh; width: 920px; max-height: 88vh; }
.chg-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--sp-3); }
.chg-empty { display: flex; align-items: center; gap: 6px; padding: var(--sp-3) 0; font-size: var(--fs-sm); }
.chg-slot .vh-slot-h { display: flex; gap: 8px; align-items: baseline; }
.chg-slot .vh-slot-h .mono { font-size: 11px; }
</style>
