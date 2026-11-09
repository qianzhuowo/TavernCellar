<script setup>
// Character avatar: initial on a name-coloured gradient, covered by the tavern's thumbnail once it loads.
// The image comes from the companion (GET /api/assets/avatar, see companion/src/assets.js); any failure keeps the initial.
import { computed, ref, watch } from 'vue';
import { hueOf, initialOf } from '../lib/status.js';
import { useApp } from '../stores/app.js';

const props = defineProps({
  name: { type: String, default: '' },
  /** tavern id the card lives in; no image without it */
  target: { type: String, default: '' },
  /** avatar file name in that tavern (binding id), e.g. "Alice.png" */
  file: { type: String, default: '' },
  /** load only when scrolled into view */
  lazy: { type: Boolean, default: true }
});

const app = useApp();
const loaded = ref(false);
const failed = ref(false);
// `v`: the avatar was changed from Studio, so the browser's cached image is stale.
const src = computed(() => {
  if (!props.target || !props.file || !/\.png$/i.test(props.file)) return '';
  const v = app.avatarAt[props.target + '/' + props.file];
  return `/api/assets/avatar?target=${encodeURIComponent(props.target)}&id=${encodeURIComponent(props.file)}${v ? '&v=' + v : ''}`;
});
watch(src, () => { loaded.value = false; failed.value = false; });

const style = computed(() => {
  const h = hueOf(props.name || props.file || '?');
  return { background: `linear-gradient(150deg, hsl(${h} 42% 46%), hsl(${(h + 40) % 360} 46% 26%))` };
});
</script>

<template>
  <div class="avatar" :style="style">
    <span v-if="!loaded" class="avatar-initial"><slot>{{ initialOf(name || '?') }}</slot></span>
    <img v-if="src && !failed" :key="src" class="avatar-img" :class="{ on: loaded }" :src="src" alt="" :loading="lazy ? 'lazy' : 'eager'" decoding="async" draggable="false" @load="loaded = true" @error="failed = true" />
  </div>
</template>
