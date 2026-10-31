<script setup>
// One slot side by side: workspace | tavern (| base). Text gets an inline diff, objects list only the fields that
// differ, anything else is shown as JSON.
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import { fmt, kindOf, fieldRows, parts } from '../lib/slot-view.js';
import { isNoise } from '../lib/entryNoise.js';

const props = defineProps({
  slotView: { type: Object, required: true },
  showBase: { type: Boolean, default: false },
  targetLabel: { type: String, default: '' },
  /** lorebook entry template: fields that differ only by SillyTavern's default-filling fold away; null = no folding */
  noiseTemplate: { type: Object, default: null },
  foldNoise: { type: Boolean, default: false }
});
const r = computed(() => props.slotView);
const kind = computed(() => kindOf(r.value));
const withBase = computed(() => props.showBase && r.value.base.present);
const allFields = computed(() => (kind.value === 'object' ? fieldRows(r.value) : []));
const noiseKeys = computed(() => (props.foldNoise ? new Set(allFields.value.filter((f) => isNoise(f.key, f.ws, f.tv, props.noiseTemplate)).map((f) => f.key)) : new Set()));
const showNoise = ref(false);
const fields = computed(() => (showNoise.value ? allFields.value : allFields.value.filter((f) => !noiseKeys.value.has(f.key))));
</script>

<template>
  <div class="cf-cols" :class="{ 'with-base': withBase }">
    <div v-if="withBase" class="cf-side base">
      <div class="cf-side-h">基准版本</div>
      <template v-if="kind === 'object'">
        <div v-for="f in fields" :key="f.key" class="cf-kv"><span class="cf-key mono">{{ f.key }}</span><div class="cf-text">{{ f.base === undefined ? '（无）' : fmt(f.base) }}</div></div>
      </template>
      <pre v-else-if="kind === 'json'" class="cf-text cf-json">{{ fmt(r.base.value) }}</pre>
      <div v-else class="cf-text long">{{ r.base.value }}</div>
    </div>

    <div class="cf-side ws">
      <div class="cf-side-h"><Icon name="folder" size="sm" />工作区</div>
      <div v-if="!r.workspace.present" class="cf-text faint">（无 / 已删除）</div>
      <template v-else-if="kind === 'object'">
        <div v-for="f in fields" :key="f.key" class="cf-kv">
          <span class="cf-key mono">{{ f.key }}</span>
          <div class="cf-text"><span v-if="f.ws === undefined" class="faint">（无）</span><template v-else v-for="(p, i) in parts(f.hasBase ? f.base : f.tv, f.ws)" :key="i"><ins v-if="p[0] === '+'">{{ p[1] }}</ins><del v-else-if="p[0] === '-'">{{ p[1] }}</del><span v-else>{{ p[1] }}</span></template></div>
        </div>
      </template>
      <pre v-else-if="kind === 'json'" class="cf-text cf-json">{{ fmt(r.workspace.value) }}</pre>
      <div v-else class="cf-text long"><template v-for="(p, i) in parts(r.base.present ? r.base.value : r.tavern.present ? r.tavern.value : '', r.workspace.value)" :key="i"><ins v-if="p[0] === '+'">{{ p[1] }}</ins><del v-else-if="p[0] === '-'">{{ p[1] }}</del><span v-else>{{ p[1] }}</span></template></div>
    </div>

    <div class="cf-side tv">
      <div class="cf-side-h"><Icon name="wine" size="sm" />酒馆{{ targetLabel ? ' · ' + targetLabel : '' }}</div>
      <div v-if="!r.tavern.present" class="cf-text faint">（无 / 已删除）</div>
      <template v-else-if="kind === 'object'">
        <div v-for="f in fields" :key="f.key" class="cf-kv">
          <span class="cf-key mono">{{ f.key }}</span>
          <div class="cf-text"><span v-if="f.tv === undefined" class="faint">（无）</span><template v-else-if="f.hasBase"><template v-for="(p, i) in parts(f.base, f.tv)" :key="i"><ins v-if="p[0] === '+'">{{ p[1] }}</ins><del v-else-if="p[0] === '-'">{{ p[1] }}</del><span v-else>{{ p[1] }}</span></template></template><template v-else>{{ fmt(f.tv) }}</template></div>
        </div>
      </template>
      <pre v-else-if="kind === 'json'" class="cf-text cf-json">{{ fmt(r.tavern.value) }}</pre>
      <div v-else-if="r.base.present" class="cf-text long"><template v-for="(p, i) in parts(r.base.value, r.tavern.value)" :key="i"><ins v-if="p[0] === '+'">{{ p[1] }}</ins><del v-else-if="p[0] === '-'">{{ p[1] }}</del><span v-else>{{ p[1] }}</span></template></div>
      <div v-else class="cf-text long">{{ r.tavern.value }}</div>
    </div>
  </div>
  <button v-if="noiseKeys.size" type="button" class="cf-noise-toggle" :aria-expanded="showNoise" @click="showNoise = !showNoise">
    <Icon :name="showNoise ? 'chevDown' : 'chevRight'" size="sm" />
    {{ showNoise ? '收起' : '另有' }} {{ noiseKeys.size }} 处酒馆自动补全的差异
    <span class="faint">（一边缺省、另一边是 SillyTavern 默认值，含义相同）</span>
  </button>
</template>

<style>
.cf-noise-toggle {
  display: inline-flex; align-items: center; gap: 4px; margin-top: var(--sp-2); padding: 3px 6px; border: 0;
  border-radius: var(--r-md); background: transparent; color: var(--text-2); font: inherit; font-size: var(--fs-sm); cursor: pointer;
}
.cf-noise-toggle:hover { background: var(--bg-3); color: var(--text); }
.cf-noise-toggle:focus-visible { outline: 1px solid var(--accent); }
.cf-noise-toggle .faint { font-size: var(--fs-xs); }
</style>
