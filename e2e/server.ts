// 通しテスト用のサーバー。ビルド済みの画面を配り、状態はメモリに置く。
// 演出の待ち時間だけ短くして、ボットの操作で 1 ゲームが早く進むようにする（持ち時間は本番と同じ）
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../apps/server/src/app.ts';
import { MemoryStore } from '../apps/server/src/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8091);

const app = await createApp({
  store: new MemoryStore(),
  webRoot: resolve(here, '../apps/web/dist'),
  timing: { boardRevealBase: 400, boardRevealPerCard: 200, ranking: 1_500 },
});
app.server.listen(port, () => console.log(`e2e server on http://localhost:${port}`));

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
