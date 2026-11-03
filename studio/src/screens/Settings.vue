<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import Seg from '../components/Seg.vue';
import Toggle from '../components/Toggle.vue';
import TavernList from '../components/TavernList.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { errorText } from '../api.js';
import { desktop, copyText, openNative, copyPathToast } from '../lib/desktop.js';

const app = useApp();
const ui = useUi();
/** '' | 'switch' (open another workspace folder) | 'move' (copy this workspace to a new folder and use it there) */
const wsMode = ref('');
const wsDir = ref('');
const removeOld = ref(false);
const busy = ref(false);
const FONT_SIZES = [13, 14, 15, 16, 17, 18, 20];
const samePath = (/** @type {string} */ a, /** @type {string} */ b) => !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
const atDefault = computed(() => samePath(app.workspace, app.settings?.defaultWorkspace || ''));

onMounted(async () => {
  app.refreshTaverns();
  await nextTick();
  const el = ui.route.arg && document.getElementById('set-' + ui.route.arg);
  if (el) el.scrollIntoView({ block: 'start' });
});

function openWs(/** @type {'switch'|'move'} */ mode, dir = '') {
  wsMode.value = mode;
  wsDir.value = dir;
  removeOld.value = false;
}

async function browse() {
  const p = await desktop.pickDirectory();
  if (p) wsDir.value = p;
}

async function applyWs() {
  const dir = wsDir.value.trim();
  if (!dir) { ui.toast('请填写文件夹', 'alert'); return; }
  busy.value = true;
  try {
    if (wsMode.value === 'move') {
      const r = await app.moveWorkspace(dir, removeOld.value);
      ui.toast(r.removed ? `已迁移到 ${r.workspace}，原文件夹已删除` : `已迁移到 ${r.workspace}；原文件夹仍保留在 ${r.from}`);
    } else {
      ui.toast('已切换工作区：' + await app.switchWorkspace(dir));
    }
    wsMode.value = '';
  } catch (e) {
    ui.toast(errorText(e), 'alert');
  } finally { busy.value = false; }
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
      <div v-if="app.settings?.defaultWorkspace && !atDefault" class="set-row">
        <div class="set-label"><div>默认位置</div><div class="faint">安装目录下的 workspace 文件夹；卸载、升级时保留</div></div>
        <div class="set-ctl">
          <div class="path-box mono" style="flex: 1" :title="app.settings.defaultWorkspace">{{ app.settings.defaultWorkspace }}</div>
          <button class="btn sm" @click="openWs('move', app.settings.defaultWorkspace)">迁移到这里…</button>
        </div>
      </div>
      <div v-if="wsMode" class="set-row">
        <div class="set-label">
          <div>{{ wsMode === 'move' ? '迁移到' : '打开工作区' }}</div>
          <div class="faint">{{ wsMode === 'move' ? '把当前工作区（文件、版本历史、备份）整个复制到一个空文件夹并改用它' : '空文件夹会新建工作区；含 cellar.json 时直接打开；当前工作区不动' }}</div>
        </div>
        <div class="set-ctl" style="flex-wrap: wrap">
          <input v-model="wsDir" class="input mono" style="flex: 1; min-width: 260px" spellcheck="false" placeholder="例如 D:\TavernCellar" @keydown.enter="applyWs" />
          <button v-if="desktop.available" class="btn sm" @click="browse">浏览…</button>
          <label v-if="wsMode === 'move'" class="check"><input v-model="removeOld" type="checkbox" />复制核对无误后删除原文件夹</label>
          <button class="btn sm ghost" :disabled="busy" @click="wsMode = ''">取消</button>
          <button class="btn sm primary" :disabled="busy" @click="applyWs"><Icon :name="busy ? 'spin' : 'check'" size="sm" />{{ wsMode === 'move' ? '迁移' : '打开' }}</button>
        </div>
      </div>
      <div v-else class="set-row">
        <div class="set-label" />
        <div class="set-ctl">
          <button class="btn sm" @click="openWs('move')">迁移到…</button>
          <button class="btn sm ghost" @click="openWs('switch')">打开其他工作区…</button>
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
      <div class="set-row">
        <div class="set-label"><div>提示语言</div><div class="faint">同步、取出时伴侣程序与酒馆给出的提示</div></div>
        <div class="set-ctl">
          <Seg :model-value="app.settings.ui.messageLang" :options="[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]" @update:model-value="(v) => app.saveUi({ messageLang: v })" />
        </div>
      </div>
    </section>

    <section id="set-text" class="set-sec card">
      <h3><Icon name="code" />编辑器</h3>
      <div class="set-row">
        <div class="set-label"><div>正文字体</div><div class="faint">角色描述、开场白、条目内容等长文本</div></div>
        <div class="set-ctl">
          <Seg :model-value="app.settings.ui.font" :options="[{ value: 'sans', label: '无衬线' }, { value: 'serif', label: '衬线' }, { value: 'mono', label: '等宽' }]" @update:model-value="(v) => app.saveUi({ font: v })" />
        </div>
      </div>
      <div class="set-row">
        <div class="set-label"><div>正文字号</div></div>
        <div class="set-ctl">
          <select class="select" style="width: 110px" :value="app.settings.ui.fontSize" @change="app.saveUi({ fontSize: Number(/** @type {any} */ ($event.target).value) })">
            <option v-for="n in FONT_SIZES" :key="n" :value="n">{{ n }} px</option>
          </select>
          <span class="set-sample" :style="{ fontSize: app.settings.ui.fontSize + 'px' }">酒窖里很安静。The cellar is quiet.</span>
        </div>
      </div>
      <div class="set-row">
        <div class="set-label"><div>显示字数</div><div class="faint">文本框下方的字数统计</div></div>
        <div class="set-ctl"><Toggle :model-value="app.settings.ui.wordCount" @update:model-value="(v) => app.saveUi({ wordCount: v })" /></div>
      </div>
      <div class="set-row">
        <div class="set-label"><div>外部编辑器</div><div class="faint">检查栏「文件位置」里打开资料项文件夹的方式；VS Code 需要已安装</div></div>
        <div class="set-ctl">
          <Seg :model-value="app.settings.ui.externalEditor" :options="[{ value: 'system', label: '系统默认' }, { value: 'vscode', label: 'VS Code' }]" @update:model-value="(v) => app.saveUi({ externalEditor: v })" />
        </div>
      </div>
      <div class="set-row">
        <div class="set-label"><div>快捷键</div></div>
        <div class="set-ctl">
          <dl class="kv set-keys">
            <dt><kbd>Ctrl</kbd>+<kbd>P</kbd></dt><dd>快速打开资料项或页面</dd>
            <dt><kbd>Ctrl</kbd>+<kbd>S</kbd></dt><dd>立即写入工作区；手动同步的酒馆有本地修改时询问是否同步</dd>
            <dt><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd></dt><dd>把当前资料项同步到全部可达的酒馆（不含固定的绑定）</dd>
            <dt><kbd>Ctrl</kbd>+<kbd>F</kbd></dt><dd>聚焦当前页面的搜索框（资料库、世界书条目）</dd>
          </dl>
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
