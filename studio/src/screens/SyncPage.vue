<script setup>
// S4: sync matrix (docs/studio-design.md §4.5). Rows = workspace items, columns = every known tavern; a cell is that
// item's binding to that tavern. Sync / pull / auto-sync / unbind share their logic with the inspector (lib/syncOps).
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import Toggle from '../components/Toggle.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useApp } from '../stores/app.js';
import { useUi, hrefOf } from '../stores/ui.js';
import {
  uiStatus, isConflict, itemName, hueOf, initialOf, relTime,
  HOST, STATUS, MODE_DOT, MODE_LABEL, MODE_TIP, OFF_MODE, STALE_HINT
} from '../lib/status.js';
import { runBindingOp, setAutoSync, unbindBinding, canReach, bindItem } from '../lib/syncOps.js';
import { api, errorText } from '../api.js';

const app = useApp();
const ui = useUi();

const onlyIssues = ref(localStorage.getItem('cs.sync.onlyIssues') === '1');
function setOnlyIssues(/** @type {boolean} */ v) { onlyIssues.value = v; localStorage.setItem('cs.sync.onlyIssues', v ? '1' : '0'); }

/** Column access mode of a tavern, independent of any binding. */
function colMode(/** @type {any} */ t) {
  if (t.host && app.taverns[t.host] === false) return 'closed';
  if (t.live) return t.responsive === false ? 'stale' : 'online';
  if (t.offline) return 'offline';
  return 'none';
}
const columns = computed(() => app.targets.map((t) => ({ ...t, mode: colMode(t), name: app.targetName(t.id) })));

const bindingOf = (/** @type {any} */ it, /** @type {string} */ id) => (it.bindings || []).find((/** @type {any} */ b) => b.target === id) || null;
const hasIssue = (/** @type {any} */ it) => !!it.error || (it.bindings || []).some((/** @type {any} */ b) => b.status !== 'in-sync' || (b.warnings && b.warnings.length) || b.tavernError || b.waiting);
const rows = computed(() => {
  const list = onlyIssues.value ? app.items.filter(hasIssue) : app.items;
  return list.map((/** @type {any} */ it) => ({ it, name: itemName(it.path), warned: (it.bindings || []).filter((/** @type {any} */ b) => b.warnings && b.warnings.length) }));
});
const issueCount = computed(() => app.items.filter(hasIssue).length);

const KIND = { character: { label: '角色', icon: 'user' }, lorebook: { label: '世界书', icon: 'book' } };
const kindOf = (/** @type {string} */ k) => KIND[k] || { label: k, icon: 'box' };
const avatarStyle = (/** @type {string} */ name) => {
  const h = hueOf(name);
  return { background: `linear-gradient(135deg, hsl(${h} 55% 52%), hsl(${(h + 40) % 360} 60% 40%))` };
};

// ---- per-cell actions ----------------------------------------------------
/** @type {Record<string, string>} key path|target -> running op */
const busy = reactive({});
const keyOf = (/** @type {string} */ path, /** @type {any} */ b) => path + '|' + b.target;
/** cell awaiting the second click of 解除绑定 */
const armed = ref('');

async function run(/** @type {string} */ path, /** @type {any} */ b, /** @type {'sync'|'pull'} */ op) {
  const k = keyOf(path, b);
  busy[k] = op;
  try { await runBindingOp(app, ui, path, b, op); } finally { delete busy[k]; }
}
async function auto(/** @type {string} */ path, /** @type {any} */ b, /** @type {boolean} */ on) {
  const k = keyOf(path, b);
  busy[k] = 'auto';
  try { await setAutoSync(app, ui, path, b, on); } finally { delete busy[k]; }
}
async function unbind(/** @type {string} */ path, /** @type {any} */ b) {
  const k = keyOf(path, b);
  if (armed.value !== k) { armed.value = k; return; }
  armed.value = '';
  busy[k] = 'unbind';
  try { await unbindBinding(app, ui, path, b); } finally { delete busy[k]; }
}

