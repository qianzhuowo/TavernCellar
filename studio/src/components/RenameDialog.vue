<script setup>
// 「改名…」: renames a bound character / lorebook in its taverns (POST /api/rename); a folder named after the old
// name follows, and a card's lorebook with the same name can go along. Opened by setting ui.renameAsk.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { renameItem } from '../lib/syncOps.js';
import { displayName } from '../lib/status.js';
import { kindOf } from '../lib/kinds.js';

const props = defineProps({ path: { type: String, required: true } });
const app = useApp();
const ui = useUi();
const it = computed(() => app.item(props.path));
const current = computed(() => (it.value ? displayName(it.value) : ''));
const name = ref(current.value);
/** The card's linked lorebook, when it is a workspace item. */
const world = computed(() => (it.value && it.value.kind === 'character' && it.value.world && it.value.world.path ? it.value.world : null));
const withWorld = ref(true);
const busy = ref(false);
/** @type {import('vue').Ref<HTMLInputElement|null>} */
const input = ref(null);

function close() { if (!busy.value) ui.renameAsk = ''; }
async function run() {
  const next = name.value.trim();
  if (!next || next === current.value) return;
  busy.value = true;
  try { if (await renameItem(app, ui, props.path, next, !!world.value && withWorld.value)) ui.renameAsk = ''; } finally { busy.value = false; }
}
const onKey = (/** @type {KeyboardEvent} */ ev) => { if (ev.key === 'Escape') close(); };
onMounted(() => { document.addEventListener('keydown', onKey); if (input.value) { input.value.focus(); input.value.select(); } });
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div class="drawer-scrim qo-scrim" @click="close" />
    <form class="dlg" role="dialog" aria-modal="true" aria-labelledby="rn-dlg-title" @submit.prevent="run">
      <h3 id="rn-dlg-title"><Icon name="edit" />给{{ it ? kindOf(it.kind).type : '' }}「{{ current }}」改名</h3>
      <p class="faint">
        在绑定的每个酒馆里改名（和在酒馆里改名一样{{ it && it.kind === 'character' ? '，聊天记录跟着角色走，旧聊天里的名字不变' : '' }}）。以旧名称命名的文件夹一并改名，同步状态和版本历史跟着走。
      </p>
      <input ref="input" v-model="name" class="input" placeholder="新名称" aria-label="新名称" />
      <label v-if="world" class="pub-check">
        <input v-model="withWorld" type="checkbox" />世界书同名时一起改名
        <span class="faint">（链接的世界书「{{ world.name }}」{{ world.name === current ? '' : '与角色卡不同名，不会改名' }}）</span>
      </label>
      <div class="dlg-btns">
        <span class="grow" />
        <button class="btn sm" type="button" :disabled="busy" @click="close">取消</button>
        <button class="btn sm primary" type="submit" :disabled="busy || !name.trim() || name.trim() === current"><Icon :name="busy ? 'spin' : 'check'" size="sm" />改名</button>
      </div>
    </form>
  </Teleport>
</template>
