<script setup>
// S2 character card editor (docs/studio-design.md §4.3, §5.1-5.2). Edits `data.*` of the decoded card and keeps the
// root mirrors equal (components/card/cardFields.js); useItem writes the workspace files after a short pause.
import { ref, computed, watch, toRef, onBeforeUnmount, nextTick } from 'vue';
import { Star } from 'lucide-vue-next';
import { useItem } from '../lib/useItem.js';
import { useApp } from '../stores/app.js';
import { useUi, historyHref } from '../stores/ui.js';
import Avatar from '../components/Avatar.vue';
import Icon from '../components/Icon.vue';
import Seg from '../components/Seg.vue';
import CardText from '../components/card/CardText.vue';
import GreetingList from '../components/card/GreetingList.vue';
import TagInput from '../components/card/TagInput.vue';
import WorldPicker from '../components/card/WorldPicker.vue';
import ItemFiles from '../components/ItemFiles.vue';
import AvatarDialog from '../components/AvatarDialog.vue';
import { avatarBlocked } from '../lib/syncOps.js';
import LorebookEditor from './LorebookEditor.vue';
import RegexList from './RegexList.vue';
import { getField, setField, extraFields } from '../components/card/cardFields.js';
import { extractedOf } from '../lib/cardParts.js';
import { api, errorText } from '../api.js';

const props = defineProps({ path: { type: String, required: true } });
const it = useItem(toRef(props, 'path'));
const app = useApp();
const ui = useUi();

// Files changed on disk while this editor held unsaved edits: the user picks a side explicitly.
const keeping = ref(false);
async function keepMine() {
  keeping.value = true;
  try {
    // Adopt the current workspace hash, then write the editor's version over the files.
    const r = await api.item(props.path);
    it.hash.value = r.hash;
    it.externalChange.value = false;
    it.touch();
    await it.save();
    if (!it.externalChange.value && !it.dirty.value) ui.toast('已用编辑器中的内容覆盖工作区文件', 'check');
  } catch (e) {
    ui.toast('写入失败：' + errorText(e), 'alert');
  } finally {
    keeping.value = false;
  }
}
// Leaving with edits that cannot be written (files changed elsewhere) must not drop them silently.
onBeforeUnmount(() => {
  if (!it.dirty.value && !it.externalChange.value) return;
  const label = name.value || props.path;
  const check = () => {
    if (it.saving.value) { window.setTimeout(check, 200); return; }
    if (it.externalChange.value) ui.toast(`「${label}」有修改未写入：文件在别处被修改，这些修改已丢弃`, 'alert');
  };
  window.setTimeout(check, 0);
});
// `it.data` is a shallowRef mutated in place: `rev` makes the template re-read fields after each edit.
const rev = ref(0);
watch(it.version, () => { rev.value++; });

// Snapshot of the data as loaded: clearing a text field that had content shows a sync hint (saves don't reload).

/** @param {string} path */
function f(path) {
  void rev.value;
  return getField(it.data.value, path);
}
/** @param {string} path @param {any} value */
function set(path, value) {
  if (!it.data.value) return;
  setField(it.data.value, path, value);
  rev.value++;
  it.touch();
}

const item = computed(() => app.item(props.path));
const binding = computed(() => item.value?.bindings?.[0] || null);
// 「更换头像…」: the avatar lives in the taverns; '' when every binding can take a new one.
const avatarBlock = computed(() => avatarBlocked(app, item.value));
const avatarAsk = ref(false);
const frameworks = computed(() => (item.value?.frameworks || []).map((/** @type {any} */ x) => x.name).join('、'));

const name = computed(() => f('name') || '');
/** "1.3" -> "v1.3"; versions that already carry a v ("V1.3") are shown as written */
const versionLabel = computed(() => { const v = String(f('character_version') || '').trim(); return !v ? 'v—' : /^v/i.test(v) ? v : 'v' + v; });
const tags = computed(() => (Array.isArray(f('tags')) ? f('tags') : []));
const greetings = computed(() => (Array.isArray(f('alternate_greetings')) ? f('alternate_greetings') : []));
const fav = computed(() => { const v = f('extensions.fav'); return v === true || v === 'true'; });
const world = computed(() => f('extensions.world') || '');
const extras = computed(() => { void rev.value; return it.data.value ? extraFields(it.data.value) : []; });

