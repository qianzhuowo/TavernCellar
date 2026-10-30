<script setup>
// S1: sync overview lists items needing attention; the full matrix and conflict view come later.
import { computed } from 'vue';
import Icon from '../components/Icon.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useApp } from '../stores/app.js';
import { uiStatus, isDirty, itemName } from '../lib/status.js';
import { hrefOf } from '../stores/ui.js';

const app = useApp();
const rows = computed(() => app.items.filter((i) => i.error || i.bindings.some((b) => isDirty(uiStatus(b.status)))));
</script>

<template>
  <div class="page">
    <div class="page-head"><div><h2>同步</h2><p class="muted">每个资料项在每个酒馆的状态。冲突不会被静默覆盖。完整的同步矩阵将在后续开放。</p></div></div>
    <div v-if="!rows.length" class="empty">
      <Icon name="ok" />
      <h3>全部已同步</h3>
      <p class="muted">{{ app.items.length }} 个资料项都与绑定的酒馆一致。</p>
    </div>
    <div v-else class="book-list card">
      <a v-for="it in rows" :key="it.path" class="book-row" :href="hrefOf('item:' + it.path)">
        <Icon :name="it.kind === 'character' ? 'user' : 'book'" />
        <div class="grow">{{ itemName(it.path) }} <span class="faint mono">{{ it.path }}</span></div>
        <StatusBadge v-if="it.error" status="invalid" />
        <span v-for="b in it.bindings" v-else :key="b.target" class="sync-pair">
          <span class="faint">{{ app.targetName(b.target) }}</span><StatusBadge :status="uiStatus(b.status)" />
        </span>
      </a>
    </div>
  </div>
</template>
