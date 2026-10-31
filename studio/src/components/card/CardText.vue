<script setup>
// Labelled textarea for a card text field: grows with its content, shows a character count underneath.
import { ref, watch, onMounted, nextTick } from 'vue';
import { countChars } from './cardFields.js';

const props = defineProps({
  label: { type: String, required: true },
  modelValue: { type: [String, null], default: null },
  rows: { type: Number, default: 3 },
  hint: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  code: { type: Boolean, default: false },
  big: { type: Boolean, default: false }
});
const emit = defineEmits(['update:modelValue']);
const ta = ref(/** @type {HTMLTextAreaElement|null} */ (null));

function grow() {
  const el = ta.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 2 + 'px';
}
function onInput(/** @type {Event} */ e) {
  emit('update:modelValue', /** @type {HTMLTextAreaElement} */ (e.target).value);
  grow();
}
onMounted(grow);
watch(() => props.modelValue, () => nextTick(grow));
</script>

<template>
  <div class="field ce-tf" :class="{ big }">
    <div class="field-label"><slot name="label">{{ label }}</slot></div>
    <textarea
      ref="ta"
      class="textarea"
      :class="{ code }"
      :rows="rows"
      :value="modelValue ?? ''"
      :placeholder="placeholder"
      :aria-label="label"
      spellcheck="false"
      @input="onInput"
    />
    <div class="field-foot">
      <span v-if="hint">{{ hint }}</span>
      <span class="spacer" />
      <span class="wc">{{ countChars(modelValue) }} 字</span>
    </div>
  </div>
</template>
