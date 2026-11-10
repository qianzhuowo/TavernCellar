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

/** Nearest scrolling ancestor: growing must not move it (see grow). @param {HTMLElement} el */
function scrollerOf(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement;
}

// Measuring needs height:auto for a moment; that shortens the page, and the scroll container would clamp its scroll
// position (jumping to the top, then back to the caret). Its position is put back before anything is painted.
function grow() {
  const el = ta.value;
  if (!el) return;
  const scroller = scrollerOf(el);
  const top = scroller ? scroller.scrollTop : 0;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 2 + 'px';
  if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
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
