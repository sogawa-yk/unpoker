import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開発時は API サーバー（apps/server、既定 8080）へ /ws を中継する
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true }, '/healthz': 'http://localhost:8080' },
  },
  build: { target: 'es2022', sourcemap: true },
});
