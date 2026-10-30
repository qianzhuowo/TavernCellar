<script setup>
import Icon from './Icon.vue';
import { useUi } from '../stores/ui.js';
const ui = useUi();
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="{ 'toast-err': t.icon === 'alert' }">
      <Icon :name="t.icon" size="sm" />{{ t.text }}
    </div>
  </div>
</template>
