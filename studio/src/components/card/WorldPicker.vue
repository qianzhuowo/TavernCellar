<script setup>
// 主要知识书 binding (data.extensions.world): workspace lorebooks + this card's tavern lorebooks, plus 清除.
// A book already in the workspace gets 打开; a tavern-only book gets 一起取出 (checkout into the workspace).
import { ref, computed, watch } from 'vue';
import Icon from '../Icon.vue';
import { api, errorText } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { useUi } from '../../stores/ui.js';
import { itemName } from '../../lib/status.js';

const props = defineProps({
  modelValue: { type: [String, null], default: null },
  /** first binding of the card: { target, ... } or null */
  binding: { type: Object, default: null }
});
const emit = defineEmits(['update:modelValue']);
const app = useApp();
const ui = useUi();

const target = computed(() => props.binding?.target || '');
const mode = computed(() => (props.binding ? app.modeOf(props.binding) : 'none'));
const tavernUsable = computed(() => mode.value === 'online' || mode.value === 'offline');
const tavernLabel = computed(() => (target.value ? app.targetName(target.value) : ''));

/** workspace lorebooks: name = binding id for this card's tavern, else any binding id, else folder name */
const wsBooks = computed(() => app.items.filter((i) => i.kind === 'lorebook').map((i) => {
  const b = i.bindings.find((x) => x.target === target.value) || i.bindings[0];
  return { name: (b && b.id) || itemName(i.path), path: i.path };
}));

const tavernBooks = ref(/** @type {string[]} */ ([]));
const loadingCat = ref(false);
const catError = ref('');
let seq = 0;
async function loadCatalog() {
  const my = ++seq;
  tavernBooks.value = [];
  catError.value = '';
  if (!target.value || !tavernUsable.value) return;
  loadingCat.value = true;
  try {
    const r = await api.catalog({ target: target.value, kind: 'lorebook', limit: 1000 });
    if (my === seq) tavernBooks.value = r.items.map((/** @type {any} */ e) => e.name || e.id);
  } catch (e) {
    if (my === seq) catError.value = errorText(e);
  } finally {
    if (my === seq) loadingCat.value = false;
  }
}
watch([target, tavernUsable], loadCatalog, { immediate: true });

const wsNames = computed(() => new Set(wsBooks.value.map((b) => b.name)));
const tavernOnly = computed(() => tavernBooks.value.filter((n) => !wsNames.value.has(n)));
const current = computed(() => props.modelValue || '');
const inWs = computed(() => wsBooks.value.find((b) => b.name === current.value) || null);
const inTavern = computed(() => tavernBooks.value.includes(current.value));
const unknown = computed(() => !!current.value && !inWs.value && !inTavern.value);

function pick(/** @type {Event} */ e) {
  const v = /** @type {HTMLSelectElement} */ (e.target).value;
  emit('update:modelValue', v);
}

const busy = ref(false);
async function takeOut() {
  busy.value = true;
  try {
    await api.checkout(target.value, 'lorebook', current.value);
    await app.refreshStatus();
    ui.toast(`已取出「${current.value}」到工作区`, 'check');
  } catch (e) {
    ui.toast('取出失败：' + errorText(e), 'alert');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="field">
    <label>主要知识书</label>
    <div class="ce-world-row">
      <select class="select ce-world-select" :value="current" aria-label="主要知识书" @change="pick">
        <option value="">— 不绑定 —</option>
        <option v-if="unknown" :value="current">{{ current }}（未找到）</option>
        <optgroup v-if="wsBooks.length" label="工作区">
          <option v-for="b in wsBooks" :key="b.path" :value="b.name">{{ b.name }}</option>
        </optgroup>
        <optgroup v-if="tavernOnly.length" :label="'酒馆 · ' + tavernLabel">
          <option v-for="n in tavernOnly" :key="n" :value="n">{{ n }}</option>
        </optgroup>
      </select>
      <button class="btn sm" type="button" :disabled="!current" @click="emit('update:modelValue', '')">清除</button>
    </div>
    <div v-if="current" class="ce-world-link">
      <Icon name="book" />
      <div class="grow">
        <div><b>{{ current }}</b></div>
        <div class="faint ce-small">
          <template v-if="inWs"><Icon name="check" size="sm" /> 已在工作区 · {{ inWs.path }}</template>
          <template v-else-if="inTavern">只在「{{ tavernLabel }}」中，尚未取出到工作区</template>
          <template v-else>工作区和酒馆中都没有找到这本书</template>
        </div>
      </div>
      <button v-if="inWs" class="btn sm" type="button" @click="ui.openItem(inWs.path)">打开<Icon name="chevRight" size="sm" /></button>
      <button v-else-if="inTavern" class="btn sm" type="button" :disabled="busy" @click="takeOut">
        <Icon :name="busy ? 'spin' : 'download'" size="sm" />一起取出
      </button>
    </div>
    <div class="help">
      <template v-if="!target">此卡未绑定酒馆，只列出工作区中的世界书。</template>
      <template v-else-if="!tavernUsable">「{{ tavernLabel }}」当前不可用，只列出工作区中的世界书。</template>
      <template v-else-if="loadingCat"><Icon name="spin" size="sm" /> 正在读取「{{ tavernLabel }}」的世界书…</template>
      <template v-else-if="catError">读取「{{ tavernLabel }}」的世界书失败（{{ catError }}），只列出工作区中的世界书。<a href="#" @click.prevent="loadCatalog">重试</a></template>
      <template v-else>列出工作区与「{{ tavernLabel }}」中的世界书。</template>
    </div>
  </div>
</template>
