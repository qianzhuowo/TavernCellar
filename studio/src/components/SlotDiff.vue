<script setup>
// One slot side by side: workspace | tavern (| base). Text gets an inline diff, objects list only the fields that
// differ, anything else is shown as JSON.
import { computed } from 'vue';
import Icon from './Icon.vue';
import { fmt, kindOf, fieldRows, parts } from '../lib/slot-view.js';

const props = defineProps({
  slotView: { type: Object, required: true },
  showBase: { type: Boolean, default: false },
  targetLabel: { type: String, default: '' }
});
const r = computed(() => props.slotView);
const kind = computed(() => kindOf(r.value));
const withBase = computed(() => props.showBase && r.value.base.present);
const fields = computed(() => (kind.value === 'object' ? fieldRows(r.value) : []));
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
</template>
