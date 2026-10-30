<script setup>
// S1: read-only placeholder for a workspace item (editors arrive in S2/S3).
import { computed } from 'vue';
import Icon from '../components/Icon.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { uiStatus, isConflict, itemName, hueOf, initialOf, MODE_LABEL, OFF_MODE } from '../lib/status.js';

const app = useApp();
const ui = useUi();
const path = computed(() => ui.route.arg);
const item = computed(() => app.item(path.value));
const name = computed(() => itemName(path.value));
const conflicts = computed(() => (item.value ? item.value.bindings.filter((b) => isConflict(uiStatus(b.status))) : []));
const avatarStyle = computed(() => {
  const h = hueOf(name.value);
  return { background: `linear-gradient(150deg, hsl(${h} 42% 46%), hsl(${(h + 40) % 360} 46% 26%))` };
});
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
  <div v-else class="page item-page">
    <div v-for="b in conflicts" :key="b.target" class="banner conflict">
      <Icon name="alert" />
      <div class="grow">与「{{ app.targetName(b.target) }}」存在冲突 · 工作区与酒馆都修改了，暂不会同步。<span class="faint">冲突处理将在后续开放</span></div>
      <button class="btn sm" disabled title="冲突处理将在后续开放">处理冲突</button>
    </div>
    <div v-if="item.error" class="banner conflict"><Icon name="alert" /><div class="grow">读取失败：{{ item.error }}</div></div>

    <div class="item-hero">
      <div class="avatar item-avatar" :style="avatarStyle">
        <Icon v-if="item.kind === 'lorebook'" name="book" size="lg" />
        <template v-else>{{ initialOf(name) }}</template>
      </div>
      <div class="grow">
        <h2>{{ name }}</h2>
        <div class="faint"><span class="mono">{{ item.path }}/</span> · {{ item.kind === 'character' ? '角色卡' : '世界书' }}</div>
      </div>
    </div>

    <div class="card item-bindings">
      <div v-for="b in item.bindings" :key="b.target" class="item-bind">
        <div class="grow">
          <b>{{ app.targetName(b.target) }}</b>
          <div class="faint">
            {{ MODE_LABEL[app.modeOf(b)] }}<template v-if="app.modeOf(b) === 'offline'"> · {{ OFF_MODE[b.offlineSync || 'wait'].label }}</template>
            · 酒馆中的文件 <span class="mono">{{ b.id }}</span>
            <template v-if="b.autoSync"> · 随时同步</template>
          </div>
        </div>
        <StatusBadge :status="uiStatus(b.status)" />
      </div>
      <div v-if="!item.bindings.length" class="faint">没有绑定任何酒馆。</div>
    </div>

    <div class="empty item-empty">
      <Icon :name="item.kind === 'character' ? 'user' : 'book'" />
      <h3>编辑器将在下一步开放</h3>
      <p class="muted">现在可以在右侧检查栏中同步、取回或开启随时同步；也可以直接用 VS Code 编辑工作区里的文件。</p>
      <button v-if="!ui.inspector" class="btn" @click="ui.toggleInspector()"><Icon name="panelRight" size="sm" />打开检查栏</button>
    </div>
  </div>
</template>
