<script setup>
// Inspector sections for a character item: script frameworks the card depends on (status `frameworks`) and 文件提取:
// which parts are taken out to edit (item layout, POST /api/layout). An extracted part gets its own files and is
// loaded by the card editor; the rest stays in card.json, untouched. Changing it only moves content between files;
// the companion refuses it if the content hash would change (docs/workspace-format.md §3, 文件提取).
import { computed, ref } from 'vue';
import Icon from '../Icon.vue';
import { api, errorText } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { useUi } from '../../stores/ui.js';
import { CARD_PARTS, BASE_SECTIONS, extractedOf, excludeFor } from '../../lib/cardParts.js';

const props = defineProps({ item: { type: Object, required: true } });
const app = useApp();
const ui = useUi();

/** Framework ids from companion/src/codec/frameworks.js -> the tavern plugin that runs it (TavernCellar never does). */
const FRAMEWORK = {
  tavern_helper: { name: '酒馆助手', need: '对应插件：酒馆助手（JS-Slash-Runner）' },
  mvu: { name: 'MVU 变量框架', need: '对应插件：酒馆助手 + MVU 脚本' },
  xiaobaix: { name: '小白X', need: '对应插件：小白X（LittleWhiteBox）' }
};
const frameworks = computed(() => (props.item.frameworks || []).map((f) => ({ ...f, ...(FRAMEWORK[f.id] || { name: f.name, need: '' }) })));

const extracted = computed(() => extractedOf(props.item));
const busy = ref('');

/** Where an extracted part is edited: its editor page, or its files. */
function openPart(/** @type {import('../../lib/cardParts.js').CardPart} */ p) {
  if (p.id === 'character_book') ui.setItemView(props.item.path, 'world');
  else if (p.id === 'regex') ui.setItemView(props.item.path, 'regex');
  else if (p.id === 'greetings') ui.setItemView(props.item.path, 'form');
  else ui.setItemView(props.item.path, 'files', p.file);
}

async function toggle(/** @type {string} */ part, /** @type {boolean} */ on) {
  const next = new Set(extracted.value);
  if (on) next.add(part); else next.delete(part);
  busy.value = part;
  try {
    await api.setLayout(props.item.path, excludeFor(next));
    await app.refreshStatus();
    ui.toast(on ? '已提取，可以在编辑器中编辑' : '已取消提取：内容留在 card.json，编辑器不再加载', 'check');
    if (on && part === 'character_book') await takeWorld();
  } catch (e) {
    ui.toast('无法修改文件提取：' + errorText(e), 'alert');
  } finally {
    busy.value = '';
  }
}

/** Extracting 角色世界书 also takes the bound lorebook out, as checkout does (a book already there is reused). */
async function takeWorld() {
  const w = app.item(props.item.path)?.world;
  const target = props.item.bindings?.[0]?.target;
  if (!w?.name || w.path || !target) return;
  try {
    await api.checkout(target, 'lorebook', w.name);
    await app.refreshStatus();
    ui.toast(`绑定的世界书「${w.name}」已取出到工作区`, 'check');
  } catch (e) {
    ui.toast(`绑定的世界书「${w.name}」没能取出：${errorText(e)}；可在「世界书」页重试`, 'alert');
  }
}
</script>

<template>
  <section class="insp-sec">
    <h4>卡片使用的脚本框架</h4>
    <div v-if="!frameworks.length" class="faint" style="font-size: var(--fs-sm)">未发现脚本框架。</div>
    <div v-else class="faint parts-hint">这张卡内含这些框架的脚本或数据，在酒馆中需要安装对应插件才能生效；TavernCellar 只原样保存，不运行它们。</div>
    <div v-for="fw in frameworks" :key="fw.id" class="fw-row">
      <Icon name="puzzle" size="sm" />
      <div class="grow">
        <div class="fw-name">{{ fw.name }}<span class="faint fw-ev">{{ fw.evidence }}</span></div>
        <div v-if="fw.need" class="faint fw-need">{{ fw.need }}</div>
      </div>
    </div>
  </section>
  <section class="insp-sec">
    <h4 class="parts-h">文件提取<button class="btn sm ghost" type="button" title="在编辑器中查看、编辑这些文件" @click="ui.setItemView(item.path, 'files')"><Icon name="file" size="sm" />查看文件</button></h4>
    <div class="faint parts-hint">勾选要编辑的部分。没勾选的留在 card.json 里，编辑器不加载，同步时原样保留。只移动文件，不改变内容和同步状态。</div>
    <div class="faint parts-hint">始终提取：{{ BASE_SECTIONS }}</div>
    <label v-for="p in CARD_PARTS" :key="p.id" class="check parts-row" :title="p.tip">
      <input type="checkbox" :checked="extracted.has(p.id)" :disabled="!!busy || !!item.error" @change="toggle(p.id, $event.target.checked)" />
      <span class="grow">{{ p.label }}</span>
      <Icon v-if="busy === p.id" name="spin" size="sm" />
      <button v-else-if="extracted.has(p.id)" class="icon-btn parts-open" type="button" :title="'打开：' + p.tip" @click.prevent="openPart(p)"><Icon name="chevRight" size="sm" /></button>
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
.parts-h { display: flex; align-items: center; }
.parts-h .btn { margin-left: auto; text-transform: none; letter-spacing: 0; }
.parts-row { align-items: center; }
.parts-open { width: 22px; height: 22px; opacity: .6; }
.parts-row:hover .parts-open { opacity: 1; }
</style>
