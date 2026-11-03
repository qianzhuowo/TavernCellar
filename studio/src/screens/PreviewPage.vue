<script setup>
// Phase 5: prompt preview (docs/studio-design.md §4.8). The tavern dry-runs the next reply of the chat open in it;
// this page shows the final prompt by section with token counts and the world info entries that fired.
import { ref, reactive, computed } from 'vue';
import Icon from '../components/Icon.vue';
import Avatar from '../components/Avatar.vue';
import { useApp } from '../stores/app.js';
import { useUi, hrefOf } from '../stores/ui.js';
import { usePreview } from '../stores/preview.js';
import { relTime, MODE_TIP } from '../lib/status.js';
import { POS, posShort } from '../editors/lorebook/entry.js';

const app = useApp();
const ui = useUi();
const pv = usePreview();

const t = computed(() => pv.target);
const pending = computed(() => (t.value ? pv.pending(t.value.id) : { local: [], blocked: [] }));
const r = computed(() => pv.result);
const stale = computed(() => !!r.value && !!t.value && r.value.target !== t.value.id);

const ROLE = { system: '系统', user: '用户', assistant: '助手', tool: '工具' };
const roleText = (/** @type {string} */ role) => ROLE[/** @type {keyof typeof ROLE} */ (role)] || role;

// ---- tokens ----------------------------------------------------------------
const tokens = computed(() => (r.value && r.value.tokens) || {});
/** room for the prompt: context minus what is kept for the reply (chat completion) */
const budget = computed(() => (tokens.value.context ? tokens.value.context - (tokens.value.response || 0) : 0));
const usePct = computed(() => (budget.value ? Math.min(100, Math.round((tokens.value.total / budget.value) * 100)) : 0));
const fmt = (/** @type {number} */ n) => (typeof n === 'number' ? n.toLocaleString() : '–');

// ---- prompt sections ---------------------------------------------------------
const q = ref('');
const open = reactive(new Set());
const PAGE = 200;
/** messages shown per expanded section (long chat histories render in pages) */
const shown = reactive(/** @type {Record<string, number>} */ ({}));

/** Sections of the result; messages without section data each make one. */
const sections = computed(() => {
  const p = (r.value && r.value.prompt) || {};
  const msgs = p.messages || [];
  const list = p.sections
    ? p.sections.map((/** @type {any} */ s, /** @type {number} */ i) => ({ key: s.identifier + ':' + i, title: s.name || s.identifier, id: s.identifier, tokens: s.tokens, messages: msgs.slice(s.start, s.start + s.count) }))
    : msgs.map((/** @type {any} */ m, /** @type {number} */ i) => ({ key: 'm' + i, title: `#${i + 1} ${roleText(m.role)}`, id: '', tokens: m.tokens, messages: [m] }));
  return list.map((/** @type {any} */ s) => ({ ...s, roles: [...new Set(s.messages.map((/** @type {any} */ m) => m.role))] }));
});
const needle = computed(() => q.value.trim().toLowerCase());
const hits = (/** @type {any} */ m) => !needle.value || String(m.content).toLowerCase().includes(needle.value);
const visible = computed(() => (needle.value ? sections.value.filter((s) => s.messages.some(hits)) : sections.value));
const isOpen = (/** @type {any} */ s) => open.has(s.key) || (!!needle.value && visible.value.length <= 5);
function toggle(/** @type {any} */ s) { open.has(s.key) ? open.delete(s.key) : open.add(s.key); }
const allOpen = computed(() => visible.value.length > 0 && visible.value.every((s) => open.has(s.key)));
function toggleAll() { if (allOpen.value) open.clear(); else visible.value.forEach((s) => open.add(s.key)); }
const textHits = computed(() => {
  const text = r.value && r.value.prompt && r.value.prompt.text;
  if (!text || !needle.value) return 0;
  return text.toLowerCase().split(needle.value).length - 1;
});
const share = (/** @type {number} */ n) => (tokens.value.total ? Math.max(1, Math.round((n / tokens.value.total) * 100)) : 0);

