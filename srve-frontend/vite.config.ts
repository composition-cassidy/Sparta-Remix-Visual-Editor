import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        trimmer: resolve(__dirname, 'trimmer.html'),
        splash: resolve(__dirname, 'splash.html'),
      },
    },
  },
  publicDir: resolve(__dirname, '..', 'assets'),
});
