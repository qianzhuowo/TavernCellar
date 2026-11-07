<script setup>
import { computed, ref, nextTick, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import Seg from './Seg.vue';
import StatusBadge from './StatusBadge.vue';
import { useApp } from '../stores/app.js';
import { useUi, hrefOf } from '../stores/ui.js';
import { useLibrary } from '../stores/library.js';
import { uiStatus, displayName, presetRef, HOST } from '../lib/status.js';
import { LIB_KINDS, libraryHref } from '../lib/kinds.js';
import { extractedOf } from '../lib/cardParts.js';
import { api, errorText } from '../api.js';
import { desktop, joinPath, openNative, openExternalEditor, copyPathToast } from '../lib/desktop.js';
import { editStep } from '../lib/syncOps.js';

const app = useApp();
const ui = useUi();
const lib = useLibrary();

const mode = computed(() => (ui.route.name === 'library' ? 'library' : ui.route.name === 'settings' ? 'settings' : 'tree'));

const groups = computed(() => [
  { key: 'character', title: '角色', icon: 'user', items: app.items.filter((i) => i.kind === 'character') },
  { key: 'lorebook', title: '世界书', icon: 'book', items: app.items.filter((i) => i.kind === 'lorebook') },
  { key: 'regex', title: '正则', icon: 'regex', items: app.items.filter((i) => i.kind === 'regex') },
  { key: 'preset', title: '预设', icon: 'sliders', items: app.items.filter((i) => i.kind === 'preset') }
]);

const SETTINGS_NAV = [
  { id: 'ws', icon: 'folder', label: '工作区' },
  { id: 'conn', icon: 'plug', label: '连接' },
  { id: 'editor', icon: 'palette', label: '外观' },
  { id: 'text', icon: 'code', label: '编辑器' },
  { id: 'history', icon: 'history', label: '版本历史' },
  { id: 'app', icon: 'box', label: '关于' }
];

/** A global regex item is named after its tavern: every tavern has exactly one. */
const regexName = (/** @type {any} */ it) => '全局正则' + (it.bindings?.length === 1 ? ' · ' + app.targetName(it.bindings[0].target) : '');
/**
 * A character's extracted 世界书 / 角色正则 shown under it; each opens that page of the card editor. The bound
 * lorebook is also its own item in the 世界书 group.
 * @param {any} it
 */
function subRows(it) {
  if (it.kind !== 'character' || it.error) return [];
  const ex = extractedOf(it);
  const rows = [];
  if (ex.has('character_book') && it.world?.name) rows.push({ view: 'world', icon: 'book', label: '世界书 · ' + it.world.name, title: it.world.path ? '绑定的世界书（工作区 ' + it.world.path + '）' : '绑定的世界书（尚未取出）' });
  if (ex.has('regex')) rows.push({ view: 'regex', icon: 'regex', label: '角色正则', title: '这张卡的角色正则' });
  return rows;
}
const hostMark = (/** @type {string} */ id) => { const t = app.target(id); return t.host ? HOST[t.host].mark : '?'; };
const sourceLabel = (/** @type {any} */ t) => app.targetName(t.id) + (t.live ? '' : ' (离线)');
// ---- 工作区「+」menu: take from the library, or make a new item in Cellar (POST /api/create) ----
const NEW_LABEL = /** @type {Record<string, string>} */ ({ character: '新建角色卡', lorebook: '新建世界书', regex: '新建正则脚本', preset: '新建预设' });
const KIND_TITLE = /** @type {Record<string, string>} */ ({ character: '角色', lorebook: '世界书', regex: '正则', preset: '预设' });
/** @type {import('vue').Ref<{kinds: string[], x: number, y: number} | null>} */
const menu = ref(null);
const naming = ref('');
const newName = ref('');
const menuBusy = ref(false);
const nameInput = ref(/** @type {HTMLInputElement|null} */ (null));
function openMenu(/** @type {MouseEvent} */ ev, /** @type {string[]} */ kinds) {
  const r = /** @type {HTMLElement} */ (ev.currentTarget).getBoundingClientRect();
  menu.value = menu.value && menu.value.kinds.join() === kinds.join() ? null : { kinds, x: r.right + 6, y: r.top };
  naming.value = '';
  newName.value = '';
}
function closeMenu() { menu.value = null; naming.value = ''; }
function onDocDown(/** @type {MouseEvent} */ ev) {
  const el = /** @type {HTMLElement} */ (ev.target);
  if (menu.value && !el.closest('.ws-menu') && !el.closest('.ws-add')) closeMenu();
  if (ctx.value && !el.closest('.ws-ctx')) closeCtx();
}
const closeCtx = () => { ctx.value = null; ctxArmed.value = false; };
const onKey = (/** @type {KeyboardEvent} */ ev) => { if (ev.key === 'Escape') { closeCtx(); if (menu.value && !naming.value) closeMenu(); } };
document.addEventListener('mousedown', onDocDown);
document.addEventListener('keydown', onKey);
window.addEventListener('blur', closeCtx);
window.addEventListener('resize', closeCtx);
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('blur', closeCtx);
  window.removeEventListener('resize', closeCtx);
});