// 角色备注 (depth prompt) — ST defaults: depth 4, role system.
const depth = computed(() => { const d = f('extensions.depth_prompt.depth'); return d ?? 4; });
const role = computed(() => f('extensions.depth_prompt.role') || 'system');
const ROLES = [{ value: 'system', label: '系统' }, { value: 'user', label: '用户' }, { value: 'assistant', label: '助手' }];
function setDepth(/** @type {Event} */ e) {
  const n = parseInt(/** @type {HTMLInputElement} */ (e.target).value, 10);
  if (Number.isFinite(n) && n >= 0) set('extensions.depth_prompt.depth', n);
}

// 群聊: talkativeness keeps its stored type (cards often hold the string "0.5").
const talk = computed(() => { const v = Number(f('extensions.talkativeness')); return Number.isFinite(v) ? v : 0.5; });
function setTalk(/** @type {Event} */ e) {
  const n = Math.round(Number(/** @type {HTMLInputElement} */ (e.target).value) * 100) / 100;
  set('extensions.talkativeness', typeof f('extensions.talkativeness') === 'number' ? n : String(n));
}

function toggleFav() {
  const on = !fav.value;
  const cur = f('extensions.fav');
  set('extensions.fav', typeof cur === 'string' ? String(on) : on);
}

// 高级定义 open state, per item.
const advKey = computed(() => 'cs.card.adv:' + props.path);
const advOpen = ref(localStorage.getItem(advKey.value) === '1');
watch(advKey, (k) => { advOpen.value = localStorage.getItem(k) === '1'; });
function toggleAdv() {
  advOpen.value = !advOpen.value;
  localStorage.setItem(advKey.value, advOpen.value ? '1' : '0');
}

// ---- views: 角色 / 世界书 / 角色正则 / 文件 (like the preset editor's pages) ----
// Only the extracted parts are loaded (companion omitParts); 世界书 and 角色正则 appear when those parts are extracted.
const extracted = computed(() => extractedOf(item.value));
const VIEWS = computed(() => [
  { value: 'form', label: '角色' },
  ...(extracted.value.has('character_book') ? [{ value: 'world', label: '世界书' }] : []),
  ...(extracted.value.has('regex') ? [{ value: 'regex', label: '角色正则' }] : []),
  { value: 'files', label: '文件' }
]);
const view = computed(() => {
  const v = ui.itemView[props.path]?.view || 'form';
  return VIEWS.value.some((o) => o.value === v) ? v : 'form';
});
const filesInitial = computed(() => ui.itemView[props.path]?.file || '');

// The editor holds only what was extracted when it loaded: reload when the extraction changes.
const layoutKey = computed(() => (item.value?.layout?.exclude || []).join());
watch(layoutKey, async () => {
  if (it.dirty.value || it.saving.value) await it.save();
  if (!it.externalChange.value) await it.load();
});

// ---- 世界书: the bound lorebook is its own workspace item, edited here with the lorebook editor ----
const worldPath = computed(() => item.value?.world?.path || '');

// ---- 角色正则: data.extensions.regex_scripts, same list editor as preset regex ----
const regexScripts = computed(() => { const s = f('extensions.regex_scripts'); return Array.isArray(s) ? s : null; });
const saveState = computed(() => (it.saving.value ? 'saving' : it.dirty.value && !it.externalChange.value ? 'dirty' : 'saved'));
function regexEdited() { rev.value++; it.touch(); }

// ---- outline: jump to a part of the card ----
const bookCount = computed(() => { const e = f('character_book.entries'); return Array.isArray(e) ? e.length : 0; });
const regexCount = computed(() => regexScripts.value?.length || 0);
/** Tavern Helper scripts: an object with `scripts`, or the older list of [key, value] pairs. */
const scriptCount = computed(() => {
  const th = f('extensions.tavern_helper');
  const s = Array.isArray(th) ? th.find((p) => Array.isArray(p) && p[0] === 'scripts')?.[1] : th?.scripts ?? f('extensions.TavernHelper_scripts');
  return Array.isArray(s) ? s.length : 0;
});

