<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import Seg from '../components/Seg.vue';
import Toggle from '../components/Toggle.vue';
import TavernList from '../components/TavernList.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { api, errorText } from '../api.js';
import { flushAll } from '../lib/useItem.js';
import { desktop, copyText, openNative, copyPathToast, updater } from '../lib/desktop.js';

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

// ---- 版本历史占用与压缩 (docs/versioning.md §7.1) ----
/** @type {import('vue').Ref<any>} */
const storage = ref(null);
const compacting = ref(false);
const MAX_MB = [20, 50, 100, 200, 500];
const KEEP_DAYS = [7, 14, 30, 60, 90];
const fmtBytes = (/** @type {number} */ n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
async function loadStorage() {
  try { storage.value = await api.historyStorage(); } catch (e) { storage.value = { error: errorText(e) }; }
}
async function compact() {
  compacting.value = true;
  try {
    const r = await api.compactHistory();
    ui.toast(`已压缩历史：${fmtBytes(r.beforeBytes)} → ${fmtBytes(r.afterBytes)}`, 'check');
    await loadStorage();
  } catch (e) { ui.toast(errorText(e), 'alert'); } finally { compacting.value = false; }
}
onMounted(loadStorage);

// ---- 检查更新 (desktop shell only; published releases only) ----
/** @type {import('vue').Ref<any>} */
const upd = ref(null);
/** '' | 'check' | 'download' | 'install' */
const updBusy = ref('');
const updPercent = ref(0);
const updReady = ref('');
const MODE_TEXT = { installer: '安装版', portable: '便携版', source: '源码运行' };
let stopProgress = () => {};
onBeforeUnmount(() => stopProgress());
async function checkUpdate() {
  updBusy.value = 'check';
  try {
    upd.value = await updater.check();
    if (upd.value && upd.value.downloaded) updReady.value = upd.value.downloaded;
  } catch (e) { upd.value = { error: errorText(e) }; } finally { updBusy.value = ''; }
}
async function downloadUpdate() {
  updBusy.value = 'download';
  updPercent.value = 0;
  stopProgress = updater.onProgress((p) => { updPercent.value = Math.round(p.percent || 0); });
  try {
    const r = await updater.download();
    if (r && r.error) ui.toast(r.error, 'alert');
    else if (r) updReady.value = r.version || '';
  } catch (e) { ui.toast(errorText(e), 'alert'); } finally { stopProgress(); updBusy.value = ''; }
}
async function installUpdate() {
  updBusy.value = 'install';
  // write what the editors still hold before the companion stops
  try { await flushAll(); } catch (e) { /* the companion reports failed saves itself */ }
  try { await updater.install(); } catch (e) { ui.toast(errorText(e), 'alert'); updBusy.value = ''; }
}
function openReleases() { window.open((upd.value && upd.value.page) || RELEASES, '_blank', 'noopener'); }
const RELEASES = 'https://github.com/qianzhuowo/TavernCellar/releases';
const fmtDate = (/** @type {string} */ d) => (d ? new Date(d).toLocaleDateString() : '');
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

    <section id="set-history" class="set-sec card">
      <h3><Icon name="history" />版本历史</h3>
      <div class="set-row">
        <div class="set-label">
          <div>占用空间</div>
          <div class="faint">
            <template v-if="storage && storage.error">{{ storage.error }}</template>
            <template v-else-if="storage">
              {{ fmtBytes(storage.bytes) }}，{{ storage.files }} 个文件<template v-if="storage.unusedBytes">；其中 {{ fmtBytes(storage.unusedBytes) }} 是不再使用的草稿中间状态</template>。
              <template v-if="storage.compacted">上次压缩：{{ new Date(storage.compacted.at).toLocaleString() }}{{ storage.compacted.reason ? '（自动，' + storage.compacted.reason + '）' : '' }}。</template>
            </template>
            <template v-else>读取中…</template>
          </div>
        </div>
        <div class="set-ctl">
          <button class="btn sm" :disabled="compacting || !storage || !!storage.error" title="删除不再使用的草稿中间状态，并把其余内容打包成一个文件。所有版本、标签、草稿和部署记录都保留" @click="compact">
            <Icon :name="compacting ? 'spin' : 'box'" size="sm" />压缩历史
          </button>
        </div>
      </div>
      <div class="set-row">
        <div class="set-label"><div>自动清理</div><div class="faint">启动 1 分钟后和之后每 12 小时检查一次；只删除不再使用的草稿中间状态，不影响任何版本</div></div>
        <div class="set-ctl"><Toggle :model-value="app.settings.ui.historyAutoClean" @update:model-value="(v) => app.saveUi({ historyAutoClean: v })" /></div>
      </div>
      <div class="set-row" :class="{ 'set-off': !app.settings.ui.historyAutoClean }">
        <div class="set-label"><div>超过此大小时压缩</div><div class="faint">历史超过这个大小时自动「压缩历史」（压缩后若仍超过，要再增长 20% 才会再压缩）</div></div>
        <div class="set-ctl">
          <select class="select" style="width: 110px" :disabled="!app.settings.ui.historyAutoClean" :value="app.settings.ui.historyMaxMB" @change="app.saveUi({ historyMaxMB: Number(/** @type {any} */ ($event.target).value) })">
            <option v-for="n in MAX_MB" :key="n" :value="n">{{ n }} MB</option>
          </select>
        </div>
      </div>
      <div class="set-row" :class="{ 'set-off': !app.settings.ui.historyAutoClean }">
        <div class="set-label"><div>清理多久以前的中间状态</div><div class="faint">没超过大小时，只删除这么久以前就不再使用的草稿中间状态</div></div>
        <div class="set-ctl">
          <select class="select" style="width: 110px" :disabled="!app.settings.ui.historyAutoClean" :value="app.settings.ui.historyKeepDays" @change="app.saveUi({ historyKeepDays: Number(/** @type {any} */ ($event.target).value) })">
            <option v-for="n in KEEP_DAYS" :key="n" :value="n">{{ n }} 天</option>
          </select>
        </div>
      </div>
    </section>

    <section id="set-app" class="set-sec card">
      <h3><Icon name="box" />关于</h3>
      <div class="set-row">
        <div class="set-label">
          <div>检查更新</div>
          <div class="faint">
            <template v-if="upd && upd.current">当前版本 {{ upd.current }}（{{ MODE_TEXT[upd.mode] || upd.mode }}）。</template>
            只检查作者发布的正式版本。
          </div>
        </div>
        <div class="set-ctl">
          <button v-if="updater.available" class="btn sm" :disabled="!!updBusy" @click="checkUpdate"><Icon :name="updBusy === 'check' ? 'spin' : 'update'" size="sm" />检查更新</button>
          <a v-else class="btn sm" :href="RELEASES" target="_blank" rel="noopener"><Icon name="external" size="sm" />查看发布页</a>
        </div>
      </div>
      <div v-if="upd" class="upd">
        <div v-if="upd.error" class="sync-note err"><Icon name="alert" size="sm" />{{ upd.error }}</div>
        <div v-else-if="!upd.newer || !upd.newer.length" class="sync-note ok"><Icon name="ok" size="sm" />已是最新版本{{ upd.latest ? '（' + upd.latest.version + '）' : '' }}</div>
        <template v-else>
          <div class="upd-head">
            <b>有新版本 {{ upd.newer[0].version }}</b>
            <span class="faint">{{ upd.newer.length > 1 ? '（共 ' + upd.newer.length + ' 个新版本）' : '' }}</span>
            <span class="grow" />
            <template v-if="upd.canInstall">
              <button v-if="updReady" class="btn sm primary" :disabled="updBusy === 'install'" @click="installUpdate"><Icon :name="updBusy === 'install' ? 'spin' : 'update'" size="sm" />重启并安装</button>
              <button v-else class="btn sm primary" :disabled="!!updBusy" @click="downloadUpdate"><Icon :name="updBusy === 'download' ? 'spin' : 'download'" size="sm" />{{ updBusy === 'download' ? '下载中 ' + updPercent + '%' : '下载更新' }}</button>
            </template>
            <button class="btn sm" @click="openReleases"><Icon name="external" size="sm" />前往下载页</button>
          </div>
          <div v-if="!upd.canInstall" class="faint upd-tip">{{ upd.mode === 'installer' ? '这个版本没有提供自动更新，请在下载页获取安装程序。' : '便携版不能自动更新：请在下载页获取新版，替换原来的 exe（工作区不受影响）。' }}</div>
          <div v-else-if="updReady" class="faint upd-tip">已下载 {{ updReady }}。重启时会先保存正在编辑的内容，工作区保持不变。</div>
          <div class="faint upd-tip">Cellar Link 插件请在酒馆的「管理扩展」中更新。</div>
          <article v-for="r in upd.newer" :key="r.version" class="upd-rel">
            <div class="upd-rel-h"><b>{{ r.name }}</b><span class="faint">{{ fmtDate(r.date) }}</span></div>
            <div class="upd-notes">{{ r.notes || '（没有更新说明）' }}</div>
          </article>
        </template>
      </div>
      <div class="set-row">
        <div class="set-label"><div>首次启动向导</div><div class="faint">重新选择工作区、查看 Cellar Link 安装方法</div></div>
        <div class="set-ctl"><button class="btn sm" @click="rerunWizard">重新运行</button></div>
      </div>
    </section>
    <div class="faint" style="text-align: center; font-size: 12px; padding: 8px 0 32px">Cellar Studio · 伴侣程序 127.0.0.1:{{ app.port }}</div>
  </div>
</template>
