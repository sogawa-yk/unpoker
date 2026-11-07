// 対局（ゲームの連続プレイ）。rules.md 付録 B-0・B-1
import { clone, type Rng } from './cards.ts';
import { GameError, newGame, type GameState } from './game.ts';

export interface MatchConfig {
  initialChips: number;
  bet: number;
  /** 規定ゲーム数。null なら無制限 */
  maxGames: number | null;
}

export const DEFAULT_CONFIG: MatchConfig = { initialChips: 1000, bet: 100, maxGames: 10 };

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
  };
}

export function validateConfig(c: MatchConfig) {
  const ok =
    Number.isInteger(c.initialChips) && c.initialChips >= 500 && c.initialChips <= 10000 && c.initialChips % 100 === 0 &&
    Number.isInteger(c.bet) && c.bet >= 10 && c.bet <= 1000 && c.bet % 10 === 0 &&
    (c.maxGames === null || (Number.isInteger(c.maxGames) && c.maxGames >= 1 && c.maxGames <= 50));
  if (!ok) throw new GameError('ルーム設定が範囲外');
}

const active = (m: MatchState) => m.players.filter((p) => p.chips > 0);

/** 次のゲームを始める。始められない（残り 2 人以下、規定数に到達）なら対局を終える */
export function startGame(m: MatchState, rng: Rng): MatchState {
  if (m.finished) throw new GameError('対局は終了している');
  if (m.game && m.game.phase !== 'result') throw new GameError('ゲームの途中');
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
  next.game = newGame(
    { players: act.map((p) => ({ id: p.id, chips: p.chips })), bet: next.config.bet, dealer: act.indexOf(dealer) },
    rng,
  );
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
  });
  next.gameNo++;
  next.game = null;
  const act = active(next);
  if (act.length < 3 || (next.config.maxGames !== null && next.gameNo > next.config.maxGames)) return endMatch(next);
  return next;
}

function endMatch(m: MatchState): MatchState {
  m.finished = true;
  m.game = null;
  m.ranking = [...m.players].sort((a, b) => b.chips - a.chips).map((p) => p.id);
  return m;
}
