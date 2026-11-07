<script setup>
// One chat-completion prompt's fields (name, role, position, depth, content), shared by the preset editor and 预设工坊.
// The prompt object is not mutated here: every change is emitted as set(key, value) for the owner to apply.
// `other` (预设工坊 对比模式) is the other side's content: the content box stays editable and highlights the differences
// (side 'a' = 来源: text only here in red; side 'b' = 目标: text only here in green).
import Icon from '../components/Icon.vue';
import Seg from '../components/Seg.vue';
import DiffText from '../components/DiffText.vue';
import CardText from '../components/card/CardText.vue';

const props = defineProps({
  prompt: { type: Object, required: true },
  /** the prompt's entry in the global prompt order, or null when it is 未插入 */
  order: { type: Object, default: null },
  /** whether 未插入 applies (collection prompts have no order) */
  hasOrder: { type: Boolean, default: true },
  readonly: { type: Boolean, default: false },
  /** the other side's content to diff against, or null (no comparison) */
  other: { type: String, default: null },
  side: { type: String, default: 'a' },
  /** @type {import('vue').PropType<string[]>} fields that differ from the other side */
  changed: { type: Array, default: () => [] },
  rows: { type: Number, default: 14 }
});
const emit = defineEmits(['set', 'insert']);

const ROLES = [{ value: 'system', label: '系统' }, { value: 'user', label: '用户' }, { value: 'assistant', label: 'AI' }];
const POSITIONS = [{ value: 0, label: '相对' }, { value: 1, label: '聊天中' }];
const val = (/** @type {Event} */ e) => /** @type {any} */ (e.target).value;
</script>

<template>
  <div class="pd">
    <div class="rx-detail-head">
      <input class="input ce-name" :class="{ 'pd-changed': changed.includes('name') }" :value="prompt.name" :readonly="readonly" placeholder="提示词名称" @input="emit('set', 'name', val($event))" />
      <slot name="actions" />
    </div>
    <div class="faint mono pe-id">{{ prompt.identifier }}</div>
    <div v-if="hasOrder && !order" class="banner">
      <Icon name="info" />
      <div class="grow">这条提示词没有插入提示词顺序，酒馆不会使用它（在酒馆提示词管理器的「插入」列表里）。</div>
      <button v-if="!readonly" class="btn sm" type="button" @click="emit('insert')"><Icon name="plus" size="sm" />插入到提示词顺序</button>
    </div>
    <div v-if="prompt.marker" class="banner"><Icon name="info" /><div class="grow">这是占位提示词，内容由酒馆在生成时填入（如聊天记录、世界书），这里只能调整名称、顺序和开关。</div></div>
    <template v-else>
      <div class="rx-grid">
        <div class="field" :class="{ 'pd-changed': changed.includes('role') }"><label>角色</label><Seg :model-value="prompt.role || 'system'" :options="ROLES" :disabled="readonly" @update:model-value="emit('set', 'role', $event)" /></div>
        <div class="field" :class="{ 'pd-changed': changed.includes('position') }"><label>位置</label><Seg :model-value="Number(prompt.injection_position) || 0" :options="POSITIONS" :disabled="readonly" @update:model-value="emit('set', 'injection_position', $event)" /></div>
        <div v-if="Number(prompt.injection_position) === 1" class="field" :class="{ 'pd-changed': changed.includes('position') }">
          <label>深度</label>
          <input class="input num" type="number" min="0" :value="prompt.injection_depth ?? 4" :readonly="readonly" @change="emit('set', 'injection_depth', parseInt(val($event), 10) || 0)" />
        </div>
        <div class="field" :class="{ 'pd-changed': changed.includes('forbid') }"><label>其他</label><label class="check"><input type="checkbox" :checked="!!prompt.forbid_overrides" :disabled="readonly" @change="emit('set', 'forbid_overrides', /** @type {any} */ ($event.target).checked)" />禁止角色卡覆盖</label></div>
      </div>
      <div v-if="other !== null" class="field">
        <label>内容</label>
        <DiffText :model-value="String(prompt.content ?? '')" :other="other" :side="side" :readonly="readonly" @update:model-value="emit('set', 'content', $event)" />
      </div>
      <div v-else-if="readonly" class="field">
        <label>内容</label>
        <div class="cf-text long pd-text">{{ prompt.content || '' }}<span v-if="!String(prompt.content || '')" class="faint">（内容为空）</span></div>
      </div>
      <CardText v-else label="内容" big :rows="rows" :model-value="prompt.content ?? ''" @update:model-value="emit('set', 'content', $event)" />
    </template>
  </div>
</template>

<style scoped>
.pd { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
.rx-detail-head { display: flex; align-items: center; gap: var(--sp-2); }
.rx-detail-head .ce-name { flex: 1; }
.pe-id { font-size: 11px; margin-top: calc(-1 * var(--sp-3)); overflow: hidden; text-overflow: ellipsis; }
.rx-grid { display: flex; flex-wrap: wrap; gap: var(--sp-3) var(--sp-5); }
.pd-text { white-space: pre-wrap; margin: 0; max-height: none; }
.pd-changed > label:first-child, input.pd-changed { color: var(--st-warn); }
input.pd-changed { border-color: color-mix(in srgb, var(--st-warn) 60%, transparent); }
</style>
