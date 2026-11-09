<script setup>
// 「导入文件夹…」: copies Cellar-format item folders from anywhere on disk into the workspace (POST /api/import).
// Opened by setting ui.importAsk (workspace「+」menu, 工作区 home page).
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { api, errorText } from '../api.js';
import { desktop, baseName } from '../lib/desktop.js';
import { projectFolders } from '../lib/kinds.js';

const app = useApp();
const ui = useUi();
const source = ref('');
const folder = ref('');
const busy = ref(false);
/** @type {import('vue').Ref<{source: string, path?: string, error?: string}[] | null>} */
const result = ref(null);
const folders = computed(() => projectFolders(app.items));
/** @type {import('vue').Ref<HTMLInputElement|null>} */
const input = ref(null);

function close() { if (!busy.value) ui.importAsk = false; }
async function browse() {
  const p = await desktop.pickDirectory();
  if (p) source.value = p;
}
async function run() {
  if (!source.value.trim() || busy.value) return;
  busy.value = true;
  try {
    const r = /** @type {any} */ (await api.importItems(source.value.trim(), folder.value.trim()));
    await app.refreshStatus();
    const done = r.items.filter((/** @type {any} */ x) => x.path);
    if (done.length === r.items.length) {
      ui.importAsk = false;
      if (done.length === 1) ui.openItem(done[0].path);
      ui.toast('已导入 ' + done.length + ' 项到「' + r.folder + '」，可在检查栏发布到酒馆');
    } else {
      result.value = r.items;
    }
  } catch (e) {
    ui.toast(errorText(e), 'alert');
  } finally { busy.value = false; }
}
const onKey = (/** @type {KeyboardEvent} */ ev) => { if (ev.key === 'Escape') close(); };
onMounted(() => { document.addEventListener('keydown', onKey); if (input.value) input.value.focus(); });
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div class="drawer-scrim qo-scrim" @click="close" />
    <form class="dlg" role="dialog" aria-modal="true" aria-labelledby="im-dlg-title" @submit.prevent="run">
      <h3 id="im-dlg-title"><Icon name="download" />导入文件夹</h3>
      <p class="faint">把 Cellar 格式的资料项文件夹（含 cellar-item.json），或装着这些文件夹的文件夹，复制进工作区。原文件夹不动；导入的项还没有绑定酒馆，可在检查栏发布。</p>
      <label class="dlg-field">源文件夹
        <span class="dlg-row">
          <input ref="input" v-model="source" class="input mono" placeholder="源文件夹的完整路径" aria-label="源文件夹" />
          <button v-if="desktop.available" class="btn sm" type="button" :disabled="busy" @click="browse"><Icon name="folderOpen" size="sm" />浏览…</button>
        </span>
      </label>
      <label class="dlg-field">放进项目文件夹
        <input v-model="folder" class="input" list="im-dlg-folders" :placeholder="'默认：' + (source.trim() ? baseName(source.trim()) : '源文件夹名')" aria-label="项目文件夹" />
        <datalist id="im-dlg-folders"><option v-for="f in folders" :key="f" :value="f" /></datalist>
      </label>
      <ul v-if="result" class="dlg-result">
        <li v-for="x in result" :key="x.source" :class="{ err: x.error }">{{ baseName(x.source) }}：{{ x.error ? '未导入，' + x.error : '已导入为 ' + x.path }}</li>
      </ul>
      <div class="dlg-btns">
        <button class="btn sm" type="button" :disabled="busy" @click="close">{{ result ? '关闭' : '取消' }}</button>
        <button v-if="!result" class="btn sm primary" type="submit" :disabled="busy || !source.trim()"><Icon :name="busy ? 'spin' : 'download'" size="sm" />导入</button>
      </div>
    </form>
  </Teleport>
</template>
