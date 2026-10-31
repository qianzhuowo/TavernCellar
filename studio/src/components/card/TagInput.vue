<script setup>
// Chip input for embedded tags: Enter / comma adds, Backspace on an empty input removes the last chip.
import { ref } from 'vue';
import Icon from '../Icon.vue';

const props = defineProps({ tags: { type: Array, default: () => [] } });
const emit = defineEmits(['update']);
const text = ref('');

function commit() {
  const parts = text.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  text.value = '';
  const next = [...props.tags];
  for (const p of parts) if (!next.includes(p)) next.push(p);
  if (next.length !== props.tags.length) emit('update', next);
}
function onKey(/** @type {KeyboardEvent} */ e) {
  if (e.isComposing) return;
  if (e.key === 'Enter' || e.key === ',' || e.key === '，') { e.preventDefault(); commit(); }
  else if (e.key === 'Backspace' && !text.value && props.tags.length) emit('update', props.tags.slice(0, -1));
}
function remove(i) { emit('update', props.tags.filter((_, j) => j !== i)); }
</script>

<template>
  <div class="chip-input ce-tags">
    <span v-for="(t, i) in tags" :key="t + i" class="chip tag">
      {{ t }}<span class="cx" role="button" :title="'移除 ' + t" @click="remove(i)"><Icon name="x" size="sm" /></span>
    </span>
    <input v-model="text" placeholder="添加标签…" aria-label="添加标签" @keydown="onKey" @blur="commit">
  </div>
</template>
