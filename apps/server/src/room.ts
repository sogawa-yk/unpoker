// 1 ルームの状態と進行。ゲームの規則は @unpoker/core に任せ、ここでは参加者・接続・タイマー・保存を扱う
import {
  betOptions,
  DEFAULT_CONFIG,
  GameError,
  pendingSeats,
  reduceMatch,
  RULES_VERSION,
  validateConfig,
  viewFor,
  type GameAction,
  type MatchConfig,
  type MatchOp,
  type MatchState,
  type Rng,
} from '@unpoker/core';
import type { GameActionMsg, RoomStatus, RoomView, ServerMsg } from './protocol.ts';
import { newPlayerId, newSeed, newToken, streamRng } from './ids.ts';
import { CODE_VERSION, type GameRow, type MatchRow, type Recorder } from './records.ts';
import type { RoomStore } from './store.ts';
import { buildPrompt, SYSTEM_PROMPT, type Explainer } from './explain.ts';

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
  /** 宣言した人がルーレットを回すまでの持ち時間（勝負の顔ぶれの発表を含む） */
  rouletteStart: number;
  /** ルーレットを止めるまでの持ち時間 */
  rouletteStop: number;
  /** 止めてからの演出（減速して止まる、燃える、新しい札。画面側の演出は約 4.5 秒） */
  swap: number;
  /** 持ち回り方式で、親がベット額を選ぶ持ち時間 */
  bet: number;
  /** 入れ替えの場面に入ってから「回す」を受け付けるまで（画面の顔ぶれ発表 SWAP_INTRO_MS ＋ 余裕） */
  swapIntro: number;
  /** 回し始めてから「ストップ」を受け付けるまで（回っている光を必ず見せる） */
  minSpin: number;
  /** 便乗の受付が始まったときの「挑戦」の発表（画面の CHALLENGE_BANNER_MS）。顔ぶれの発表はこの後に始まる */
  challengeBanner: number;
}

export const DEFAULT_TIMING: Timing = {
  placement: 60_000,
  flip: 10_000,
  declare: 20_000,
  join: 20_000,
  boardRevealBase: 1_500,
  boardRevealPerCard: 1_200,
  ranking: 5_000,
  rouletteStart: 15_000,
  rouletteStop: 10_000,
  swap: 7_000,
  bet: 30_000,
  swapIntro: 3_000,
  minSpin: 1_500,
  challengeBanner: 2_600,
};

export interface RoomPlayer {
  id: string;
  name: string;
  token: string;
  /** 端末に保存したプレイヤー ID（記録で、ルームをまたいで同じ人を見分ける。古い端末には無い） */
  deviceId?: string | null;
}

