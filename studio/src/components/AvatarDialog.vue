<script setup>
// 「更换头像…」: picks an image, shows its centre square (no interactive cropper), and replaces the card's avatar in
// every bound tavern (POST /api/avatar). The image is converted to a PNG here, so every tavern path receives PNG.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { setAvatar } from '../lib/syncOps.js';
import { displayName } from '../lib/status.js';

const props = defineProps({ path: { type: String, required: true } });
const emit = defineEmits(['close']);
const app = useApp();
const ui = useUi();
const it = computed(() => app.item(props.path));
/** Side of the square PNG sent to the taverns. */
const SIZE = 512;

/** @type {import('vue').Ref<HTMLInputElement|null>} */
const input = ref(null);
const preview = ref('');
const error = ref('');
const busy = ref(false);

/** Centre square of the picked image, scaled down to at most SIZE px, as a PNG data URL. */
async function squarePng(/** @type {File} */ file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(SIZE, side);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

async function picked() {
  const file = input.value && input.value.files && input.value.files[0];
  if (!file) return;
  error.value = '';
  try {
    preview.value = await squarePng(file);
  } catch {
    preview.value = '';
    error.value = '无法读取这张图片；请选择 PNG、JPEG 或 WebP 图片';
  }
}

function close() { if (!busy.value) emit('close'); }
async function run() {
  if (!preview.value || !it.value) return;
  busy.value = true;
  try { if (await setAvatar(app, ui, it.value, preview.value.slice(preview.value.indexOf(',') + 1))) emit('close'); } finally { busy.value = false; }
}
const onKey = (/** @type {KeyboardEvent} */ ev) => { if (ev.key === 'Escape') close(); };
onMounted(() => { document.addEventListener('keydown', onKey); if (input.value) input.value.click(); });
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div class="drawer-scrim qo-scrim" @click="close" />
    <form class="dlg" role="dialog" aria-modal="true" aria-labelledby="av-dlg-title" @submit.prevent="run">
      <h3 id="av-dlg-title"><Icon name="user" />更换「{{ it ? displayName(it) : '' }}」的头像</h3>
      <p class="faint">在绑定的每个酒馆里换成这张图片（取中间的正方形，最大 {{ SIZE }}px）。只换图片，卡片内容和同步状态不变。</p>
      <input ref="input" class="av-file" type="file" accept="image/png,image/jpeg,image/webp" @change="picked" />
      <div class="av-preview">
        <img v-if="preview" :src="preview" alt="新头像预览" />
        <button v-else class="btn sm" type="button" @click="input && input.click()"><Icon name="file" size="sm" />选择图片…</button>
      </div>
      <p v-if="error" class="av-error">{{ error }}</p>
      <div class="dlg-btns">
        <button v-if="preview" class="btn sm" type="button" :disabled="busy" @click="input && input.click()">换一张…</button>
        <span class="grow" />
        <button class="btn sm" type="button" :disabled="busy" @click="close">取消</button>
        <button class="btn sm primary" type="submit" :disabled="busy || !preview"><Icon :name="busy ? 'spin' : 'check'" size="sm" />更换头像</button>
      </div>
    </form>
  </Teleport>
</template>

<style scoped>
.av-file { display: none; }
.av-preview { display: flex; align-items: center; justify-content: center; min-height: 160px; }
.av-preview img { width: 160px; height: 160px; border-radius: 14px; object-fit: cover; box-shadow: var(--shadow-2); }
.av-error { color: var(--st-conflict, #d55); margin: 0; }
</style>
