// ルームの一覧と、WebSocket で届いたメッセージの振り分け
import type { RawData, WebSocket, WebSocketServer } from 'ws';
import { ClientMsg, type ServerMsg } from './protocol.ts';
import { newRoomId } from './ids.ts';
import { newRoomData, Room, RoomError, type Conn, type RoomDeps } from './room.ts';

export const MAX_ROOMS = 200;
/** 最後の操作からこの時間が過ぎ、誰も接続していないルームは破棄する */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

export class Rooms {
  rooms = new Map<string, Room>();
  constructor(private deps: RoomDeps) {}

  async load() {
    for (const d of await this.deps.store.loadAll()) {
      if (this.deps.now() - d.updatedAt > ROOM_TTL_MS) {
        await this.deps.store.delete(d.id);
        continue;
      }
      const r = new Room(d, this.deps);
      this.rooms.set(d.id, r);
      r.resume();
    }
  }

  create(): Room {
    if (this.rooms.size >= MAX_ROOMS) this.sweep();
    if (this.rooms.size >= MAX_ROOMS) throw new RoomError('ルームが多すぎる。しばらくしてから試す');
    let id = newRoomId();
    while (this.rooms.has(id)) id = newRoomId();
    const r = new Room(newRoomData(id, this.deps.now()), this.deps);
    this.rooms.set(id, r);
    return r;
  }

  sweep() {
    for (const [id, r] of this.rooms) {
      if (r.conns.size === 0 && this.deps.now() - r.data.updatedAt > ROOM_TTL_MS) {
        r.dispose();
        this.rooms.delete(id);
        void this.deps.store.delete(id);
      }
    }
  }

  async flushAll() {
    await Promise.all([...this.rooms.values()].map((r) => r.flush()));
  }

  disposeAll() {
    for (const r of this.rooms.values()) r.dispose();
  }

  /** 1 接続ぶんの処理 */
  handle(ws: WebSocket) {
    const conn: Conn = {
      role: null,
      roomId: null,
      playerId: null,
      send: (msg: ServerMsg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    // 簡易レート制限（トークンバケット: 毎秒 20、最大 40）
    let tokens = 40;
    let last = Date.now();
    const allow = () => {
      const now = Date.now();
      tokens = Math.min(40, tokens + ((now - last) / 1000) * 20);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };

    ws.on('message', (raw: RawData) => {
      if (!allow()) return conn.send({ t: 'error', message: '操作が多すぎる', code: 'rate_limited' });
      let msg: ClientMsg;
      try {
        msg = ClientMsg.parse(JSON.parse(raw.toString()));
      } catch {
        return conn.send({ t: 'error', message: 'メッセージの形が正しくない', code: 'bad_request' });
      }
      try {
        this.dispatch(conn, msg);
      } catch (e) {
        if (e instanceof RoomError) conn.send({ t: 'error', message: e.message, code: e.code });
        else {
          this.deps.log?.('unexpected error', { error: String(e) });
          conn.send({ t: 'error', message: 'サーバーで問題が起きた', code: 'bad_request' });
        }
      }
    });
    ws.on('close', () => {
      if (conn.roomId) this.rooms.get(conn.roomId)?.detach(conn);
    });
  }

  private room(conn: Conn): Room {
    const r = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
    if (!r) throw new RoomError('ルームに入っていない');
    return r;
  }

  /** テーブル（iPad）か、テーブルなしのルームの親機だけができる操作 */
  private requireHost(conn: Conn): Room {
    const r = this.room(conn);
    if (conn.role === 'table' || (conn.role === 'player' && conn.playerId !== null && conn.playerId === r.data.hostId)) return r;
    throw new RoomError('テーブルだけができる操作');
  }

  private dispatch(conn: Conn, msg: ClientMsg) {
    switch (msg.t) {
      case 'ping':
        return conn.send({ t: 'pong', serverTime: this.deps.now() });
      case 'createRoom': {
        if (conn.roomId) throw new RoomError('すでにルームに入っている');
        const r = this.create();
        Object.assign(conn, { role: 'table', roomId: r.id, playerId: null });
        conn.send({ t: 'welcome', roomId: r.id, token: r.data.tableToken, role: 'table' });
        r.attach(conn);
        void r.flush();
        return;
      }
      case 'hostRoom': {
        if (conn.roomId) throw new RoomError('すでにルームに入っている');
        const r = this.create();
        const p = r.join(msg.name, true, msg.deviceId ?? null);
        Object.assign(conn, { role: 'player', roomId: r.id, playerId: p.id });
        conn.send({ t: 'welcome', roomId: r.id, token: p.token, role: 'player', playerId: p.id });
        r.attach(conn);
        void r.flush();
        return;
      }
      case 'join': {
        if (conn.roomId) throw new RoomError('すでにルームに入っている');
        const r = this.rooms.get(msg.roomId);
        if (!r) return conn.send({ t: 'error', message: 'ルームが見つからない', code: 'room_not_found' });
        const p = r.join(msg.name, false, msg.deviceId ?? null);
        Object.assign(conn, { role: 'player', roomId: r.id, playerId: p.id });
        conn.send({ t: 'welcome', roomId: r.id, token: p.token, role: 'player', playerId: p.id });
        r.attach(conn);
        return;
      }
      case 'resume': {
        const r = this.rooms.get(msg.roomId);
        if (!r) return conn.send({ t: 'error', message: 'ルームが見つからない', code: 'room_not_found' });
        if (conn.roomId) this.rooms.get(conn.roomId)?.detach(conn);
        if (msg.token === r.data.tableToken) {
          Object.assign(conn, { role: 'table', roomId: r.id, playerId: null });
          conn.send({ t: 'welcome', roomId: r.id, token: msg.token, role: 'table' });
        } else {
          const p = r.playerByToken(msg.token);
          if (!p) return conn.send({ t: 'error', message: 'このルームの参加者ではない', code: 'bad_token' });
          Object.assign(conn, { role: 'player', roomId: r.id, playerId: p.id });
          conn.send({ t: 'welcome', roomId: r.id, token: msg.token, role: 'player', playerId: p.id });
        }
        r.attach(conn);
        return;
      }
      case 'configure':
        return this.requireHost(conn).configure(msg.config);
      case 'kick':
        return this.requireHost(conn).kick(msg.playerId);
      case 'start':
        return this.requireHost(conn).start();
      case 'nextGame':
        return this.requireHost(conn).nextGame();
      case 'pause': {
        const r = this.requireHost(conn);
        return msg.paused ? r.pause() : r.unpause();
      }
      case 'bet': {
        if (conn.role !== 'player' || !conn.playerId) throw new RoomError('プレイヤーだけができる操作');
        return this.room(conn).bet(conn.playerId, msg.amount);
      }
      case 'action': {
        if (conn.role !== 'player' || !conn.playerId) throw new RoomError('プレイヤーだけができる操作');
        return this.room(conn).action(conn.playerId, msg.action);
      }
    }
  }
}

/** 応答のない接続を切る（30 秒ごとに ping） */
export function heartbeat(wss: WebSocketServer) {
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
  });
  const iv = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(iv));
}