/** 今の対局の記録の状態（乱数の種と、次の操作の番号） */
export interface RoomRecord {
  matchId: string;
  seed: string;
  eventNo: number;
  startedAt: number;
  /** 記録を書き始めたゲーム（配った札の記録を 1 回だけ書くため） */
  dealtGames: number[];
  finishedGames: number[];
  /** ゲームを配った時刻（ゲーム番号 → 時刻） */
  gameStartedAt?: Record<number, number>;
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
  /** テーブルなしで遊ぶルームの親機（ルームを作ったスマホ）。iPad で作ったルームは無い */
  hostId?: string | null;
  /** テーブルが持ち時間を止めている。演出の待ち時間は止めない（古い保存データには無い） */
  paused?: boolean;
  /** 止めている間の、操作待ちの残り時間（ミリ秒） */
  pausedRemain?: number | null;
  /** この時刻までは、ルーレットの操作を保留する（演出を最後まで見せるため。古い保存データには無い） */
  rouletteGate?: number | null;
  /** 便乗の受付が始まった時刻（「挑戦」の発表が終わるまで、顔ぶれの発表を始めないため） */
  joinAt?: number | null;
  /** このルームで始めた対局の数 */
  matchNo?: number;
  /** 今の対局の記録（古い保存データには無い。無ければ記録しない） */
  rec?: RoomRecord | null;
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
  /** AI 相談の説明文（生成 AI）。無ければ数字だけ */
  explainer?: Explainer;
  /** 対局の記録（分析用）。無ければ記録しない */
  recorder?: Recorder;
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
  /** 早すぎて保留したルーレットの操作（順に実行する） */
  private rouletteQueue: ('start' | 'stop')[] = [];
  private rouletteTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (this.rouletteTimer) clearTimeout(this.rouletteTimer);
    this.rouletteTimer = null;
    this.rouletteQueue = [];
  }

  // ---- 参加者 ----

  /** 参加する。host なら、テーブルなしで遊ぶルームの親機にする */
  join(name: string, host = false, deviceId: string | null = null): RoomPlayer {
    if (this.data.status !== 'lobby') throw new RoomError('対局が始まっているので参加できない');
    if (this.data.players.length >= MAX_PLAYERS) throw new RoomError('満席', 'room_full');
    if (this.data.players.some((p) => p.name === name)) throw new RoomError('同じ名前の参加者がいる');
    const p: RoomPlayer = { id: newPlayerId(), name, token: newToken(), deviceId };
    this.data.players.push(p);
    if (deviceId) this.deps.recorder?.player({ deviceId, name, lastSeen: this.deps.now() });
    if (host) this.data.hostId = p.id;
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
    if (playerId === this.data.hostId) throw new RoomError('親機は外せない');
    const before = this.data.players.length;
    this.data.players = this.data.players.filter((p) => p.id !== playerId);
    if (this.data.players.length === before) throw new RoomError('その参加者はいない');
    for (const c of this.conns) if (c.playerId === playerId) c.send({ t: 'error', message: 'テーブルから外された', code: 'bad_token' });
    this.commit();
  }

  start() {
    if (this.data.status !== 'lobby') throw new RoomError('すでに始まっている');
    if (this.data.players.length < 3) throw new RoomError('3 人以上そろってから始める');
    const now = this.deps.now();
    this.data.matchNo = (this.data.matchNo ?? 0) + 1;
    this.data.rec = { matchId: `${this.id}-${this.data.matchNo}`, seed: newSeed(), eventNo: 0, startedAt: now, dealtGames: [], finishedGames: [] };
    this.data.match = null;
    this.exec({ op: 'create', config: this.data.config, players: this.data.players.map((p) => ({ id: p.id, name: p.name })) }, 'table');
    this.exec({ op: 'start' }, 'table');
    this.data.status = this.data.match!.finished ? 'finished' : 'playing';
    this.commit();
  }

  nextGame() {
    const m = this.data.match;
    if (this.data.status !== 'playing' || !m?.game || m.game.phase !== 'result') throw new RoomError('結果が出てから次へ進む');
    this.exec({ op: 'next' }, 'table');
    if (this.data.match!.finished) this.data.status = 'finished';
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

  /** 持ち回り方式で、親がベット額を決めて配る */
  bet(playerId: string, amount: number) {
    const m = this.data.match;
    if (this.data.status !== 'playing' || !m?.betting) throw new RoomError('ベット額を選ぶ場面ではない');
    this.exec({ op: 'bet', playerId, amount }, playerId);
    this.commit();
  }

  action(playerId: string, msg: GameActionMsg) {
    const m = this.data.match;
    if (this.data.status !== 'playing' || !m?.game) throw new RoomError('ゲーム中ではない');
    const seat = m.seatIds.indexOf(playerId);
    if (seat < 0) throw new RoomError('このゲームには参加していない');
    const action = { ...msg, seat } as GameAction;
    if (action.type === 'roulette') return this.roulette(action);
    this.applyGame(action);
    if (msg.type === 'consult') this.explain(seat);
  }

  /**
   * ルーレットの操作。画面の演出（顔ぶれの発表、回っている光）を飛ばさないよう、早すぎる操作は捨てずに保留し、
   * 受け付けられる時刻になってから順に実行する。連打で同じ操作が重なっても 1 回だけ。
   */
  private roulette(action: Extract<GameAction, { type: 'roulette' }>) {
    const ch = this.data.match!.game!.challenge;
    if (this.data.match!.game!.phase !== 'swap' || !ch || action.seat !== ch.roller) {
      this.applyGame(action); // 正しくない操作は、ゲームのほうでエラーにする
      return;
    }
    // 今の状態と保留中の操作から見て、もう済んでいる（または済む予定の）操作は無視する
    const expected = [ch.roulette ?? 'stopped', ...this.rouletteQueue.map((c) => (c === 'start' ? 'spinning' : 'stopped'))].at(-1);
    if ((action.cmd === 'start' && expected !== 'ready') || (action.cmd === 'stop' && expected !== 'spinning')) return;
    const gate = this.data.rouletteGate ?? 0;
    if (this.rouletteQueue.length === 0 && this.deps.now() >= gate) {
      this.applyGame(action);
      return;
    }
    this.rouletteQueue.push(action.cmd);
    this.armRoulette();
  }

  private armRoulette() {
    if (this.rouletteTimer || this.rouletteQueue.length === 0) return;
    const wait = Math.max(0, (this.data.rouletteGate ?? 0) - this.deps.now());
    this.rouletteTimer = setTimeout(() => {
      this.rouletteTimer = null;
      const cmd = this.rouletteQueue.shift();
      const g = this.data.match?.game;
      const ch = g?.challenge;
      if (!cmd || !g || g.phase !== 'swap' || !ch || ch.roller === undefined) {
        this.rouletteQueue = [];
        return;
      }
      if ((cmd === 'start' && ch.roulette === 'ready') || (cmd === 'stop' && ch.roulette === 'spinning')) {
        try {
          this.applyGame({ type: 'roulette', seat: ch.roller, cmd });
        } catch (e) {
          this.deps.log?.('roulette failed', { room: this.id, error: String(e) });
        }
      }
      this.armRoulette();
    }, wait);
  }

  /** 相談の答えに、生成 AI の説明文を後から添える（失敗しても数字の答えはそのまま） */
  private explain(seat: number) {
    const ex = this.deps.explainer;
    const m = this.data.match;
    const g = m?.game;
    const rec = g?.seats[seat]?.advice.at(-1);
    if (!ex || !m || !g || !rec) return;
    const gameNo = m.gameNo;
    const key = rec.key;
    const names = m.seatIds.map((id) => this.data.players.find((p) => p.id === id)?.name ?? '？');
    const prompt = buildPrompt(g, seat, rec, names);
    rec.explaining = true;
    this.commit();
    const t0 = this.deps.now();
    void ex
      .explain(SYSTEM_PROMPT, prompt)
      .catch((e) => {
        this.deps.log?.('explain failed', { room: this.id, error: String(e) });
        return null;
      })
      .then((text) => {
        const cur = this.data.match;
        const r = cur?.gameNo === gameNo ? cur.game?.seats[seat]?.advice.find((x) => x.key === key) : undefined;
        if (!r) return;
        r.explanation = text;
        r.explaining = false;
        const rec = this.data.rec;
        if (rec && text) this.deps.recorder?.note({ matchId: rec.matchId, eventNo: rec.eventNo, at: this.deps.now(), kind: 'explanation', data: { gameNo, seat, key, text } });
        this.deps.log?.('explained', { room: this.id, ms: this.deps.now() - t0, ok: text !== null });
        this.commit();
      });
  }

  private applyGame(action: GameAction) {
    const m = this.data.match!;
    const actor = 'seat' in action ? (m.seatIds[action.seat] ?? 'table') : 'timer';
    this.exec({ op: 'game', action }, actor);
    this.commit();
  }

  // ---- 状態の変更と記録 ----

  /**
   * 状態を変える操作は、すべてここを通す。乱数は「対局の種 ＋ 操作の番号」で決まるので、
   * 記録した操作を順に当て直せば同じ対局を再現できる（core の replayMatch）
   */
  private exec(op: MatchOp, actor: string) {
    const r = this.data.rec;
    const rng: Rng = r ? streamRng(r.seed, r.eventNo) : this.deps.rng;
    let next: MatchState;
    try {
      next = reduceMatch(this.data.match, op, rng);
    } catch (e) {
      if (e instanceof GameError) throw new RoomError(e.message, 'rule');
      throw e;
    }
    this.data.match = next;
    if (!r) return;
    const at = this.deps.now();
    const rec = this.deps.recorder;
    rec?.event({ matchId: r.matchId, eventNo: r.eventNo, at, actor, gameNo: next.gameNo, phase: next.game?.phase ?? (next.betting ? 'bet' : next.finished ? 'finished' : null), op });
    r.eventNo++;
    if (!rec) return;
    if (op.op === 'create') rec.match(this.matchRow());
    const g = next.game;
    if (g && !r.dealtGames.includes(next.gameNo)) {
      r.dealtGames.push(next.gameNo);
      r.gameStartedAt = { ...r.gameStartedAt, [next.gameNo]: at };
      rec.game(this.gameRow(next, at));
    }
    if (g?.result && !r.finishedGames.includes(next.gameNo)) {
      r.finishedGames.push(next.gameNo);
      rec.game({ ...this.gameRow(next, r.gameStartedAt?.[next.gameNo] ?? at), endedAt: at });
    }
    if (next.finished && op.op !== 'create') rec.match({ ...this.matchRow(), endedAt: at });
  }

  /** ゲームの記録の行。配った直後の山札は、入れ替えで引いた札を先頭に戻して求める */
  private gameRow(m: MatchState, startedAt: number): GameRow {
    const g = m.game!;
    const res = g.result;
    const sw = g.challenge?.swap;
    return {
      matchId: this.data.rec!.matchId,
      gameNo: m.gameNo,
      startedAt,
      endedAt: null,
      seatIds: [...m.seatIds],
      dealer: g.dealer,
      bet: g.bet,
      carryIn: g.carryIn,
      hands: g.seats.map((x) => [...x.hand]),
      initialBoard: [...g.initialBoard],
      deck: sw ? [sw.added, ...g.deck] : [...g.deck],
      result: res
        ? {
            delta: Object.fromEntries(m.seatIds.map((id, i) => [id, res.delta[i]!])),
            winners: res.winners.map((i) => m.seatIds[i]!),
            nut: res.nut,
            challenged: g.challenge !== null,
            bet: g.bet,
            carryIn: g.carryIn,
            carryOut: res.carryOut,
            scores: [...res.scores],
            board: [...res.board],
          }
        : null,
    };
  }

  private matchRow(): MatchRow {
    const r = this.data.rec!;
    const m = this.data.match;
    return {
      matchId: r.matchId,
      roomId: this.id,
      startedAt: r.startedAt,
      endedAt: null,
      config: this.data.config,
      players: (m?.players ?? []).map((p) => ({ id: p.id, deviceId: this.data.players.find((x) => x.id === p.id)?.deviceId ?? null, name: p.name })),
      seed: r.seed,
      rulesVersion: RULES_VERSION,
      codeVersion: CODE_VERSION,
      ranking: m?.ranking ?? null,
      chips: m?.finished ? Object.fromEntries(m.players.map((p) => [p.id, p.chips])) : null,
      refund: m?.refund ?? null,
    };
  }

  // ---- 進行タイマー ----

  /** 局面に応じた締め切りを決める。同じ局面のままなら締め切りは変えない */
  private schedule() {
    const g = this.data.match?.game;
    if (this.data.status === 'playing' && this.data.match?.betting) {
      this.setDeadline(`${this.data.match.gameNo}:bet`, this.deps.timing.bet, true);
      return;
    }
    if (this.data.status !== 'playing' || !g || g.phase === 'result') {
      this.data.deadline = null;
      this.data.phaseKey = null;
      this.data.pausedRemain = null;
      if (this.data.status !== 'playing') this.data.paused = false;
      return;
    }
    const key = `${this.data.match!.gameNo}:${g.phase}:${g.phase === 'reveal' ? g.revealTurn : g.phase === 'swap' ? (g.challenge?.roulette ?? '') : ''}`;
    const t = this.deps.timing;
    if (key !== this.data.phaseKey && g.phase === 'join') this.data.joinAt = this.deps.now();
    if (key !== this.data.phaseKey && g.phase === 'swap') {
      // 「挑戦」と顔ぶれの発表中は回さない。回し始めたら、しばらくは止めない
      const now = this.deps.now();
      const r = g.challenge?.roulette;
      if (r === 'ready') this.data.rouletteGate = Math.max(now, (this.data.joinAt ?? 0) + t.challengeBanner) + t.swapIntro;
      else if (r === 'spinning') this.data.rouletteGate = now + t.minSpin;
    }
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
        case 'swap': {
          const r = g.challenge?.roulette;
          if (r === 'ready') return [t.rouletteStart, true];
          if (r === 'spinning') return [t.rouletteStop, true];
          return [t.swap, false];
        }
      }
    })();
    this.setDeadline(key, ms, isTimeout);
  }

  /** 締め切りを付ける。同じ局面のままなら付け直さない（止めている間の持ち時間は満タンで止めておく） */
  private setDeadline(key: string, ms: number, isTimeout: boolean) {
    if (isTimeout && this.data.config.timeLimit === false) {
      // 持ち時間なしのルーム: 操作待ちは締め切りを付けず、全員が操作するまで待つ（演出の待ち時間はそのまま）
      this.data.deadline = null;
      this.data.pausedRemain = null;
      this.data.deadlineMs = 0;
      this.data.deadlineIsTimeout = true;
      this.data.phaseKey = key;
      return;
    }
    if (key === this.data.phaseKey && (this.data.deadline !== null || this.data.pausedRemain != null)) return;
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
    if (this.data.status === 'playing' && this.data.match?.betting) {
      // 親が選ばなければ最低ベット（B-0）
      this.data.phaseKey = null;
      this.data.deadline = null;
      try {
        this.exec({ op: 'bet', playerId: null, amount: null }, 'timer');
      } catch (e) {
        this.deps.log?.('timer bet failed', { room: this.id, error: String(e) });
      }
      this.commit();
      return;
    }
    const g = this.data.match?.game;
    if (!g || this.data.status !== 'playing') return;
    this.data.phaseKey = null; // 次の局面の締め切りを付け直す
    this.data.deadline = null;
    try {
      const action: GameAction = pendingSeats(g).length > 0 ? { type: 'timeout' } : { type: 'advance' };
      this.exec({ op: 'game', action }, 'timer');
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
      hostId: d.hostId ?? null,
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
      betting: m?.betting ? { dealerId: m.betting.dealerId, options: betOptions(m) } : null,
      paused: !!d.paused,
      pausedRemain: d.pausedRemain ?? null,
      serverTime: this.deps.now(),
    };
  }
}
