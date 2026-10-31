<script setup>
import { ref, onMounted, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import Seg from '../components/Seg.vue';
import TavernList from '../components/TavernList.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { errorText } from '../api.js';
import { desktop, copyText, openNative, copyPathToast } from '../lib/desktop.js';

const app = useApp();
const ui = useUi();
const editingWs = ref(false);
const wsDir = ref('');
const busy = ref(false);

onMounted(async () => {
  app.refreshTaverns();
  await nextTick();
  const el = ui.route.arg && document.getElementById('set-' + ui.route.arg);
  if (el) el.scrollIntoView({ block: 'start' });
});

async function switchWs(/** @type {string} */ dir) {
  if (!dir) return;
  busy.value = true;
  try {
    const ws = await app.switchWorkspace(dir);
    editingWs.value = false;
    ui.toast('已切换工作区：' + ws);
  } catch (e) {
    ui.toast(errorText(e), 'alert');
  } finally { busy.value = false; }
}

async function changeWs() {
  if (desktop.available) { const p = await desktop.pickDirectory(); if (p) switchWs(p); return; }
  wsDir.value = app.workspace;
  editingWs.value = true;
}

async function copyWs() { await copyPathToast(app.workspace, ui.toast); }
function rerunWizard() { app.saveUi({ wizardDone: false }).then(() => ui.go('#/wizard')); }
</script>

<template>
  <div class="page settings">
    <div class="page-head"><div><h2>设置</h2><p class="muted">设置保存在本机，不会写入工作区。</p></div></div>

    <section id="set-ws" class="set-sec card">
      <h3><Icon name="folder" />工作区</h3>
      <div class="set-row">
        <div class="set-label"><div>当前路径</div></div>
        <div class="set-ctl"><div class="path-box mono" style="flex: 1" :title="app.workspace">{{ app.workspace || '未选择' }}</div></div>
      </div>
      <div v-if="editingWs" class="set-row">
        <div class="set-label"><div>新的工作区</div><div class="faint">空文件夹会新建工作区；含 cellar.json 时直接打开</div></div>
        <div class="set-ctl">
          <input v-model="wsDir" class="input mono" style="flex: 1" spellcheck="false" @keydown.enter="switchWs(wsDir.trim())" />
          <button class="btn sm ghost" @click="editingWs = false">取消</button>
          <button class="btn sm primary" :disabled="busy" @click="switchWs(wsDir.trim())"><Icon :name="busy ? 'spin' : 'check'" size="sm" />切换</button>
        </div>
      </div>
      <div v-else class="set-row">
        <div class="set-label" />
        <div class="set-ctl">
          <button class="btn sm" @click="changeWs">切换…</button>
          <button v-if="desktop.available" class="btn sm ghost" @click="openNative('showInFolder', app.workspace, ui.toast)"><Icon name="external" size="sm" />在资源管理器中打开</button>
          <button v-else class="btn sm ghost" @click="copyWs"><Icon name="copy" size="sm" />复制路径</button>
        </div>
      </div>
    </section>

    <section id="set-conn" class="set-sec card">
      <h3><Icon name="plug" />连接</h3>
      <div class="set-row">
        <div class="set-label"><div>端口</div><div class="faint">伴侣程序只监听本机</div></div>
        <div class="set-ctl"><div class="path-box mono">127.0.0.1:{{ app.port }}</div></div>
      </div>
      <div class="set-sub">
        <div class="set-sub-h">本机酒馆<span style="flex: 1" />
          <button class="btn sm" :disabled="app.detecting" @click="app.refreshTaverns()"><Icon :name="app.detecting ? 'spin' : 'refresh'" size="sm" />重新检测</button>
        </div>
        <div v-if="!app.detect" class="faint" style="padding: 12px 0"><Icon name="spin" size="sm" /> 正在检测本机酒馆…</div>
        <TavernList v-else />
      </div>
    </section>

    <section id="set-editor" class="set-sec card">
      <h3><Icon name="palette" />外观</h3>
      <div class="set-row">
        <div class="set-label"><div>主题</div></div>
        <div class="set-ctl">
          <Seg :model-value="app.settings.ui.theme" :options="[{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }]" @update:model-value="(v) => app.saveUi({ theme: v })" />
        </div>
      </div>
      <div class="set-row">
        <div class="set-label"><div>界面密度</div><div class="faint">影响列表行高（世界书列表 紧凑 32px / 舒适 40px）</div></div>
        <div class="set-ctl">
          <Seg :model-value="app.settings.ui.density" :options="[{ value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' }]" @update:model-value="(v) => app.saveUi({ density: v })" />
        </div>
      </div>
    </section>

    <section id="set-app" class="set-sec card">
      <h3><Icon name="box" />关于</h3>
      <div class="set-row">
        <div class="set-label"><div>首次启动向导</div><div class="faint">重新选择工作区、查看 Cellar Link 安装方法</div></div>
        <div class="set-ctl"><button class="btn sm" @click="rerunWizard">重新运行</button></div>
      </div>
    </section>
    <div class="faint" style="text-align: center; font-size: 12px; padding: 8px 0 32px">Cellar Studio · 伴侣程序 127.0.0.1:{{ app.port }}</div>
  </div>
</template>
