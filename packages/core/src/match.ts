// 対局（ゲームの連続プレイ）。rules.md 付録 B-0・B-1
import { clone, type Rng } from './cards.ts';
import { categoryOf, evaluate } from './evaluator.ts';
import { drawSpecialDeals, type SpecialDeal, type SpecialKind } from './special.ts';
import type { PlayerStats } from './stats.ts';
import { GameError, newGame, paidExtras, type GameState } from './game.ts';

export type BetMode = 'fixed' | 'rotating';

export interface MatchConfig {
  initialChips: number;
  /** 固定ベット額（ベット方式が固定のとき） */
  bet: number;
  /** 規定ゲーム数。無制限（null）は 2026-11-10 に廃止。古い保存データには残っていることがある */
  maxGames: number | null;
  /** ベット方式（rules.md B-0）。古い設定には無い（固定として扱う） */
  betMode?: BetMode;
  /** 持ち回り: 最低ベット、最高ベット（null は上限なし）、刻み幅 */
  minBet?: number;
  maxBet?: number | null;
  betStep?: number;
  /** 持ち時間（過ぎたら自動で操作して進める）を使うか。古い設定には無い（使う） */
  timeLimit?: boolean;
  /** ヘッズアップ: 3 人以上で始めた対局が残り 2 人になっても続けるか（B-0・B-1）。古い設定には無い（続けない） */
  headsUp?: boolean;
  /** 前払いクレジット（B-11）。追加めくりと AI 相談の料金を、対局の最初に買ったクレジットから払う。古い設定には無い（使わない） */
  prepaid?: boolean;
  /** 特殊効果カード（B-10）。古い設定には無い（使わない） */
  specialCards?: boolean;
}

/** クレジットを買う単位（固定ベットならベット額、持ち回りなら最低ベット） */
export const creditUnit = (c: MatchConfig) => (c.betMode === 'rotating' ? (c.minBet ?? c.bet) : c.bet);
/** 1 人が買える上限（単位の数） */
export const CREDIT_MAX_UNITS = 10;
/** 買える単位の数の上限（持ち点の半分まで） */
export const creditMaxUnits = (c: MatchConfig, chips: number) => Math.max(0, Math.min(CREDIT_MAX_UNITS, Math.floor(chips / 2 / creditUnit(c))));

export const DEFAULT_CONFIG: MatchConfig = {
  initialChips: 1000,
  bet: 100,
  maxGames: 10,
  betMode: 'fixed',
  minBet: 100,
  maxBet: 500,
  betStep: 50,
  timeLimit: true,
  headsUp: false,
  prepaid: true,
  specialCards: false,
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
  /** 成績の集計用（特殊効果カードを配る条件。古い記録には無い） */
  detail?: GameDetail;
}

/** 1 ゲームの成績（プレイヤー ID で持つ） */
export interface GameDetail {
  firsts: string[];
  lasts: string[];
  /** チャレンジの参加者（宣言、強制参加、便乗）。チャレンジが無ければ空 */
  declarers: string[];
  forced: string[];
  joiners: string[];
  /** 最終の役の種類（0 ハイカード 〜 8 ストレートフラッシュ） */
  category: Record<string, number>;
  /** 自分の札が役を上げなかった（最終の役が、場札 5 枚だけの役と同じ種類） */
  boardOnly: string[];
  /** 仮 1 位だったのに、チャレンジで勝てなかった */
  reversed: string[];
  /** 相手のナッツで負けた */
  nutLosers: string[];
  /** 追加めくりと AI 相談に使った額 */
  spent: Record<string, number>;
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
  /** 前払いクレジットの残り（プレイヤー ID → 額。前払い制のときだけ） */
  credits?: Record<string, number>;
  /** 前払い制で、対局の最初にクレジットを買っている間（買い終えた人の ID） */
  buying?: { done: string[] } | null;
  /** 特殊効果カードの持ち札（プレイヤー ID → 種類。持てるのは 1 枚。B-10） */
  specials?: Record<string, SpecialKind | null>;
  /** 対局の始めに配ったカード（条件と種類は伏せて公開する） */
  specialDeals?: SpecialDeal[];
  /** 持っているカードと新しいカードのどちらを持つか、選んでもらっている間 */
  specialOffers?: { playerId: string; current: SpecialKind; offered: SpecialKind }[];
  /** 「今 2 組増やす」を使った人（次のゲームは 2 枚 × 2 組） */
  shrinkNext?: string[];
}

export function createMatch(config: MatchConfig, players: { id: string; name: string }[], held: Record<string, SpecialKind | null> = {}): MatchState {
  if (players.length < 2 || players.length > 4) throw new GameError('参加人数は 2〜4 人');
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
    ...(config.prepaid ? { credits: Object.fromEntries(players.map((p) => [p.id, 0])), buying: { done: [] } } : {}),
    ...(config.specialCards ? { specials: Object.fromEntries(players.map((p) => [p.id, held[p.id] ?? null])), specialDeals: [], specialOffers: [], shrinkNext: [] } : {}),
  };
}

