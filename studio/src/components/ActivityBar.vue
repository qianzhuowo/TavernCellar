<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi, pathOfKey } from '../stores/ui.js';
import { libraryHref } from '../lib/kinds.js';

const app = useApp();
const ui = useUi();

// 工作区 first (the daily entry), then 资料库 / 同步 / 预览 / 历史. These are pages, not documents: they never become tabs.
// From an open item (e.g. a lorebook) the 资料库 opens on that item's kind; elsewhere it keeps the last kind.
const acts = computed(() => [
  { key: 'item', icon: 'folder', tip: '工作区', href: ui.lastItem ? '#/item/' + encodeURIComponent(ui.lastItem) : null },
  { key: 'library', icon: 'library', tip: '资料库', href: libraryHref(app.itemKind(pathOfKey(ui.route.key))) },
  { key: 'sync', icon: 'sync', tip: '同步', href: '#/sync', dot: app.conflictCount },
  { key: 'preview', icon: 'eye', tip: '预览', href: '#/preview' },
  { key: 'history', icon: 'history', tip: '历史', href: '#/history' }
]);

const light = computed(() => app.settings?.ui?.theme === 'light');
const toggleTheme = () => app.saveUi({ theme: document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' });

function click(/** @type {any} */ a) {
  if (a.key === 'item' && !a.href) { if (!ui.side) ui.toggleSide(); return; }
  if (a.key === ui.route.name && a.key !== 'item') { ui.toggleSide(); return; }
  if (!ui.side) ui.toggleSide();
  ui.go(a.href);
}
</script>

<template>
  <nav class="activity" aria-label="主导航">
    <button
      v-for="a in acts"
      :key="a.key"
      class="act"
      :class="{ on: ui.route.name === a.key }"
      :data-tip="a.tip"
      :aria-label="a.tip"
      @click="click(a)"
    >
      <Icon :name="a.icon" />
      <span v-if="a.dot" class="dot">{{ a.dot }}</span>
    </button>
    <span class="grow" />
    <button class="act" :data-tip="light ? '切换到深色' : '切换到浅色'" :aria-label="light ? '切换到深色' : '切换到浅色'" @click="toggleTheme">
      <Icon :name="light ? 'moon' : 'sun'" />
    </button>
    <button class="act" :class="{ on: ui.route.name === 'settings' }" data-tip="设置" aria-label="设置" @click="ui.go('#/settings')">
      <Icon name="settings" />
    </button>
  </nav>
</template>
