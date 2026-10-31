<script setup>
// S2 character card editor (docs/studio-design.md §4.3). Placeholder until implemented.
import { toRef } from 'vue';
import { useItem } from '../lib/useItem.js';

const props = defineProps({ path: { type: String, required: true } });
const it = useItem(toRef(props, 'path'));
</script>

<template>
  <div class="page"><p class="muted">角色卡编辑器开发中…{{ it.loading.value ? '' : '' }}</p></div>
</template>
