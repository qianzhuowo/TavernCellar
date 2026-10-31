<script setup>
import { computed, reactive } from 'vue';
import Icon from './Icon.vue';
import Toggle from './Toggle.vue';
import StatusBadge from './StatusBadge.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { api, errorText } from '../api.js';
import { desktop, copyText, joinPath } from '../lib/desktop.js';
import { uiStatus, isConflict, HOST, MODE_LABEL, MODE_TIP, MODE_DOT, OFF_MODE, STATUS, STALE_HINT } from '../lib/status.js';

const props = defineProps({ path: { type: String, required: true } });
const app = useApp();
const ui = useUi();
const item = computed(() => app.item(props.path));
const abs = computed(() => joinPath(app.workspace, props.path));
/** @type {Record<string, string>} */
const busy = reactive({});

const dotClass = (/** @type {string} */ m) => MODE_DOT[m] || 'off';

function subline(/** @type {any} */ b) {
  const mode = app.modeOf(b);
  if (mode === 'offline') return '离线 · ' + OFF_MODE[b.offlineSync || 'wait'].short;
  return MODE_LABEL[mode];
}

/** Whether sync / pull can be attempted for this binding right now. */
function canAct(/** @type {any} */ b) {
  const m = app.modeOf(b);
  return m === 'online' || m === 'offline';
}

async function run(/** @type {any} */ b, /** @type {'sync'|'pull'} */ op) {
  const s = uiStatus(b.status);
  if (isConflict(s)) { ui.openConflict(props.path); return; }
  busy[b.target] = op;
  try {
    await (op === 'sync' ? api.sync(props.path, b.target) : api.pull(props.path, b.target));
    ui.toast((op === 'sync' ? '已同步到 ' : '已从酒馆取回：') + app.targetName(b.target));
    await app.refreshStatus();
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    await app.refreshStatus();
  } finally {
    delete busy[b.target];
  }
}

async function setAuto(/** @type {any} */ b, /** @type {boolean} */ on) {
  busy[b.target] = 'auto';
  try {
    await api.autoSync(props.path, b.target, on);
    b.autoSync = on;
    ui.toast(on ? '已开启随时同步' : '已关闭随时同步');
    await app.refreshStatus();
  } catch (e) {
    ui.toast(errorText(e), 'alert');
  } finally {
    delete busy[b.target];
  }
}

async function copyPath() {
  const ok = await copyText(abs.value);
  ui.toast(ok ? '已复制路径' : '复制失败', ok ? 'copy' : 'alert');
}
</script>

<template>
  <aside class="inspector">
    <div class="panel-head">检查栏<span class="spacer" /><button class="icon-btn" title="收起" @click="ui.toggleInspector()"><Icon name="x" size="sm" /></button></div>
    <div v-if="item" class="insp-scroll">
      <section class="insp-sec">
        <h4>同步状态</h4>
        <div v-if="!item.bindings.length" class="faint" style="font-size: var(--fs-sm)">没有绑定任何酒馆。</div>
        <div v-for="b in item.bindings" :key="b.target" class="sync-row" :class="'mode-' + app.modeOf(b)">
          <div class="sync-head">
            <span class="dot" :class="dotClass(app.modeOf(b))" :title="MODE_TIP[app.modeOf(b)]" />
            <div class="grow">
              <div class="sync-name">{{ app.targetName(b.target) }}<span v-if="app.target(b.target).host" class="host-mark">{{ HOST[app.target(b.target).host].mark }}</span></div>
              <div class="faint sync-sub">{{ subline(b) }}</div>
            </div>
            <StatusBadge :status="uiStatus(b.status)" :label="STATUS[uiStatus(b.status)].label + (app.modeOf(b) === 'offline' ? ' · 离线' : '')" />
          </div>
          <div v-if="app.modeOf(b) === 'stale'" class="sync-note warn"><Icon name="alert" size="sm" />{{ STALE_HINT }}</div>
          <div v-if="b.waiting" class="sync-note"><Icon name="wait" size="sm" />待同步：酒馆启动后自动同步</div>
          <div v-if="b.tavernError" class="sync-note err"><Icon name="alert" size="sm" />{{ b.tavernError }}</div>
          <div v-if="isConflict(uiStatus(b.status))" class="sync-note err">
            <Icon name="alert" size="sm" /><span class="grow">两边都改了同一处</span>
            <a v-if="ui.route.name !== 'conflict'" href="#" @click.prevent="ui.openConflict(props.path)">处理冲突</a>
          </div>
          <div class="sync-ops">
            <Toggle
              sync
              :model-value="b.autoSync"
              label="随时同步"
              :disabled="!!busy[b.target]"
              title="修改后自动同步到此酒馆"
              @update:model-value="(v) => setAuto(b, v)"
            />
            <span class="grow" />
            <button class="btn sm" :disabled="!canAct(b) || !!busy[b.target]" title="从酒馆取回，覆盖工作区" @click="run(b, 'pull')">
              <Icon :name="busy[b.target] === 'pull' ? 'spin' : 'download'" size="sm" />取回
            </button>
            <button
              class="btn sm"
              :class="{ primary: uiStatus(b.status) === 'local' }"
              :disabled="!canAct(b) || !!busy[b.target]"
              title="把工作区写入酒馆"
              @click="run(b, 'sync')"
            >
              <Icon :name="busy[b.target] === 'sync' ? 'spin' : 'upload'" size="sm" />同步
            </button>
          </div>
        </div>
      </section>

      <section v-if="item.error" class="insp-sec">
        <h4>读取错误</h4>
        <div class="sync-note err"><Icon name="alert" size="sm" />{{ item.error }}</div>
      </section>

      <section class="insp-sec">
        <h4>文件位置</h4>
        <div class="path-box mono" :title="abs">{{ path }}/</div>
        <div class="insp-btns">
          <template v-if="desktop.available">
            <button class="btn sm" @click="desktop.showInFolder(abs)"><Icon name="folderOpen" size="sm" />在资源管理器中显示</button>
            <button class="btn sm" @click="desktop.openInEditor(abs)"><Icon name="code" size="sm" />VS Code</button>
          </template>
          <button v-else class="btn sm" :title="abs" @click="copyPath"><Icon name="copy" size="sm" />复制路径</button>
        </div>
        <dl class="kv" style="margin-top: 10px">
          <dt>类型</dt><dd>{{ item.kind === 'character' ? '角色卡' : '世界书' }}</dd>
          <dt>绑定</dt><dd>{{ item.bindings.length }} 个酒馆</dd>
        </dl>
      </section>
    </div>
  </aside>
</template>
