<script setup>
import { computed, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import Toggle from './Toggle.vue';
import StatusBadge from './StatusBadge.vue';
import CardParts from './card/CardParts.vue';
import { kindOf } from '../lib/kinds.js';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { runBindingOp, setAutoSync, canReach, followBinding, pinText, PIN_TIP, removeItem } from '../lib/syncOps.js';
import { desktop, joinPath, openNative, openExternalEditor, copyPathToast } from '../lib/desktop.js';
import { uiStatus, isConflict, HOST, MODE_LABEL, MODE_TIP, MODE_DOT, OFF_MODE, STATUS, STALE_HINT } from '../lib/status.js';

const props = defineProps({ path: { type: String, required: true } });
const app = useApp();
const ui = useUi();
const item = computed(() => app.item(props.path));
const abs = computed(() => joinPath(app.workspace, props.path));
const editor = computed(() => app.settings?.ui?.externalEditor || 'system');
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
  return canReach(app.modeOf(b));
}

async function run(/** @type {any} */ b, /** @type {'sync'|'pull'} */ op) {
  if (isConflict(uiStatus(b.status))) { ui.openConflict(props.path); return; }
  busy[b.target] = op;
  try { await runBindingOp(app, ui, props.path, b, op); } finally { delete busy[b.target]; }
}

async function setAuto(/** @type {any} */ b, /** @type {boolean} */ on) {
  busy[b.target] = 'auto';
  try { await setAutoSync(app, ui, props.path, b, on); } finally { delete busy[b.target]; }
}

async function follow(/** @type {any} */ b) {
  busy[b.target] = 'follow';
  try { await followBinding(app, ui, props.path, b); } finally { delete busy[b.target]; }
}

async function copyPath() {
  await copyPathToast(abs.value, ui.toast);
}

// ---- remove from workspace (two steps: 移除… then 确认移除) ----
const removing = ref(false);
const keepFiles = ref(false);
const removeBusy = ref(false);
watch(() => props.path, () => { removing.value = false; keepFiles.value = false; });

async function confirmRemove() {
  removeBusy.value = true;
  try { if (await removeItem(app, ui, props.path, keepFiles.value)) removing.value = false; } finally { removeBusy.value = false; }
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
          <div v-if="b.pinned" class="sync-note sync-pin" :title="PIN_TIP">
            <Icon name="pin" size="sm" /><span class="grow">{{ pinText(b.pinned) }}</span>
            <button class="btn sm" :disabled="!!busy[b.target]" @click="follow(b)">跟随最新</button>
          </div>
          <a v-else-if="b.deployed" class="sync-note sync-dep" href="#/history" title="在版本历史中查看"><Icon name="history" size="sm" />酒馆中是版本 <span class="mono">{{ b.deployed.slice(0, 8) }}</span></a>
          <div v-if="isConflict(uiStatus(b.status))" class="sync-note err">
            <Icon name="alert" size="sm" /><span class="grow">两边都改了同一处</span>
            <a v-if="ui.route.name !== 'conflict'" href="#" @click.prevent="ui.openConflict(props.path)">处理冲突</a>
          </div>
          <div class="sync-ops">
            <Toggle
              sync
              :model-value="b.autoSync"
              label="随时同步"
              :disabled="!!busy[b.target] || !!b.pinned"
              :title="b.pinned ? '固定在某个版本时不自动同步' : '修改后自动同步到此酒馆'"
              @update:model-value="(v) => setAuto(b, v)"
            />
            <span class="grow" />
            <button class="btn sm" :disabled="!canAct(b) || !!busy[b.target]" :title="b.pinned ? '把酒馆里在推送版本之后的修改合并进工作区，并改为跟随最新' : '从酒馆取回，覆盖工作区'" @click="run(b, 'pull')">
              <Icon :name="busy[b.target] === 'pull' ? 'spin' : 'download'" size="sm" />取回
            </button>
            <button
              v-if="!b.pinned"
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

      <CardParts v-if="item.kind === 'character'" :item="item" />

      <section class="insp-sec">
        <h4>文件位置</h4>
        <div class="path-box mono" :title="abs">{{ path }}/</div>
        <div class="insp-btns">
          <template v-if="desktop.available">
            <button class="btn sm" @click="openNative('showInFolder', abs, ui.toast)"><Icon name="folderOpen" size="sm" />在资源管理器中显示</button>
            <button v-if="editor !== 'vscode'" class="btn sm" title="用系统默认程序打开这个文件夹（可在设置中改为 VS Code）" @click="openExternalEditor(abs, editor, ui.toast)"><Icon name="external" size="sm" />打开文件夹</button>
          </template>
          <button v-if="editor === 'vscode'" class="btn sm" title="在 VS Code 中打开这个文件夹" @click="openExternalEditor(abs, editor, ui.toast)"><Icon name="code" size="sm" />在 VS Code 中打开</button>
          <button class="btn sm" :title="abs" @click="copyPath"><Icon name="copy" size="sm" />复制路径</button>
        </div>
        <dl class="kv" style="margin-top: 10px">
          <dt>类型</dt><dd>{{ kindOf(item.kind).type }}</dd>
          <dt>绑定</dt><dd>{{ item.bindings.length }} 个酒馆</dd>
        </dl>
      </section>

      <section class="insp-sec">
        <h4>移除</h4>
        <button v-if="!removing" class="btn sm" title="不再在工作区里管理这一项" @click="removing = true"><Icon name="trash" size="sm" />从工作区移除…</button>
        <div v-else class="insp-remove">
          <p class="faint">只从工作区移除：酒馆里的内容不受影响，之前的版本仍在版本历史中。文件夹里你自己的笔记会保留。</p>
          <label class="insp-check"><input v-model="keepFiles" type="checkbox" />保留文件夹里的全部文件</label>
          <div class="insp-btns">
            <button class="btn sm danger" :disabled="removeBusy" @click="confirmRemove"><Icon :name="removeBusy ? 'spin' : 'trash'" size="sm" />确认移除</button>
            <button class="btn sm ghost" :disabled="removeBusy" @click="removing = false">取消</button>
          </div>
        </div>
      </section>
    </div>
  </aside>
</template>
