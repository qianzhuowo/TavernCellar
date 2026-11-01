<script setup>
// Inspector sections for a character item: script frameworks the card depends on (status `frameworks`) and which
// parts are split into their own files (item layout, POST /api/layout). Re-layout only moves content between files;
// the companion refuses it if the content hash would change (docs/workspace-format.md, 选择性拆出).
import { computed, ref } from 'vue';
import Icon from '../Icon.vue';
import { api, errorText } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { useUi } from '../../stores/ui.js';

const props = defineProps({ item: { type: Object, required: true } });
const app = useApp();
const ui = useUi();

/** Framework ids from companion/src/codec/frameworks.js -> what the user installs in the tavern. */
const FRAMEWORK = {
  tavern_helper: { name: '酒馆助手', need: '需要在酒馆中安装酒馆助手（JS-Slash-Runner）' },
  mvu: { name: 'MVU 变量框架', need: '依赖酒馆助手及 MVU 脚本' },
  xiaobaix: { name: '小白X', need: '需要在酒馆中安装小白X（LittleWhiteBox）' }
};
const frameworks = computed(() => (props.item.frameworks || []).map((f) => ({ ...f, ...(FRAMEWORK[f.id] || { name: f.name, need: '' }) })));

/** Same order and ids as CHARACTER_PARTS in companion/src/codec/character.js. */
const PARTS = [
  { id: 'fields', label: '正文字段', tip: '描述、第一条消息、设定等各为一个 .md 文件' },
  { id: 'greetings', label: '其他开场', tip: 'alternate_greetings/NN.md，每条一个文件' },
  { id: 'regex', label: '角色正则', tip: 'regex/NN-名称.json + 替换文本' },
  { id: 'scripts', label: '酒馆助手脚本', tip: 'scripts/NN-名称.json + .js' },
  { id: 'variables', label: '酒馆助手变量', tip: 'variables.json' },
  { id: 'character_book', label: '内嵌世界书', tip: 'character_book/NNNN-备注.md，每个条目一个文件' }
];
const exclude = computed(() => new Set(props.item.layout?.exclude || []));
const busy = ref('');

async function toggle(/** @type {string} */ part, /** @type {boolean} */ split) {
  const next = new Set(exclude.value);
  if (split) next.delete(part); else next.add(part);
  busy.value = part;
  try {
    await api.setLayout(props.item.path, PARTS.map((p) => p.id).filter((id) => next.has(id)));
    await app.refreshStatus();
    ui.toast(split ? '已拆成单独文件' : '已并回 card.json', 'check');
  } catch (e) {
    ui.toast('无法修改拆分方式：' + errorText(e), 'alert');
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <section class="insp-sec">
    <h4>依赖的脚本框架</h4>
    <div v-if="!frameworks.length" class="faint" style="font-size: var(--fs-sm)">未发现脚本框架。</div>
    <div v-for="fw in frameworks" :key="fw.id" class="fw-row">
      <Icon name="puzzle" size="sm" />
      <div class="grow">
        <div class="fw-name">{{ fw.name }}<span class="faint fw-ev">{{ fw.evidence }}</span></div>
        <div v-if="fw.need" class="faint fw-need">{{ fw.need }}</div>
      </div>
    </div>
  </section>
  <section class="insp-sec">
    <h4>文件拆分</h4>
    <div class="faint parts-hint">勾选的部分拆成单独文件，未勾选的留在 card.json。只移动文件，不改变内容和同步状态。</div>
    <label v-for="p in PARTS" :key="p.id" class="check parts-row" :title="p.tip">
      <input type="checkbox" :checked="!exclude.has(p.id)" :disabled="!!busy || !!item.error" @change="toggle(p.id, $event.target.checked)" />
      <span class="grow">{{ p.label }}</span>
      <Icon v-if="busy === p.id" name="spin" size="sm" />
    </label>
  </section>
</template>

<style scoped>
.fw-row { display: flex; gap: 8px; align-items: flex-start; font-size: var(--fs-sm); padding: 3px 0; }
.fw-row > svg { margin-top: 3px; color: var(--st-warn); flex: none; }
.fw-name { color: var(--text); }
.fw-ev { margin-left: 6px; font-size: var(--fs-xs); }
.fw-need { font-size: var(--fs-xs); line-height: 1.5; }
.parts-hint { font-size: var(--fs-xs); line-height: 1.5; margin-bottom: 6px; }
.parts-row { display: flex; width: 100%; padding: 3px 0; font-size: var(--fs-sm); }
.grow { flex: 1; min-width: 0; }
</style>