// ---- bind an unbound cell to a tavern item (the way back from unbind) -------
/** cell (path|target) whose picker is open */
const picking = ref('');
const pickQuery = ref('');
/** @type {import('vue').Ref<any[]>} */
const pickResults = ref([]);
const pickError = ref('');
const pickBusy = ref(false);
let pickSeq = 0;
function openPick(/** @type {any} */ it, /** @type {any} */ c) {
  picking.value = it.path + '|' + c.id;
  pickQuery.value = itemName(it.path);
  searchPick(it, c);
}
async function searchPick(/** @type {any} */ it, /** @type {any} */ c) {
  const my = ++pickSeq;
  pickError.value = '';
  try {
    const r = /** @type {any} */ (await api.catalog({ target: c.id, kind: it.kind, query: pickQuery.value.trim() || undefined, limit: 20 }));
    if (my === pickSeq) pickResults.value = r.items || [];
  } catch (e) {
    if (my === pickSeq) { pickResults.value = []; pickError.value = errorText(e); }
  }
}
async function bindTo(/** @type {any} */ it, /** @type {any} */ c, /** @type {string} */ id) {
  pickBusy.value = true;
  try {
    if ((await bindItem(app, ui, it.path, c.id, id)) !== 'error') picking.value = '';
  } finally { pickBusy.value = false; }
}

/** Cell presentation for an existing binding. */
function cellView(/** @type {any} */ b) {
  const mode = app.modeOf(b);
  const status = uiStatus(b.status);
  const reach = canReach(mode);
  return {
    mode,
    status,
    reach,
    conflict: isConflict(status),
    /** when the tavern can't be reached, the status shown is the last known one */
    known: !reach && mode !== 'stale',
    sub: mode === 'offline' ? '离线 · ' + OFF_MODE[b.offlineSync || 'wait'].short : MODE_LABEL[mode],
    canSync: reach && (status === 'local' || status === 'invalid'),
    canPull: reach && (status === 'remote' || status === 'invalid')
  };
}

// ---- 同步全部本地修改到 ----------------------------------------------------
const bulkTarget = ref(localStorage.getItem('cs.sync.bulkTarget') || '');
const menuOpen = ref(false);
const bulk = reactive({ running: false, done: 0, total: 0 });
const localItems = (/** @type {string} */ id) => app.items.filter((/** @type {any} */ it) => { const b = bindingOf(it, id); return b && uiStatus(b.status) === 'local'; });
const bulkCol = computed(() => columns.value.find((c) => c.id === bulkTarget.value) || columns.value.find((c) => canReach(c.mode)) || columns.value[0] || null);
const bulkCount = computed(() => (bulkCol.value ? localItems(bulkCol.value.id).length : 0));
function pickBulk(/** @type {string} */ id) { bulkTarget.value = id; localStorage.setItem('cs.sync.bulkTarget', id); menuOpen.value = false; }

async function syncAll() {
  const col = bulkCol.value;
  if (!col || bulk.running) return;
  const list = localItems(col.id);
  if (!list.length) return;
  Object.assign(bulk, { running: true, done: 0, total: list.length });
  const n = { ok: 0, conflict: 0, error: 0 };
  try {
    for (const it of list) {
      const b = bindingOf(it, col.id);
      const k = keyOf(it.path, b);
      busy[k] = 'sync';
      try { n[await runBindingOp(app, ui, it.path, b, 'sync', { quiet: true })]++; } finally { delete busy[k]; bulk.done++; }
    }
  } finally {
    bulk.running = false;
    await app.refreshStatus();
  }
  const parts = [`${n.ok} 已同步`];
  if (n.conflict) parts.push(`${n.conflict} 冲突`);
  if (n.error) parts.push(`${n.error} 失败`);
  ui.toast(`同步到 ${col.name}：${parts.join('，')}`, n.conflict || n.error ? 'alert' : undefined);
}

function onDocClick(/** @type {MouseEvent} */ e) {
  const el = /** @type {HTMLElement} */ (e.target);
  if (menuOpen.value && !el.closest('.sx-split')) menuOpen.value = false;
  if (armed.value && !el.closest('.sx-unbind')) armed.value = '';
}
onMounted(() => document.addEventListener('mousedown', onDocClick));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick));

const LEGEND = ['synced', 'local', 'remote', 'conflict', 'unbound'];
const warnTime = (/** @type {any} */ b) => { const t = Date.parse(b.warnedAt || ''); return isNaN(t) ? '' : relTime(t); };
</script>

