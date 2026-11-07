<script setup>
// Small pill dropdown ("状态 全部 ▾") used in list toolbars. A transparent native <select> covers the whole pill, so a
// click anywhere on it (prefix, value or arrow) opens the list, and keyboard / screen readers keep the native control.
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  /** @type {import('vue').PropType<string|number>} */
  modelValue: { type: [String, Number], default: '' },
  /** @type {import('vue').PropType<{value: string|number, label: string, disabled?: boolean}[]>} */
  options: { type: Array, required: true },
  /** prefix shown before the value, e.g. 状态 */
  label: { type: String, default: '' },
  /** shown when no option matches (e.g. 改为…) */
  placeholder: { type: String, default: '' },
  /** highlighted when the filter is not at its default */
  active: { type: Boolean, default: false },
  title: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(['update:modelValue', 'change']);

const current = computed(() => props.options.find((/** @type {any} */ o) => String(o.value) === String(props.modelValue)));
function change(/** @type {Event} */ ev) {
  const raw = /** @type {HTMLSelectElement} */ (ev.target).value;
  const opt = props.options.find((/** @type {any} */ o) => String(o.value) === raw);
  const value = opt ? /** @type {any} */ (opt).value : raw;
  emit('update:modelValue', value);
  emit('change', value);
}
</script>

<template>
  <label class="mini-select" :class="{ active, disabled }" :title="title">
    <span v-if="label" class="ms-label">{{ label }}</span>
    <span class="ms-value">{{ current ? /** @type {any} */ (current).label : placeholder }}</span>
    <Icon name="chevDown" size="sm" />
    <select :value="current ? String(/** @type {any} */ (current).value) : ''" :disabled="disabled" :aria-label="label || title || undefined" @change="change">
      <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
      <option v-for="o in /** @type {any[]} */ (options)" :key="String(o.value)" :value="String(o.value)" :disabled="o.disabled">{{ o.label }}</option>
    </select>
  </label>
</template>
