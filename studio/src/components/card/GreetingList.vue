<script setup>
// 其他开场: collapsible textareas with add / delete / drag-to-reorder. Emits the whole new list on every change.
import { ref, watch } from 'vue';
import { GripVertical } from 'lucide-vue-next';
import Icon from '../Icon.vue';
import CardText from './CardText.vue';
import { countChars } from './cardFields.js';

const props = defineProps({
  items: { type: Array, default: () => [] },
  /** bumped when the card reloads, to reset the open state */
  version: { type: Number, default: 0 }
});
const emit = defineEmits(['update']);

/** open state per row, kept parallel to items */
const open = ref(/** @type {boolean[]} */ ([]));
watch(() => props.version, () => { open.value = props.items.map((_, i) => i === 0); }, { immediate: true });

const armed = ref(-1);
let armTimer = 0;
const dragFrom = ref(-1);
const dragOver = ref(-1);

function preview(/** @type {string} */ g) {
  const line = (g || '').split('\n').find((l) => l.trim());
  return line ? line.replace(/[*"]/g, '').trim() : '（空）';
}
function toggle(i) { open.value[i] = !open.value[i]; }
function edit(i, text) {
  const next = [...props.items];
  next[i] = text;
  emit('update', next);
}
function add() {
  emit('update', [...props.items, '']);
  open.value = [...open.value, true];
}
function del(i) {
  // Non-empty rows need a second click within 3 s, so a stray click cannot lose text.
  if ((props.items[i] || '').trim() && armed.value !== i) {
    armed.value = i;
    clearTimeout(armTimer);
    armTimer = window.setTimeout(() => { armed.value = -1; }, 3000);
    return;
  }
  armed.value = -1;
  emit('update', props.items.filter((_, j) => j !== i));
  open.value = open.value.filter((_, j) => j !== i);
}

function onDragStart(i, /** @type {DragEvent} */ e) {
  dragFrom.value = i;
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }
}
function onDragOver(i, /** @type {DragEvent} */ e) {
  if (dragFrom.value < 0) return;
  e.preventDefault();
  dragOver.value = i;
}
function onDrop(i) {
  const from = dragFrom.value;
  dragFrom.value = dragOver.value = -1;
  if (from < 0 || from === i) return;
  const next = [...props.items];
  const flags = [...open.value];
  const [g] = next.splice(from, 1);
  const [f] = flags.splice(from, 1);
  next.splice(i, 0, g);
  flags.splice(i, 0, f);
  open.value = flags;
  emit('update', next);
}
function onDragEnd() { dragFrom.value = dragOver.value = -1; }
</script>

<template>
  <div class="field">
    <div class="field-label">
      其他开场<span class="badge">{{ items.length }}</span>
      <span class="spacer" />
      <button class="btn sm" type="button" @click="add"><Icon name="plus" size="sm" />新增开场</button>
    </div>
    <div v-if="items.length" class="ce-greets">
      <div
        v-for="(g, i) in items"
        :key="i"
        class="ce-greet"
        :class="{ open: open[i], dragging: dragFrom === i, over: dragOver === i && dragFrom !== i }"
        @dragover="onDragOver(i, $event)"
        @drop.prevent="onDrop(i)"
      >
        <div class="ce-greet-head">
          <span class="ce-grip" title="拖动排序" draggable="true" @dragstart="onDragStart(i, $event)" @dragend="onDragEnd">
            <GripVertical class="ic sm" aria-hidden="true" />
          </span>
          <span class="ce-greet-no">#{{ i + 1 }}</span>
          <button class="ce-greet-preview" type="button" @click="toggle(i)">{{ preview(g) }}</button>
          <span class="wc faint ce-greet-wc">{{ countChars(g) }} 字</span>
          <button
            class="icon-btn"
            :class="{ 'ce-armed': armed === i }"
            type="button"
            :title="armed === i ? '再次点击删除' : '删除'"
            @click="del(i)"
          >
            <Icon name="trash" size="sm" /><span v-if="armed === i" class="ce-armed-text">确认删除</span>
          </button>
          <button class="icon-btn" type="button" :title="open[i] ? '收起' : '展开'" @click="toggle(i)">
            <span class="ce-chev"><Icon name="chevDown" size="sm" /></span>
          </button>
        </div>
        <div v-if="open[i]" class="ce-greet-body">
          <CardText :label="`其他开场 #${i + 1}`" :model-value="g" :rows="4" @update:model-value="edit(i, $event)" />
        </div>
      </div>
    </div>
    <div v-else class="ce-none faint">还没有其他开场。聊天开始时会在第一条消息与这些开场之间切换。</div>
  </div>
</template>