/** 対局の始めに特殊効果カードを配る（前の対局の成績から。B-10）。持っている人には、どちらを持つか選んでもらう */
export function dealSpecials(m: MatchState, stats: PlayerStats[], rng: Rng): MatchState {
  if (!m.specials) throw new GameError('特殊効果カードを使わない対局');
  const next = clone(m);
  const deals = drawSpecialDeals(stats, next.players.map((p) => p.id), rng);
  next.specialDeals = deals;
  for (const d of deals) {
    const cur = next.specials![d.recipient];
    if (cur) next.specialOffers!.push({ playerId: d.recipient, current: cur, offered: d.kind });
    else next.specials![d.recipient] = d.kind;
  }
  return next;
}

/** 持っているカードと新しいカードのどちらを持つか（take なら新しいほう）。playerId が null なら時間切れ: 全員いまのカードのまま */
export function chooseSpecial(m: MatchState, playerId: string | null, take: boolean): MatchState {
  if (!m.specialOffers?.length) throw new GameError('選ぶ場面ではない');
  const next = clone(m);
  if (playerId === null) {
    next.specialOffers = [];
    return next;
  }
  const k = next.specialOffers!.findIndex((o) => o.playerId === playerId);
  if (k < 0) throw new GameError('選ぶカードがない');
  const o = next.specialOffers!.splice(k, 1)[0]!;
  if (take) {
    next.specials![playerId] = o.offered;
    // 同じ人への次の提案は、新しく持ったカードとの比べになる
    for (const x of next.specialOffers!) if (x.playerId === playerId) x.current = o.offered;
  }
  return next;
}

/** 最初のゲームを始める前に待つこと（クレジットを買う、カードを選ぶ）が残っているか */
export const waitingBeforeStart = (m: MatchState) => !!m.buying || !!m.specialOffers?.length;

/**
 * 前払いクレジットを買う（対局の最初に 1 回だけ。B-11）。units は単位の数。
 * playerId が null なら時間切れ: まだ買っていない人は 0 で締め切る。全員が買い終えたら buying が null になる
 */
export function buyCredit(m: MatchState, playerId: string | null, units: number | null): MatchState {
  if (!m.buying || !m.credits) throw new GameError('クレジットを買う場面ではない');
  const next = clone(m);
  const b = next.buying!;
  if (playerId === null) {
    b.done = next.players.map((p) => p.id);
  } else {
    const p = next.players.find((x) => x.id === playerId) ?? fail('参加していない');
    if (b.done.includes(playerId)) throw new GameError('もう買った');
    const u = units ?? 0;
    if (!Number.isInteger(u) || u < 0 || u > creditMaxUnits(next.config, p.chips)) throw new GameError('買える数を超えている');
    const price = u * creditUnit(next.config);
    p.chips -= price;
    next.credits![playerId] = price;
    b.done.push(playerId);
  }
  if (next.players.every((p) => b.done.includes(p.id))) next.buying = null;
  return next;
}

const fail = (msg: string): never => {
  throw new GameError(msg);
};

