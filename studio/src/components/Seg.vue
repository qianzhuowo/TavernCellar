<script setup>
/** Segmented control. options: [{value, label}] */
defineProps({
  modelValue: { type: [String, Number, Boolean, null], default: null },
  options: { type: Array, required: true },
  disabled: { type: Boolean, default: false },
  accent: { type: Boolean, default: false }
});
defineEmits(['update:modelValue']);
</script>

<template>
  <div class="seg" :class="{ accent }" role="radiogroup">
    <button
      v-for="o in options"
      :key="String(o.value)"
      type="button"
      role="radio"
      :aria-checked="modelValue === o.value"
      :class="{ on: modelValue === o.value }"
      :disabled="disabled"
      @click="modelValue !== o.value && $emit('update:modelValue', o.value)"
    >
      <slot name="option" :option="o">{{ o.label }}</slot>
    </button>
  </div>
</template>
