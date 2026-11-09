<script setup>
// 「移到项目…」: moves a workspace item into a project folder, or back to its kind's default folder (POST /api/move).
// One entry for the inspector and the workspace tree's context menu (opened by setting ui.moveAsk).
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { moveItem } from '../lib/syncOps.js';
import { displayName } from '../lib/status.js';
import { projectOf, projectFolders } from '../lib/kinds.js';

const props = defineProps({ path: { type: String, required: true } });
const app = useApp();
const ui = useUi();
const it = computed(() => app.item(props.path));
const name = computed(() => (it.value ? displayName(it.value) : props.path));
const current = computed(() => projectOf(it.value));
const folders = computed(() => projectFolders(app.items).filter((f) => f !== current.value));
const folder = ref('');
const busy = ref(false);
/** @type {import('vue').Ref<HTMLInputElement|null>} */
const input = ref(null);

function close() { if (!busy.value) ui.moveAsk = ''; }
async function run(/** @type {string} */ to) {
  busy.value = true;
  try { if (await moveItem(app, ui, props.path, to)) ui.moveAsk = ''; } finally { busy.value = false; }
}
const onKey = (/** @type {KeyboardEvent} */ ev) => { if (ev.key === 'Escape') close(); };
onMounted(() => { document.addEventListener('keydown', onKey); if (input.value) input.value.focus(); });
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div class="drawer-scrim qo-scrim" @click="close" />
    <form class="dlg" role="dialog" aria-modal="true" aria-labelledby="mv-dlg-title" @submit.prevent="folder.trim() && run(folder.trim())">
      <h3 id="mv-dlg-title"><Icon name="folderOpen" />把「{{ name }}」移到项目文件夹</h3>
      <p class="faint">现在在 <span class="mono">{{ path }}/</span>。整个文件夹（连同你自己的笔记）一起移动，同步状态和版本历史跟着它走，酒馆不受影响。</p>
      <input ref="input" v-model="folder" class="input" list="mv-dlg-folders" placeholder="项目文件夹名，如 诡异复苏" aria-label="项目文件夹" />
      <datalist id="mv-dlg-folders"><option v-for="f in folders" :key="f" :value="f" /></datalist>
      <div class="dlg-btns">
        <button v-if="current" class="btn sm" type="button" :disabled="busy" title="移回这类资料项的默认文件夹（characters、lorebooks …）" @click="run('')">移回默认文件夹</button>
        <span class="grow" />
        <button class="btn sm" type="button" :disabled="busy" @click="close">取消</button>
        <button class="btn sm primary" type="submit" :disabled="busy || !folder.trim()"><Icon :name="busy ? 'spin' : 'check'" size="sm" />移动</button>
      </div>
    </form>
  </Teleport>
</template>
