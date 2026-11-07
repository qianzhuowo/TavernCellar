<script setup>
// 复制 / 删除 buttons of one prompt row (preset editor list, 预设工坊 target list). Delete asks for a second click.
import { ref } from 'vue';
import Icon from './Icon.vue';
import { copyBlock, deleteBlock } from '../lib/presetPrompts.js';

defineProps({ prompt: { type: Object, required: true } });
const emit = defineEmits(['copy', 'remove']);
const armed = ref(false);
function remove() {
  if (!armed.value) { armed.value = true; return; }
  armed.value = false;
  emit('remove');
}
</script>

<template>
  <span class="pra" @click.stop @dblclick.stop>
    <button class="icon-btn pra-btn" type="button" :disabled="!!copyBlock(prompt)" :title="copyBlock(prompt) || '复制到下方'" @click="emit('copy')"><Icon name="copy" size="sm" /></button>
    <button
      class="icon-btn pra-btn"
      type="button"
      :class="{ danger: armed }"
      :disabled="!!deleteBlock(prompt)"
      :title="deleteBlock(prompt) || (armed ? '再点一次删除' : '删除')"
      @click="remove"
      @blur="armed = false"
    ><Icon :name="armed ? 'alert' : 'trash'" size="sm" /></button>
  </span>
</template>

<style scoped>
.pra { display: inline-flex; align-items: center; gap: 0; flex: none; }
.pra-btn { width: 24px; height: 24px; }
.pra-btn.danger { color: var(--st-conflict); }
</style>
