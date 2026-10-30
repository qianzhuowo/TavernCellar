<script setup>
import Icon from './Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { HOST, MODE_LABEL, MODE_TIP } from '../lib/status.js';

const app = useApp();
const ui = useUi();
const dotClass = (/** @type {string} */ m) => (m === 'online' ? 'on' : m === 'offline' ? 'wait' : 'off');
const toggleTheme = () => app.saveUi({ theme: document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' });
</script>

<template>
  <header class="titlebar">
    <div class="brand"><span class="brand-mark"><Icon name="wine" /></span>TavernCellar</div>
    <span class="sep">·</span>
    <span class="ws-name" :title="app.workspace"><Icon name="folder" size="sm" />{{ app.workspaceName }}</span>
    <span class="spacer" />
    <a class="conn-summary" href="#/settings/conn" title="酒馆连接">
      <span v-for="h in ['st', 'tt']" :key="h" class="conn" :title="HOST[h].name + ' · ' + MODE_TIP[app.hostState[h]]">
        <span class="dot" :class="dotClass(app.hostState[h])" />{{ HOST[h].mark }}<span class="conn-label">{{ MODE_LABEL[app.hostState[h]] }}</span>
      </span>
    </a>
    <button class="icon-btn" title="切换深色 / 浅色" @click="toggleTheme">
      <Icon :name="ui && app.settings && app.settings.ui.theme === 'light' ? 'moon' : 'sun'" />
    </button>
  </header>
</template>
