// 1 ルームの状態と進行。ゲームの規則は @unpoker/core に任せ、ここでは参加者・接続・タイマー・保存を扱う
import {
  apply,
  createMatch,
  DEFAULT_CONFIG,
  GameError,
  pendingSeats,
  settleGame,
  startGame,
  validateConfig,
  viewFor,
  type GameAction,
  type MatchConfig,
  type MatchState,
  type Rng,
} from '@unpoker/core';
import type { GameActionMsg, RoomStatus, RoomView, ServerMsg } from './protocol.ts';
import { newPlayerId, newToken } from './ids.ts';
import type { RoomStore } from './store.ts';

export interface Timing {
  /** 配置フェーズの持ち時間 */
  placement: number;
  /** 公開フェーズの 1 回の持ち時間 */
  flip: number;
  declare: number;
  join: number;
  /** 場札公開の演出: 基本時間 ＋ 伏せ札 1 枚あたり */
  boardRevealBase: number;
  boardRevealPerCard: number;
  /** 仮順位の発表演出 */
  ranking: number;
  /** 場札入れ替えの演出 */
  swap: number;
}

export const DEFAULT_TIMING: Timing = {
  placement: 60_000,
  flip: 10_000,
  declare: 20_000,
  join: 20_000,
  boardRevealBase: 1_500,
  boardRevealPerCard: 1_200,
  ranking: 5_000,
  swap: 6_000,
};

export interface RoomPlayer {
  id: string;
  name: string;
  token: string;
}

/** 保存する形（JSON） */
export interface RoomData {
  id: string;
  createdAt: number;
  updatedAt: number;
  tableToken: string;
  players: RoomPlayer[];
  config: MatchConfig;
  status: RoomStatus;
  match: MatchState | null;
  seq: number;
  deadline: number | null;
  /** 締め切りまでの長さ（画面のゲージ用） */
  deadlineMs: number;
  deadlineIsTimeout: boolean;
  /** 締め切りを決めたときの局面（同じ局面の間は締め切りを延ばさない） */
  phaseKey: string | null;
  /** テーブルが持ち時間を止めている。演出の待ち時間は止めない（古い保存データには無い） */
  paused?: boolean;
  /** 止めている間の、操作待ちの残り時間（ミリ秒） */
  pausedRemain?: number | null;
}

export interface Conn {
  role: 'table' | 'player' | null;
  roomId: string | null;
  playerId: string | null;
  send(msg: ServerMsg): void;
}

export interface RoomDeps {
  store: RoomStore;
  timing: Timing;
  rng: Rng;
  now: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class RoomError extends Error {
  constructor(
    message: string,
    public code: 'room_full' | 'bad_request' | 'rule' = 'bad_request',
  ) {
    super(message);
  }
}

export const MAX_PLAYERS = 4;

export function newRoomData(id: string, now: number): RoomData {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    tableToken: newToken(),
    players: [],
    config: { ...DEFAULT_CONFIG },
    status: 'lobby',
    match: null,
    seq: 0,
    deadline: null,
    deadlineMs: 0,
    deadlineIsTimeout: false,
    phaseKey: null,
    paused: false,
    pausedRemain: null,
  };
}