// ---- right-click menu of a workspace item (same actions as the inspector) ----
/** @type {import('vue').Ref<{path: string, x: number, y: number} | null>} */
const ctx = ref(null);
const ctxArmed = ref(false);
const editor = computed(() => app.settings?.ui?.externalEditor || 'system');
function openCtx(/** @type {MouseEvent} */ ev, /** @type {string} */ path) {
  closeMenu();
  ctxArmed.value = false;
  // keep the menu inside the window (it is about 230 × 220 px)
  ctx.value = { path, x: Math.min(ev.clientX, window.innerWidth - 236), y: Math.min(ev.clientY, window.innerHeight - 230) };
}
async function ctxRun(/** @type {string} */ action) {
  const c = ctx.value;
  if (!c) return;
  // 撤销 takes two clicks, like the inspector: the first arms it and keeps the menu open
  if (action === 'revert' && !ctxArmed.value) { ctxArmed.value = true; return; }
  closeCtx();
  const abs = joinPath(app.workspace, c.path);
  if (action === 'reveal') await openNative('showInFolder', abs, ui.toast);
  else if (action === 'open') await openExternalEditor(abs, editor.value, ui.toast);
  else if (action === 'copy') await copyPathToast(abs, ui.toast);
  else if (action === 'revert') await editStep(app, ui, c.path, 'revert');
  else if (action === 'remove') ui.removeAsk = c.path;
}
async function pickNew(/** @type {string} */ kind) {
  if (kind === 'regex') { await newRegexScript(); return; }
  naming.value = kind;
  newName.value = '';
  await nextTick();
  nameInput.value?.focus();
}
async function createNamed() {
  const name = newName.value.trim();
  if (!name || menuBusy.value) return;
  menuBusy.value = true;
  try {
    const r = await api.createItem(naming.value, name);
    await app.refreshStatus();
    closeMenu();
    ui.openItem(r.path);
    ui.toast('已新建「' + name + '」，可在检查栏发布到酒馆');
  } catch (e) {
    ui.toast(errorText(e), 'alert');
  } finally { menuBusy.value = false; }
}
/** The workspace keeps one global regex list: open it (taking it from a connected tavern, or making it) and add a script. */
async function newRegexScript() {
  if (menuBusy.value) return;
  menuBusy.value = true;
  try {
    let path = app.items.find((/** @type {any} */ i) => i.kind === 'regex')?.path;
    if (!path) {
      const live = app.targets.find((/** @type {any} */ t) => t.live);
      path = live ? (await api.checkout(live.id, 'regex', 'global')).path : (await api.createItem('regex')).path;
      await app.refreshStatus();
    }
    closeMenu();
    ui.newScriptFor = path;
    ui.openItem(path);
  } catch (e) {
    ui.toast(errorText(e), 'alert');
  } finally { menuBusy.value = false; }
}
function jump(/** @type {string} */ id) {
  if (ui.route.name !== 'settings' || ui.route.arg !== id) ui.go('#/settings/' + id);
  const el = document.getElementById('set-' + id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
</script>

<template>
  <aside class="side">
    <!-- 资料库 filters -->
    <template v-if="mode === 'library'">
      <div class="panel-head">资料库</div>
      <div class="panel-body side-filters">
        <div class="field">
          <label>酒馆</label>
          <select class="select" :value="lib.target" :disabled="!lib.sources.length" @change="lib.setTarget(/** @type {any} */ ($event.target).value)">
            <option v-if="!lib.sources.length" value="">没有可浏览的酒馆</option>
            <option v-for="t in lib.sources" :key="t.id" :value="t.id">{{ sourceLabel(t) }}</option>
          </select>
        </div>
        <div class="field">
          <label>类型</label>
          <Seg :model-value="lib.kind" :options="LIB_KINDS" @update:model-value="(k) => ui.go(libraryHref(k))" />
        </div>
        <div v-if="lib.tags.length" class="field">
          <label>标签</label>
          <div class="tag-cloud">
            <span v-for="t in lib.tags" :key="t" class="chip tag" :class="{ on: lib.tag === t }" @click="lib.tag = lib.tag === t ? '' : t">{{ t }}</span>
          </div>
        </div>
        <div class="side-note faint"><Icon name="info" size="sm" />资料库只读浏览酒馆里的内容；取出后才会出现在工作区。</div>
      </div>
    </template>

    <!-- 设置 nav -->
    <template v-else-if="mode === 'settings'">
      <div class="panel-head">设置</div>
      <div class="panel-body">
        <div
          v-for="n in SETTINGS_NAV"
          :key="n.id"
          class="tree-item"
          :class="{ on: (ui.route.arg || 'ws') === n.id }"
          style="padding-left: 12px"
          tabindex="0"
          @click="jump(n.id)"
          @keydown.enter="jump(n.id)"
        >
          <Icon :name="n.icon" size="sm" /><span class="name">{{ n.label }}</span>
        </div>
      </div>
    </template>

    <!-- 工作区 tree -->
    <template v-else>
      <div class="panel-head">工作区<span class="spacer" /><button class="icon-btn ws-add" type="button" title="取出或新建" @click="openMenu($event, ['character', 'lorebook', 'regex', 'preset'])"><Icon name="plus" size="sm" /></button></div>
      <div class="panel-body">
        <div v-for="g in groups" :key="g.key" class="tree-group" :class="{ collapsed: ui.collapsed[g.key] }">
          <div class="tg-head" @click="ui.toggleGroup(g.key)">
            <Icon :name="ui.collapsed[g.key] ? 'chevRight' : 'chevDown'" size="sm" /><Icon :name="g.icon" size="sm" />{{ g.title }}<span class="count">{{ g.items.length }}</span><button class="tg-add icon-btn ws-add" type="button" :title="'取出或新建' + g.title" @click.stop="openMenu($event, [g.key])"><Icon name="plus" size="sm" /></button>
          </div>
          <template v-if="!ui.collapsed[g.key]">
            <template v-for="it in g.items" :key="it.path">
            <a
              class="tree-item"
              :class="{ on: ui.route.key === 'item:' + it.path }"
              :href="hrefOf('item:' + it.path)"
              :title="it.kind === 'preset' ? (presetRef(it.bindings?.[0]?.id)?.type || '') + ' · ' + it.path : it.path"
              @contextmenu.prevent="openCtx($event, it.path)"
            >
              <span class="name">{{ it.kind === 'regex' ? regexName(it) : displayName(it) }}</span>
              <span class="badges">
                <StatusBadge v-if="it.error" status="invalid" icon-only :title="it.error" />
                <StatusBadge
                  v-for="b in it.bindings"
                  v-else
                  :key="b.target"
                  :status="uiStatus(b.status)"
                  icon-only
                  :title="app.targetName(b.target) + ' (' + hostMark(b.target) + ')'"
                />
              </span>
            </a>
            <a
              v-for="s in subRows(it)"
              :key="s.view"
              class="tree-item tree-sub"
              :class="{ on: ui.route.key === 'item:' + it.path && (ui.itemView[it.path]?.view || 'form') === s.view }"
              :href="hrefOf('item:' + it.path)"
              :title="s.title"
              @click="ui.setItemView(it.path, s.view)"
              @contextmenu.prevent="openCtx($event, it.path)"
            >
              <Icon :name="s.icon" size="sm" /><span class="name">{{ s.label }}</span>
            </a>
            </template>
            <div v-if="!g.items.length" class="tree-empty faint">还没有{{ g.title }} · <a :href="libraryHref(g.key)">去资料库取出</a></div>
          </template>
        </div>
        <div class="tree-legend faint">徽标按绑定的酒馆依次排列，悬停查看酒馆名</div>
      </div>
      <Teleport to="body">
        <div v-if="menu" class="ws-menu" role="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
          <template v-if="!naming">
            <a v-for="k in menu.kinds" :key="'lib-' + k" class="ws-mi" role="menuitem" :href="libraryHref(k)" @click="closeMenu"><Icon name="download" size="sm" />从资料库导入{{ menu.kinds.length > 1 ? KIND_TITLE[k] : '' }}</a>
            <div class="ws-sep" />
            <button v-for="k in menu.kinds" :key="'new-' + k" class="ws-mi" role="menuitem" type="button" :disabled="menuBusy" @click="pickNew(k)"><Icon name="plus" size="sm" />{{ NEW_LABEL[k] }}</button>
          </template>
          <form v-else class="ws-name" @submit.prevent="createNamed">
            <label class="faint">{{ NEW_LABEL[naming] }} · 名称</label>
            <input ref="nameInput" v-model="newName" class="input" :placeholder="KIND_TITLE[naming] + '名称'" @keydown.esc="closeMenu" />
            <div class="ws-name-btns">
              <button class="btn sm" type="button" @click="naming = ''">返回</button>
              <button class="btn sm primary" type="submit" :disabled="menuBusy || !newName.trim()">{{ menuBusy ? '创建中…' : '创建' }}</button>
            </div>
          </form>
        </div>
        <div v-if="ctx" class="ws-menu ws-ctx" role="menu" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @contextmenu.prevent>
          <template v-if="desktop.available">
            <button class="ws-mi" role="menuitem" type="button" @click="ctxRun('reveal')"><Icon name="folderOpen" size="sm" />在资源管理器中显示</button>
          </template>
          <button v-if="desktop.available || editor === 'vscode'" class="ws-mi" role="menuitem" type="button" @click="ctxRun('open')"><Icon :name="editor === 'vscode' ? 'code' : 'external'" size="sm" />{{ editor === 'vscode' ? '在 VS Code 中打开' : '打开文件夹' }}</button>
          <button class="ws-mi" role="menuitem" type="button" @click="ctxRun('copy')"><Icon name="copy" size="sm" />复制路径</button>
          <div class="ws-sep" />
          <button class="ws-mi" :class="{ danger: ctxArmed }" role="menuitem" type="button" :disabled="!app.inDraft(ctx.path)" :title="app.inDraft(ctx.path) ? '恢复成最近一次记录的版本（还没记录过时恢复成刚取出 / 新建时的样子），之后可在检查栏撤回' : '这一项没有未记录的修改'" @click="ctxRun('revert')"><Icon name="revert" size="sm" />{{ ctxArmed ? '确定撤销当前的修改？' : '撤销当前的修改' }}</button>
          <div class="ws-sep" />
          <button class="ws-mi danger" role="menuitem" type="button" @click="ctxRun('remove')"><Icon name="trash" size="sm" />从工作区移除…</button>
        </div>
      </Teleport>
    </template>
  </aside>
</template>
