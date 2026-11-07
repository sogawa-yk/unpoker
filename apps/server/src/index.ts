// 起動処理。環境変数:
//   PORT          … 待ち受けるポート（既定 8080）
//   WEB_ROOT      … ビルド済みの画面のディレクトリ（既定 ../web/dist があればそれ）
//   STORE         … memory | file | nosql（既定 memory）
//   STORE_DIR     … STORE=file のときの保存先（既定 .data/rooms）
//   NOSQL_TABLE / NOSQL_REGION / NOSQL_COMPARTMENT … STORE=nosql のとき
//   NOSQL_AUTH    … resource_principal（既定。Container Instances 上）| config（手元。OCI_PROFILE のプロファイル）
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { FileStore, MemoryStore, NoSqlStore, type RoomStore } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8080);
const defaultWeb = resolve(here, '../../web/dist');
const webRoot = process.env.WEB_ROOT ?? (existsSync(defaultWeb) ? defaultWeb : null);
const env = (k: string) => process.env[k] ?? (() => { throw new Error(`環境変数 ${k} が必要`); })();
const store: RoomStore =
  process.env.STORE === 'file'
    ? new FileStore(process.env.STORE_DIR ?? '.data/rooms')
    : process.env.STORE === 'nosql'
      ? new NoSqlStore({
          table: process.env.NOSQL_TABLE ?? 'unpoker_rooms',
          region: env('NOSQL_REGION'),
          compartment: env('NOSQL_COMPARTMENT'),
          auth: process.env.NOSQL_AUTH === 'config' ? 'config' : 'resource_principal',
          profile: process.env.OCI_PROFILE,
        })
      : new MemoryStore();

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

const app = await createApp({ store, webRoot, log });
app.server.listen(port, () => log('listening', { port, webRoot, store: process.env.STORE ?? 'memory' }));

const shutdown = async (signal: string) => {
  log('shutting down', { signal });
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