export function validateConfig(c: MatchConfig) {
  const ok =
    Number.isInteger(c.initialChips) && c.initialChips >= 500 && c.initialChips <= 10000 && c.initialChips % 100 === 0 &&
    Number.isInteger(c.bet) && c.bet >= 10 && c.bet <= 1000 && c.bet % 10 === 0 &&
    Number.isInteger(c.maxGames) && c.maxGames! >= 1 && c.maxGames! <= 50;
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

/**
 * 対局を終えるか（B-1）。残り 1 人、規定ゲーム数に到達、
 * またはヘッズアップを続けない設定で、3 人以上で始めた対局が残り 2 人になったとき
 */
function shouldEnd(m: MatchState): boolean {
  const left = active(m).length;
  if (left <= 1) return true;
  if (left === 2 && m.players.length >= 3 && !m.config.headsUp) return true;
  return m.config.maxGames !== null && m.gameNo > m.config.maxGames;
}

/** 次のゲームを始める。始められない（残り 2 人以下、規定数に到達）なら対局を終える */
export function startGame(m: MatchState, rng: Rng): MatchState {
  if (m.finished) throw new GameError('対局は終了している');
  if (m.game && m.game.phase !== 'result') throw new GameError('ゲームの途中');
  if (m.betting) throw new GameError('親がベット額を選んでいる');
  if (m.buying) throw new GameError('クレジットを買っている');
  if (m.specialOffers?.length) throw new GameError('特殊効果カードを選んでいる');
  const next = clone(m);
  const act = active(next);
  if (shouldEnd(next)) return endMatch(next);
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
  if (isFinal && next.credits) {
    // 最終ゲームでは追加めくりと AI 相談ができない。使い残しのクレジットは全部、最終ゲームの持ち越しポットに入れる（B-11）
    const carry = next.carry ?? { amount: 0, from: {} };
    for (const [id, v] of Object.entries(next.credits)) {
      if (v <= 0) continue;
      carry.amount += v;
      carry.from[id] = (carry.from[id] ?? 0) + v;
      next.credits[id] = 0;
    }
    next.carry = carry;
  }
  next.game = newGame(
    {
      players: act.map((p) => ({
        id: p.id,
        chips: p.chips,
        credit: next.credits?.[p.id] ?? 0,
        held: next.specials?.[p.id] ?? null,
        // 前のゲームで「今 2 組増やす」を使った人は、2 枚 × 2 組（場に出す 1 枚と合わせて 5 枚）
        handSize: next.shrinkNext?.includes(p.id) ? 5 : undefined,
      })),
      specials: !!next.specials,
      bet,
      dealer: act.indexOf(dealer),
      carryIn: next.carry?.amount ?? 0,
      extraPeeks: !isFinal,
      prepaid: !!next.credits,
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
    detail: gameDetail(g, next.seatIds),
  });
  // 持ち越しポット: 今のゲームの勝者が受け取り済み。このゲームで払われた料金が次へ
  const from: Record<string, number> = {};
  g.seats.forEach((s, i) => {
    if (paidExtras(s) > 0) from[next.seatIds[i]!] = paidExtras(s);
  });
  next.carry = { amount: r.carryOut, from };
  if (next.specials && g.special) {
    g.seats.forEach((_, i) => (next.specials![next.seatIds[i]!] = g.special!.held[i] ?? null));
    next.shrinkNext = g.special.surged.map((i) => next.seatIds[i]!);
  }
  if (next.credits) {
    g.seats.forEach((s, i) => {
      const id = next.seatIds[i]!;
      next.credits![id] = s.credit ?? 0;
      // 脱落した人の使い残しは、次のゲームの持ち越しポットへ（B-11）
      if (r.stacks[i] === 0 && next.credits![id]! > 0) {
        next.carry!.amount += next.credits![id]!;
        next.carry!.from[id] = (next.carry!.from[id] ?? 0) + next.credits![id]!;
        next.credits![id] = 0;
      }
    });
  }
  next.gameNo++;
  next.game = null;
  if (shouldEnd(next)) return endMatch(next);
  return next;
}

function gameDetail(g: GameState, ids: string[]): GameDetail {
  const r = g.result!;
  const prov = g.provisional;
  const ch = g.challenge;
  const id = (i: number) => ids[i]!;
  const boardCat = categoryOf(evaluate(r.board));
  const winners = new Set(r.winners);
  return {
    firsts: (prov?.firsts ?? []).map(id),
    lasts: (prov?.lasts ?? []).map(id),
    declarers: (ch?.declarers ?? []).map(id),
    forced: (ch?.forced ?? []).map(id),
    joiners: (ch?.joiners ?? []).map(id),
    category: Object.fromEntries(r.scores.map((s, i) => [id(i), categoryOf(s)])),
    boardOnly: r.scores.map((s, i) => [s, i] as const).filter(([s]) => categoryOf(s) === boardCat).map(([, i]) => id(i)),
    reversed: ch ? ch.forced.filter((i) => !winners.has(i)).map(id) : [],
    nutLosers: r.nut ? g.seats.map((_, i) => i).filter((i) => !winners.has(i)).map(id) : [],
    spent: Object.fromEntries(g.seats.map((s, i) => [id(i), paidExtras(s)])),
  };
}

function endMatch(m: MatchState): MatchState {
  m.finished = true;
  m.game = null;
  const left = active(m);
  if (m.credits) {
    // 途中で終わった: 残り 1 人なら、全員の使い残しを残った人へ。そうでなければ本人へ返す（B-11）
    for (const [id, v] of Object.entries(m.credits)) {
      if (v <= 0) continue;
      const to = left.length === 1 ? left[0]! : m.players.find((x) => x.id === id);
      if (to) to.chips += v;
      m.credits[id] = 0;
    }
  }
  if (left.length === 1 && m.carry && m.carry.amount > 0) {
    // 残り 1 人で終わった: 持ち越しポットは残った人が全部受け取る（B-3。2026-11-10 決定）
    left[0]!.chips += m.carry.amount;
    m.carry = { amount: 0, from: {} };
  } else if (m.carry && m.carry.amount > 0) {
    // 受け取る次のゲームがないので、持ち越しポットは払った人へ返す
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
