<script setup>
import { ref, computed, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import TavernList from '../components/TavernList.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { errorText } from '../api.js';
import { desktop, copyText } from '../lib/desktop.js';
import { REPO_URL } from '../lib/status.js';

const app = useApp();
const ui = useUi();
const step = ref(1);
const STEPS = ['选择工作区', '安装 Cellar Link', '连接酒馆'];
/** 'current' keeps the workspace the companion already uses; 'other' switches to `dir`. */
const choice = ref(app.workspace ? 'current' : 'other');
const dir = ref('');
const busy = ref(false);

const anyConnected = computed(() => (app.status.targets || []).length > 0);

onMounted(() => { if (!app.detect) app.refreshTaverns(); });

async function pick() {
  const p = await desktop.pickDirectory();
  if (p) { dir.value = p; choice.value = 'other'; }
}

async function next() {
  if (step.value === 1 && choice.value === 'other') {
    if (!dir.value.trim()) { ui.toast('请填写工作区文件夹', 'alert'); return; }
    busy.value = true;
    try {
      const ws = await app.switchWorkspace(dir.value.trim());
      ui.toast('工作区：' + ws);
    } catch (e) {
      ui.toast(errorText(e), 'alert');
      return;
    } finally { busy.value = false; }
  }
  if (step.value === 2) app.refreshTaverns();
  step.value++;
}

async function finish(/** @type {boolean} */ later) {
  await app.saveUi({ wizardDone: true });
  ui.go(later ? '#/library' : '#/library');
}

async function copyRepo() { ui.toast((await copyText(REPO_URL)) ? '已复制仓库地址' : '复制失败，请手动选择', 'copy'); }
</script>

<template>
  <div class="app-full">
    <div class="wz">
      <div class="wz-brand"><span class="brand-mark"><Icon name="wine" /></span><b>TavernCellar</b><span class="faint">· Cellar Studio</span></div>

      <div class="wz-card" :class="{ wide: step === 3 }">
        <ol class="wz-steps">
          <template v-for="(s, i) in STEPS" :key="s">
            <li :class="{ on: step === i + 1, done: step > i + 1 }">
              <span class="wz-n"><Icon v-if="step > i + 1" name="check" size="sm" /><template v-else>{{ i + 1 }}</template></span>{{ s }}
            </li>
            <span v-if="i < STEPS.length - 1" class="wz-line" />
          </template>
        </ol>

        <!-- 1 · 选择工作区 -->
        <div v-if="step === 1" class="wz-body">
          <h1>选择工作区</h1>
          <p>工作区是一个普通文件夹，存放你从酒馆取出的角色卡与世界书。Studio 和 VS Code 改的都是这里的文件。</p>
          <div class="wz-opts">
            <div v-if="app.workspace" class="wz-opt" :class="{ on: choice === 'current' }" tabindex="0" @click="choice = 'current'" @keydown.enter="choice = 'current'">
              <span class="wz-radio" /><Icon name="folder" />
              <div class="grow">
                <div>使用当前工作区</div>
                <div class="faint">伴侣程序正在使用的文件夹</div>
                <div class="path-box mono" style="margin-top: 8px">{{ app.workspace }}</div>
              </div>
            </div>
            <div class="wz-opt" :class="{ on: choice === 'other' }" tabindex="0" @click="choice = 'other'">
              <span class="wz-radio" /><Icon name="folderOpen" />
              <div class="grow">
                <div>选择其他文件夹…</div>
                <div class="faint">检测到 cellar.json 时直接打开；空文件夹会新建工作区</div>
                <div class="dt-path" style="margin-top: 8px" @click.stop="choice = 'other'">
                  <input v-model="dir" class="input mono" placeholder="例如 D:\Documents\TavernCellar" spellcheck="false" @focus="choice = 'other'" />
                  <button v-if="desktop.available" class="btn sm" @click.stop="pick">浏览…</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 2 · 安装 Cellar Link -->
        <div v-else-if="step === 2" class="wz-body">
          <h1>安装 Cellar Link</h1>
          <p>Cellar Link 是装在酒馆里的小扩展，让 Studio 和酒馆互相同步。每个酒馆装一次即可。</p>
          <ol class="wz-howto">
            <li>在酒馆中打开 <b>扩展</b> → <b>安装扩展</b></li>
            <li>填入下面的仓库地址并安装
              <div class="copy-line"><span class="mono">{{ REPO_URL }}</span><button class="btn sm" @click="copyRepo"><Icon name="copy" size="sm" />复制</button></div>
            </li>
            <li>刷新酒馆页面，Cellar Link 会自动连接本机的伴侣程序，无需填写任何东西</li>
          </ol>
          <div class="dt-note faint"><Icon name="info" size="sm" /><div>TauriTavern 同样从扩展菜单安装。已经装过可以直接下一步。</div></div>
        </div>

        <!-- 3 · 连接酒馆 -->
        <div v-else class="wz-body">
          <h1>连接酒馆</h1>
          <p>打开酒馆页面后，Cellar Link 会自动连接。告诉伴侣程序酒馆装在哪里，酒馆没运行时也能浏览和取出。这一步可以跳过。</p>
          <TavernList />
          <div class="wz-redetect">
            <span class="faint">
              <template v-if="anyConnected"><span class="dot on" /> 已有 {{ app.status.targets.length }} 个酒馆连接</template>
              <template v-else><span class="dot wait" /> 等待酒馆连接…也可以先进入，稍后在「设置」中查看</template>
            </span>
            <button class="btn sm" :disabled="app.detecting" @click="app.refreshTaverns()"><Icon :name="app.detecting ? 'spin' : 'refresh'" size="sm" />重新检测</button>
          </div>
        </div>

        <div class="wz-foot">
          <button class="btn ghost" @click="finish(true)">稍后再说</button>
          <span class="grow" />
          <button v-if="step > 1" class="btn" @click="step--"><Icon name="back" size="sm" />上一步</button>
          <button v-if="step < 3" class="btn primary" :disabled="busy" @click="next">下一步<Icon :name="busy ? 'spin' : 'chevRight'" size="sm" /></button>
          <button v-else class="btn primary" @click="finish(false)">进入资料库<Icon name="chevRight" size="sm" /></button>
        </div>
      </div>
      <div class="wz-note faint">第 {{ step }} / 3 步 · 任何一步都可以稍后在「设置」中完成</div>
    </div>
  </div>
</template>
