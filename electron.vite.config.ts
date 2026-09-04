import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      emptyOutDir: true,
      rollupOptions: {
        external: ['better-sqlite3', '@whiskeysockets/baileys', 'qrcode', 'ws', 'pino', 'jimp', 'qrcode-terminal']
        // 注意：lru-cache 必须打进包（勿加 external）。教训：加 external 后 electron-builder 未把顶层
        // node_modules/lru-cache 打进 asar（仅嵌套副本），导致 kuai-z 启动即报 Cannot find module 'lru-cache'
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