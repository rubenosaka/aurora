import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'electron-vite';
import { contentSecurityPolicyPlugin } from './src/main/content-security-policy.ts';

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.js'
        }
      }
    }
  },
  renderer: {
    base: './',
    plugins: [vue(), tailwindcss(), contentSecurityPolicyPlugin()]
  }
});
