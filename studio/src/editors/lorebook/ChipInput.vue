<script setup>
// Chip list editor: Enter or comma adds, Backspace on empty input removes the last chip.
import { ref } from 'vue';
import Icon from '../../components/Icon.vue';

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' }
});
const emit = defineEmits(['update:modelValue']);
const text = ref('');

function add() {
  const parts = text.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  text.value = '';
  if (parts.length) emit('update:modelValue', [...(props.modelValue ?? []), ...parts]);
}
/** @param {number} i */
function remove(i) {
  const next = [...(props.modelValue ?? [])];
  next.splice(i, 1);
  emit('update:modelValue', next);
}
/** @param {KeyboardEvent} ev */
function onKey(ev) {
  if (ev.key === 'Enter' || ev.key === ',' || ev.key === '，') { ev.preventDefault(); add(); }
  else if (ev.key === 'Backspace' && !text.value && props.modelValue?.length) remove(props.modelValue.length - 1);
}
/** @param {unknown} k */
const isRegex = (k) => /^\/.+\/[a-z]*$/.test(String(k));
</script>

<template>
  <div class="chip-input">
    <span v-for="(k, i) in modelValue" :key="i + ':' + k" class="chip" :class="{ regex: isRegex(k) }">
      {{ k }}<span class="cx" title="删除" @click="remove(i)"><Icon name="x" size="sm" /></span>
    </span>
    <input v-model="text" :placeholder="modelValue?.length ? '' : placeholder" @keydown="onKey" @blur="add" />
  </div>
</template>