const hasXiaobaix = computed(() => (app.item(props.path)?.parts || []).includes('xiaobaix'));

/** @typedef {{id: string, label: string, adv?: boolean, sub?: boolean, count?: number, greet?: number, file?: string, view?: string}} OutlineItem */
const outline = computed(() => {
  /** @type {OutlineItem[]} */
  const out = [
    { id: 'ce-sec-head', label: '名称与标签' },
    { id: 'ce-sec-desc', label: '角色描述' }
  ];
  if (extracted.value.has('greetings')) {
    out.push({ id: 'ce-sec-first', label: '第一条消息' }, { id: 'ce-sec-greets', label: '其他开场', count: greetings.value.length });
    greetings.value.forEach((g, i) => out.push({ id: 'ce-greet-' + i, label: '#' + (i + 1) + ' ' + (String(g || '').split('\n').find((l) => l.trim()) || '（空）').replace(/[*"]/g, '').trim(), sub: true, greet: i }));
  }
  out.push(
    { id: 'ce-sec-prompt', label: '提示词覆盖', adv: true },
    { id: 'ce-sec-persona', label: '角色设定', adv: true },
    { id: 'ce-sec-note', label: '角色备注', adv: true },
    { id: 'ce-sec-creator', label: '创作者的元数据', adv: true },
    { id: 'ce-sec-group', label: '群聊', adv: true },
    { id: 'ce-sec-extra', label: '其他字段', adv: true }
  );
  if (extracted.value.has('character_book')) out.push({ id: '', label: world.value ? '世界书 · ' + world.value : '世界书', count: worldPath.value ? undefined : bookCount.value, view: 'world' });
  if (extracted.value.has('regex')) out.push({ id: '', label: '角色正则', count: regexCount.value, view: 'regex' });
  if (extracted.value.has('xiaobaix') && hasXiaobaix.value) out.push({ id: '', label: '小白X脚本及变量', file: 'xiaobaix' });
  if (extracted.value.has('helper') && scriptCount.value) out.push({ id: '', label: '酒馆助手脚本', count: scriptCount.value, file: 'scripts' });
  return out;
});

const greetList = ref(/** @type {any} */ (null));
const activeId = ref('ce-sec-head');
async function jump(/** @type {OutlineItem} */ o) {
  if (o.view) { ui.setItemView(props.path, o.view); return; }
  if (o.file) { ui.setItemView(props.path, 'files', o.file); return; }
  if (o.adv && !advOpen.value) toggleAdv();
  if (o.greet !== undefined) greetList.value?.reveal(o.greet);
  await nextTick();
  const el = document.getElementById(o.id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  activeId.value = o.sub ? 'ce-sec-greets' : o.id;
  lockUntil = Date.now() + 900;
  el.classList.remove('ce-flash');
  void el.offsetWidth;
  el.classList.add('ce-flash');
}

// Scroll spy: the outline marks the last section whose top has passed the upper part of the view.
let lockUntil = 0;
let raf = 0;
function spyNow() {
  raf = 0;
  if (view.value !== 'form' || Date.now() < lockUntil) return;
  const form = document.querySelector('.ce-form');
  if (!form) return;
  const line = Math.max(0, form.getBoundingClientRect().top) + 140;
  let cur = '';
  for (const o of outline.value) {
    if (!o.id || o.sub) continue;
    const el = document.getElementById(o.id);
    if (el && el.getBoundingClientRect().top <= line) cur = o.id;
  }
  activeId.value = cur || 'ce-sec-head';
}
function onScroll() { if (!raf) raf = requestAnimationFrame(spyNow); }
document.addEventListener('scroll', onScroll, true);
onBeforeUnmount(() => { document.removeEventListener('scroll', onScroll, true); cancelAnimationFrame(raf); });
</script>

<template>
  <div class="ce" :class="{ wide: !!it.data.value }">
    <div v-if="it.externalChange.value" class="banner warn">
      <Icon name="alert" />
      <div class="grow"><b>文件在别处被修改</b><span class="muted"> · 工作区里的文件在你编辑时被改动了（VS Code 或从酒馆取回），暂停写入。重新加载会丢弃这里尚未写入的修改；保留我的修改会用这里的内容覆盖那些改动。</span></div>
      <button class="btn sm" type="button" :disabled="keeping" @click="it.load()"><Icon name="refresh" size="sm" />重新加载</button>
      <button class="btn sm" type="button" :disabled="keeping" @click="keepMine"><Icon :name="keeping ? 'spin' : 'check'" size="sm" />保留我的修改</button>
    </div>

    <div v-if="it.error.value && !it.data.value" class="banner conflict">
      <Icon name="alert" />
      <div class="grow">无法读取角色卡：{{ it.error.value }}</div>
      <button class="btn sm" type="button" @click="it.load()">重试</button>
    </div>
    <div v-else-if="!it.data.value" class="ce-loading faint"><Icon name="spin" /> 正在读取角色卡…</div>

    <template v-else>
      <div class="ce-bar">
        <button class="icon-btn ce-hist" type="button" title="版本历史：只看这个角色的版本，可对比、恢复" aria-label="版本历史" @click="ui.go(historyHref(path))"><Icon name="history" size="sm" /></button>
        <span class="mono faint ce-path">{{ path }}/</span>
        <span class="ce-save" :class="{ busy: it.saving.value || it.dirty.value }">
          <template v-if="it.saving.value"><Icon name="spin" size="sm" />正在写入…</template>
          <template v-else-if="it.dirty.value && !it.externalChange.value"><Icon name="dot" size="sm" />未写入</template>
          <template v-else-if="it.externalChange.value"><Icon name="alert" size="sm" />暂停写入</template>
          <template v-else><Icon name="check" size="sm" />已写入工作区</template>
        </span>
        <Seg class="ce-view" :model-value="view" :options="VIEWS" @update:model-value="(v) => ui.setItemView(path, v)" />
      </div>

      <ItemFiles v-if="view === 'files'" class="ce-files" :path="path" :initial="filesInitial" />

      <!-- 世界书: the bound lorebook (its own workspace item) in the lorebook editor -->
      <div v-else-if="view === 'world'" class="ce-pane ce-world-pane">
        <div class="ce-world-head">
          <WorldPicker :model-value="world" :binding="binding" @update:model-value="set('extensions.world', $event)" />
        </div>
        <LorebookEditor v-if="worldPath" :key="worldPath" :path="worldPath" />
        <div v-else class="empty grow">
          <Icon name="book" />
          <template v-if="world">
            <h3>绑定的世界书「{{ world }}」还不在工作区</h3>
            <p class="muted">如果它在酒馆里，用上方的「一起取出」把它取出到工作区，就能在这里编辑。</p>
          </template>
          <template v-else-if="bookCount">
            <h3>这张卡带有内嵌世界书（{{ bookCount }} 个条目），但没有绑定世界书</h3>
            <p class="muted">酒馆只在导入内嵌世界书后使用它（导入后会绑定到这张卡）。可以在酒馆的角色面板中导入，再在上方选择并取出；也可以直接编辑内嵌条目的文件。</p>
            <button class="btn" type="button" @click="ui.setItemView(path, 'files', 'character_book')"><Icon name="file" size="sm" />编辑内嵌条目文件</button>
          </template>
          <template v-else>
            <h3>这张卡没有绑定世界书</h3>
            <p class="muted">在上方选择一本世界书绑定到这张卡。</p>
          </template>
        </div>
      </div>

      <!-- 角色正则: data.extensions.regex_scripts -->
      <div v-else-if="view === 'regex'" class="ce-pane">
        <RegexList v-if="regexScripts" :key="it.version.value" :scripts="regexScripts" :save-state="saveState" empty-text="这张卡还没有角色正则 · 点「新建」添加" @edited="regexEdited" />
        <div v-else class="empty grow">
          <Icon name="regex" /><h3>这张卡没有角色正则</h3>
          <p class="muted">角色正则随卡片保存在 extensions.regex_scripts 里，只对这个角色生效。</p>
          <button class="btn" type="button" @click="set('extensions.regex_scripts', [])"><Icon name="plus" size="sm" />添加角色正则</button>
        </div>
      </div>
      <div v-else class="ce-layout">
      <nav class="ce-outline" aria-label="大纲">
        <div class="ce-outline-h"><Icon name="outline" size="sm" />大纲</div>
        <button
          v-for="o in outline"
          :key="o.label + o.id"
          type="button"
          class="ce-ol"
          :class="{ on: !!o.id && o.id === activeId, sub: o.sub, file: !!o.file || !!o.view }"
          :title="o.view ? '切换到「' + o.label.split(' · ')[0] + '」页' : o.file ? '在「文件」中打开' : o.label"
          @click="jump(o)"
        >
          <span class="ce-ol-t">{{ o.label }}</span>
          <span v-if="o.count" class="ce-ol-n">{{ o.count }}</span>
          <Icon v-if="o.view" name="chevRight" size="sm" />
          <Icon v-else-if="o.file" name="file" size="sm" />
        </button>
      </nav>
      <div class="ce-form">

      <div id="ce-sec-head" class="ce-head">
        <div class="ce-avatar">
          <Avatar :name="name || '?'" :target="binding?.target || ''" :file="binding?.id || ''" :lazy="false" />
          <button class="btn sm ghost ce-avatar-btn" type="button" :disabled="!!avatarBlock" :title="avatarBlock || '在绑定的酒馆里换一张头像图片'" @click="avatarAsk = true">更换头像…</button>
          <AvatarDialog v-if="avatarAsk" :path="path" @close="avatarAsk = false" />
        </div>
        <div class="ce-meta">
          <div class="ce-name-row">
            <input
              class="input ce-name"
              :value="name"
              placeholder="为这个角色命名"
              aria-label="名称"
              @input="set('name', $event.target.value)"
            >
            <button
              class="ce-fav"
              :class="{ on: fav }"
              type="button"
              :title="fav ? '从收藏夹移除' : '添加到收藏夹'"
              :aria-pressed="fav"
              @click="toggleFav"
            >
              <Star class="ic" aria-hidden="true" />
            </button>
          </div>
          <div class="field">
            <label>嵌入的标签</label>
            <TagInput :tags="tags" @update="set('tags', $event)" />
          </div>
          <div class="ce-sub faint">
            <Icon name="user" size="sm" />{{ f('creator') || '未填写创作者' }}
            <span>·</span>{{ versionLabel }}
            <template v-if="world"><span>·</span><Icon name="book" size="sm" />{{ world }}</template>
            <template v-if="frameworks"><span>·</span><span class="ce-fw" :title="'这张卡内含这些框架的脚本或数据，在酒馆中需要安装对应插件才能生效；TavernCellar 只原样保存，不运行它们'"><Icon name="puzzle" size="sm" />卡内使用：{{ frameworks }}</span></template>
          </div>
        </div>
      </div>

      <CardText id="ce-sec-desc" big label="角色描述" :rows="8" :model-value="f('description')" @update:model-value="set('description', $event)" />
      <template v-if="extracted.has('greetings')">
        <CardText id="ce-sec-first" big label="第一条消息" :rows="6" :model-value="f('first_mes')" @update:model-value="set('first_mes', $event)" />
        <GreetingList id="ce-sec-greets" ref="greetList" :items="greetings" @update="set('alternate_greetings', $event)" />
      </template>

      <div class="card ce-adv-wrap" :class="{ collapsed: !advOpen }">
        <button class="collapse-head" type="button" :aria-expanded="advOpen" @click="toggleAdv">
          <span class="chev"><Icon name="chevDown" size="sm" /></span>高级定义
          <span class="meta">提示词覆盖 · 角色设定 · 角色备注 · 创作者的元数据 · 群聊</span>
        </button>
        <div v-if="advOpen" class="collapse-body ce-adv">
          <section id="ce-sec-prompt" class="ce-block">
            <div class="ce-block-title"><h3>提示词覆盖</h3><p>可插入 <code v-pre>{{original}}</code> 引用全局设置中的原文</p></div>
            <div class="ce-block-body">
              <CardText label="主要提示词" :rows="3" :model-value="f('system_prompt')" @update:model-value="set('system_prompt', $event)" />
              <CardText label="后续历史指令" :rows="2" :model-value="f('post_history_instructions')" @update:model-value="set('post_history_instructions', $event)" />
            </div>
          </section>
          <section id="ce-sec-persona" class="ce-block">
            <div class="ce-block-title"><h3>角色设定</h3></div>
            <div class="ce-block-body">
              <CardText label="角色设定摘要" :rows="2" :model-value="f('personality')" @update:model-value="set('personality', $event)" />
              <CardText label="情景" :rows="2" :model-value="f('scenario')" @update:model-value="set('scenario', $event)" />
              <CardText label="对话示例" code :rows="5" hint="每段以 <START> 开头" :model-value="f('mes_example')" @update:model-value="set('mes_example', $event)" />
            </div>
          </section>
          <section id="ce-sec-note" class="ce-block">
            <div class="ce-block-title"><h3>角色备注</h3><p>按深度插入到聊天记录中</p></div>
            <div class="ce-block-body">
              <CardText label="角色备注" :rows="2" :model-value="f('extensions.depth_prompt.prompt')" @update:model-value="set('extensions.depth_prompt.prompt', $event)" />
              <div class="field-row">
                <div class="field">
                  <label>@ 深度</label>
                  <input class="input num ce-num" type="number" min="0" :value="depth" @change="setDepth">
                </div>
                <div class="field">
                  <label>角色</label>
                  <Seg :model-value="role" :options="ROLES" @update:model-value="set('extensions.depth_prompt.role', $event)" />
                </div>
              </div>
            </div>
          </section>
          <section id="ce-sec-creator" class="ce-block">
            <div class="ce-block-title"><h3>创作者的元数据</h3></div>
            <div class="ce-block-body">
              <div class="ce-grid-2">
                <div class="field">
                  <label>创作者</label>
                  <input class="input" :value="f('creator') ?? ''" @input="set('creator', $event.target.value)">
                </div>
                <div class="field">
                  <label>角色版本</label>
                  <input class="input mono" :value="f('character_version') ?? ''" @input="set('character_version', $event.target.value)">
                </div>
              </div>
              <CardText label="创作者的注释" :rows="3" hint="不随 AI 提示词发送" :model-value="f('creator_notes')" @update:model-value="set('creator_notes', $event)" />
            </div>
          </section>
          <section id="ce-sec-group" class="ce-block">
            <div class="ce-block-title"><h3>群聊</h3></div>
            <div class="ce-block-body">
              <div class="field">
                <label>发言频率</label>
                <div class="ce-talk">
                  <span>低</span>
                  <input class="ce-range" type="range" min="0" max="1" step="0.05" :value="talk" aria-label="发言频率" @input="setTalk">
                  <span>高</span>
                  <output class="badge">{{ talk.toFixed(2) }}</output>
                </div>
              </div>
            </div>
          </section>
          <section id="ce-sec-extra" class="ce-block">
            <div class="ce-block-title"><h3>其他字段</h3><p>原样保留，可在 card.json 中编辑</p></div>
            <div class="ce-block-body">
              <div v-if="extras.length" class="ce-extras">
                <div v-for="x in extras" :key="x[0]" class="ce-extra"><span class="mono">{{ x[0] }}</span><span class="faint mono">{{ x[1] }}</span></div>
              </div>
              <div v-else class="faint">没有其他字段</div>
            </div>
          </section>
        </div>
      </div>
      <div class="ce-tail" />
      </div>
      </div>
    </template>
  </div>
</template>
