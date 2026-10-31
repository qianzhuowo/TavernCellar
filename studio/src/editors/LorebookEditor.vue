<script setup>
// S3 lorebook editor (docs/studio-design.md §4.4): entry list (search, filters, ST sorts, Cellar group tree,
// virtual scrolling, multi-select + bulk bar) | entry detail. All edits mutate the decoded book in place and
// go through useItem's auto-save; groups live in extensions.cellar.group (= entries/ subfolders on disk).
import { computed, reactive, ref, toRaw, toRef, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import Toggle from '../components/Toggle.vue';
import EntryDetail from './lorebook/EntryDetail.vue';
import { useItem } from '../lib/useItem.js';
import { POS, LAMP_LABEL, SORTS, SORT_FN, lampOf, posShort, groupOf, setGroup, normGroup, inclusionGroups } from './lorebook/entry.js';

const props = defineProps({ path: { type: String, required: true } });
const it = useItem(toRef(props, 'path'));

// Reactive view over the raw decoded book: mutations through it change the object useItem writes.
const book = computed(() => (it.data.value ? reactive(it.data.value) : null));
const entryMap = computed(() => /** @type {Record<string, any>} */ (book.value?.entries ?? {}));
const all = computed(() => Object.values(entryMap.value).map((e, idx) => ({ e, idx })));
const total = computed(() => all.value.length);
const bookName = computed(() => props.path.split('/').pop());

// ---- view state (per book, remembered) ----
const VIEW_KEY = 'tc.lb.view:' + props.path;
const saved = (() => { try { return JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'); } catch { return {}; } })();
const q = ref('');
const f = reactive({ status: 'all', pos: 'all', en: 'all', incl: 'all' });
const sort = ref(saved.sort ?? 'order');
const collapsed = ref(new Set(saved.collapsed ?? []));
watch([sort, collapsed], () => localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: sort.value, collapsed: [...collapsed.value] })), { deep: true });

const sel = ref(/** @type {number|null} */ (null));
const multi = ref(new Set(/** @type {number[]} */ ([])));
let anchor = /** @type {number|null} */ (null);

const inclOptions = computed(() => [...new Set(all.value.flatMap(({ e }) => inclusionGroups(e)))].sort());
const groupPaths = computed(() => {
  const s = new Set();
  for (const { e } of all.value) {
    const parts = groupOf(e).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) s.add(parts.slice(0, i).join('/'));
  }
  return [...s].sort((a, b) => a.localeCompare(b, 'zh'));
});
const filtering = computed(() => Boolean(q.value.trim()) || Object.values(f).some((v) => v !== 'all'));

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  const list = all.value.filter(({ e }) => {
    if (needle) {
      const hay = [e.comment, ...(e.key ?? []), ...(e.keysecondary ?? []), e.content].join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    if (f.status !== 'all' && lampOf(e) !== f.status) return false;
    if (f.pos !== 'all' && String(e.position) !== f.pos) return false;
    if (f.en !== 'all' && (f.en === 'on') === Boolean(e.disable)) return false;
    if (f.incl !== 'all' && !inclusionGroups(e).includes(f.incl)) return false;
    return true;
  });
  return list.sort(SORT_FN[sort.value] ?? SORT_FN.order);
});

/**
 * Flattened rows: group headers (nested by '/') then entries; groups first, ungrouped entries after.
 * @typedef {{type:'group', path:string, name:string, depth:number, count:number, uids:number[], open:boolean}} GroupRow
 * @typedef {{type:'entry', e:any, depth:number}} EntryRow
 */
const rows = computed(() => {
  const root = { children: new Map(), entries: /** @type {any[]} */ ([]) };
  for (const { e } of filtered.value) {
    let node = root;
    for (const part of groupOf(e).split('/').filter(Boolean)) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map(), entries: [] });
      node = node.children.get(part);
    }
    node.entries.push(e);
  }
  /** @param {any} node @returns {number[]} */
  const uidsOf = (node) => [...node.entries.map((/** @type {any} */ e) => e.uid), ...[...node.children.values()].flatMap(uidsOf)];
  /** @type {(GroupRow|EntryRow)[]} */
  const out = [];
  /** @param {any} node @param {string} prefix @param {number} depth */
  const walk = (node, prefix, depth) => {
    for (const name of [...node.children.keys()].sort((a, b) => a.localeCompare(b, 'zh'))) {
      const child = node.children.get(name);
      const path = prefix ? prefix + '/' + name : name;
      const uids = uidsOf(child);
      const open = filtering.value || !collapsed.value.has(path);
      out.push({ type: 'group', path, name, depth, count: uids.length, uids, open });
      if (open) walk(child, path, depth + 1);
    }
    for (const e of node.entries) out.push({ type: 'entry', e, depth });
  };
  walk(root, '', 0);
  return out;
});
const visibleUids = computed(() => rows.value.filter((r) => r.type === 'entry').map((r) => /** @type {EntryRow} */ (r).e.uid));

