import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

// Proxy /v1 (REST + WS) to the local claude-worker dev server (`pnpm server`).
const workerUrl = process.env.WORKER_URL ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['@claude-worker/source'] },
  server: {
    port: 5190,
    proxy: {
      '/v1': { target: workerUrl, changeOrigin: true, ws: true },
    },
  },
})
