<script setup>
import { computed, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import Toggle from './Toggle.vue';
import StatusBadge from './StatusBadge.vue';
import CardParts from './card/CardParts.vue';
import PublishPanel from './PublishPanel.vue';
import { kindOf } from '../lib/kinds.js';
import { useApp } from '../stores/app.js';
import { useUi, historyHref } from '../stores/ui.js';
import { runBindingOp, setAutoSync, canReach, followBinding, pinText, PIN_TIP, editStep, renameBlocked } from '../lib/syncOps.js';
import { desktop, joinPath, openNative, openExternalEditor, copyPathToast } from '../lib/desktop.js';
import { uiStatus, isConflict, hasChanges, HOST, MODE_LABEL, MODE_TIP, MODE_DOT, OFF_MODE, STATUS, STALE_HINT } from '../lib/status.js';

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

watch(() => props.path, () => { armedRevert.value = false; });

// ---- 撤回 / 取消撤回 / 撤销当前的修改 (docs/versioning.md §6) ----
const stepBusy = ref('');
const armedRevert = ref(false);
const edits = computed(() => (item.value && item.value.edits) || { undo: false, redo: false });
const inDraft = computed(() => app.inDraft(props.path));
async function step(/** @type {'undo'|'redo'|'revert'} */ op) {
  if (op === 'revert' && !armedRevert.value) { armedRevert.value = true; return; }
  armedRevert.value = false;
  stepBusy.value = op;
  try { await editStep(app, ui, props.path, op); } finally { stepBusy.value = ''; }
}

// 「改名…」: bound characters and lorebooks (renamed in their taverns, RenameDialog).
const renamable = computed(() => !!item.value && (item.value.kind === 'character' || item.value.kind === 'lorebook') && item.value.bindings.length > 0);
const renameWhyNot = computed(() => (renamable.value ? renameBlocked(app, item.value) : ''));

</script>

<template>
  <aside class="inspector">
    <div class="panel-head">检查栏<span class="spacer" /><button class="icon-btn" title="收起" @click="ui.toggleInspector()"><Icon name="x" size="sm" /></button></div>
    <div v-if="item" class="insp-scroll">
      <section class="insp-sec">
        <h4>同步状态</h4>
        <div v-if="!item.bindings.length" class="faint" style="font-size: var(--fs-sm)">没有绑定任何酒馆。</div>
        <PublishPanel v-if="!item.bindings.length" :path="path" />
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
          <a v-else-if="b.deployed" class="sync-note sync-dep" :href="historyHref(props.path)" title="在版本历史中查看这一项"><Icon name="history" size="sm" />酒馆中是版本 <span class="mono">{{ b.deployed.slice(0, 8) }}</span></a>
          <a v-if="hasChanges(uiStatus(b.status))" class="sync-note sync-dep" href="#" title="列出上次同步之后改动的地方" @click.prevent="ui.changesAsk = { path: props.path, target: b.target }"><Icon name="eye" size="sm" />查看差异</a>
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

      <section class="insp-sec">
        <h4>修改</h4>
        <div class="insp-btns">
          <button class="btn sm" :disabled="!edits.undo || !!stepBusy" title="撤回在 Cellar 中对这一项的上一次修改（如新建、删除、改动条目）" @click="step('undo')"><Icon :name="stepBusy === 'undo' ? 'spin' : 'undo'" size="sm" />撤回</button>
          <button class="btn sm" :disabled="!edits.redo || !!stepBusy" title="重新应用刚才撤回的修改" @click="step('redo')"><Icon :name="stepBusy === 'redo' ? 'spin' : 'redo'" size="sm" />取消撤回</button>
        </div>
        <div class="insp-btns" style="margin-top: 6px">
          <button
            class="btn sm"
            :class="{ danger: armedRevert }"
            :disabled="!inDraft || !!stepBusy"
            :title="inDraft ? '把这一项恢复成最近一次记录的版本（还没记录过版本时，恢复成刚取出 / 新建时的样子），放弃草稿里对它的修改（之后仍可撤回）' : '这一项没有未记录的修改'"
            @click="step('revert')"
          >
            <Icon :name="stepBusy === 'revert' ? 'spin' : 'revert'" size="sm" />{{ armedRevert ? '确定撤销当前的修改？' : '撤销当前的修改' }}
          </button>
          <button v-if="armedRevert" class="btn sm ghost" @click="armedRevert = false">取消</button>
        </div>
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
          <button class="btn sm" title="把这一项移到项目文件夹（如把角色卡和它的世界书放在一起），或移回默认文件夹" @click="ui.moveAsk = path"><Icon name="folderOpen" size="sm" />移到项目…</button>
          <button
            v-if="renamable"
            class="btn sm"
            :disabled="!!renameWhyNot"
            :title="renameWhyNot || '在绑定的酒馆里改名（和在酒馆里改名一样），以旧名称命名的文件夹跟着改名'"
            @click="ui.renameAsk = path"
          ><Icon name="edit" size="sm" />改名…</button>
        </div>
        <dl class="kv" style="margin-top: 10px">
          <dt>类型</dt><dd>{{ kindOf(item.kind).type }}</dd>
          <dt>项目</dt><dd>{{ item.project || '无（默认文件夹）' }}</dd>
          <dt>绑定</dt><dd>{{ item.bindings.length }} 个酒馆</dd>
        </dl>
      </section>

      <section class="insp-sec">
        <h4>移除</h4>
        <button class="btn sm" title="不再在工作区里管理这一项" @click="ui.removeAsk = path"><Icon name="trash" size="sm" />从工作区移除…</button>
      </section>
    </div>
  </aside>
</template>