<template>
  <div class="page sx">
    <div class="page-head">
      <div>
        <h2>同步</h2>
        <p class="muted">每个资料项在每个酒馆的状态。冲突不会被静默覆盖，需要逐字段处理。</p>
      </div>
    </div>

    <div v-if="!app.items.length" class="empty">
      <Icon name="folder" />
      <h3>工作区还没有资料项</h3>
      <p class="muted">在资料库中把角色卡或世界书取出到工作区后，这里会显示它们在各个酒馆的同步状态。</p>
      <a class="btn" :href="hrefOf('library')"><Icon name="library" size="sm" />去资料库</a>
    </div>

    <div v-else-if="!columns.length" class="empty">
      <Icon name="plug" />
      <h3>还没有已知的酒馆</h3>
      <p class="muted">打开装有 Cellar Link 的酒馆页面，或在设置中填写酒馆目录。</p>
      <a class="btn" :href="hrefOf('settings')"><Icon name="settings" size="sm" />打开设置</a>
    </div>

    <template v-else>
      <div class="sx-bar">
        <Toggle :model-value="onlyIssues" :label="`只看有问题的项${issueCount ? ' (' + issueCount + ')' : ''}`" @update:model-value="setOnlyIssues" />
        <span class="grow" />
        <div class="sx-split btn-group">
          <button
            class="btn primary"
            :disabled="bulk.running || !bulkCol || !bulkCount || !canReach(bulkCol.mode)"
            :title="!bulkCol ? '' : !canReach(bulkCol.mode) ? MODE_TIP[bulkCol.mode] : !bulkCount ? '没有本地修改需要同步到这个酒馆' : ''"
            @click="syncAll()"
          >
            <Icon :name="bulk.running ? 'spin' : 'upload'" size="sm" />
            <template v-if="bulk.running">正在同步 {{ bulk.done }} / {{ bulk.total }}</template>
            <template v-else>同步全部本地修改到<span v-if="bulkCount" class="sx-count">{{ bulkCount }}</span></template>
          </button>
          <button class="btn sx-split-pick" :disabled="bulk.running" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
            <span class="sx-ellip">{{ bulkCol ? bulkCol.name : '选择酒馆' }}</span><Icon name="chevDown" size="sm" />
          </button>
          <div v-if="menuOpen" class="sx-menu" role="menu">
            <button v-for="c in columns" :key="c.id" class="sx-menu-item" :class="{ on: bulkCol && c.id === bulkCol.id }" role="menuitem" @click="pickBulk(c.id)">
              <span class="dot" :class="MODE_DOT[c.mode]" />
              <span class="grow sx-ellip">{{ c.name }}</span>
              <span class="faint">{{ localItems(c.id).length }} 项本地修改</span>
            </button>
          </div>
        </div>
      </div>

      <div class="legend">
        <StatusBadge v-for="s in LEGEND" :key="s" :status="s" />
        <span class="st closed"><Icon name="offline" />酒馆未连接</span>
        <span class="faint legend-off">离线 = 酒馆未运行，状态读取自数据目录</span>
      </div>

      <div v-if="onlyIssues && !rows.length" class="empty">
        <Icon name="ok" />
        <h3>没有需要处理的项</h3>
        <p class="muted">{{ app.items.length }} 个资料项都与绑定的酒馆一致。</p>
        <button class="btn" @click="setOnlyIssues(false)">显示全部</button>
      </div>

      <div v-else class="matrix-wrap card">
        <table class="matrix sx-matrix">
          <thead>
            <tr>
              <th class="item-col sx-sticky">资料项 <span class="faint">{{ rows.length }}</span></th>
              <th v-for="c in columns" :key="c.id" :class="'sx-col-' + c.mode">
                <div class="tv-head">
                  <span class="dot" :class="MODE_DOT[c.mode]" :title="MODE_TIP[c.mode]" />
                  <div class="sx-col-text">
                    <div class="sx-col-name">
                      <span class="sx-ellip" :title="c.name">{{ c.name }}</span>
                      <span v-if="c.host" class="hostmark">{{ HOST[c.host].mark }}</span>
                    </div>
                    <div class="faint">{{ MODE_LABEL[c.mode] }}<template v-if="c.mode === 'online' && c.hostVersion"> · v{{ c.hostVersion }}</template><template v-if="c.origin"> · {{ c.origin.replace(/^https?:\/\//, '') }}</template></div>
                  </div>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in rows" :key="r.it.path">
              <tr :class="{ 'sx-has-warn': r.warned.length }">
                <th scope="row" class="sx-sticky sx-item">
                  <a class="item-cell" :href="hrefOf('item:' + r.it.path)">
                    <span class="avatar sx-av" :style="avatarStyle(r.name)">{{ initialOf(r.name) }}</span>
                    <span class="sx-item-text">
                      <span class="item-name sx-ellip" :title="r.name">{{ r.name }}</span>
                      <span class="faint sx-item-sub"><Icon :name="kindOf(r.it.kind).icon" size="sm" />{{ kindOf(r.it.kind).label }} · <span class="mono">{{ r.it.path }}/</span></span>
                    </span>
                  </a>
                  <div v-if="r.it.error" class="sx-err"><Icon name="alert" size="sm" /><span>无法读取：{{ r.it.error }}</span></div>
                </th>

                <td v-for="c in columns" :key="c.id" class="cell" :class="(() => { const b = bindingOf(r.it, c.id); if (!b) return 'unbound'; const v = cellView(b); return { conflict: v.conflict && v.reach, 'is-off': !v.reach }; })()">
                  <template v-if="!bindingOf(r.it, c.id)">
                    <div class="cell-main">
                      <StatusBadge status="unbound" title="取出或绑定到这个酒馆中的对应项后才会同步" />
                      <button v-if="canReach(c.mode) && picking !== r.it.path + '|' + c.id" class="btn sm ghost sx-bind" title="把这个资料项绑定到酒馆中已有的一项；两边一致即为已同步，不同则先选择保留哪一边" @click="openPick(r.it, c)"><Icon name="link" size="sm" />绑定…</button>
                    </div>
                    <div v-if="picking === r.it.path + '|' + c.id" class="sx-pick">
                      <div class="sx-pick-bar">
                        <input v-model="pickQuery" class="input sm" placeholder="搜索酒馆中的名称" @keydown.enter="searchPick(r.it, c)" @keydown.esc="picking = ''" />
                        <button class="btn sm ghost" @click="searchPick(r.it, c)"><Icon name="search" size="sm" /></button>
                        <button class="btn sm ghost" title="取消" @click="picking = ''"><Icon name="x" size="sm" /></button>
                      </div>
                      <div v-if="pickError" class="sx-err"><Icon name="alert" size="sm" /><span>{{ pickError }}</span></div>
                      <div v-else-if="!pickResults.length" class="faint sx-pick-empty">没有找到</div>
                      <button v-for="e in pickResults" :key="e.id" class="sx-pick-row" :disabled="pickBusy || !!e.checkedOut" :title="e.checkedOut ? '已绑定在 ' + e.checkedOut : e.id" @click="bindTo(r.it, c, e.id)">
                        <span class="sx-ellip">{{ e.name || e.id }}</span>
                        <span v-if="e.checkedOut" class="faint sx-ellip">已绑定</span>
                      </button>
                    </div>
                  </template>

                  <template v-else v-for="b in [bindingOf(r.it, c.id)]" :key="b.target">
                    <template v-for="v in [cellView(b)]" :key="v.mode">
                      <div class="cell-main">
                        <template v-if="v.reach">
                          <StatusBadge :status="v.status" :label="v.mode === 'offline' ? STATUS[v.status].label + ' · 离线' : ''" />
                        </template>
                        <template v-else>
                          <span class="st closed" :title="MODE_TIP[v.mode]"><Icon :name="v.mode === 'stale' ? 'wait' : 'offline'" />{{ v.mode === 'stale' ? '酒馆无响应' : v.mode === 'closed' ? '已关闭' : '酒馆未连接' }}</span>
                          <span class="cell-sub">上次已知：{{ STATUS[v.status].label }}</span>
                        </template>
                        <span v-if="v.mode === 'stale'" class="cell-sub">{{ STALE_HINT }}</span>
                        <span v-else-if="v.mode === 'offline'" class="cell-sub">{{ v.sub }}</span>
                        <span v-if="b.waiting" class="cell-hint"><Icon name="wait" size="sm" />待同步：酒馆启动后自动同步</span>
                        <span v-if="b.tavernError" class="sx-err"><Icon name="alert" size="sm" /><span>{{ b.tavernError }}</span></span>
                      </div>

                      <div class="cell-ops">
                        <button v-if="v.conflict" class="btn sm primary" @click="ui.openConflict(r.it.path)"><Icon name="alert" size="sm" />处理冲突</button>
                        <template v-else>
                          <button class="btn sm" :disabled="!v.canSync || !!busy[keyOf(r.it.path, b)] || bulk.running" :title="!v.reach ? MODE_TIP[v.mode] : !v.canSync ? '没有本地修改需要同步' : '把工作区的修改写入酒馆'" @click="run(r.it.path, b, 'sync')">
                            <Icon :name="busy[keyOf(r.it.path, b)] === 'sync' ? 'spin' : 'upload'" size="sm" />同步
                          </button>
                          <button class="btn sm" :disabled="!v.canPull || !!busy[keyOf(r.it.path, b)] || bulk.running" :title="!v.reach ? MODE_TIP[v.mode] : !v.canPull ? '酒馆没有新的修改' : '从酒馆取回，覆盖工作区'" @click="run(r.it.path, b, 'pull')">
                            <Icon :name="busy[keyOf(r.it.path, b)] === 'pull' ? 'spin' : 'download'" size="sm" />取回
                          </button>
                        </template>
                        <span class="grow" />
                        <span class="sx-unbind" :class="{ armed: armed === keyOf(r.it.path, b) }">
                          <button
                            class="btn sm"
                            :class="armed === keyOf(r.it.path, b) ? 'danger sx-unbind-confirm' : 'ghost sx-icon'"
                            :disabled="!!busy[keyOf(r.it.path, b)] || bulk.running"
                            :title="armed === keyOf(r.it.path, b) ? '' : '解除绑定'"
                            :aria-label="armed === keyOf(r.it.path, b) ? '确认解除绑定' : '解除绑定'"
                            @click="unbind(r.it.path, b)"
                          >
                            <Icon :name="busy[keyOf(r.it.path, b)] === 'unbind' ? 'spin' : 'link'" size="sm" /><template v-if="armed === keyOf(r.it.path, b)">确认解除</template>
                          </button>
                        </span>
                      </div>
                      <div v-if="armed === keyOf(r.it.path, b)" class="sx-unbind-note">
                        只删除绑定记录：工作区文件和酒馆中的内容都会保留。再次点击「确认解除」生效。
                      </div>

                      <div class="cell-auto">
                        <Toggle
                          :model-value="!!b.autoSync"
                          sync
                          label="随时同步"
                          :disabled="!!busy[keyOf(r.it.path, b)] || v.mode === 'closed'"
                          :title="v.mode === 'closed' ? MODE_TIP.closed : '工作区或酒馆一有修改就自动同步（冲突除外）'"
                          @update:model-value="(on) => auto(r.it.path, b, on)"
                        />
                      </div>
                    </template>
                  </template>
                </td>
              </tr>

              <tr v-for="b in r.warned" :key="r.it.path + '|warn|' + b.target" class="warn-row">
                <td :colspan="columns.length + 1">
                  <details class="warn-note">
                    <summary>
                      <Icon name="alert" size="sm" />
                      <span class="sx-warn-head">
                        <b>{{ b.warnings[0] }}</b><template v-if="b.warnings.length > 1"> 等 {{ b.warnings.length }} 条提示</template>
                        <span class="faint">（{{ app.targetName(b.target) }} · 上次同步{{ warnTime(b) ? ' · ' + warnTime(b) : '' }}）</span>
                      </span>
                      <span class="faint sx-warn-toggle">展开查看<Icon name="chevDown" size="sm" /></span>
                    </summary>
                    <ul class="sx-warn-list">
                      <li v-for="(w, i) in b.warnings" :key="i" class="mono">{{ w }}</li>
                    </ul>
                    <div class="faint sx-warn-foot">下次与该酒馆同步一致后，这条提示会自动消失。</div>
                  </details>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
