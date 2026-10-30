<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import Icon from '../components/Icon.vue';
import Seg from '../components/Seg.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { useLibrary } from '../stores/library.js';
import { hueOf, initialOf, relTime, STALE_HINT } from '../lib/status.js';

const app = useApp();
const ui = useUi();
const lib = useLibrary();
/** @type {import('vue').Ref<any>} */
const preview = ref(null);
const sentinel = ref(/** @type {HTMLElement|null} */ (null));
let qTimer = 0;
/** @type {IntersectionObserver|null} */
let io = null;

const cur = computed(() => lib.current);
const stale = computed(() => !!cur.value && !!cur.value.live && (cur.value.responsive === false || lib.errorCode === 'timeout'));
const sub = computed(() => {
  const t = cur.value;
  if (!t) return '';
  const parts = [app.targetName(t.id)];
  if (lib.total || !lib.loading) parts.push(lib.total + (lib.kind === 'character' ? ' 个角色' : ' 本世界书'));
  return parts.join(' · ');
});

function onQuery(/** @type {string} */ v) {
  lib.query = v;
  clearTimeout(qTimer);
  qTimer = window.setTimeout(() => lib.reload(), 250);
}

function open(/** @type {any} */ e) {
  if (e.checkedOut) ui.openItem(e.checkedOut);
  else preview.value = e;
}

async function take(/** @type {any} */ e, /** @type {boolean} */ thenOpen) {
  const p = await lib.checkout(e);
  if (p && thenOpen) { preview.value = null; ui.openItem(p); }
}

const thumbStyle = (/** @type {string} */ name) => {
  const h = hueOf(name);
  return { background: `linear-gradient(150deg, hsl(${h} 42% 46%), hsl(${(h + 40) % 360} 46% 26%))` };
};

onMounted(() => {
  lib.reload();
  io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting) && lib.hasMore && !lib.loading) lib.loadMore(); }, { rootMargin: '400px' });
  if (sentinel.value) io.observe(sentinel.value);
});
onBeforeUnmount(() => { if (io) io.disconnect(); clearTimeout(qTimer); lib.cancel(); });
// sources can appear later (tavern connects): pick one then
watch(() => lib.sources.map((s) => s.id).join(), () => { if (!lib.current) lib.reload(); });
</script>

