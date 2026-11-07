// 対局（ゲームの連続プレイ）。rules.md 付録 B-0・B-1
import { clone, type Rng } from './cards.ts';
import { GameError, newGame, paidExtras, type GameState } from './game.ts';

export type BetMode = 'fixed' | 'rotating';

export interface MatchConfig {
  initialChips: number;
  /** 固定ベット額（ベット方式が固定のとき） */
  bet: number;
  /** 規定ゲーム数。null なら無制限 */
  maxGames: number | null;
  /** ベット方式（rules.md B-0）。古い設定には無い（固定として扱う） */
  betMode?: BetMode;
  /** 持ち回り: 最低ベット、最高ベット（null は上限なし）、刻み幅 */
  minBet?: number;
  maxBet?: number | null;
  betStep?: number;
  /** 持ち時間（過ぎたら自動で操作して進める）を使うか。古い設定には無い（使う） */
  timeLimit?: boolean;
}

export const DEFAULT_CONFIG: MatchConfig = {
  initialChips: 1000,
  bet: 100,
  maxGames: 10,
  betMode: 'fixed',
  minBet: 100,
  maxBet: 500,
  betStep: 50,
  timeLimit: true,
};

export const BET_STEPS = [10, 50, 100] as const;

export interface MatchPlayer {
  id: string;
  name: string;
  chips: number;
}

export interface GameRecord {
  gameNo: number;
  seatIds: string[];
  delta: Record<string, number>;
  winners: string[];
  nut: boolean;
  challenged: boolean;
  /** このゲームのベット額 */
  bet?: number;
  /** このゲームで勝者が受け取った持ち越しポット */
  carryIn?: number;
  /** このゲームで次へ持ち越した額 */
  carryOut?: number;
}

/** 次のゲームへ持ち越すポット。対局が終わって受け取る人がいなければ、払った人へ返す */
export interface CarryPot {
  amount: number;
  /** 払った人ごとの額（プレイヤー ID → 額） */
  from: Record<string, number>;
}

export interface MatchState {
  config: MatchConfig;
  /** 席順（ルームに入った順） */
  players: MatchPlayer[];
  /** 次に始めるゲームの番号（1 始まり） */
  gameNo: number;
  dealerId: string | null;
  game: GameState | null;
  /** 今のゲームの席番号 → プレイヤー ID */
  seatIds: string[];
  history: GameRecord[];
  finished: boolean;
  /** 終了時の順位（持ち点の多い順） */
  ranking: string[] | null;
  /** 次のゲームの持ち越しポット（古い保存データには無い） */
  carry?: CarryPot;
  /** 対局の終了時に払い戻した持ち越しポット（プレイヤー ID → 額） */
  refund?: Record<string, number> | null;
  /** 持ち回り方式で、親がベット額を選んでいる間（配る前） */
  betting?: { dealerId: string } | null;
}

export function createMatch(config: MatchConfig, players: { id: string; name: string }[]): MatchState {
  if (players.length < 3 || players.length > 4) throw new GameError('参加人数は 3 人か 4 人');
  validateConfig(config);
  return {
    config: { ...config },
    players: players.map((p) => ({ ...p, chips: config.initialChips })),
    gameNo: 1,
    dealerId: null,
    game: null,
    seatIds: [],
    history: [],
    finished: false,
    ranking: null,
    carry: { amount: 0, from: {} },
    refund: null,
  };
}

export function validateConfig(c: MatchConfig) {
  const ok =
    Number.isInteger(c.initialChips) && c.initialChips >= 500 && c.initialChips <= 10000 && c.initialChips % 100 === 0 &&
    Number.isInteger(c.bet) && c.bet >= 10 && c.bet <= 1000 && c.bet % 10 === 0 &&
    (c.maxGames === null || (Number.isInteger(c.maxGames) && c.maxGames >= 1 && c.maxGames <= 50));
  if (!ok) throw new GameError('ルーム設定が範囲外');
  if (c.betMode !== undefined && c.betMode !== 'fixed' && c.betMode !== 'rotating') throw new GameError('ベット方式が不正');
  if (c.betMode === 'rotating') {
    const min = c.minBet;
    const max = c.maxBet;
    const okR =
      Number.isInteger(min) && min! >= 10 && min! <= 1000 && min! % 10 === 0 &&
      (max === null || (Number.isInteger(max) && max! >= min! && max! <= 1000 && max! % 10 === 0)) &&
      (BET_STEPS as readonly number[]).includes(c.betStep ?? -1);
    if (!okR) throw new GameError('持ち回りベットの設定が範囲外');
  }
}

const active = (m: MatchState) => m.players.filter((p) => p.chips > 0);

