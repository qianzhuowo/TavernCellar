<script setup>
defineProps({
  modelValue: { type: Boolean, default: false },
  label: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  sync: { type: Boolean, default: false },
  title: { type: String, default: '' }
});
defineEmits(['update:modelValue']);
</script>

<template>
  <label class="toggle" :class="{ sync, disabled }" :title="title">
    <input type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit('update:modelValue', /** @type {HTMLInputElement} */ ($event.target).checked)" />
    <span class="track" />
    <span v-if="label" class="tlabel">{{ label }}</span>
  </label>
</template>
