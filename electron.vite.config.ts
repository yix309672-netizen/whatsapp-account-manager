import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      emptyOutDir: true,
      rollupOptions: {
        external: ['better-sqlite3']
      }
    },
    resolve: {
      alias: {
        '@main': path.resolve(__dirname, 'src/main'),
        '@preload': path.resolve(__dirname, 'src/preload')
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      emptyOutDir: true
    },
    resolve: {
      alias: {
        '@preload': path.resolve(__dirname, 'src/preload')
      }
    }
  },
  renderer: {
    build: {
      outDir: 'dist/renderer',
      emptyOutDir: true
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': path.resolve(__dirname, 'src/renderer')
      }
    }
  }
});