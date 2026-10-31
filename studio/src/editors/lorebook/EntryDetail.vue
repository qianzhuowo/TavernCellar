<script setup>
// Entry detail pane (docs/studio-design.md §4.4 条目详情; fields and ST wording per appendix A).
// Edits mutate the (reactive) entry in place and emit 'change'; the editor auto-saves.
import { computed, ref, watch } from 'vue';
import Icon from '../../components/Icon.vue';
import Seg from '../../components/Seg.vue';
import Toggle from '../../components/Toggle.vue';
import ChipInput from './ChipInput.vue';
import { POS, lampOf, groupOf } from './entry.js';

const props = defineProps({
  entry: { type: Object, required: true },
  groups: { type: Array, default: () => [] }
});
const emit = defineEmits(['change', 'duplicate', 'delete', 'move']);

const LAMPS = [{ value: 'const', label: '永久' }, { value: 'key', label: '关键词' }, { value: 'vec', label: '向量化' }];
const LOGIC = [[0, '与任意'], [3, '与所有'], [2, '非所有'], [1, '非任何']];
const ROLES = [{ value: 0, label: '⚙ 系统' }, { value: 1, label: '👤 用户' }, { value: 2, label: '🤖 AI' }];
const TRI = [{ value: null, label: '全局' }, { value: true, label: '是' }, { value: false, label: '否' }];
const TRIGGERS = [['normal', '正常'], ['continue', '继续'], ['impersonate', 'AI 帮答'], ['swipe', '滑动'], ['regenerate', '重新生成'], ['quiet', '静默']];
const MATCH = [['matchCharacterDescription', '角色描述'], ['matchCharacterPersonality', '角色性格'], ['matchScenario', '情景'],
  ['matchPersonaDescription', '用户设定描述'], ['matchCharacterDepthPrompt', '角色备注'], ['matchCreatorNotes', '创作者的注释']];

const e = computed(() => /** @type {any} */ (props.entry));
const lamp = computed(() => lampOf(e.value));
const isD = computed(() => e.value.position === 4);
const confirmDelete = ref(false);
watch(() => e.value.uid, () => { confirmDelete.value = false; });

const ADV_KEY = 'tc.lb.adv';
const advOpen = ref(localStorage.getItem(ADV_KEY) === '1');
watch(advOpen, (v) => localStorage.setItem(ADV_KEY, v ? '1' : '0'));

/** @param {string} k @param {unknown} v */
function set(k, v) {
  e.value[k] = v;
  emit('change');
}
/** @param {string} v */
function setLamp(v) {
  e.value.constant = v === 'const';
  e.value.vectorized = v === 'vec';
  emit('change');
}
/** Number input → number, or null for nullable fields when emptied. @param {Event} ev @param {boolean} nullable */
function numOf(ev, nullable = false) {
  const raw = /** @type {HTMLInputElement} */ (ev.target).value.trim();
  if (raw === '') return nullable ? null : 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : nullable ? null : 0;
}
/** @param {Event} ev */
const val = (ev) => /** @type {HTMLInputElement} */ (ev.target).value;
/** @param {Event} ev */
const checked = (ev) => /** @type {HTMLInputElement} */ (ev.target).checked;

