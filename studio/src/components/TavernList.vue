<script setup>
// 本机酒馆 list: shared by 设置 → 连接 and the wizard's 连接酒馆 step.
// Source of truth = /api/taverns/locations (configured dirs) + /api/detect (running / plugin / offline state).
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import Toggle from './Toggle.vue';
import Seg from './Seg.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { errorText } from '../api.js';
import { desktop } from '../lib/desktop.js';
import { HOST, OFF_MODE, PLUGIN_HINT, ONCE_HINT, REPO_URL, STALE_HINT } from '../lib/status.js';

const app = useApp();
const ui = useUi();
const saving = ref(false);
/** inline "add / set directory" input: { host, value, port? } */
const adding = ref(/** @type {null | {host:'st'|'tt', value:string, data?:string, port?:number}} */ (null));
/** @type {import('vue').Ref<Record<string, boolean>>} */
const open = ref({});

const locs = computed(() => (app.locations && app.locations.locations) || { st: [], tt: [] });
const resolved = computed(() => (app.locations && app.locations.resolved) || []);
const det = computed(() => app.detect || { st: { instances: [], unconfigured: [], otherConnections: [] }, tt: { instances: [], otherConnections: [] } });

const OFF_OPTS = [{ value: 'wait', label: OFF_MODE.wait.label }, { value: 'write', label: OFF_MODE.write.label }];

function clone() { return JSON.parse(JSON.stringify(locs.value)); }

/** Merge one configured location with its resolution and detection result. */
function inst(/** @type {'st'|'tt'} */ host, /** @type {number} */ i) {
  const key = host + ':' + i;
  const loc = locs.value[host][i] || {};
  const r = resolved.value.find((x) => x.key === key) || {};
  const d = (det.value[host].instances || []).find((x) => x.key === key) || {};
  const targetId = d.targetId || r.targetId || null;
  const lt = targetId ? (app.status.targets || []).find((t) => t.id === targetId) : null;
  const live = !!lt;
  const stale = !!lt && lt.responsive === false;
  return {
    key, host, loc, r, d, targetId, live, stale,
    label: d.label || r.label || (host === 'st' ? 'SillyTavern' : 'TauriTavern'),
    version: d.version || '',
    running: !!d.running,
    plugin: d.plugin,
    offlineReady: !!d.offlineReady,
    offlineSync: loc.offlineSync || r.offlineSync || d.offlineSync || 'wait',
    error: d.error || r.error || null,
    users: d.users || r.users || [],
    user: loc.user || d.user || r.user || '',
    userDir: d.userDir || r.userDir || '',
    dataRoot: d.dataRoot || r.dataRoot || '',
    port: d.port || null
  };
}

const stList = computed(() => locs.value.st.map((_, i) => inst('st', i)));
const ttList = computed(() => locs.value.tt.map((_, i) => inst('tt', i)));

/** Running STs on known ports that have no directory configured yet. */
const stUnconfigured = computed(() => (det.value.st.unconfigured || []).map((u) => {
  const conn = (det.value.st.otherConnections || []).find((c) => c.origin === u.url);
  const lt = conn ? (app.status.targets || []).find((t) => t.id === conn.id) : null;
  return { ...u, connected: !!lt, stale: !!lt && lt.responsive === false };
}));
/** Connected via Cellar Link only, not matching any running port we know. */
const stLinkOnly = computed(() => (det.value.st.otherConnections || []).filter((c) => !stUnconfigured.value.some((u) => u.url === c.origin)));
const ttLinkOnly = computed(() => det.value.tt.otherConnections || []);

async function save(/** @type {any} */ next, /** @type {string} */ msg) {
  saving.value = true;
  try {
    await app.saveLocations(next);
    if (msg) ui.toast(msg);
    return true;
  } catch (e) {
    ui.toast(errorText(e), 'alert');
    return false;
  } finally {
    saving.value = false;
  }
}

async function edit(/** @type {'st'|'tt'} */ host, /** @type {number} */ i, /** @type {string} */ field, /** @type {string} */ value) {
  const next = clone();
  if ((next[host][i][field] || '') === value) return;
  next[host][i][field] = value || undefined;
  if (field === 'dir') delete next[host][i].user;
  await save(next, '已保存');
}

