import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ root: 'apps/workbench', base: './', plugins: [vue()], server: { host: '127.0.0.1', port: 4320 }, build: { target: 'es2023', outDir: '../../dist/web', emptyOutDir: true } });
