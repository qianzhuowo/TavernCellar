<script setup>
// 「从工作区移除」confirmation, the one entry for both the inspector button and the workspace tree's context menu
// (opened by setting ui.removeAsk; the current page stays where it is).
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { removeItem } from '../lib/syncOps.js';
import { displayName } from '../lib/status.js';

const props = defineProps({ path: { type: String, required: true } });
const app = useApp();
const ui = useUi();
const keepFiles = ref(false);
const busy = ref(false);
const name = computed(() => { const it = app.item(props.path); return it ? displayName(it) : props.path; });
/** @type {import('vue').Ref<HTMLButtonElement|null>} */
const cancelBtn = ref(null);

function close() { if (!busy.value) ui.removeAsk = ''; }
async function confirm() {
  busy.value = true;
  try { if (await removeItem(app, ui, props.path, keepFiles.value)) ui.removeAsk = ''; } finally { busy.value = false; }
}
const onKey = (/** @type {KeyboardEvent} */ ev) => { if (ev.key === 'Escape') close(); };
onMounted(() => { document.addEventListener('keydown', onKey); if (cancelBtn.value) cancelBtn.value.focus(); });
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div class="drawer-scrim qo-scrim" @click="close" />
    <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="rm-dlg-title">
      <h3 id="rm-dlg-title"><Icon name="trash" />从工作区移除「{{ name }}」？</h3>
      <p class="faint">只从工作区移除：酒馆里的内容不受影响，之前的版本仍在版本历史中。文件夹里你自己的笔记会保留。</p>
      <label class="insp-check"><input v-model="keepFiles" type="checkbox" />保留文件夹里的全部文件</label>
      <div class="dlg-btns">
        <button ref="cancelBtn" class="btn sm" :disabled="busy" @click="close">取消</button>
        <button class="btn sm danger" :disabled="busy" @click="confirm"><Icon :name="busy ? 'spin' : 'trash'" size="sm" />确认移除</button>
      </div>
    </div>
  </Teleport>
</template>
