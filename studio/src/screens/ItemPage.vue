<script setup>
// Workspace item: conflict / error banners, then the editor for its kind (S2 CardEditor, S3 LorebookEditor).
import { computed } from 'vue';
import Icon from '../components/Icon.vue';
import CardEditor from '../editors/CardEditor.vue';
import LorebookEditor from '../editors/LorebookEditor.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { uiStatus, isConflict } from '../lib/status.js';

const app = useApp();
const ui = useUi();
const path = computed(() => ui.route.arg);
const item = computed(() => app.item(path.value));
const conflicts = computed(() => (item.value ? item.value.bindings.filter((b) => isConflict(uiStatus(b.status))) : []));
</script>

<template>
  <div v-if="!item" class="page">
    <div class="empty">
      <Icon name="alert" />
      <h3>工作区里找不到这个资料项</h3>
      <p class="muted mono">{{ path }}</p>
      <a class="btn" href="#/library">去资料库</a>
    </div>
  </div>
  <div v-else class="item-page" :class="item.kind">
    <div v-if="conflicts.length || item.error" class="item-banners">
      <div v-for="b in conflicts" :key="b.target" class="banner conflict">
        <Icon name="alert" />
        <div class="grow">与「{{ app.targetName(b.target) }}」存在冲突 · 工作区与酒馆都修改了同一处，暂不会同步。</div>
        <button class="btn sm" @click="ui.openConflict(item.path)">处理冲突</button>
      </div>
      <div v-if="item.error" class="banner conflict"><Icon name="alert" /><div class="grow">工作区文件无法读取：{{ item.error }}</div></div>
    </div>
    <CardEditor v-if="item.kind === 'character' && !item.error" :key="item.path" :path="item.path" />
    <LorebookEditor v-else-if="item.kind === 'lorebook' && !item.error" :key="item.path" :path="item.path" />
  </div>
</template>
