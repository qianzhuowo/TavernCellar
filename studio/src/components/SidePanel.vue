<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';
import Seg from './Seg.vue';
import StatusBadge from './StatusBadge.vue';
import { useApp } from '../stores/app.js';
import { useUi, hrefOf } from '../stores/ui.js';
import { useLibrary } from '../stores/library.js';
import { uiStatus, itemName, HOST } from '../lib/status.js';

const app = useApp();
const ui = useUi();
const lib = useLibrary();

const mode = computed(() => (ui.route.name === 'library' ? 'library' : ui.route.name === 'settings' ? 'settings' : 'tree'));

const groups = computed(() => [
  { key: 'character', title: '角色', icon: 'user', items: app.items.filter((i) => i.kind === 'character') },
  { key: 'lorebook', title: '世界书', icon: 'book', items: app.items.filter((i) => i.kind === 'lorebook') }
]);

const SETTINGS_NAV = [
  { id: 'ws', icon: 'folder', label: '工作区' },
  { id: 'conn', icon: 'plug', label: '连接' },
  { id: 'editor', icon: 'palette', label: '外观' },
  { id: 'app', icon: 'box', label: '关于' }
];

const hostMark = (/** @type {string} */ id) => { const t = app.target(id); return t.host ? HOST[t.host].mark : '?'; };
const sourceLabel = (/** @type {any} */ t) => app.targetName(t.id) + (t.live ? '' : ' (离线)');
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
          <Seg :model-value="lib.kind" :options="[{ value: 'character', label: '角色' }, { value: 'lorebook', label: '世界书' }]" @update:model-value="lib.setKind" />
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
      <div class="panel-head">工作区<span class="spacer" /><a class="icon-btn" href="#/library" title="从资料库取出"><Icon name="plus" size="sm" /></a></div>
      <div class="panel-body">
        <div v-for="g in groups" :key="g.key" class="tree-group" :class="{ collapsed: ui.collapsed[g.key] }">
          <div class="tg-head" @click="ui.toggleGroup(g.key)">
            <Icon :name="ui.collapsed[g.key] ? 'chevRight' : 'chevDown'" size="sm" /><Icon :name="g.icon" size="sm" />{{ g.title }}<span class="count">{{ g.items.length }}</span>
          </div>
          <template v-if="!ui.collapsed[g.key]">
            <a
              v-for="it in g.items"
              :key="it.path"
              class="tree-item"
              :class="{ on: ui.route.key === 'item:' + it.path }"
              :href="hrefOf('item:' + it.path)"
              :title="it.path"
            >
              <span class="name">{{ itemName(it.path) }}</span>
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
            <div v-if="!g.items.length" class="tree-empty faint">还没有{{ g.title }} · <a href="#/library">去资料库取出</a></div>
          </template>
        </div>
        <div class="tree-group">
          <div class="tg-head"><Icon name="chevRight" size="sm" /><Icon name="regex" size="sm" />正则<span class="count">阶段 4 开放</span></div>
        </div>
        <div class="tree-group">
          <div class="tg-head"><Icon name="chevRight" size="sm" /><Icon name="sliders" size="sm" />预设<span class="count">阶段 4 开放</span></div>
        </div>
        <div class="tree-legend faint">徽标按绑定的酒馆依次排列，悬停查看酒馆名</div>
      </div>
    </template>
  </aside>
</template>
