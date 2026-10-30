<script setup>
import Icon from './Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi, hrefOf } from '../stores/ui.js';
import { itemName } from '../lib/status.js';

defineProps({ hasInspector: { type: Boolean, default: false } });
const app = useApp();
const ui = useUi();

const FIXED = { library: ['资料库', 'library'], settings: ['设置', 'settings'], sync: ['同步', 'sync'], history: ['历史', 'history'] };
const BAR = { conflict: 'var(--st-conflict)', both: 'var(--st-conflict)', invalid: 'var(--st-conflict)', local: 'var(--st-local)', remote: 'var(--st-remote)' };

function info(/** @type {string} */ key) {
  if (key.startsWith('item:')) {
    const it = app.item(key.slice(5));
    return { label: itemName(key.slice(5)), icon: it && it.kind === 'lorebook' ? 'book' : 'user', bar: it ? BAR[app.worst(it)] : '' };
  }
  const f = FIXED[key] || [key, 'circle'];
  return { label: f[0], icon: f[1], bar: '' };
}
</script>

<template>
  <div class="tabs" role="tablist">
    <a
      v-for="k in ui.tabs"
      :key="k"
      class="tab"
      role="tab"
      :class="{ on: ui.route.key === k }"
      :href="hrefOf(k)"
      :title="k.startsWith('item:') ? k.slice(5) : ''"
      @auxclick.prevent="ui.closeTab(k)"
    >
      <span v-if="info(k).bar" class="bar" :style="{ background: info(k).bar }" />
      <Icon :name="info(k).icon" size="sm" />
      <span class="label">{{ info(k).label }}</span>
      <span class="x" title="关闭" @click.prevent.stop="ui.closeTab(k)"><Icon name="x" size="sm" /></span>
    </a>
    <div class="tabs-tools">
      <button v-if="hasInspector" class="icon-btn" :class="{ on: ui.inspector }" title="检查栏" @click="ui.toggleInspector()"><Icon name="panelRight" size="sm" /></button>
    </div>
  </div>
</template>
