<script setup>
import Icon from '../components/Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { copyText } from '../lib/desktop.js';

const app = useApp();
const ui = useUi();
const CMD = 'git init && git add -A && git commit -m "快照"\ngit log --stat';
async function copy() { ui.toast((await copyText(CMD)) ? '已复制命令' : '复制失败', 'copy'); }
</script>

<template>
  <div class="page hist">
    <div class="hist-hero">
      <div class="hist-icon"><Icon name="history" /></div>
      <h2>版本历史将在阶段 2 推出</h2>
      <p class="muted">阶段 2 会为工作区加入 JJ 式版本管理。在此之前，工作区就是一个普通文件夹，你可以用 git 查看它的历史。</p>
    </div>
    <div class="hist-tip">
      <div class="faint">在工作区目录（<span class="mono">{{ app.workspace }}</span>）中运行：</div>
      <code>{{ CMD }}</code>
      <button class="icon-btn" title="复制" @click="copy"><Icon name="copy" size="sm" /></button>
    </div>
  </div>
</template>
