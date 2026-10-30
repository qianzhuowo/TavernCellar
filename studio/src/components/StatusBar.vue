<script setup>
import Icon from './Icon.vue';
import { useApp } from '../stores/app.js';
import { HOST, MODE_LABEL, MODE_TIP } from '../lib/status.js';

const app = useApp();
const dotClass = (/** @type {string} */ m) => (m === 'online' ? 'on' : m === 'offline' ? 'wait' : 'off');
</script>

<template>
  <footer class="statusbar">
    <a v-for="h in ['st', 'tt']" :key="h" class="si" href="#/settings/conn" :title="HOST[h].name + ' · ' + MODE_TIP[app.hostState[h]]">
      <span class="dot" :class="dotClass(app.hostState[h])" />{{ HOST[h].mark }} {{ MODE_LABEL[app.hostState[h]] }}
    </a>
    <span class="div" />
    <a class="si" href="#/sync" :style="app.dirtyCount ? 'color: var(--st-local)' : ''">
      <Icon :name="app.dirtyCount ? 'dot' : 'check'" size="sm" />{{ app.dirtyCount ? app.dirtyCount + ' 项有未同步修改' : '全部已同步' }}
    </a>
    <a v-if="app.conflictCount" class="si" href="#/sync" style="color: var(--st-conflict)">
      <Icon name="alert" size="sm" />{{ app.conflictCount }} 项冲突
    </a>
    <span class="spacer" />
    <span class="si hide-narrow faint" :title="app.workspace"><Icon name="folder" size="sm" />{{ app.items.length }} 个资料项</span>
    <span class="si hide-narrow faint">127.0.0.1:{{ app.port }}</span>
  </footer>
</template>