<template>
  <div class="page lib">
    <div class="page-head">
      <div>
        <h2>资料库 <span v-if="cur && !cur.live" class="offline-badge"><Icon name="disk" size="sm" />离线 · 直接读取数据目录</span><span v-else-if="cur && cur.responsive === false" class="stale-badge" :title="STALE_HINT"><span class="dot stale" />无响应</span></h2>
        <p class="muted">{{ sub || '选择一个酒馆浏览' }}</p>
      </div>
      <div class="page-actions">
        <Seg :model-value="lib.kind" :options="[{ value: 'character', label: '角色' }, { value: 'lorebook', label: '世界书' }]" @update:model-value="lib.setKind" />
        <label class="search">
          <Icon name="search" size="sm" />
          <input class="input" :value="lib.query" placeholder="搜索名称" @input="onQuery(/** @type {any} */ ($event.target).value)" />
        </label>
        <select v-model="lib.sort" class="select" style="width: 120px">
          <option v-if="lib.kind === 'character'" value="recent">最近聊天</option>
          <option value="name">名称</option>
          <option value="default">酒馆顺序</option>
        </select>
      </div>
    </div>

    <div v-if="!lib.sources.length" class="empty">
      <Icon name="plug" />
      <h3>还没有可浏览的酒馆</h3>
      <p class="muted">打开装有 Cellar Link 的酒馆页面，或在设置中填写酒馆位置以离线浏览。</p>
      <a class="btn" href="#/settings/conn"><Icon name="settings" size="sm" />酒馆连接设置</a>
    </div>
    <div v-else-if="lib.error" class="banner" :class="stale ? 'warn' : 'conflict'"><Icon name="alert" /><div class="grow"><b v-if="stale">酒馆无响应</b><template v-else>读取失败：</template>{{ stale ? ' · ' : '' }}{{ lib.error }}</div><button class="btn sm" :disabled="lib.loading" @click="lib.reload()"><Icon :name="lib.loading ? 'spin' : 'refresh'" size="sm" />重试</button></div>
    <div v-else-if="!lib.loading && !lib.shown.length" class="empty">
      <Icon :name="lib.kind === 'character' ? 'user' : 'book'" />
      <h3>{{ lib.query || lib.tag ? '没有匹配的结果' : '这个酒馆里还没有' + (lib.kind === 'character' ? '角色' : '世界书') }}</h3>
    </div>

    <!-- characters -->
    <div v-if="lib.kind === 'character' && lib.shown.length" class="cat-grid">
      <div v-for="e in lib.shown" :key="e.id" class="cat-card" tabindex="0" :title="e.name" @click="open(e)" @keydown.enter="open(e)">
        <div class="cat-thumb" :style="thumbStyle(e.name)">
          <span class="cat-initial">{{ initialOf(e.name) }}</span>
          <span v-if="e.checkedOut" class="in-ws"><Icon name="check" size="sm" />已在工作区</span>
        </div>
        <div class="cat-info">
          <div class="cat-name">{{ e.name }}</div>
          <div v-if="e.tags && e.tags.length" class="cat-tags"><span v-for="t in e.tags.slice(0, 2)" :key="t" class="chip tag">{{ t }}</span></div>
          <div class="cat-time faint">{{ relTime(e.dateLastChat) }}</div>
        </div>
      </div>
    </div>

    <!-- lorebooks -->
    <div v-if="lib.kind === 'lorebook' && lib.shown.length" class="book-list card">
      <div v-for="e in lib.shown" :key="e.id" class="book-row">
        <Icon name="book" />
        <div class="grow">{{ e.name }}</div>
        <a v-if="e.checkedOut" class="in-ws static" :href="'#/item/' + encodeURIComponent(e.checkedOut)"><Icon name="check" size="sm" />已在工作区</a>
        <button v-else class="btn sm" :disabled="lib.busy[e.id]" @click="take(e, false)"><Icon :name="lib.busy[e.id] ? 'spin' : 'download'" size="sm" />取出</button>
      </div>
    </div>

    <div ref="sentinel" class="load-more faint">
      <template v-if="lib.loading && lib.slow"><Icon name="spin" size="sm" /> 酒馆迟迟没有响应…<span v-if="cur && cur.live">若酒馆页面在后台，切换过去即可恢复。</span><button class="btn sm ghost" @click="lib.cancel()">取消</button></template>
      <template v-else-if="lib.loading"><Icon name="spin" size="sm" /> 加载中…</template>
      <template v-else-if="lib.hasMore"><button class="btn sm ghost" @click="lib.loadMore()">加载更多（{{ lib.items.length }} / {{ lib.total }}）</button></template>
      <template v-else-if="lib.items.length">共 {{ lib.total }} 项</template>
    </div>

    <!-- preview drawer -->
    <template v-if="preview">
      <div class="drawer-scrim" @click="preview = null" />
      <aside class="drawer" role="dialog" aria-label="预览">
        <div class="drawer-head"><span class="faint">预览 · 只读</span><span class="grow" /><button class="icon-btn" @click="preview = null"><Icon name="x" size="sm" /></button></div>
        <div class="drawer-body">
          <div class="pv-hero">
            <div class="avatar pv-avatar" :style="thumbStyle(preview.name)">{{ initialOf(preview.name) }}</div>
            <div>
              <h2>{{ preview.name }}</h2>
              <div v-if="preview.tags && preview.tags.length" class="cat-tags"><span v-for="t in preview.tags" :key="t" class="chip tag">{{ t }}</span></div>
              <div class="faint">最后聊天：{{ relTime(preview.dateLastChat) }} · {{ cur && app.targetName(cur.id) }}</div>
            </div>
          </div>
          <dl class="kv pv-kv">
            <dt>文件</dt><dd class="mono" :title="preview.id">{{ preview.id }}</dd>
            <dt>来源</dt><dd>{{ cur && (cur.live ? 'Cellar Link' : '数据目录（离线）') }}</dd>
          </dl>
          <div class="dt-note faint"><Icon name="info" size="sm" /><div>描述、开场白与头像预览将在后续版本提供。取出后可在工作区中查看。</div></div>
        </div>
        <div class="drawer-foot">
          <button class="btn ghost" @click="preview = null">关闭</button>
          <span class="grow" />
          <button class="btn primary" :disabled="lib.busy[preview.id]" @click="take(preview, true)"><Icon :name="lib.busy[preview.id] ? 'spin' : 'download'" size="sm" />取出到工作区</button>
        </div>
      </aside>
    </template>
  </div>
</template>