// ---- world info ------------------------------------------------------------
const books = computed(() => {
  /** @type {Map<string, {world: string, path: string|null, entries: any[], tokens: number}>} */
  const m = new Map();
  for (const e of (r.value && r.value.worldInfo && r.value.worldInfo.entries) || []) {
    const b = m.get(e.world) || { world: e.world, path: e.path, entries: [], tokens: 0 };
    b.entries.push(e);
    b.tokens += e.tokens || 0;
    m.set(e.world, b);
  }
  return [...m.values()];
});
const wiCount = computed(() => books.value.reduce((n, b) => n + b.entries.length, 0));
const wiTokens = computed(() => books.value.reduce((n, b) => n + b.tokens, 0));
const entryTitle = (/** @type {any} */ e) => e.comment || (e.keys && e.keys.join(', ')) || `#${e.uid}`;
const posTip = (/** @type {any} */ e) => (POS[e.position] ? POS[e.position].label : '') + (e.position === 4 ? ` · 深度 ${e.depth}` : '') + (e.outletName ? ` · ${e.outletName}` : '');
function openEntry(/** @type {any} */ e) {
  if (!e.path) return;
  ui.focusEntry = { path: e.path, uid: e.uid };
  ui.openItem(e.path);
}

const at = computed(() => (r.value ? relTime(Date.parse(r.value.at)) : ''));
const API = { openai: '聊天补全', textgenerationwebui: '文本补全', kobold: 'KoboldAI', koboldhorde: 'AI Horde', novel: 'NovelAI' };
const apiText = (/** @type {string} */ a) => API[/** @type {keyof typeof API} */ (a)] || a;
</script>

