<script setup>
// Editable text with the differences against another text highlighted underneath, like one side of VS Code's
// side-by-side diff: side 'a' (来源) marks the text only it has in red, side 'b' (目标) the text only it has in green.
// A transparent textarea lies over a backdrop with the same text and metrics; both sit in one grid cell, so the
// backdrop sets the height (it grows with the content) and the wrapping stays identical.
import { computed } from 'vue';
import { diffText } from '../lib/diff.js';

const props = defineProps({
  modelValue: { type: String, default: '' },
  /** the other side's text */
  other: { type: String, default: '' },
  /** 'a' = this text is the old side (from), 'b' = the new side (to) */
  side: { type: String, default: 'b' },
  readonly: { type: Boolean, default: false },
  label: { type: String, default: '内容' }
});
const emit = defineEmits(['update:modelValue']);

/** This side's text cut into [marked, text] runs. */
const runs = computed(() => {
  const mine = props.modelValue || '';
  const parts = props.side === 'a' ? diffText(mine, props.other || '') : diffText(props.other || '', mine);
  const skip = props.side === 'a' ? '+' : '-';
  /** @type {Array<[boolean, string]>} */
  const out = [];
  for (const [op, text] of parts) if (op !== skip) out.push([op !== '=', text]);
  return out;
});
const changed = computed(() => runs.value.some((r) => r[0]));
</script>

<template>
  <div class="dt" :class="['side-' + side, { readonly }]">
    <div class="dt-back" aria-hidden="true"><template v-for="(r, i) in runs" :key="i"><mark v-if="r[0]">{{ r[1] }}</mark><template v-else>{{ r[1] }}</template></template>{{ '\u200b' }}</div>
    <textarea
      class="dt-text"
      :value="modelValue"
      :readonly="readonly"
      :aria-label="label"
      spellcheck="false"
      placeholder="（内容为空）"
      @input="emit('update:modelValue', /** @type {HTMLTextAreaElement} */ ($event.target).value)"
    />
    <span v-if="!changed && modelValue" class="dt-same faint">与另一侧相同</span>
  </div>
</template>

<style scoped>
.dt { position: relative; display: grid; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-2); min-height: 160px; }
.dt:focus-within { border-color: var(--accent-line); box-shadow: var(--input-glow); }
.dt-back, .dt-text {
  grid-area: 1 / 1; margin: 0; padding: var(--sp-4) var(--sp-5); box-sizing: border-box; min-width: 0;
  font-family: var(--font-body); font-size: var(--fs-editor); line-height: var(--lh-editor); letter-spacing: normal;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; tab-size: 4;
}
.dt-back { color: transparent; pointer-events: none; }
.dt-back mark { color: transparent; border-radius: 2px; }
.side-a .dt-back mark { background: var(--diff-del); }
.side-b .dt-back mark { background: var(--diff-add); }
.dt-text { width: 100%; height: 100%; border: 0; outline: none; resize: none; overflow: hidden; background: transparent; color: var(--text); }
.dt-text::placeholder { color: var(--text-3); }
.dt-same { position: absolute; right: 8px; bottom: 4px; font-size: 10px; pointer-events: none; }
</style>
