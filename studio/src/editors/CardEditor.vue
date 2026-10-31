<script setup>
// S2 character card editor (docs/studio-design.md §4.3, §5.1-5.2). Edits `data.*` of the decoded card and keeps the
// root mirrors equal (components/card/cardFields.js); useItem writes the workspace files after a short pause.
import { ref, shallowRef, computed, watch, toRef, toRaw } from 'vue';
import { Star } from 'lucide-vue-next';
import { useItem } from '../lib/useItem.js';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';
import { hueOf, initialOf } from '../lib/status.js';
import Icon from '../components/Icon.vue';
import Seg from '../components/Seg.vue';
import CardText from '../components/card/CardText.vue';
import GreetingList from '../components/card/GreetingList.vue';
import TagInput from '../components/card/TagInput.vue';
import WorldPicker from '../components/card/WorldPicker.vue';
import { getField, setField, extraFields } from '../components/card/cardFields.js';

const props = defineProps({ path: { type: String, required: true } });
const it = useItem(toRef(props, 'path'));
const app = useApp();
const ui = useUi();

// `it.data` is a shallowRef mutated in place: `rev` makes the template re-read fields after each edit.
const rev = ref(0);
watch(it.version, () => { rev.value++; });

// Snapshot of the data as loaded: clearing a text field that had content shows a sync hint (saves don't reload).
const orig = shallowRef(/** @type {any} */ (null));
watch(it.version, () => { orig.value = it.data.value ? structuredClone(toRaw(it.data.value)) : null; }, { immediate: true });
const was = (/** @type {string} */ path) => { const v = getField(orig.value, path); return typeof v === 'string' ? v : null; };

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

const name = computed(() => f('name') || '');
const avatarStyle = computed(() => {
  const h = hueOf(name.value || props.path);
  return { background: `linear-gradient(150deg, hsl(${h} 42% 46%), hsl(${(h + 40) % 360} 46% 26%))` };
});
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
</script>

<template>
  <div class="ce">
    <div v-if="it.externalChange.value" class="banner warn">
      <Icon name="alert" />
      <div class="grow"><b>文件在别处被修改</b><span class="muted"> · 工作区里的文件在你编辑时被改动了（VS Code 或从酒馆取回）。重新加载会丢弃这里尚未写入的修改。</span></div>
      <button class="btn sm" type="button" @click="it.load()"><Icon name="refresh" size="sm" />重新加载</button>
    </div>

    <div v-if="it.error.value && !it.data.value" class="banner conflict">
      <Icon name="alert" />
      <div class="grow">无法读取角色卡：{{ it.error.value }}</div>
      <button class="btn sm" type="button" @click="it.load()">重试</button>
    </div>
    <div v-else-if="!it.data.value" class="ce-loading faint"><Icon name="spin" /> 正在读取角色卡…</div>

    <template v-else>
      <div class="ce-bar">
        <span class="mono faint ce-path">{{ path }}/</span>
        <span class="ce-save" :class="{ busy: it.saving.value || it.dirty.value }">
          <template v-if="it.saving.value"><Icon name="spin" size="sm" />正在写入…</template>
          <template v-else-if="it.dirty.value && !it.externalChange.value"><Icon name="dot" size="sm" />未写入</template>
          <template v-else-if="it.externalChange.value"><Icon name="alert" size="sm" />暂停写入</template>
          <template v-else><Icon name="check" size="sm" />已写入工作区</template>
        </span>
      </div>

      <div class="ce-head">
        <div class="ce-avatar">
          <div class="avatar" :style="avatarStyle">{{ initialOf(name || '?') }}</div>
          <span class="faint">换头像请在酒馆中操作</span>
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
            <span>·</span>v{{ f('character_version') || '—' }}
            <template v-if="world"><span>·</span><Icon name="book" size="sm" />{{ world }}</template>
          </div>
        </div>
      </div>

      <CardText big label="角色描述" :rows="8" :was="was('description')" :model-value="f('description')" @update:model-value="set('description', $event)" />
      <CardText big label="第一条消息" :rows="6" :was="was('first_mes')" :model-value="f('first_mes')" @update:model-value="set('first_mes', $event)" />
      <GreetingList :items="greetings" :version="it.version.value" @update="set('alternate_greetings', $event)" />

      <div class="card ce-adv-wrap" :class="{ collapsed: !advOpen }">
        <button class="collapse-head" type="button" :aria-expanded="advOpen" @click="toggleAdv">
          <span class="chev"><Icon name="chevDown" size="sm" /></span>高级定义
          <span class="meta">提示词覆盖 · 角色设定 · 角色备注 · 创作者的元数据 · 群聊 · 世界书</span>
        </button>
        <div v-if="advOpen" class="collapse-body ce-adv">
          <section class="ce-block">
            <div class="ce-block-title"><h3>提示词覆盖</h3><p>可插入 <code v-pre>{{original}}</code> 引用全局设置中的原文</p></div>
            <div class="ce-block-body">
              <CardText label="主要提示词" :rows="3" :was="was('system_prompt')" :model-value="f('system_prompt')" @update:model-value="set('system_prompt', $event)" />
              <CardText label="后续历史指令" :rows="2" :was="was('post_history_instructions')" :model-value="f('post_history_instructions')" @update:model-value="set('post_history_instructions', $event)" />
            </div>
          </section>
          <section class="ce-block">
            <div class="ce-block-title"><h3>角色设定</h3></div>
            <div class="ce-block-body">
              <CardText label="角色设定摘要" :rows="2" :was="was('personality')" :model-value="f('personality')" @update:model-value="set('personality', $event)" />
              <CardText label="情景" :rows="2" :was="was('scenario')" :model-value="f('scenario')" @update:model-value="set('scenario', $event)" />
              <CardText label="对话示例" code :rows="5" hint="每段以 <START> 开头" :model-value="f('mes_example')" @update:model-value="set('mes_example', $event)" />
            </div>
          </section>
          <section class="ce-block">
            <div class="ce-block-title"><h3>角色备注</h3><p>按深度插入到聊天记录中</p></div>
            <div class="ce-block-body">
              <CardText label="角色备注" :rows="2" :was="was('extensions.depth_prompt.prompt')" :model-value="f('extensions.depth_prompt.prompt')" @update:model-value="set('extensions.depth_prompt.prompt', $event)" />
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
          <section class="ce-block">
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
              <CardText label="创作者的注释" :rows="3" hint="不随 AI 提示词发送" :was="was('creator_notes')" :model-value="f('creator_notes')" @update:model-value="set('creator_notes', $event)" />
            </div>
          </section>
          <section class="ce-block">
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
          <section class="ce-block">
            <div class="ce-block-title"><h3>世界书</h3></div>
            <div class="ce-block-body">
              <WorldPicker :model-value="world" :binding="binding" @update:model-value="set('extensions.world', $event)" />
            </div>
          </section>
          <section class="ce-block">
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
    </template>
  </div>
</template>