async function browse(/** @type {'st'|'tt'} */ host, /** @type {number} */ i, /** @type {string} */ field) {
  const p = await desktop.pickDirectory();
  if (p) await edit(host, i, field, p);
}

async function remove(/** @type {'st'|'tt'} */ host, /** @type {number} */ i) {
  const next = clone();
  next[host].splice(i, 1);
  await save(next, '已移除');
}

function startAdd(/** @type {'st'|'tt'} */ host, /** @type {number} */ [port] = []) {
  adding.value = { host, value: '', data: host === 'tt' ? (app.locations && app.locations.detectedTtDataRoot) || '' : undefined, port };
}

async function pickAdd(/** @type {'value'|'data'} */ field) {
  const p = await desktop.pickDirectory();
  if (p && adding.value) adding.value[field] = p;
}

async function commitAdd() {
  const a = adding.value;
  if (!a) return;
  const next = clone();
  if (a.host === 'st') {
    if (!a.value.trim()) { ui.toast('请填写 SillyTavern 安装目录', 'alert'); return; }
    next.st.push({ dir: a.value.trim() });
  } else {
    if (!a.data || !a.data.trim()) { ui.toast('请填写 TauriTavern 数据目录', 'alert'); return; }
    next.tt.push({ install: a.value.trim() || undefined, data: a.data.trim() });
  }
  if (await save(next, '已添加')) adding.value = null;
}

async function autoTt(/** @type {number} */ i) {
  const root = app.locations && app.locations.detectedTtDataRoot;
  if (!root) { ui.toast('没有找到 TauriTavern 的上次运行记录', 'alert'); return; }
  await edit('tt', i, 'data', root);
}

async function setOff(/** @type {any} */ x, /** @type {'wait'|'write'} */ mode) {
  try {
    await app.setOfflineSync(x.key, mode);
    ui.toast(x.label + '：' + OFF_MODE[mode].label);
  } catch (e) { ui.toast(errorText(e), 'alert'); }
}

async function accept(/** @type {'st'|'tt'} */ host, /** @type {boolean} */ on) {
  try {
    await app.setAccept(host, on);
    ui.toast(HOST[host].name + (on ? ' 已开启' : ' 已关闭：Studio 不再连接或读取它'));
  } catch (e) { ui.toast(errorText(e), 'alert'); }
}

const isOpen = (/** @type {any} */ x) => open.value[x.key] !== undefined ? open.value[x.key] : x.live || x.running || !!x.error || !x.plugin;
const toggleOpen = (/** @type {any} */ x) => { open.value = { ...open.value, [x.key]: !isOpen(x) }; };
const counts = (/** @type {any} */ x) => (x.d && x.d.counts) || null;
</script>

