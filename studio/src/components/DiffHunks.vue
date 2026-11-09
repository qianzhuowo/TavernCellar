<script setup>
// Compact line diff (GitHub Desktop style): old / new line numbers, removed and added lines, inline marks inside a
// changed line pair, and unchanged runs folded to「… N 行未改动」(click to show). Read-only.
import { computed, ref, watch } from 'vue';
import { diffLines } from '../lib/diff.js';

const props = defineProps({
  from: { type: String, default: '' },
  to: { type: String, default: '' },
  /** monospace text (JSON) instead of the reading font */
  mono: { type: Boolean, default: false }
});
const blocks = computed(() => diffLines(props.from, props.to));
/** indexes of gap blocks the user opened */
const opened = ref(/** @type {Set<number>} */ (new Set()));
watch(blocks, () => { opened.value = new Set(); });
function open(/** @type {number} */ i) { opened.value = new Set([...opened.value, i]); }
const SIGN = { '=': ' ', '-': '-', '+': '+' };
const CLS = { '=': 'eq', '-': 'del', '+': 'add' };
</script>

<template>
  <div class="dh" :class="{ mono }">
    <template v-for="(blk, i) in blocks" :key="i">
      <button v-if="blk.gap && !opened.has(i)" type="button" class="dh-gap" title="展开" @click="open(i)">… {{ blk.lines.length }} 行未改动</button>
      <template v-else>
        <div v-for="(l, k) in blk.lines" :key="k" class="dh-line" :class="CLS[l.op]">
          <span class="dh-n">{{ l.a ?? '' }}</span><span class="dh-n">{{ l.b ?? '' }}</span><span class="dh-sign">{{ SIGN[l.op] }}</span>
          <span class="dh-t"><template v-if="l.parts"><template v-for="(p, j) in l.parts" :key="j"><mark v-if="p[0] !== '='">{{ p[1] }}</mark><template v-else>{{ p[1] }}</template></template></template><template v-else>{{ l.text || '\u200b' }}</template></span>
        </div>
      </template>
    </template>
  </div>
</template>

<style>
.dh {
  border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; background: var(--bg-1);
  font-family: var(--font-body); font-size: 13.5px; line-height: 1.6;
}
.dh.mono { font-family: var(--font-mono); font-size: 12.5px; }
.dh-line { display: grid; grid-template-columns: auto auto 1.4em minmax(0, 1fr); }
.dh-n {
  min-width: 3.2em; padding: 0 6px; text-align: right; color: var(--text-3); font-family: var(--font-mono); font-size: 11px;
  font-variant-numeric: tabular-nums; user-select: none; border-right: 1px solid var(--line); padding-top: 2px; }
.dh-sign { text-align: center; color: var(--text-3); font-family: var(--font-mono); user-select: none; }
.dh-t { padding-right: 8px; white-space: pre-wrap; word-break: break-word; }
.dh-line.del { background: color-mix(in srgb, var(--diff-del) 55%, transparent); }
.dh-line.add { background: color-mix(in srgb, var(--diff-add) 55%, transparent); }
.dh-line.del .dh-sign { color: var(--st-conflict); }
.dh-line.add .dh-sign { color: var(--st-synced); }
.dh-line mark { color: inherit; border-radius: 2px; }
.dh-line.del mark { background: var(--diff-del); }
.dh-line.add mark { background: var(--diff-add); }
.dh-gap {
  display: block; width: 100%; padding: 2px 10px; border: 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
  background: var(--bg-2); color: var(--text-3); font: inherit; font-size: var(--fs-xs); text-align: left; cursor: pointer;
}
.dh-gap:first-child { border-top: 0; }
.dh-gap:last-child { border-bottom: 0; }
.dh-gap:hover { background: var(--bg-3); color: var(--text); }
.dh-gap:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