<template>
  <div class="page pv">
    <div class="page-head">
      <div>
        <h2>预览</h2>
        <p class="muted">用酒馆自己的 dryRun 组装酒馆当前聊天的下一条回复：最终提示词、每段的 token、触发了哪些世界书条目。不会发给模型，也不写聊天。预览的是酒馆里的内容，工作区的修改要先同步。</p>
      </div>
    </div>

    <div v-if="!pv.sources.length" class="empty">
      <Icon name="plug" />
      <h3>没有已连接的酒馆</h3>
      <p class="muted">预览需要酒馆页面在运行：打开装有 Cellar Link 的 SillyTavern 或 TauriTavern，并进入一个角色的聊天。</p>
      <a class="btn" :href="hrefOf('settings')"><Icon name="settings" size="sm" />打开设置</a>
    </div>

    <template v-else>
      <div class="pv-bar card">
        <div class="field pv-target">
          <label>酒馆</label>
          <select class="select" :value="t ? t.id : ''" :disabled="!!pv.running" @change="pv.choose(/** @type {any} */ ($event.target).value)">
            <option v-for="s in pv.sources" :key="s.id" :value="s.id">{{ s.name }}{{ s.can ? '' : '（插件需更新）' }}</option>
          </select>
        </div>
        <div class="field pv-input">
          <label>测试输入<span class="hint">可选</span></label>
          <textarea v-model="pv.input" class="textarea" rows="2" maxlength="8000" placeholder="例如一句会触发关键字的话" spellcheck="false" />
          <div class="help faint">作为一条附加指令加在提示词末尾（与酒馆的静默生成相同），参与世界书扫描；不会写进聊天。</div>
        </div>
        <div class="pv-go">
          <button
            class="btn primary"
            :disabled="!!pv.running || !t || !t.can || t.responsive === false"
            :title="t && t.responsive === false ? MODE_TIP.stale : ''"
            @click="pv.run({ syncFirst: true })"
          >
            <Icon :name="pv.running ? 'spin' : 'eye'" size="sm" />
            <template v-if="pv.running === 'sync'">正在同步 {{ pv.sync.done }} / {{ pv.sync.total }}</template>
            <template v-else-if="pv.running">正在预览…</template>
            <template v-else-if="pending.local.length">同步 {{ pending.local.length }} 项并预览</template>
            <template v-else>{{ r ? '重新预览' : '预览' }}</template>
          </button>
          <button v-if="pending.local.length && !pv.running" class="btn ghost sm" :disabled="!t || !t.can" @click="pv.run()">只预览酒馆当前内容</button>
        </div>
      </div>

      <div v-if="t && !t.can" class="banner warn"><Icon name="alert" /><div class="grow">{{ t.name }} 的 Cellar Link 版本不支持预览：更新插件后刷新酒馆页面。</div></div>
      <div v-if="pending.local.length && !pv.running" class="banner info">
        <Icon name="info" />
        <div class="grow">工作区有 <b>{{ pending.local.length }}</b> 项修改还没同步到 {{ t && t.name }}：{{ pending.local.slice(0, 4).map((x) => x.it.path.split('/').pop()).join('、') }}{{ pending.local.length > 4 ? ' 等' : '' }}。「同步并预览」会先同步它们。</div>
      </div>
      <div v-if="pending.blocked.length" class="banner conflict">
        <Icon name="alert" />
        <div class="grow">{{ pending.blocked.length }} 项与这个酒馆有冲突，处理之前不会同步，预览里是酒馆中的版本。</div>
        <a class="btn sm" :href="hrefOf('sync')">去处理</a>
      </div>
      <div v-if="pv.error" class="banner conflict"><Icon name="alert" /><div class="grow">{{ pv.error }}</div></div>

      <div v-if="!r && !pv.running && !pv.error" class="empty pv-empty">
        <Icon name="eye" />
        <h3>还没有预览</h3>
        <p class="muted">先在酒馆里打开要测试的角色聊天，再点「预览」。改完世界书条目后回到这里点「同步并预览」，就能看到触发结果的变化。</p>
      </div>

      <template v-if="r">
        <div class="pv-head card" :class="{ dim: pv.running }">
          <Avatar :name="r.chat.character.name" :target="r.target" :file="r.chat.character.avatar" :lazy="false" />
          <div class="pv-who">
            <div class="pv-name">
              <a v-if="r.chat.character.path" :href="hrefOf('item:' + r.chat.character.path)">{{ r.chat.character.name }}</a>
              <span v-else>{{ r.chat.character.name }}</span>
            </div>
            <div class="faint">{{ r.chat.chatId || '（无聊天）' }} · {{ r.chat.messages }} 条消息 · {{ apiText(r.api) }}{{ r.model ? ' · ' + r.model : '' }} · {{ app.targetName(r.target) }} · {{ at }}</div>
            <div v-if="r.input" class="faint pv-input-echo">测试输入：{{ r.input }}</div>
          </div>
          <div class="pv-meter">
            <div class="pv-meter-num"><b>{{ fmt(tokens.total) }}</b><span class="faint"> token{{ budget ? ' / ' + fmt(budget) : '' }}</span></div>
            <div v-if="budget" class="pv-bar-track" :title="`上下文 ${fmt(tokens.context)}${tokens.response ? '，回复预留 ' + fmt(tokens.response) : ''}`"><span :class="{ full: usePct >= 95 }" :style="{ width: usePct + '%' }" /></div>
            <div class="faint pv-meter-sub">{{ tokens.approx ? '按内容估算' : '酒馆分词器计数' }}{{ tokens.response ? ' · 回复预留 ' + fmt(tokens.response) : '' }}</div>
          </div>
        </div>
        <div v-if="stale" class="faint pv-note">这是在 {{ app.targetName(r.target) }} 里的预览；点「预览」在当前选择的酒馆里重新组装。</div>

        <div class="pv-cols">
          <section class="pv-prompt">
            <div class="pv-sec-head">
              <h3>提示词</h3>
              <span class="faint">{{ r.prompt.messages ? r.prompt.messages.length + ' 条消息' : '文本' }}</span>
              <span class="grow" />
              <label class="search"><Icon name="search" size="sm" /><input v-model="q" class="input" data-find placeholder="在提示词中查找" spellcheck="false" /></label>
              <button v-if="r.prompt.messages" class="btn ghost sm" @click="toggleAll()">{{ allOpen ? '全部收起' : '全部展开' }}</button>
            </div>
            <div v-if="r.prompt.sections" class="faint pv-hint">按预设中的提示词分段。酒馆发送时可能合并相邻的系统消息（「压缩系统消息」），分段与 token 以合并前为准。</div>

            <pre v-if="r.prompt.text != null" class="pv-text">{{ r.prompt.text }}</pre>
            <div v-if="r.prompt.text != null && needle" class="faint pv-hint">找到 {{ textHits }} 处</div>

            <div v-for="s in visible" :key="s.key" class="pv-section" :class="{ open: isOpen(s) }">
              <button class="pv-s-head" @click="toggle(s)">
                <Icon :name="isOpen(s) ? 'chevDown' : 'chevRight'" size="sm" />
                <span class="pv-s-title">{{ s.title }}</span>
                <span v-for="role in s.roles" :key="role" class="badge soft">{{ roleText(role) }}</span>
                <span v-if="s.messages.length > 1" class="faint">{{ s.messages.length }} 条</span>
                <span class="grow" />
                <span class="pv-share"><span :style="{ width: share(s.tokens) + '%' }" /></span>
                <span class="pv-tok">{{ fmt(s.tokens) }}</span>
              </button>
              <div v-if="isOpen(s)" class="pv-s-body">
                <div v-for="(m, i) in s.messages.slice(0, shown[s.key] || PAGE)" v-show="hits(m)" :key="i" class="pv-msg">
                  <div class="pv-msg-h faint"><span>{{ roleText(m.role) }}{{ m.name ? ' · ' + m.name : '' }}</span><span>{{ fmt(m.tokens) }}</span></div>
                  <pre class="pv-msg-c">{{ m.content }}</pre>
                </div>
                <button v-if="s.messages.length > (shown[s.key] || PAGE)" class="btn ghost sm" @click="shown[s.key] = (shown[s.key] || PAGE) + PAGE">再显示 {{ Math.min(PAGE, s.messages.length - (shown[s.key] || PAGE)) }} 条</button>
              </div>
            </div>
            <div v-if="r.prompt.messages && !visible.length" class="faint pv-hint">没有包含「{{ q }}」的消息</div>
          </section>

          <section class="pv-wi">
            <div class="pv-sec-head">
              <h3>世界书</h3>
              <span class="faint">{{ wiCount }} 条触发 · {{ fmt(wiTokens) }} token</span>
            </div>
            <div v-if="r.worldInfo.overflowed" class="banner warn"><Icon name="alert" /><div class="grow">超出世界书预算：还有条目因为预算不够没有加入。</div></div>
            <div v-if="!wiCount" class="faint pv-hint">没有条目被触发。可以在「测试输入」里写一句包含关键字的话再预览。</div>
            <div v-for="b in books" :key="b.world" class="pv-book">
              <div class="pv-book-h">
                <Icon name="book" size="sm" />
                <a v-if="b.path" :href="hrefOf('item:' + b.path)" class="pv-book-name">{{ b.world }}</a>
                <span v-else class="pv-book-name" title="这本世界书不在工作区">{{ b.world }}</span>
                <span class="grow" />
                <span class="faint">{{ b.entries.length }} 条 · {{ fmt(b.tokens) }}</span>
              </div>
              <div
                v-for="e in b.entries"
                :key="e.uid"
                class="pv-entry"
                :class="{ link: !!e.path }"
                :title="(e.path ? '打开这个条目 · ' : '') + posTip(e)"
                @click="openEntry(e)"
              >
                <span class="lamp" :class="e.constant ? 'const' : 'key'" />
                <span class="pv-e-name">{{ entryTitle(e) }}</span>
                <span class="pv-e-pos mono">{{ posShort(e) }}{{ e.position === 4 ? e.depth : '' }}</span>
                <span class="pv-e-ord mono faint">{{ e.order }}</span>
                <span class="pv-tok">{{ fmt(e.tokens) }}</span>
              </div>
            </div>
            <div v-if="wiCount" class="faint pv-hint"><span class="lamp const" /> 常驻　<span class="lamp key" /> 关键字触发　数字为插入顺序</div>
          </section>
        </div>
      </template>
    </template>
  </div>
</template>
