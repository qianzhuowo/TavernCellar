<script setup>
// Global regex editor (kind 'regex', data { scripts: RegexScriptData[] }); the list/detail UI is RegexList.
import { ref, computed, watch, toRef } from 'vue';
import { useItem } from '../lib/useItem.js';
import { useUi } from '../stores/ui.js';
import Icon from '../components/Icon.vue';
import RegexList from './RegexList.vue';
import { api, errorText } from '../api.js';

const props = defineProps({ path: { type: String, required: true } });
const it = useItem(toRef(props, 'path'));
const ui = useUi();

const rev = ref(0);
watch(it.version, () => { rev.value++; });
const scripts = computed(() => { void rev.value; const s = it.data.value?.scripts; return Array.isArray(s) ? s : null; });
const saveState = computed(() => (it.saving.value ? 'saving' : it.dirty.value && !it.externalChange.value ? 'dirty' : 'saved'));

const keeping = ref(false);
async function keepMine() {
  keeping.value = true;
  try {
    const r = await api.item(props.path);
    it.hash.value = r.hash;
    it.externalChange.value = false;
    it.touch();
    await it.save();
  } catch (e) {
    ui.toast('写入失败：' + errorText(e), 'alert');
  } finally {
    keeping.value = false;
  }
}
</script>

<template>
  <div class="rx">
    <div v-if="it.externalChange.value" class="banner warn">
      <Icon name="alert" />
      <div class="grow"><b>文件在别处被修改</b><span class="muted"> · 暂停写入。重新加载会丢弃这里尚未写入的修改；保留我的修改会覆盖那些改动。</span></div>
      <button class="btn sm" type="button" :disabled="keeping" @click="it.load()"><Icon name="refresh" size="sm" />重新加载</button>
      <button class="btn sm" type="button" :disabled="keeping" @click="keepMine"><Icon :name="keeping ? 'spin' : 'check'" size="sm" />保留我的修改</button>
    </div>
    <div v-if="it.error.value && !it.data.value" class="banner conflict">
      <Icon name="alert" /><div class="grow">无法读取正则：{{ it.error.value }}</div>
      <button class="btn sm" type="button" @click="it.load()">重试</button>
    </div>
    <div v-else-if="!it.data.value" class="ce-loading faint"><Icon name="spin" /> 正在读取正则…</div>
    <div v-else-if="!scripts" class="banner warn">
      <Icon name="info" /><div class="grow">这个酒馆的全局正则不是列表（或还没有创建过），这里不提供编辑。文件按原样保存在 <span class="mono">{{ path }}/cellar-item.json</span>。</div>
    </div>
    <RegexList v-else :key="it.version.value" :scripts="scripts" :save-state="saveState" empty-text="还没有全局正则 · 点「新建」添加" :auto-add="ui.newScriptFor === path" @edited="it.touch()" @auto-added="ui.newScriptFor = ''" />
  </div>
</template>

<style scoped>
.rx { display: flex; height: 100%; min-height: 0; gap: 0; flex-wrap: wrap; align-content: stretch; }
.rx > .banner { flex: 1 0 100%; margin: var(--sp-3) var(--sp-4) 0; }
.rx > .ce-loading { flex: 1 0 100%; }
.grow { flex: 1; min-width: 0; }
</style>