// ---- virtual list (fixed row height) ----
const ROW = 34;
const listEl = ref(/** @type {HTMLElement|null} */ (null));
const scrollTop = ref(0);
const viewH = ref(600);
const win = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / ROW) - 8);
  const end = Math.min(rows.value.length, Math.ceil((scrollTop.value + viewH.value) / ROW) + 8);
  return { start, end, top: start * ROW, height: rows.value.length * ROW, rows: rows.value.slice(start, end) };
});
let ro = /** @type {ResizeObserver|null} */ (null);
onMounted(() => {
  ro = new ResizeObserver(() => { if (listEl.value) viewH.value = listEl.value.clientHeight; });
  watch(listEl, (el) => { if (el) { ro?.observe(el); viewH.value = el.clientHeight; } }, { immediate: true });
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => { ro?.disconnect(); window.removeEventListener('keydown', onKey); });
/** @param {number} uid */
function scrollToUid(uid) {
  const i = rows.value.findIndex((r) => r.type === 'entry' && r.e.uid === uid);
  const el = listEl.value;
  if (i < 0 || !el) return;
  if (i * ROW < el.scrollTop) el.scrollTop = i * ROW;
  else if ((i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW - el.clientHeight;
}

// ---- selection ----
const selected = computed(() => (sel.value == null ? null : all.value.find(({ e }) => e.uid === sel.value)?.e ?? null));
watch(() => it.version.value, () => {
  if (selected.value) return;
  sel.value = visibleUids.value[0] ?? null;
  multi.value = new Set();
});
/** @param {any} e @param {MouseEvent} ev */
function clickRow(e, ev) {
  const uid = e.uid;
  if (ev.ctrlKey || ev.metaKey) {
    const m = new Set(multi.value);
    if (!m.size && sel.value != null) m.add(sel.value);
    m.has(uid) ? m.delete(uid) : m.add(uid);
    multi.value = m;
  } else if (ev.shiftKey && anchor != null) {
    const ids = visibleUids.value, a = ids.indexOf(anchor), b = ids.indexOf(uid);
    if (a >= 0 && b >= 0) multi.value = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else {
    multi.value = new Set();
    anchor = uid;
  }
  sel.value = uid;
}
/** @param {number} uid */
function toggleCheck(uid) {
  const m = new Set(multi.value);
  if (!m.size && sel.value != null && sel.value !== uid) m.add(sel.value);
  m.has(uid) ? m.delete(uid) : m.add(uid);
  multi.value = m;
  anchor = uid;
}
/** @param {GroupRow} g */
const groupState = (g) => {
  const n = g.uids.filter((u) => multi.value.has(u)).length;
  return n === 0 ? 'none' : n === g.uids.length ? 'all' : 'some';
};
/** @param {GroupRow} g */
function toggleGroupCheck(g) {
  const m = new Set(multi.value);
  if (groupState(g) === 'all') g.uids.forEach((u) => m.delete(u));
  else g.uids.forEach((u) => m.add(u));
  multi.value = m;
}
/** @param {string} path */
function toggleCollapse(path) {
  const s = new Set(collapsed.value);
  s.has(path) ? s.delete(path) : s.add(path);
  collapsed.value = s;
}
/** @param {KeyboardEvent} ev */
function onKey(ev) {
  const t = /** @type {HTMLElement} */ (ev.target);
  if (t.closest('input, textarea, select, [contenteditable]')) return;
  if (ev.key === 'Escape' && multi.value.size) { multi.value = new Set(); return; }
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
  if (!t.closest('.lb-left') && t !== document.body) return;
  const ids = visibleUids.value;
  if (!ids.length) return;
  ev.preventDefault();
  const i = sel.value == null ? -1 : ids.indexOf(sel.value);
  const next = ids[Math.max(0, Math.min(ids.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
  sel.value = next;
  anchor = next;
  multi.value = new Set();
  scrollToUid(next);
}

// ---- edits ----
const changed = () => it.touch();
/** @param {any} e @param {boolean} on */
function setEnabled(e, on) { e.disable = !on; changed(); }
const nextUid = () => all.value.reduce((m, { e }) => Math.max(m, Number(e.uid) || 0), -1) + 1;
/** @param {any} entry */
function insert(entry) {
  const uid = nextUid();
  entry.uid = uid;
  entryMap.value[String(uid)] = entry;
  changed();
  sel.value = uid;
  multi.value = new Set();
  nextTick(() => scrollToUid(uid));
}
function createEntry() {
  const base = it.entryTemplate.value ? structuredClone(toRaw(it.entryTemplate.value)) : {};
  const e = { ...base, key: [], keysecondary: [], comment: '', content: '' };
  // New entries land in the group of the selected entry (or the filtered view's), like ST adds to the open list.
  if (selected.value && groupOf(selected.value)) setGroup(e, groupOf(selected.value));
  insert(e);
}
/** @param {any} src */
function duplicate(src) {
  const copy = structuredClone(toRaw(src));
  copy.comment = (copy.comment ?? '') + ' (副本)';
  insert(copy);
}
/** @param {number[]} uids */
function removeEntries(uids) {
  const set = new Set(uids);
  for (const [k, e] of Object.entries(entryMap.value)) if (set.has(e.uid)) delete entryMap.value[k];
  changed();
  multi.value = new Set();
  if (sel.value != null && set.has(sel.value)) sel.value = visibleUids.value[0] ?? null;
}

// ---- bulk bar ----
const bulk = reactive({ pos: '', orderMode: 'set', order: '', depth: '', prob: '', group: '', confirmDelete: false });
watch(() => multi.value.size, (n) => { if (n < 2) bulk.confirmDelete = false; });
const picked = computed(() => all.value.filter(({ e }) => multi.value.has(e.uid)).map(({ e }) => e));
/** @param {(e:any)=>void} fn */
function applyBulk(fn) { picked.value.forEach(fn); changed(); }
function bulkPos() {
  if (bulk.pos === '') return;
  const p = Number(bulk.pos);
  applyBulk((e) => { e.position = p; });
  bulk.pos = '';
}
function bulkOrder() {
  const n = Number(bulk.order);
  if (bulk.order === '' || !Number.isFinite(n)) return;
  applyBulk((e) => { e.order = bulk.orderMode === 'add' ? (Number(e.order) || 0) + n : n; });
}
/** @param {'depth'|'probability'} key @param {string} raw */
function bulkNum(key, raw) {
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) return;
  applyBulk((e) => { e[key] = n; });
}
function bulkGroup() {
  const g = normGroup(bulk.group);
  applyBulk((e) => setGroup(e, g));
  if (g) { const s = new Set(collapsed.value); s.delete(g); collapsed.value = s; }
}

// ---- stats for the header ----
const stats = computed(() => {
  const c = { const: 0, key: 0, vec: 0, off: 0 };
  for (const { e } of all.value) { c[lampOf(e)]++; if (e.disable) c.off++; }
  return c;
});
const otherKeys = computed(() => Object.keys(book.value ?? {}).filter((k) => k !== 'entries'));
const settingsOpen = ref(false);
</script>

<template>
  <div v-if="it.error.value && !book" class="page"><div class="banner conflict"><Icon name="alert" /><div class="grow">读取失败：{{ it.error.value }}</div><button class="btn sm" @click="it.load()">重试</button></div></div>
  <div v-else-if="!book" class="page"><p class="muted"><Icon name="spin" size="sm" /> 正在读取…</p></div>
  <div v-else class="lb" :class="{ multi: multi.size > 1 }">
    <div v-if="it.externalChange.value" class="banner conflict lb-ext">
      <Icon name="alert" /><div class="grow">文件在别处被修改，Studio 中尚未保存的修改不会覆盖它。</div>
      <button class="btn sm" @click="it.load()">重新加载</button>
    </div>

    <div class="bulk" :class="{ show: multi.size > 1 }">
      <span class="bulk-n">已选 <b>{{ multi.size }}</b> 项</span>
      <button class="btn sm" @click="applyBulk((e) => { e.disable = false; })"><Icon name="check" size="sm" />启用</button>
      <button class="btn sm" @click="applyBulk((e) => { e.disable = true; })"><Icon name="minus" size="sm" />停用</button>
      <span class="vsep" />
      <label class="mini-select"><span>位置</span>
        <select v-model="bulk.pos" @change="bulkPos"><option value="" disabled>改为…</option><option v-for="(p, i) in POS" :key="i" :value="String(i)">{{ p.short }} · {{ p.label }}</option></select>
        <Icon name="chevDown" size="sm" />
      </label>
      <div class="bulk-num"><span>顺序</span>
        <select v-model="bulk.orderMode" class="tiny"><option value="set">设为</option><option value="add">加减</option></select>
        <input v-model="bulk.order" class="input num sm" type="number" @keydown.enter="bulkOrder" />
        <button class="btn sm" @click="bulkOrder">应用</button>
      </div>
      <div class="bulk-num"><span>深度</span><input v-model="bulk.depth" class="input num sm" type="number" @keydown.enter="bulkNum('depth', bulk.depth)" @change="bulkNum('depth', bulk.depth)" /></div>
      <div class="bulk-num"><span>触发 %</span><input v-model="bulk.prob" class="input num sm" type="number" @keydown.enter="bulkNum('probability', bulk.prob)" @change="bulkNum('probability', bulk.prob)" /></div>
      <div class="bulk-num"><span>移到分组</span>
        <input v-model="bulk.group" class="input sm" style="width: 120px" list="lb-groups-bulk" placeholder="留空 = 取消分组" @keydown.enter="bulkGroup" />
        <datalist id="lb-groups-bulk"><option v-for="g in groupPaths" :key="g" :value="g" /></datalist>
        <button class="btn sm" @click="bulkGroup">移动</button>
      </div>
      <span class="grow" />
      <button v-if="!bulk.confirmDelete" class="btn sm danger" @click="bulk.confirmDelete = true"><Icon name="trash" size="sm" />删除</button>
      <button v-else class="btn sm danger" @click="removeEntries([...multi])">确认删除 {{ multi.size }} 项</button>
      <button class="icon-btn" title="取消选择（Esc）" @click="multi = new Set()"><Icon name="x" size="sm" /></button>
    </div>

    <div class="lb-panes">
      <section class="lb-left">
        <div class="book-wrap">
          <button class="collapse-head" type="button" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen">
            <Icon :name="settingsOpen ? 'chevDown' : 'chevRight'" size="sm" /><Icon name="book" size="sm" />
            <span class="grow ellipsis">{{ bookName }}</span>
            <span class="faint">{{ total }} 个条目</span>
            <span class="lb-save faint" :title="it.saving.value || it.dirty.value ? '正在写入工作区' : '已写入工作区'">
              <Icon :name="it.saving.value || it.dirty.value ? 'spin' : 'check'" size="sm" />
            </span>
          </button>
          <div v-if="settingsOpen" class="book-set">
            <dl class="kv">
              <dt><span class="lamp const" /> {{ LAMP_LABEL.const }}</dt><dd>{{ stats.const }}</dd>
              <dt><span class="lamp key" /> {{ LAMP_LABEL.key }}</dt><dd>{{ stats.key }}</dd>
              <dt><span class="lamp vec" /> {{ LAMP_LABEL.vec }}</dt><dd>{{ stats.vec }}</dd>
              <dt>已停用</dt><dd>{{ stats.off }}</dd>
            </dl>
            <div v-if="otherKeys.length" class="faint lb-other">本书其他字段：<span class="mono">{{ otherKeys.join('、') }}</span>（原样保留，可在 book.json 中编辑）</div>
          </div>
        </div>

        <div class="lb-tools">
          <div class="lb-tools-row">
            <div class="search grow"><Icon name="search" size="sm" /><input v-model="q" class="input" placeholder="搜索标题、关键字、内容" /></div>
            <button class="btn primary" title="新建条目" @click="createEntry"><Icon name="plus" size="sm" />新建</button>
          </div>
          <div class="lb-tools-row filters">
            <label class="mini-select" :class="{ active: f.status !== 'all' }"><span>状态</span>
              <select v-model="f.status"><option value="all">全部</option><option value="const">永久</option><option value="key">关键词</option><option value="vec">向量化</option></select><Icon name="chevDown" size="sm" />
            </label>
            <label class="mini-select" :class="{ active: f.pos !== 'all' }"><span>位置</span>
              <select v-model="f.pos"><option value="all">全部</option><option v-for="(p, i) in POS" :key="i" :value="String(i)">{{ p.short }}</option></select><Icon name="chevDown" size="sm" />
            </label>
            <label class="mini-select" :class="{ active: f.en !== 'all' }"><span>启用</span>
              <select v-model="f.en"><option value="all">全部</option><option value="on">已启用</option><option value="off">已停用</option></select><Icon name="chevDown" size="sm" />
            </label>
            <label v-if="inclOptions.length" class="mini-select" :class="{ active: f.incl !== 'all' }"><span>包含组</span>
              <select v-model="f.incl"><option value="all">全部</option><option v-for="g in inclOptions" :key="g" :value="g">{{ g }}</option></select><Icon name="chevDown" size="sm" />
            </label>
            <span class="grow" />
            <label class="mini-select"><span>排序</span>
              <select v-model="sort"><option v-for="s in SORTS" :key="s.value" :value="s.value">{{ s.label }}</option></select><Icon name="chevDown" size="sm" />
            </label>
          </div>
        </div>

        <div class="lb-head"><span /><span /><span>启用</span><span>标题 · 关键字</span><span>位置</span><span>深度</span><span>顺序</span><span>触发</span></div>
        <div ref="listEl" class="lb-list" role="listbox" aria-multiselectable="true" tabindex="0" @scroll="scrollTop = /** @type {HTMLElement} */ ($event.target).scrollTop">
          <div v-if="!rows.length" class="empty">
            <Icon name="search" />
            <h3>{{ total ? '没有符合条件的条目' : '这本世界书还没有条目' }}</h3>
            <button v-if="total" class="btn sm" @click="q = ''; Object.assign(f, { status: 'all', pos: 'all', en: 'all', incl: 'all' })">清除筛选</button>
            <button v-else class="btn sm primary" @click="createEntry"><Icon name="plus" size="sm" />新建条目</button>
          </div>
          <div v-else :style="{ height: win.height + 'px', position: 'relative' }">
            <div :style="{ transform: `translateY(${win.top}px)` }">
              <template v-for="r in win.rows" :key="r.type === 'group' ? 'g:' + r.path : 'e:' + r.e.uid">
                <div v-if="r.type === 'group'" class="lb-group" :style="{ '--d': r.depth }" @click="toggleCollapse(r.path)">
                  <label class="check lb-chk" @click.stop><input type="checkbox" :checked="groupState(r) === 'all'" :indeterminate="groupState(r) === 'some'" aria-label="选择整组" @change="toggleGroupCheck(r)" /></label>
                  <Icon :name="r.open ? 'chevDown' : 'chevRight'" size="sm" />
                  <Icon :name="r.open ? 'folderOpen' : 'folder'" size="sm" />
                  <span class="lb-gname ellipsis">{{ r.name }}</span>
                  <span class="faint">{{ r.count }}</span>
                </div>
                <div v-else class="lb-row" :class="{ on: multi.size > 1 ? multi.has(r.e.uid) : r.e.uid === sel, off: r.e.disable }"
                  :style="{ '--d': r.depth }" role="option" :aria-selected="r.e.uid === sel" @click="clickRow(r.e, $event)">
                  <label class="check lb-chk" @click.stop><input type="checkbox" :checked="multi.has(r.e.uid)" aria-label="多选" @change="toggleCheck(r.e.uid)" /></label>
                  <span class="lamp" :class="lampOf(r.e)" :title="LAMP_LABEL[lampOf(r.e)]" />
                  <span @click.stop><Toggle class="mini" :model-value="!r.e.disable" title="启用" @update:model-value="setEnabled(r.e, $event)" /></span>
                  <span class="lb-main">
                    <span class="lb-title">{{ r.e.comment || '（无标题）' }}</span>
                    <span class="lb-keys">
                      <span v-for="k in (r.e.key ?? []).slice(0, 2)" :key="k" class="chip">{{ k }}</span>
                      <span v-if="(r.e.key ?? []).length > 2" class="chip">+{{ r.e.key.length - 2 }}</span>
                    </span>
                  </span>
                  <span class="lb-pos">{{ posShort(r.e) }}</span>
                  <span class="lb-num">{{ r.e.position === 4 ? r.e.depth : '–' }}</span>
                  <span class="lb-num">{{ r.e.order }}</span>
                  <span class="lb-num" :class="{ warn: (r.e.probability ?? 100) < 100 }">{{ r.e.probability ?? 100 }}%</span>
                </div>
              </template>
            </div>
          </div>
        </div>
        <div class="lb-foot faint">显示 {{ visibleUids.length }} / {{ total }} 条<template v-if="groupPaths.length"> · {{ groupPaths.length }} 个分组</template> · ↑↓ 切换 · Ctrl/Shift 多选</div>
      </section>

      <section class="lb-right">
        <div v-if="multi.size > 1" class="empty" style="margin-top: 80px">
          <Icon name="box" /><h3>已选 {{ multi.size }} 个条目</h3><p>使用上方批量操作条统一修改；单击条目回到单项编辑。</p>
        </div>
        <EntryDetail v-else-if="selected" :entry="selected" :groups="groupPaths" @change="changed" @duplicate="duplicate(selected)" @delete="removeEntries([selected.uid])" />
        <div v-else class="empty" style="margin-top: 80px"><Icon name="book" /><h3>选择一个条目</h3><p>在左侧列表中点击条目查看与编辑</p></div>
      </section>
    </div>
  </div>
</template>
