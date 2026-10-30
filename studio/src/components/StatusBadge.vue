<script setup>
// Small status badge: <StatusBadge status="local" /> or icon-only.
import Icon from './Icon.vue';
import { STATUS, STATUS_CLASS } from '../lib/status.js';

defineProps({
  status: { type: String, required: true },
  iconOnly: { type: Boolean, default: false },
  label: { type: String, default: '' },
  title: { type: String, default: '' }
});
</script>

<template>
  <span class="st" :class="[STATUS_CLASS[status] || 'unbound', { 'icon-only': iconOnly }]" :title="title || (iconOnly ? (STATUS[status] || {}).label : '')">
    <Icon :name="(STATUS[status] || STATUS.unbound).icon" />
    <template v-if="!iconOnly">{{ label || (STATUS[status] || STATUS.unbound).label }}</template>
  </span>
</template>