<template>
  <div class="dt-list">
    <!-- ===== SillyTavern ===== -->
    <section v-for="host in ['st', 'tt']" :key="host" class="dt-card card" :class="{ refused: !app.taverns[host] }">
      <div class="dt-head">
        <span class="host-mark lg">{{ HOST[host].mark }}</span>
        <b>{{ HOST[host].name }}</b>
        <span class="grow" />
        <Toggle :model-value="app.taverns[host]" label="接受连接" @update:model-value="(v) => accept(host, v)" />
      </div>

      <div v-if="app.taverns[host]" class="dt-body">
        <!-- configured locations -->
        <div v-for="(x, i) in host === 'st' ? stList : ttList" :key="x.key" class="dt-inst" :class="{ collapsed: !isOpen(x) }">
          <div class="dt-inst-head">
            <button class="icon-btn dt-chev" :title="isOpen(x) ? '收起' : '展开'" @click="toggleOpen(x)"><Icon :name="isOpen(x) ? 'chevDown' : 'chevRight'" size="sm" /></button>
            <b>{{ x.label }}</b><span v-if="x.version" class="faint mono">v{{ x.version }}</span>
            <div class="dt-pills">
              <span class="dt-pill" :class="x.running ? 'ok' : 'dim'"><span class="dot" :class="x.running ? 'on' : 'off'" />{{ x.running ? '运行中' : '未运行' }}</span>
              <span v-if="x.plugin === false" class="dt-pill warn"><Icon name="alert" size="sm" />Cellar Link 未安装</span>
              <span v-else-if="x.plugin" class="dt-pill ok"><Icon name="puzzle" size="sm" />Cellar Link 已安装</span>
              <span v-if="x.stale" class="dt-pill stale" :title="STALE_HINT"><span class="dot stale" />无响应</span>
              <span v-else-if="x.live" class="dt-pill ok"><Icon name="plug" size="sm" />已连接</span>
              <span v-else-if="x.running" class="dt-pill wait"><span class="dot wait" />等待连接…</span>
              <span class="dt-pill" :class="x.offlineReady ? 'info' : 'dim'">{{ x.offlineReady ? '离线可用' : '离线不可用' }}</span>
            </div>
            <span class="grow" />
            <button class="icon-btn" title="移除" :disabled="saving" @click="remove(host, i)"><Icon name="trash" size="sm" /></button>
          </div>

          <div v-if="isOpen(x)" class="dt-inst-body">
            <div v-if="host === 'st'" class="dt-fields two">
              <div class="dt-field">
                <label>安装目录</label>
                <div class="dt-path">
                  <input class="input mono" :value="x.loc.dir" placeholder="例如 D:\SillyTavern" spellcheck="false" @change="edit('st', i, 'dir', /** @type {any} */ ($event.target).value.trim())" />
                  <button v-if="desktop.available" class="btn sm" @click="browse('st', i, 'dir')">浏览…</button>
                </div>
              </div>
              <div class="dt-field">
                <label>用户</label>
                <select class="select" :value="x.user" :disabled="x.users.length < 2" @change="edit('st', i, 'user', /** @type {any} */ ($event.target).value)">
                  <option v-if="!x.users.length" :value="x.user">{{ x.user || '—' }}</option>
                  <option v-for="u in x.users" :key="u" :value="u">{{ u }}</option>
                </select>
              </div>
            </div>
            <div v-else class="dt-fields two">
              <div class="dt-field">
                <label>安装目录 <span class="faint">（可选）</span></label>
                <div class="dt-path">
                  <input class="input mono" :value="x.loc.install || ''" placeholder="例如 D:\TauriTavern" spellcheck="false" @change="edit('tt', i, 'install', /** @type {any} */ ($event.target).value.trim())" />
                  <button v-if="desktop.available" class="btn sm" @click="browse('tt', i, 'install')">浏览…</button>
                </div>
              </div>
              <div class="dt-field">
                <label>数据目录</label>
                <div class="dt-path">
                  <input class="input mono" :value="x.loc.data || ''" placeholder="TauriTavern 的数据目录" spellcheck="false" @change="edit('tt', i, 'data', /** @type {any} */ ($event.target).value.trim())" />
                  <button v-if="desktop.available" class="btn sm" @click="browse('tt', i, 'data')">浏览…</button>
                  <button class="btn sm" title="读取 TauriTavern 上次运行记录" @click="autoTt(i)">自动识别</button>
                </div>
              </div>
            </div>

            <div v-if="x.error" class="dt-warn"><Icon name="alert" size="sm" />{{ x.error }}</div>
            <div v-else-if="x.userDir" class="dt-derived faint">
              <template v-if="counts(x)">已找到 {{ counts(x).lorebooks }} 本世界书 · {{ counts(x).characters }} 个角色 · </template>
              数据目录 <span class="mono">{{ x.userDir }}</span><template v-if="x.port"> · 端口 {{ x.port }}</template>
            </div>
            <div v-if="x.plugin === false" class="dt-warn"><Icon name="alert" size="sm" />未安装 Cellar Link：{{ PLUGIN_HINT }} <span class="mono">{{ REPO_URL }}</span></div>

            <div class="dt-off" :class="{ dis: !x.offlineReady }">
              <span class="dt-off-label">酒馆未运行时</span>
              <Seg :model-value="x.offlineSync" :options="OFF_OPTS" :disabled="!x.offlineReady || saving" @update:model-value="(v) => setOff(x, v)" />
              <div class="dt-off-hint faint">{{ x.offlineReady ? OFF_MODE[x.offlineSync].hint : '离线不可用：' + ONCE_HINT }}</div>
            </div>
          </div>
        </div>

        <!-- ST running without a configured directory -->
        <template v-if="host === 'st'">
          <div v-for="u in stUnconfigured" :key="u.url" class="dt-inst link-only">
            <div class="dt-inst-head">
              <b>SillyTavern (:{{ u.port }})</b><span class="faint mono">{{ u.url }}</span>
              <div class="dt-pills">
                <span class="dt-pill ok"><span class="dot on" />运行中</span>
                <span v-if="u.stale" class="dt-pill stale" :title="STALE_HINT"><span class="dot stale" />无响应</span>
                <span v-else-if="u.connected" class="dt-pill ok"><Icon name="plug" size="sm" />已连接</span>
                <span v-else class="dt-pill wait"><span class="dot wait" />等待连接…</span>
              </div>
              <span class="grow" />
              <button class="btn sm" @click="startAdd('st', [u.port])">设置目录…</button>
            </div>
            <div class="dt-inst-head faint">设置安装目录后，酒馆未运行时也能浏览与取出。</div>
          </div>
          <div v-for="c in stLinkOnly" :key="c.id" class="dt-inst link-only">
            <div class="dt-inst-head">
              <b>{{ c.label }}</b><span class="faint mono">{{ c.origin }}</span>
              <div class="dt-pills"><span class="dt-pill ok"><Icon name="plug" size="sm" />已连接</span></div>
              <span class="grow" />
              <button class="btn sm" @click="startAdd('st')">设置目录…</button>
            </div>
            <div class="dt-inst-head faint">只通过 Cellar Link 连接；设置目录后酒馆未运行时也能浏览与取出。</div>
          </div>
        </template>
        <template v-else>
          <div v-for="c in ttLinkOnly" :key="c.id" class="dt-inst link-only">
            <div class="dt-inst-head">
              <b>{{ c.label }}</b>
              <div class="dt-pills"><span class="dt-pill ok"><Icon name="plug" size="sm" />已连接</span></div>
            </div>
          </div>
        </template>

        <div v-if="!(host === 'st' ? stList.length + stUnconfigured.length + stLinkOnly.length : ttList.length + ttLinkOnly.length)" class="dt-empty faint">
          没有找到 {{ HOST[host].name }}。启动酒馆后会自动连接，或手动添加安装位置。
        </div>

        <!-- add -->
        <div v-if="adding && adding.host === host" class="dt-inst dt-adding">
          <div class="dt-fields" :class="{ two: host === 'tt' }">
            <div class="dt-field">
              <label>{{ host === 'st' ? 'SillyTavern 安装目录' : '安装目录（可选）' }}<template v-if="adding.port"> · 端口 {{ adding.port }}</template></label>
              <div class="dt-path">
                <input v-model="adding.value" class="input mono" :placeholder="host === 'st' ? '例如 D:\\SillyTavern' : '例如 D:\\TauriTavern'" spellcheck="false" @keydown.enter="commitAdd" />
                <button v-if="desktop.available" class="btn sm" @click="pickAdd('value')">浏览…</button>
              </div>
            </div>
            <div v-if="host === 'tt'" class="dt-field">
              <label>数据目录</label>
              <div class="dt-path">
                <input v-model="adding.data" class="input mono" placeholder="TauriTavern 的数据目录" spellcheck="false" @keydown.enter="commitAdd" />
                <button v-if="desktop.available" class="btn sm" @click="pickAdd('data')">浏览…</button>
              </div>
            </div>
          </div>
          <div class="dt-add-ops">
            <button class="btn sm ghost" @click="adding = null">取消</button>
            <button class="btn sm primary" :disabled="saving" @click="commitAdd"><Icon :name="saving ? 'spin' : 'check'" size="sm" />添加</button>
          </div>
        </div>
        <button v-else class="dt-add" @click="startAdd(host)"><Icon name="plus" size="sm" />添加 {{ HOST[host].name }}</button>
      </div>
      <div v-else class="dt-body faint dt-closed">已关闭：Studio 不连接、也不读取 {{ HOST[host].name }}。</div>
    </section>

    <div class="dt-note faint">
      <Icon name="info" size="sm" />
      <div>关闭「接受连接」= Studio 不再连接、也不再读取该酒馆。未运行的酒馆可离线浏览、取出与取回；写入酒馆文件取决于每个酒馆的「酒馆未运行时」设置。{{ ONCE_HINT }}。</div>
    </div>
  </div>
</template>
