<script setup>
// Renders its slot only once it comes near the viewport (and keeps it afterwards). Long lists of heavy blocks
// (version-history field diffs: hundreds of side-by-side text diffs) then cost only what is on screen.
import { ref, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  /** placeholder height before the content is shown */
  minHeight: { type: Number, default: 80 }
});
const shown = ref(false);
const el = ref(/** @type {HTMLElement|null} */ (null));
/** @type {IntersectionObserver|null} */
let io = null;

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined' || !el.value) { shown.value = true; return; }
  io = new IntersectionObserver((list) => {
    if (list.some((e) => e.isIntersecting)) { shown.value = true; io?.disconnect(); io = null; }
  }, { rootMargin: '600px 0px' });
  io.observe(el.value);
});
onBeforeUnmount(() => { io?.disconnect(); io = null; });
</script>

<template>
  <div ref="el" :style="shown ? undefined : { minHeight: props.minHeight + 'px' }">
    <slot v-if="shown" />
  </div>
</template>
