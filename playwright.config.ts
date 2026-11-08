// 通しテスト（e2e/）。iPhone と iPad の Safari に近い WebKit で、テーブル 1 台とスマホ数台をまとめて動かす。
// 実行: npm run e2e（画面をビルドしてから、テスト用サーバーを立てる）
import { defineConfig } from '@playwright/test';

const PORT = 8091;

export default defineConfig({
  testDir: 'e2e',
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'webkit',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build -w @unpoker/web && tsx e2e/server.ts',
    url: `http://localhost:${PORT}/healthz`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
