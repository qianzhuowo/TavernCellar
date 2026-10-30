import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Served by the companion at http://127.0.0.1:7349/studio/ (same origin as the API).
// Do not use the Vite dev server: the companion rejects foreign origins by design.
export default defineConfig({
  base: '/studio/',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800
  }
});
