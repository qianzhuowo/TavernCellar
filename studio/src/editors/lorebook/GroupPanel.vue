<script setup>
// Group panel (docs/studio-design.md §4.4 条目分组 · 整组操作). Every action states how many entries it changes
// and to what before it runs. Rename / dissolve change group paths, so the editor performs them.
import { computed, ref, watch } from 'vue';
import Icon from '../../components/Icon.vue';
import { POS, posShort, setPosition, groupOf } from './entry.js';

const props = defineProps({
  path: { type: String, required: true },
  /** every entry in the group, sub-groups included */
  entries: { type: Array, required: true }
});
const emit = defineEmits(['change', 'rename', 'dissolve']);

const list = computed(() => /** @type {any[]} */ (props.entries));
const positions = computed(() => [...new Set(list.value.map((e) => e.position ?? 0))]);
const uniform = computed(() => (positions.value.length === 1 ? positions.value[0] : null));
const parent = computed(() => props.path.split('/').slice(0, -1).join('/'));
const subgroups = computed(() => new Set(list.value.map(groupOf).filter((g) => g !== props.path)).size);

// ---- position ----
const pos = ref(String(uniform.value ?? 0));
watch(() => props.path, () => { pos.value = String(uniform.value ?? 0); reset(); });
const posChanges = computed(() => list.value.filter((e) => (e.position ?? 0) !== Number(pos.value)).length);
function applyPos() {
  const p = Number(pos.value);
  list.value.forEach((e) => { if ((e.position ?? 0) !== p) setPosition(e, p); });
  emit('change');
}

// ---- order ----
const orderMode = ref('range');
const start = ref('');
const step = ref('1');
const delta = ref('');
/** Current relative order inside the group: higher order first, then uid. */
const ranked = computed(() => [...list.value].sort((a, b) => (Number(b.order) || 0) - (Number(a.order) || 0) || a.uid - b.uid));
const rangeText = computed(() => {
  const s = Number(start.value), t = Number(step.value);
  if (start.value === '' || !Number.isFinite(s) || !Number.isFinite(t)) return '';
  const last = s - t * (ranked.value.length - 1);
  return ranked.value.length > 1 ? `${s} → ${last}（每条减 ${t}，保留组内先后）` : String(s);
});
const orderValid = computed(() => (orderMode.value === 'range' ? Boolean(rangeText.value) : delta.value !== '' && Number.isFinite(Number(delta.value)) && Number(delta.value) !== 0));
function applyOrder() {
  if (!orderValid.value) return;
  if (orderMode.value === 'range') {
    const s = Number(start.value), t = Number(step.value);
    ranked.value.forEach((e, i) => { e.order = s - t * i; });
  } else {
    const d = Number(delta.value);
    list.value.forEach((e) => { e.order = (Number(e.order) || 0) + d; });
  }
  emit('change');
}

// ---- rename / dissolve ----
const name = ref(props.path);
watch(() => props.path, (p) => { name.value = p; });
const confirmDissolve = ref(false);
function reset() { confirmDissolve.value = false; }
</script>

<template>
  <div class="ent grp">
    <div class="ent-title">
      <Icon name="folderOpen" />
      <h2 class="grp-name">{{ path }}</h2>
      <span class="uid">{{ list.length }} 个条目<template v-if="subgroups"> · {{ subgroups }} 个子组</template></span>
    </div>
    <p class="faint grp-help">Cellar 分组只在工作区里组织条目（对应 <span class="mono">entries/{{ path }}/</span> 文件夹），酒馆不认识它。同一组的条目使用相同的插入位置。</p>

    <div class="ent-block">
      <div class="ent-block-title">插入位置</div>
      <div v-if="uniform === null" class="grp-warn"><Icon name="alert" size="sm" />位置不一：{{ positions.map((p) => POS[p]?.short ?? p).join('、') }}。选择一个位置后点「统一」。</div>
      <div class="ins-row">
        <div class="field compact"><label>位置</label>
          <select v-model="pos" class="select" style="width: 196px">
            <option v-for="(p, i) in POS" :key="i" :value="String(i)">{{ p.short }} · {{ p.label }}</option>
          </select>
        </div>
        <button class="btn" :disabled="!posChanges" @click="applyPos">{{ uniform === null ? '统一' : '改位置' }}</button>
        <span class="faint grp-preview">{{ posChanges ? `将修改 ${posChanges} 个条目：位置 → ${POS[Number(pos)]?.short}` : '组内条目都已是这个位置' }}{{ posChanges && Number(pos) === 4 ? '（没有深度的条目使用深度 4）' : '' }}</span>
      </div>
    </div>

    <div class="ent-block">
      <div class="ent-block-title">顺序</div>
      <div class="ins-row">
        <div class="field compact"><label>方式</label>
          <select v-model="orderMode" class="select" style="width: 150px"><option value="range">设为一段区间</option><option value="add">整体加减</option></select>
        </div>
        <template v-if="orderMode === 'range'">
          <div class="field compact"><label>起始（最高）</label><input v-model="start" class="input num" type="number" :placeholder="String(ranked[0]?.order ?? 100)" /></div>
          <div class="field compact"><label>间隔</label><input v-model="step" class="input num" type="number" /></div>
        </template>
        <div v-else class="field compact"><label>加减</label><input v-model="delta" class="input num" type="number" placeholder="如 10 或 -10" /></div>
        <button class="btn" :disabled="!orderValid" @click="applyOrder">应用</button>
      </div>
      <span class="faint grp-preview">{{ orderValid ? `将修改 ${list.length} 个条目的顺序：${orderMode === 'range' ? rangeText : (Number(delta) > 0 ? '+' : '') + delta}` : '当前顺序：' + ranked.slice(0, 6).map((e) => e.order).join('、') + (ranked.length > 6 ? '…' : '') }}</span>
    </div>

    <div class="ent-block">
      <div class="ent-block-title">组名</div>
      <div class="ins-row">
        <div class="field compact grow"><label>改名<span class="hint">用 / 分级</span></label><input v-model="name" class="input" @keydown.enter="name.trim() && name.trim() !== path && emit('rename', name)" /></div>
        <button class="btn" :disabled="!name.trim() || name.trim() === path" @click="emit('rename', name)">改名</button>
      </div>
      <div class="ins-row">
        <span class="faint grp-preview grow">解散：{{ list.length }} 个条目{{ parent ? `回到上级组「${parent}」` : '回到未分组' }}，子组保留并上移一级。条目本身不变。</span>
        <button v-if="!confirmDissolve" class="btn" @click="confirmDissolve = true">解散</button>
        <button v-else class="btn danger" @click="emit('dissolve')">确认解散</button>
      </div>
    </div>
    <p class="faint grp-help">位置一致的组在列表中显示为 {{ uniform === null ? '「位置不一」' : posShort(list[0]) }}。</p>
  </div>
</template>
