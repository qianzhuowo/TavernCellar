<script setup>
// An unbound item: publish it to a tavern (POST /api/publish), or bind it to an item the tavern already has
// (POST /api/bind). A name the tavern already has is never overwritten: the companion answers `conflict` with the
// existing item, and this panel offers to bind to it — bind compares both sides and lets the user pick one.
import { computed, ref, watch, nextTick } from 'vue';
import Icon from './Icon.vue';
import SearchSelect from './SearchSelect.vue';
import { kindOf } from '../lib/kinds.js';
import { displayName } from '../lib/status.js';
import { warningText } from '../lib/warnings.js';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { api, errorText } from '../api.js';

const props = defineProps({ path: { type: String, required: true } });
const app = useApp();
const ui = useUi();
const item = computed(() => app.item(props.path));

/** Taverns that can create items: live ones with a new enough Cellar Link, and offline data folders. */
const pubTargets = computed(() => app.targets.filter((t) => (t.live && t.create >= 1) || (!t.live && t.offline)));
const name = ref('');
const busy = ref('');
const nameInput = ref(/** @type {HTMLInputElement|null} */ (null));
/** The card's linked lorebook, when it is an unbound workspace item that can go along. */
const world = computed(() => {
  const w = item.value && item.value.kind === 'character' ? item.value.world : null;
  const book = w && w.path ? app.item(w.path) : null;
  return book && !book.bindings.length ? { name: w.name, path: w.path } : null;
});
const withWorld = ref(true);

/**
 * A tavern item with the name this item (or its lorebook) would get: `path` is the workspace item to bind to it.
 * @type {import('vue').Ref<{target: string, kind: string, id: string, path: string} | null>}
 */
const clash = ref(null);

watch(() => props.path, () => {
  name.value = item.value ? displayName(item.value) : '';
  clash.value = null;
  picking.value = '';
}, { immediate: true });

async function publish(/** @type {any} */ t) {
  busy.value = t.id;
  clash.value = null;
  try {
    const r = await api.publish(props.path, t.id, name.value.trim(), !!world.value && withWorld.value);
    const failed = (r.warnings || []).find((/** @type {any} */ w) => w.code === 'world-publish-failed');
    if (failed && failed.existing) {
      clash.value = { target: t.id, kind: 'lorebook', id: failed.existing, path: failed.path };
      ui.toast('已发布到 ' + app.targetName(t.id) + '；' + warningText(failed), 'alert');
    } else {
      ui.toast('已发布到 ' + app.targetName(t.id) + (r.world && r.world.published ? '（连同世界书「' + r.world.name + '」）' : ''));
    }
    app.refreshStatus();
  } catch (e) {
    const d = /** @type {any} */ (e).details;
    if (/** @type {any} */ (e).code === 'conflict' && d && d.id) clash.value = { target: t.id, kind: d.kind || item.value.kind, id: d.id, path: props.path };
    else ui.toast(errorText(e), 'alert');
  } finally { busy.value = ''; }
}

/** Binds a workspace item to an existing tavern item; differing content becomes a whole-item conflict to resolve. */
async function bind(/** @type {string} */ path, /** @type {string} */ target, /** @type {string} */ id) {
  busy.value = 'bind';
  try {
    const r = await api.bind(path, target, id);
    await app.refreshStatus();
    clash.value = null;
    picking.value = '';
    if (r.result === 'conflict') {
      ui.toast('已绑定到「' + id + '」；两边内容不同，请选择保留哪一边', 'alert');
      ui.openConflict(path);
    } else {
      ui.toast('已绑定到 ' + app.targetName(target) + ' 的「' + id + '」，两边内容一致');
    }
  } catch (e) {
    ui.toast(errorText(e), 'alert');
  } finally { busy.value = ''; }
}

async function rename() {
  clash.value = null;
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
}

// ---- bind to an item the tavern already has (any name) ----
const picking = ref('');
const choices = ref(/** @type {{value: string, label: string}[]} */ ([]));
const loading = ref(false);
async function startPick(/** @type {string} */ target) {
  picking.value = target;
  choices.value = [];
  loading.value = true;
  try {
    const r = await api.catalog({ target, kind: item.value.kind, limit: 5000 });
    choices.value = r.items.filter((/** @type {any} */ x) => !x.checkedOut).map((/** @type {any} */ x) => ({ value: x.id, label: x.name && x.name !== x.id ? x.name + ' · ' + x.id : x.id }));
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    picking.value = '';
  } finally { loading.value = false; }
}
const kindLabel = (/** @type {string} */ k) => kindOf(k).type;
</script>

<template>
  <div v-if="item" class="publish">
    <div v-if="item.kind === 'regex'" class="faint pub-tip">全局正则在每个酒馆里都有一份，把这一项绑定到它即可。</div>
    <template v-else-if="pubTargets.length">
      <div class="faint pub-tip">在酒馆里新建这一项并绑定，之后照常同步。</div>
      <input ref="nameInput" v-model="name" class="input" :placeholder="'在酒馆中的名称'" aria-label="在酒馆中的名称" />
      <label v-if="world" class="pub-check"><input v-model="withWorld" type="checkbox" />连同链接的世界书「{{ world.name }}」一起发布</label>
      <button v-for="t in pubTargets" :key="t.id" class="btn sm primary" :disabled="!!busy || !name.trim()" @click="publish(t)">
        <Icon :name="busy === t.id ? 'spin' : 'upload'" size="sm" />{{ busy === t.id ? '发布中…' : '发布到 ' + app.targetName(t.id) + (t.live ? '' : '（离线）') }}
      </button>
    </template>
    <div v-else class="faint pub-tip">连接 ST/TT，或在设置中填写酒馆数据目录后，可以把它发布到酒馆。</div>

    <div v-if="clash" class="sync-note warn pub-clash" role="alert">
      <div class="grow">
        {{ app.targetName(clash.target) }} 里已有同名的{{ kindLabel(clash.kind) }}「{{ clash.id }}」，不会覆盖它。
        可以把{{ clash.path === path ? '这一项' : '工作区的世界书' }}绑定到它：两边内容不同时，进入冲突页选择保留哪一边。
      </div>
      <div class="pub-clash-btns">
        <button class="btn sm primary" :disabled="!!busy" @click="bind(clash.path, clash.target, clash.id)"><Icon :name="busy === 'bind' ? 'spin' : 'link'" size="sm" />绑定到它</button>
        <button v-if="clash.path === path" class="btn sm" :disabled="!!busy" @click="rename">换个名字</button>
        <button class="btn sm ghost" @click="clash = null">关闭</button>
      </div>
    </div>

    <template v-for="t in app.targets.filter((x) => x.live || x.offline)" :key="'bind-' + t.id">
      <a v-if="picking !== t.id" href="#" class="pub-bind faint" @click.prevent="startPick(t.id)">绑定到 {{ app.targetName(t.id) }} 里已有的{{ kindLabel(item.kind) }}…</a>
      <div v-else class="pub-pick">
        <SearchSelect
          :model-value="''"
          :options="choices"
          :disabled="loading || !!busy"
          :placeholder="loading ? '正在读取…' : '选择' + kindLabel(item.kind)"
          :empty-text="loading ? '正在读取…' : '没有未绑定的' + kindLabel(item.kind)"
          :aria-label="'选择要绑定的' + kindLabel(item.kind)"
          @update:model-value="(id) => bind(path, t.id, id)"
        />
        <button class="btn sm ghost" @click="picking = ''">取消</button>
      </div>
    </template>
  </div>
</template>
