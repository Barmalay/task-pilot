import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Демо-режим поднимает интерфейс на своем порту и направляет его на свой сервер.
const api = process.env.TASK_PILOT_API ?? 'http://127.0.0.1:5176';
const port = Number(process.env.TASK_PILOT_WEB_PORT ?? 5177);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': {
        target: api,
        changeOrigin: false,
        // Обрыв потока SSE на сервере доводится до браузера: иначе EventSource не узнает, что сервер перезапустился.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            proxyRes.on('close', () => {
              if (!proxyRes.complete) res.destroy();
            });
          });
        },
      },
    },
  },
});