/** @param {string} t */
function toggleTrigger(t) {
  const cur = Array.isArray(e.value.triggers) ? e.value.triggers : [];
  set('triggers', cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
}
const filter = computed(() => e.value.characterFilter ?? { isExclude: false, names: [], tags: [] });
/** @param {object} patch */
function setFilter(patch) { set('characterFilter', { ...filter.value, ...patch }); }

const group = computed(() => groupOf(e.value));
/** Group changes go through the editor: joining a group may also change the insert position (same group, same position). @param {Event} ev */
function changeGroup(ev) {
  emit('move', val(ev));
}
// ST stores delayUntilRecursion as false/true or a recursion level.
const delayOn = computed(() => Boolean(e.value.delayUntilRecursion));
</script>

<template>
  <div class="ent">
    <div class="ent-title">
      <span class="lamp" :class="lamp" />
      <input class="input title-input" :value="e.comment ?? ''" placeholder="条目标题/备忘录" aria-label="条目标题/备忘录" @input="set('comment', val($event))" />
      <span class="uid mono" title="uid">#{{ e.uid }}</span>
      <button class="icon-btn" title="复制为新条目" @click="emit('duplicate')"><Icon name="copy" size="sm" /></button>
      <button v-if="!confirmDelete" class="icon-btn" title="删除条目" @click="confirmDelete = true"><Icon name="trash" size="sm" /></button>
      <button v-else class="btn sm danger" @click="emit('delete')">确认删除</button>
    </div>

    <div class="ent-status">
      <div class="field compact"><label>状态</label>
        <Seg :model-value="lamp" :options="LAMPS" @update:model-value="setLamp">
          <template #option="{ option }"><span class="lamp" :class="option.value" />{{ option.label }}</template>
        </Seg>
      </div>
      <div class="field compact"><label>启用</label>
        <Toggle :model-value="!e.disable" :label="e.disable ? '已停用' : '已启用'" @update:model-value="set('disable', !$event)" />
      </div>
      <div class="field compact grow"><label>分组<span class="hint">Cellar 分组，/ 分级；对应工作区子文件夹</span></label>
        <input class="input" :value="group" list="lb-groups" placeholder="（未分组）" @change="changeGroup" />
        <datalist id="lb-groups"><option v-for="g in groups" :key="g" :value="g" /></datalist>
      </div>
    </div>

    <div class="ent-block">
      <div class="ent-block-title">关键字</div>
      <div class="field compact"><label>主要关键字<span class="hint">支持 /正则/</span></label>
        <ChipInput :model-value="e.key ?? []" placeholder="输入关键字后回车" @update:model-value="set('key', $event)" />
      </div>
      <div class="kw-row">
        <div class="field compact"><label>逻辑</label>
          <select class="select" style="width: 120px" :value="e.selectiveLogic ?? 0" @change="set('selectiveLogic', Number(val($event)))">
            <option v-for="l in LOGIC" :key="l[0]" :value="l[0]">{{ l[1] }}</option>
          </select>
        </div>
        <div class="field compact grow"><label>可选过滤器</label>
          <ChipInput :model-value="e.keysecondary ?? []" placeholder="可选，与逻辑配合" @update:model-value="set('keysecondary', $event)" />
        </div>
      </div>
    </div>

    <div class="ent-block">
      <div class="ent-block-title">插入</div>
      <div class="ins-row">
        <div class="field compact"><label>位置</label>
          <select class="select" style="width: 196px" :value="e.position ?? 0" @change="set('position', Number(val($event)))">
            <option v-for="(p, i) in POS" :key="i" :value="i">{{ p.short }} · {{ p.label }}</option>
          </select>
        </div>
        <div class="field compact" :class="{ 'is-disabled': !isD }"><label>深度<span v-if="!isD" class="hint">仅 @D</span></label>
          <input class="input num" type="number" min="0" :value="e.depth ?? ''" :disabled="!isD" @change="set('depth', numOf($event))" />
        </div>
        <div v-if="isD" class="field compact"><label>角色</label>
          <Seg :model-value="e.role ?? 0" :options="ROLES" @update:model-value="set('role', $event)" />
        </div>
        <div class="field compact"><label>顺序</label>
          <input class="input num" type="number" :value="e.order ?? ''" @change="set('order', numOf($event))" />
        </div>
        <div class="field compact"><label>触发 %</label>
          <div class="prob">
            <input class="input num" type="number" min="0" max="100" :value="e.probability ?? 100" @change="set('probability', numOf($event))" />
            <label class="check"><input type="checkbox" :checked="e.useProbability !== false" @change="set('useProbability', checked($event))" />使用概率</label>
          </div>
        </div>
        <div v-if="e.position === 7" class="field compact"><label>Outlet 名称</label>
          <input class="input mono" style="width: 130px" :value="e.outletName ?? ''" @input="set('outletName', val($event))" />
        </div>
      </div>
    </div>

    <div class="field ent-content">
      <label>内容<span class="hint">{{ (e.content ?? '').length }} 字</span></label>
      <textarea class="textarea" spellcheck="false" :value="e.content ?? ''" @input="set('content', val($event))" />
    </div>

    <div class="card ent-adv-wrap">
      <button class="collapse-head" type="button" :aria-expanded="advOpen" @click="advOpen = !advOpen">
        <Icon :name="advOpen ? 'chevDown' : 'chevRight'" size="sm" />高级
        <span class="faint">递归 · 分组 · 时效 · 扫描 · 额外匹配来源 · 筛选 · 其他</span>
      </button>
      <div v-if="advOpen" class="ent-adv">
        <div class="adv-grp"><h4>递归</h4>
          <div class="checks">
            <label class="check"><input type="checkbox" :checked="!!e.excludeRecursion" @change="set('excludeRecursion', checked($event))" />不可递归</label>
            <label class="check"><input type="checkbox" :checked="!!e.preventRecursion" @change="set('preventRecursion', checked($event))" />防止进一步递归</label>
          </div>
          <div class="inline-fields">
            <label class="check"><input type="checkbox" :checked="delayOn" @change="set('delayUntilRecursion', checked($event))" />延迟到递归</label>
            <div class="field compact" :class="{ 'is-disabled': !delayOn }"><label>递归等级</label>
              <input class="input num" type="number" min="1" placeholder="1" :disabled="!delayOn"
                :value="typeof e.delayUntilRecursion === 'number' ? e.delayUntilRecursion : ''"
                @change="set('delayUntilRecursion', numOf($event, true) ?? true)" />
            </div>
          </div>
        </div>
        <div class="adv-grp"><h4>包含组</h4>
          <div class="inline-fields">
            <div class="field compact grow"><label>包含组</label>
              <input class="input" :value="e.group ?? ''" placeholder="组名，逗号分隔" @input="set('group', val($event))" />
            </div>
            <div class="field compact"><label>组权重</label>
              <input class="input num" type="number" :value="e.groupWeight ?? ''" @change="set('groupWeight', numOf($event))" />
            </div>
          </div>
          <div class="inline-fields">
            <label class="check"><input type="checkbox" :checked="!!e.groupOverride" @change="set('groupOverride', checked($event))" />确定优先级</label>
            <div class="field compact"><label>组评分</label><Seg :model-value="e.useGroupScoring ?? null" :options="TRI" @update:model-value="set('useGroupScoring', $event)" /></div>
          </div>
        </div>
        <div class="adv-grp"><h4>时效</h4>
          <div class="inline-fields">
            <div class="field compact"><label>黏性</label><input class="input num" type="number" placeholder="无" :value="e.sticky ?? ''" @change="set('sticky', numOf($event, true))" /></div>
            <div class="field compact"><label>冷却</label><input class="input num" type="number" placeholder="无" :value="e.cooldown ?? ''" @change="set('cooldown', numOf($event, true))" /></div>
            <div class="field compact"><label>延迟</label><input class="input num" type="number" placeholder="无" :value="e.delay ?? ''" @change="set('delay', numOf($event, true))" /></div>
          </div>
        </div>
        <div class="adv-grp"><h4>扫描</h4>
          <div class="tri-grid">
            <span>扫描深度</span>
            <input class="input num" type="number" min="0" placeholder="全局" :value="e.scanDepth ?? ''" @change="set('scanDepth', numOf($event, true))" />
            <span>区分大小写</span><Seg :model-value="e.caseSensitive ?? null" :options="TRI" @update:model-value="set('caseSensitive', $event)" />
            <span>完整单词</span><Seg :model-value="e.matchWholeWords ?? null" :options="TRI" @update:model-value="set('matchWholeWords', $event)" />
          </div>
        </div>
        <div class="adv-grp wide"><h4>额外匹配来源</h4>
          <div class="checks cols-3">
            <label v-for="m in MATCH" :key="m[0]" class="check"><input type="checkbox" :checked="!!e[m[0]]" @change="set(m[0], checked($event))" />{{ m[1] }}</label>
          </div>
        </div>
        <div class="adv-grp wide"><h4>筛选</h4>
          <div class="field compact"><label>绑定到角色</label>
            <ChipInput :model-value="filter.names ?? []" placeholder="输入角色名" @update:model-value="setFilter({ names: $event })" />
          </div>
          <div class="field compact"><label>绑定到标签</label>
            <ChipInput :model-value="filter.tags ?? []" placeholder="输入标签" @update:model-value="setFilter({ tags: $event })" />
          </div>
          <label class="check"><input type="checkbox" :checked="!!filter.isExclude" @change="setFilter({ isExclude: checked($event) })" />排除</label>
          <div class="field compact"><label>筛选生成触发器<span class="hint">都不选 = 全部</span></label>
            <div class="trig">
              <button v-for="t in TRIGGERS" :key="t[0]" type="button" class="trig-btn" :class="{ on: (e.triggers ?? []).includes(t[0]) }" @click="toggleTrigger(t[0])">{{ t[1] }}</button>
            </div>
          </div>
        </div>
        <div class="adv-grp wide"><h4>其他</h4>
          <div class="checks">
            <label class="check"><input type="checkbox" :checked="!!e.ignoreBudget" @change="set('ignoreBudget', checked($event))" />无视回复限额</label>
            <label class="check"><input type="checkbox" :checked="!!e.addMemo" @change="set('addMemo', checked($event))" />添加备忘录</label>
            <label class="check"><input type="checkbox" :checked="!!e.selective" @change="set('selective', checked($event))" />选择性</label>
          </div>
          <div class="field compact"><label>自动化 ID</label>
            <input class="input mono" :value="e.automationId ?? ''" placeholder="（空）" @input="set('automationId', val($event))" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