export class Room {
  conns = new Set<Conn>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    public data: RoomData,
    private deps: RoomDeps,
  ) {}

  get id() {
    return this.data.id;
  }

  /** 読み込み直後に呼ぶ。保存されていた締め切りでタイマーを張り直す */
  resume() {
    this.arm();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---- 参加者 ----

  join(name: string): RoomPlayer {
    if (this.data.status !== 'lobby') throw new RoomError('対局が始まっているので参加できない');
    if (this.data.players.length >= MAX_PLAYERS) throw new RoomError('満席', 'room_full');
    if (this.data.players.some((p) => p.name === name)) throw new RoomError('同じ名前の参加者がいる');
    const p: RoomPlayer = { id: newPlayerId(), name, token: newToken() };
    this.data.players.push(p);
    this.commit();
    return p;
  }

  playerByToken(token: string): RoomPlayer | undefined {
    return this.data.players.find((p) => p.token === token);
  }

  attach(conn: Conn) {
    this.conns.add(conn);
    this.broadcast(); // 接続状態の表示が変わる
  }

  detach(conn: Conn) {
    if (this.conns.delete(conn)) this.broadcast();
  }

  // ---- テーブルの操作 ----

  configure(config: MatchConfig) {
    if (this.data.status !== 'lobby') throw new RoomError('設定を変えられるのは待機中だけ');
    try {
      validateConfig(config);
    } catch (e) {
      throw new RoomError((e as Error).message);
    }
    this.data.config = { ...config };
    this.commit();
  }

  kick(playerId: string) {
    if (this.data.status !== 'lobby') throw new RoomError('外せるのは待機中だけ');
    const before = this.data.players.length;
    this.data.players = this.data.players.filter((p) => p.id !== playerId);
    if (this.data.players.length === before) throw new RoomError('その参加者はいない');
    for (const c of this.conns) if (c.playerId === playerId) c.send({ t: 'error', message: 'テーブルから外された', code: 'bad_token' });
    this.commit();
  }

  start() {
    if (this.data.status !== 'lobby') throw new RoomError('すでに始まっている');
    if (this.data.players.length < 3) throw new RoomError('3 人以上そろってから始める');
    let m = createMatch(this.data.config, this.data.players.map((p) => ({ id: p.id, name: p.name })));
    m = startGame(m, this.deps.rng);
    this.data.match = m;
    this.data.status = m.finished ? 'finished' : 'playing';
    this.commit();
  }

  nextGame() {
    const m = this.data.match;
    if (this.data.status !== 'playing' || !m?.game || m.game.phase !== 'result') throw new RoomError('結果が出てから次へ進む');
    let next = settleGame(m);
    if (!next.finished) next = startGame(next, this.deps.rng);
    this.data.match = next;
    if (next.finished) this.data.status = 'finished';
    this.commit();
  }

  /** 持ち時間を止める（テーブル）。止めている間も操作はでき、演出は進む */
  pause() {
    if (this.data.status !== 'playing') throw new RoomError('止められるのは対局中だけ');
    if (this.data.paused) return;
    this.data.paused = true;
    if (this.data.deadline !== null && this.data.deadlineIsTimeout) {
      this.data.pausedRemain = Math.max(0, this.data.deadline - this.deps.now());
      this.data.deadline = null;
    }
    this.commit();
  }

  /** 持ち時間を再開する（テーブル）。止めたときの残り時間から続ける */
  unpause() {
    if (!this.data.paused) return;
    this.data.paused = false;
    if (this.data.pausedRemain != null) {
      this.data.deadline = this.deps.now() + this.data.pausedRemain;
      this.data.pausedRemain = null;
    }
    this.commit();
  }

  // ---- プレイヤーの操作 ----

  action(playerId: string, msg: GameActionMsg) {
    const m = this.data.match;
    if (this.data.status !== 'playing' || !m?.game) throw new RoomError('ゲーム中ではない');
    const seat = m.seatIds.indexOf(playerId);
    if (seat < 0) throw new RoomError('このゲームには参加していない');
    const action = { ...msg, seat } as GameAction;
    this.applyGame(action);
  }

  private applyGame(action: GameAction) {
    const m = this.data.match!;
    try {
      m.game = apply(m.game!, action, this.deps.rng);
    } catch (e) {
      if (e instanceof GameError) throw new RoomError(e.message, 'rule');
      throw e;
    }
    this.commit();
  }

  // ---- 進行タイマー ----

  /** 局面に応じた締め切りを決める。同じ局面のままなら締め切りは変えない */
  private schedule() {
    const g = this.data.match?.game;
    if (this.data.status !== 'playing' || !g || g.phase === 'result') {
      this.data.deadline = null;
      this.data.phaseKey = null;
      this.data.pausedRemain = null;
      if (this.data.status !== 'playing') this.data.paused = false;
      return;
    }
    const key = `${this.data.match!.gameNo}:${g.phase}:${g.phase === 'reveal' ? g.revealTurn : ''}`;
    if (key === this.data.phaseKey && (this.data.deadline !== null || this.data.pausedRemain != null)) return;
    const t = this.deps.timing;
    const hidden = g.seats.length; // 各自が出した伏せ札の枚数
    const [ms, isTimeout] = ((): [number, boolean] => {
      switch (g.phase) {
        case 'placement':
          return [t.placement, true];
        case 'boardReveal':
          return [t.boardRevealBase + t.boardRevealPerCard * hidden, false];
        case 'reveal':
          return [t.flip, true];
        case 'ranking':
          return [t.ranking, false];
        case 'declare':
          return [t.declare, true];
        case 'join':
          return [t.join, true];
        case 'swap':
          return [t.swap, false];
      }
    })();
    this.data.deadlineMs = ms;
    this.data.deadlineIsTimeout = isTimeout;
    this.data.phaseKey = key;
    if (isTimeout && this.data.paused) {
      // 止めている間に次の操作待ちへ進んだら、持ち時間は満タンのまま止めておく
      this.data.deadline = null;
      this.data.pausedRemain = ms;
    } else {
      this.data.deadline = this.deps.now() + ms;
      this.data.pausedRemain = null;
    }
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.data.deadline === null) return;
    const wait = Math.max(0, this.data.deadline - this.deps.now());
    this.timer = setTimeout(() => this.fire(), wait);
  }

  private fire() {
    this.timer = null;
    const g = this.data.match?.game;
    if (!g || this.data.status !== 'playing') return;
    this.data.phaseKey = null; // 次の局面の締め切りを付け直す
    this.data.deadline = null;
    try {
      const action: GameAction = pendingSeats(g).length > 0 ? { type: 'timeout' } : { type: 'advance' };
      this.data.match!.game = apply(g, action, this.deps.rng);
    } catch (e) {
      this.deps.log?.('timer action failed', { room: this.id, error: String(e) });
    }
    this.commit();
  }

  // ---- 保存と配信 ----

  private commit() {
    this.data.seq++;
    this.data.updatedAt = this.deps.now();
    this.schedule();
    this.arm();
    const snapshot = JSON.parse(JSON.stringify(this.data)) as RoomData;
    this.saving = this.saving
      .then(() => this.deps.store.save(snapshot))
      .catch((e) => this.deps.log?.('save failed', { room: this.id, error: String(e) }));
    this.broadcast();
  }

  /** 保存の完了を待つ（テストと終了処理用） */
  flush() {
    return this.saving;
  }

  broadcast() {
    for (const c of this.conns) c.send({ t: 'state', seq: this.data.seq, room: this.view(c) });
  }

  view(conn: Conn): RoomView {
    const d = this.data;
    const m = d.match;
    const connected = new Set([...this.conns].filter((c) => c.role === 'player').map((c) => c.playerId));
    const seatOf = (id: string) => (m?.game ? m.seatIds.indexOf(id) : -1);
    const mySeat = conn.role === 'player' && conn.playerId ? seatOf(conn.playerId) : -1;
    return {
      roomId: d.id,
      status: d.status,
      config: d.config,
      players: d.players.map((p) => {
        const s = seatOf(p.id);
        const chipsNow = m?.players.find((x) => x.id === p.id)?.chips ?? d.config.initialChips;
        return { id: p.id, name: p.name, connected: connected.has(p.id), chips: chipsNow, seat: s >= 0 ? s : null };
      }),
      tableConnected: [...this.conns].some((c) => c.role === 'table'),
      you: conn.role === 'player' && conn.playerId ? { role: 'player', playerId: conn.playerId } : { role: 'table' },
      gameNo: m?.gameNo ?? 0,
      dealerId: m?.dealerId ?? null,
      history: m?.history ?? [],
      ranking: m?.ranking ?? null,
      game: m?.game ? viewFor(m.game, mySeat >= 0 ? { kind: 'seat', seat: mySeat } : { kind: 'table' }) : null,
      deadline: d.deadline,
      deadlineMs: d.deadlineMs,
      deadlineIsTimeout: d.deadlineIsTimeout,
      refund: m?.refund ?? null,
      paused: !!d.paused,
      pausedRemain: d.pausedRemain ?? null,
      serverTime: this.deps.now(),
    };
  }
}
