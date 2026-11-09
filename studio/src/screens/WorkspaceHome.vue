<script setup>
// 工作区 with no document open (#/workspace): an empty page like VS Code's, with a rotating friendly tip.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import { useApp } from '../stores/app.js';
import { useUi } from '../stores/ui.js';

const app = useApp();
const ui = useUi();

const EMPTY_TIPS = [
  '当前工作区还是空白哦，去资料库中提取或者自己新建一个项目吧~',
  '酒窖里还空空的~ 从资料库取出一张角色卡，或者点工作区右上角的「+」新建一个吧！',
  '这里静悄悄的……要不要先去资料库挑一本世界书搬进来？',
  '新的故事从一张空白卡片开始~ 点工作区的「+」试试看吧',
];
const TIPS = [
  '从左边挑一个项目开始编辑吧~',
  '小提示：按 Ctrl+P 可以快速打开任意项目哦',
  '改完记得在「历史」里记录一个版本，以后想回来就方便啦~',
  '右键工作区里的项目，还能找到更多小功能哦',
  '想看看酒馆最后会发出去什么？去「预览」里瞧一瞧吧~',
];
const empty = computed(() => !app.items.length);
const tips = computed(() => (empty.value ? EMPTY_TIPS : TIPS));
const i = ref(Math.floor(Math.random() * 100));
const tip = computed(() => tips.value[i.value % tips.value.length]);
const next = () => { i.value++; };
let timer = 0;
onMounted(() => { timer = window.setInterval(next, 8000); });
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="ws-home">
    <div class="ws-home-mark"><Icon name="wine" /></div>
    <Transition name="ws-tip" mode="out-in">
      <p :key="tip" class="ws-home-tip" title="点一下换一条" @click="next">{{ tip }}</p>
    </Transition>
    <div class="ws-home-by">—— by: 茄子</div>
    <button class="btn sm ghost ws-home-act" type="button" title="把磁盘上 Cellar 格式的资料项文件夹复制进工作区" @click="ui.importAsk = true"><Icon name="folderOpen" size="sm" />导入文件夹…</button>
  </div>
</template>
