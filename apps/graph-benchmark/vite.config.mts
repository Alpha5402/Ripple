import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ root: 'apps/graph-benchmark', plugins: [vue()], base: './', build: { target: 'es2023', outDir: '../../dist/graph-benchmark', emptyOutDir: true } });