/** 次のゲームを始める。始められない（残り 2 人以下、規定数に到達）なら対局を終える */
export function startGame(m: MatchState, rng: Rng): MatchState {
  if (m.finished) throw new GameError('対局は終了している');
  if (m.game && m.game.phase !== 'result') throw new GameError('ゲームの途中');
  if (m.betting) throw new GameError('親がベット額を選んでいる');
  const next = clone(m);
  const act = active(next);
  if (act.length < 3 || (next.config.maxGames !== null && next.gameNo > next.config.maxGames)) return endMatch(next);
  // 親: 最初はランダム、以降は席順で次の参加者（脱落者は飛ばす）
  let dealer: MatchPlayer;
  if (next.dealerId === null) {
    dealer = act[Math.floor(rng() * act.length)]!;
  } else {
    const idx = next.players.findIndex((p) => p.id === next.dealerId);
    dealer = act[0]!;
    for (let k = 1; k <= next.players.length; k++) {
      const cand = next.players[(idx + k) % next.players.length]!;
      if (cand.chips > 0) {
        dealer = cand;
        break;
      }
    }
  }
  next.dealerId = dealer.id;
  next.seatIds = act.map((p) => p.id);
  if (next.config.betMode === 'rotating') {
    // 親がベット額を選ぶまで配らない
    next.betting = { dealerId: dealer.id };
    next.game = null;
    return next;
  }
  return deal(next, next.config.bet, rng);
}

/** 持ち回り方式で、親が選べるベット額（最低ベット〜min(最高ベット, 親の持ち点) を刻み幅ごと） */
export function betOptions(m: MatchState): number[] {
  if (!m.betting) return [];
  const c = m.config;
  const min = c.minBet ?? c.bet;
  const step = c.betStep ?? 10;
  const chips = m.players.find((p) => p.id === m.betting!.dealerId)?.chips ?? 0;
  const cap = Math.min(c.maxBet ?? Infinity, chips);
  const out = [min];
  for (let v = min + step; v <= cap; v += step) out.push(v);
  return out;
}

/** 親がベット額を決めて配る。amount が null なら最低ベット（時間切れ） */
export function chooseBet(m: MatchState, playerId: string | null, amount: number | null, rng: Rng): MatchState {
  if (!m.betting) throw new GameError('ベット額を選ぶ場面ではない');
  if (playerId !== null && playerId !== m.betting.dealerId) throw new GameError('ベット額を選べるのは親だけ');
  const opts = betOptions(m);
  const bet = amount ?? opts[0]!;
  if (!opts.includes(bet)) throw new GameError('選べないベット額');
  const next = clone(m);
  next.betting = null;
  return deal(next, bet, rng);
}

function deal(next: MatchState, bet: number, rng: Rng): MatchState {
  const act = active(next);
  const dealer = next.players.find((p) => p.id === next.dealerId)!;
  const isFinal = next.config.maxGames !== null && next.gameNo === next.config.maxGames;
  next.game = newGame(
    {
      players: act.map((p) => ({ id: p.id, chips: p.chips })),
      bet,
      dealer: act.indexOf(dealer),
      carryIn: next.carry?.amount ?? 0,
      extraPeeks: !isFinal,
    },
    rng,
  );
  next.carry = { amount: 0, from: {} }; // 受け取りはこのゲームの勝者に任せた
  return next;
}

/** 結果が出たゲームの収支を持ち点に反映する */
export function settleGame(m: MatchState): MatchState {
  const g = m.game;
  if (!g || g.phase !== 'result' || !g.result) throw new GameError('結果が出ていない');
  const next = clone(m);
  const r = g.result;
  const delta: Record<string, number> = {};
  next.seatIds.forEach((id, i) => {
    const p = next.players.find((x) => x.id === id)!;
    p.chips = r.stacks[i]!;
    delta[id] = r.delta[i]!;
  });
  next.history.push({
    gameNo: next.gameNo,
    seatIds: [...next.seatIds],
    delta,
    winners: r.winners.map((i) => next.seatIds[i]!),
    nut: r.nut,
    challenged: g.challenge !== null,
    bet: g.bet,
    carryIn: g.carryIn,
    carryOut: r.carryOut,
  });
  // 持ち越しポット: 今のゲームの勝者が受け取り済み。このゲームで払われた料金が次へ
  const from: Record<string, number> = {};
  g.seats.forEach((s, i) => {
    if (paidExtras(s) > 0) from[next.seatIds[i]!] = paidExtras(s);
  });
  next.carry = { amount: r.carryOut, from };
  next.gameNo++;
  next.game = null;
  const act = active(next);
  if (act.length < 3 || (next.config.maxGames !== null && next.gameNo > next.config.maxGames)) return endMatch(next);
  return next;
}

function endMatch(m: MatchState): MatchState {
  m.finished = true;
  m.game = null;
  // 受け取る次のゲームがないので、持ち越しポットは払った人へ返す
  if (m.carry && m.carry.amount > 0) {
    for (const [id, v] of Object.entries(m.carry.from)) {
      const p = m.players.find((x) => x.id === id);
      if (p) p.chips += v;
    }
    m.refund = { ...m.carry.from };
    m.carry = { amount: 0, from: {} };
  }
  m.ranking = [...m.players].sort((a, b) => b.chips - a.chips).map((p) => p.id);
  return m;
}
