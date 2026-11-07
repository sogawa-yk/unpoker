// HTTP サーバー（静的ファイル配信と /healthz）と WebSocket（/ws）
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_TIMING, type RoomDeps, type Timing } from './room.ts';
import { heartbeat, Rooms, ROOM_TTL_MS } from './rooms.ts';
import { cryptoRng } from './ids.ts';
import { MemoryStore, type RoomStore } from './store.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export interface AppOptions {
  store?: RoomStore;
  timing?: Partial<Timing>;
  /** ビルド済みの画面（apps/web/dist）。無ければ静的配信はしない */
  webRoot?: string | null;
  log?: RoomDeps['log'];
  explainer?: RoomDeps['explainer'];
}

export async function createApp(opts: AppOptions = {}) {
  const deps: RoomDeps = {
    store: opts.store ?? new MemoryStore(),
    timing: { ...DEFAULT_TIMING, ...opts.timing },
    rng: cryptoRng,
    now: () => Date.now(),
    log: opts.log,
    explainer: opts.explainer,
  };
  const rooms = new Rooms(deps);
  await rooms.load();
  const webRoot = opts.webRoot ? resolve(opts.webRoot) : null;

  const server = createServer((req, res) => {
    void handleHttp(req, res, webRoot).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('connection', (ws) => rooms.handle(ws));
  heartbeat(wss);
  const sweep = setInterval(() => rooms.sweep(), Math.min(ROOM_TTL_MS, 10 * 60 * 1000));

  return {
    server,
    rooms,
    async close() {
      clearInterval(sweep);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      await rooms.flushAll();
      rooms.disposeAll();
    },
  };
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, webRoot: string | null) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname === '/healthz') {
    res.setHeader('Content-Type', 'text/plain');
    res.end('ok');
    return;
  }
  if (!webRoot || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.statusCode = 404;
    res.end();
    return;
  }
  // パスの正規化（webRoot の外に出ない）
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = join(webRoot, rel);
  if (file !== webRoot && !file.startsWith(webRoot + sep)) {
    res.statusCode = 400;
    res.end();
    return;
  }
  let st = await stat(file).catch(() => null);
  if (st?.isDirectory()) {
    file = join(file, 'index.html');
    st = await stat(file).catch(() => null);
  }
  if (!st) {
    // 画面のルーティング（/table/..., /play/...）は index.html に任せる
    if (extname(rel)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    file = join(webRoot, 'index.html');
    st = await stat(file).catch(() => null);
    if (!st) {
      res.statusCode = 404;
      res.end();
      return;
    }
  }
  const ext = extname(file);
  res.setHeader('Content-Type', TYPES[ext] ?? 'application/octet-stream');
  // ビルド成果物のうちハッシュ付きのファイル（assets/）は長くキャッシュ、index.html はキャッシュしない
  res.setHeader('Cache-Control', file.includes(`${join(webRoot, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('Content-Length', st.size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}
