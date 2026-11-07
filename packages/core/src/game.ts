// 1 ゲームの進行（rules.md と付録 B）。状態は JSON にそのまま保存できる形にする。
// apply(state, action, rng) は渡された state を変えず、新しい state を返す。
import { clone, fullDeck, shuffle, type Card, type Rng } from './cards.ts';
import { bestSet, nutScore, type HandScore } from './evaluator.ts';
import { distributeLayers } from './pots.ts';
import { arrangeSets, chooseBoardIndex } from './strategy.ts';
import { adviseChallenge, advisePlacement, type Advice, type ChallengeOutcome } from './advisor.ts';

export const HAND_SIZE = 7;
export const FREE_PEEKS = 3;

/** 追加でめくる 1 枚の料金（rules.md B-5: 0.25B。端数は切り上げ） */
export const peekPriceFor = (bet: number) => Math.ceil(bet / 4);

/** AI 相談の料金（rules.md B-6: 配置 0.1B、チャレンジの判断 0.25B。端数は切り上げ） */
export const advicePriceFor = (bet: number) => ({ placement: Math.ceil(bet / 10), challenge: Math.ceil(bet / 4) });

export type AdviceTopic = 'place' | 'arrange' | 'declare' | 'join';

/** 相談の記録。中身は相談した本人だけが見る */
export interface AdviceRecord {
  /** 同じ判断で二重に払わないための鍵（例: place は めくった枚数ごと） */
  key: string;
  topic: AdviceTopic;
  fee: number;
  advice: Advice;
}

export type Phase =
  | 'placement' // 3 枚めくる → 1 枚を場に出す → 3 セットを作る（全員同時）
  | 'boardReveal' // 場札 5 枚の公開演出
  | 'reveal' // 公開フェーズ（交代で自分の札を 1 枚ずつめくる）
  | 'ranking' // 仮順位の発表演出
  | 'declare' // 仮最下位がチャレンジを宣言するか
  | 'join' // 仮 2 位・3 位が便乗するか
  | 'swap' // 場札の入れ替え演出
  | 'result';

export interface SeatState {
  id: string;
  /** ゲーム中の残りの持ち点（払った分は引かれている） */
  stack: number;
  baseBet: number;
  challengeFee: number;
  /** 追加でめくった料金の合計（次のゲームの持ち越しポットに入る） */
  peekFee: number;
  /** AI 相談の料金の合計（次のゲームの持ち越しポットに入る） */
  adviceFee: number;
  advice: AdviceRecord[];
  hand: Card[];
  /** めくった札の位置（めくった順） */
  peeked: number[];
  /** 場に出した札の位置 */
  boardIndex: number | null;
  /** 3 セット（手札の位置の組） */
  sets: [number, number][] | null;
  /** 公開フェーズでめくった札の位置 */
  revealed: number[];
  declare: boolean | null;
  join: boolean | null;
}

export interface Provisional {
  scores: HandScore[];
  bestSet: number[];
  firsts: number[];
  lasts: number[];
}

export interface ChallengeState {
  declarers: number[];
  forced: number[];
  /** 便乗できる席（2 位・3 位、宣言しなかった同率最下位） */
  optional: number[];
  joiners: number[];
  swap: { index: number; removed: Card; added: Card } | null;
}

export interface GameResult {
  board: Card[];
  scores: HandScore[];
  bestSet: number[];
  candidates: number[];
  winners: number[];
  nut: boolean;
  /** 各席の収支（このゲームで増えた持ち点。負なら減った） */
  delta: number[];
  /** 各席のゲーム後の持ち点 */
  stacks: number[];
  /** 内訳: メインポット（基本ベット＋チャレンジ費）の受取額、ナッツ増額の受取額と支払額、持ち越しポットの受取額 */
  mainPayout: number[];
  nutPayout: number[];
  nutPaid: number[];
  carryPayout: number[];
  /** 次のゲームへ持ち越す額（このゲームの追加めくりの料金の合計） */
  carryOut: number;
}

export interface GameState {
  phase: Phase;
  bet: number;
  /** 親の席。公開フェーズはここから始まり、同点の端数もここから優先する */
  dealer: number;
  seats: SeatState[];
  initialBoard: Card[];
  board: Card[];
  deck: Card[];
  revealTurn: number;
  provisional: Provisional | null;
  challenge: ChallengeState | null;
  result: GameResult | null;
  /** 前のゲームからの持ち越しポット。このゲームの最終勝者が受け取る */
  carryIn: number;
  /** 追加でめくる 1 枚の料金 */
  peekPrice: number;
  /** 追加でめくれるか（規定数の最終ゲームでは、受け取る次のゲームがないのでめくれない） */
  extraPeeks: boolean;
}

export type GameAction =
  | { type: 'peek'; seat: number; index: number }
  | { type: 'place'; seat: number; index: number }
  | { type: 'arrange'; seat: number; sets: [number, number][] }
  | { type: 'flip'; seat: number; index: number }
  | { type: 'declare'; seat: number; yes: boolean }
  | { type: 'join'; seat: number; yes: boolean }
  /** AI に相談する（今の判断について。料金は持ち越しポットへ） */
  | { type: 'consult'; seat: number }
  /** 演出フェーズを次へ進める（サーバーのタイマーが送る） */
  | { type: 'advance' }
  /** 持ち時間切れ。今のフェーズで操作が済んでいない席を自動で操作する */
  | { type: 'timeout' };

export class GameError extends Error {}

const fail = (msg: string): never => {
  throw new GameError(msg);
};

export interface NewGameInput {
  players: { id: string; chips: number }[];
  bet: number;
  dealer: number;
  carryIn?: number;
  /** 追加でめくれるか（既定は true） */
  extraPeeks?: boolean;
}

export function newGame({ players, bet, dealer, carryIn = 0, extraPeeks = true }: NewGameInput, rng: Rng): GameState {
  const n = players.length;
  if (n < 3 || n > 4) fail('参加人数は 3 人か 4 人');
  if (players.some((p) => p.chips <= 0)) fail('持ち点が 0 の参加者はゲームに入れない');
  const deck = shuffle(fullDeck(), rng);
  const seats: SeatState[] = players.map((p) => {
    const base = Math.min(bet, p.chips); // 足りなければオールイン
    return {
      id: p.id,
      stack: p.chips - base,
      baseBet: base,
      challengeFee: 0,
      peekFee: 0,
      adviceFee: 0,
      advice: [],
      hand: deck.splice(0, HAND_SIZE),
      peeked: [],
      boardIndex: null,
      sets: null,
      revealed: [],
      declare: null,
      join: null,
    };
  });
  const initialBoard = deck.splice(0, n === 3 ? 2 : 1);
  return {
    phase: 'placement',
    bet,
    dealer,
    seats,
    initialBoard,
    board: [...initialBoard],
    deck,
    revealTurn: dealer,
    provisional: null,
    challenge: null,
    result: null,
    carryIn,
    peekPrice: peekPriceFor(bet),
    extraPeeks,
  };
}

/** 親から席順に並べた席番号（同点の端数の優先順にも使う） */
export const seatOrder = (s: GameState): number[] =>
  s.seats.map((_, i) => (s.dealer + i) % s.seats.length);

const setIndices = (seat: SeatState): number[] =>
  [...Array(HAND_SIZE).keys()].filter((i) => i !== seat.boardIndex);

const setCards = (seat: SeatState): [Card, Card][] =>
  (seat.sets ?? []).map(([a, b]) => [seat.hand[a]!, seat.hand[b]!]);

function seatOf(s: GameState, seat: number): SeatState {
  return s.seats[seat] ?? fail(`席 ${seat} は存在しない`);
}

export function apply(state: GameState, action: GameAction, rng: Rng): GameState {
  const s = clone(state);
  switch (action.type) {
    case 'peek': {
      if (s.phase !== 'placement') fail('配置フェーズではない');
      const p = seatOf(s, action.seat);
      if (p.boardIndex !== null) fail('場に札を出した後はめくれない');
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= HAND_SIZE) fail('位置が不正');
      if (p.peeked.includes(action.index)) fail('すでにめくった札');
      if (p.peeked.length >= FREE_PEEKS) {
        // 4 枚目からは有料（B-5）。料金は次のゲームの持ち越しポットへ
        if (!s.extraPeeks) fail('このゲームでは追加でめくれない');
        if (p.stack < s.peekPrice) fail('持ち点が足りないので追加でめくれない');
        p.stack -= s.peekPrice;
        p.peekFee += s.peekPrice;
      }
      p.peeked.push(action.index);
      return s;
    }
    case 'place': {
      if (s.phase !== 'placement') fail('配置フェーズではない');
      const p = seatOf(s, action.seat);
      if (p.boardIndex !== null) fail('すでに場に出した');
      if (p.peeked.length < FREE_PEEKS) fail(`先に ${FREE_PEEKS} 枚めくる`);
      if (!p.peeked.includes(action.index)) fail('めくった札の中から選ぶ');
      p.boardIndex = action.index;
      return s;
    }
    case 'arrange': {
      if (s.phase !== 'placement') fail('配置フェーズではない');
      const p = seatOf(s, action.seat);
      if (p.boardIndex === null) fail('先に場に札を出す');
      if (p.sets !== null) fail('セットは確定済み');
      validateSets(p, action.sets);
      p.sets = action.sets.map(([a, b]) => [a, b]);
      return afterPlacement(s);
    }
    case 'consult':
      return consult(s, action.seat, rng);
    case 'flip': {
      if (s.phase !== 'reveal') fail('公開フェーズではない');
      if (action.seat !== s.revealTurn) fail('自分の番ではない');
      const p = seatOf(s, action.seat);
      if (!setIndices(p).includes(action.index)) fail('めくれない位置');
      if (p.revealed.includes(action.index)) fail('すでにめくった札');
      p.revealed.push(action.index);
      return afterFlip(s);
    }
    case 'declare': {
      if (s.phase !== 'declare') fail('宣言の受付中ではない');
      if (!s.provisional!.lasts.includes(action.seat)) fail('宣言できるのは仮最下位だけ');
      const p = seatOf(s, action.seat);
      if (p.declare !== null) fail('すでに選んだ');
      if (action.yes && p.stack <= 0) fail('持ち点が残っていないので宣言できない');
      p.declare = action.yes;
      return afterDeclare(s, rng);
    }
    case 'join': {
      if (s.phase !== 'join') fail('便乗の受付中ではない');
      if (!s.challenge!.optional.includes(action.seat)) fail('便乗できる席ではない');
      const p = seatOf(s, action.seat);
      if (p.join !== null) fail('すでに選んだ');
      p.join = action.yes;
      return afterJoin(s, rng);
    }
    case 'advance': {
      if (s.phase === 'boardReveal') {
        s.phase = 'reveal';
        s.revealTurn = s.dealer;
        return s;
      }
      if (s.phase === 'ranking') {
        const prov = s.provisional!;
        const canDeclare = prov.lasts.filter((i) => s.seats[i]!.stack > 0);
        if (prov.lasts.length === 0 || canDeclare.length === 0) return finish(s);
        // 持ち点がない最下位は自動で見送り
        for (const i of prov.lasts) if (s.seats[i]!.stack <= 0) s.seats[i]!.declare = false;
        s.phase = 'declare';
        return s;
      }
      if (s.phase === 'swap') return finish(s);
      return fail(`このフェーズ（${s.phase}）は advance で進めない`);
    }
    case 'timeout':
      return timeout(s, rng);
  }
}

function validateSets(p: SeatState, sets: [number, number][]) {
  if (!Array.isArray(sets) || sets.length !== 3) fail('セットは 3 つ');
  const used = sets.flat();
  if (used.length !== 6 || sets.some((x) => !Array.isArray(x) || x.length !== 2)) fail('各セットは 2 枚');
  const expect = setIndices(p);
  if (new Set(used).size !== 6 || !used.every((i) => expect.includes(i))) fail('場に出していない 6 枚をちょうど 1 回ずつ使う');
}

function afterPlacement(s: GameState): GameState {
  if (s.seats.some((p) => p.sets === null)) return s;
  // 場札: 初期の場札 ＋ 各自が出した札（席番号順）
  s.board = [...s.initialBoard, ...s.seats.map((p) => p.hand[p.boardIndex!]!)];
  s.phase = 'boardReveal';
  return s;
}

function afterFlip(s: GameState): GameState {
  const remaining = (i: number) => setIndices(s.seats[i]!).length - s.seats[i]!.revealed.length;
  const order = seatOrder(s);
  const start = order.indexOf(s.revealTurn);
  for (let k = 1; k <= order.length; k++) {
    const next = order[(start + k) % order.length]!;
    if (remaining(next) > 0) {
      s.revealTurn = next;
      return s;
    }
  }
  // 全員めくり終えた → 仮順位
  const evals = s.seats.map((p) => bestSet(setCards(p), s.board));
  const scores = evals.map((e) => e.score);
  const top = Math.max(...scores);
  const firsts = scores.flatMap((v, i) => (v === top ? [i] : []));
  const others = scores.flatMap((v, i) => (v !== top ? [i] : []));
  const bottom = Math.min(...others.map((i) => scores[i]!));
  const lasts = others.filter((i) => scores[i] === bottom);
  s.provisional = { scores, bestSet: evals.map((e) => e.index), firsts, lasts };
  s.phase = 'ranking';
  return s;
}

const payFee = (p: SeatState, bet: number) => {
  const fee = Math.min(bet, p.stack);
  p.stack -= fee;
  p.challengeFee += fee;
};

function afterDeclare(s: GameState, rng: Rng): GameState {
  const prov = s.provisional!;
  if (prov.lasts.some((i) => s.seats[i]!.declare === null)) return s;
  const declarers = prov.lasts.filter((i) => s.seats[i]!.declare === true);
  if (declarers.length === 0) return finish(s);
  for (const i of declarers) payFee(s.seats[i]!, s.bet);
  for (const i of prov.firsts) payFee(s.seats[i]!, s.bet); // 仮 1 位は強制参加（払える分だけ）
  const optional = s.seats
    .map((_, i) => i)
    .filter((i) => !prov.firsts.includes(i) && !declarers.includes(i) && s.seats[i]!.stack > 0);
  s.challenge = { declarers, forced: [...prov.firsts], optional, joiners: [], swap: null };
  if (optional.length === 0) return doSwap(s, rng);
  s.phase = 'join';
  return s;
}

function afterJoin(s: GameState, rng: Rng): GameState {
  const ch = s.challenge!;
  if (ch.optional.some((i) => s.seats[i]!.join === null)) return s;
  ch.joiners = ch.optional.filter((i) => s.seats[i]!.join === true);
  for (const i of ch.joiners) payFee(s.seats[i]!, s.bet);
  return doSwap(s, rng);
}

function doSwap(s: GameState, rng: Rng): GameState {
  const index = Math.floor(rng() * 5);
  const added = s.deck.shift() ?? fail('山札がない');
  const removed = s.board[index]!;
  s.board[index] = added; // 除外した札は以降使わない
  s.challenge!.swap = { index, removed, added };
  s.phase = 'swap';
  return s;
}

/** 追加めくりと AI 相談に払った額（次のゲームの持ち越しポットへ。古い保存データには無い） */
export const paidExtras = (p: SeatState) => (p.peekFee ?? 0) + (p.adviceFee ?? 0);

/** 今この席が相談できる判断（相談できる場面でなければ null） */
export function adviceTopic(s: GameState, seat: number): AdviceTopic | null {
  const p = s.seats[seat];
  if (!p) return null;
  if (s.phase === 'placement' && p.sets === null) return p.peeked.length < FREE_PEEKS ? null : p.boardIndex === null ? 'place' : 'arrange';
  if (s.phase === 'declare' && s.provisional!.lasts.includes(seat) && p.declare === null && p.stack > 0) return 'declare';
  if (s.phase === 'join' && s.challenge!.optional.includes(seat) && p.join === null) return 'join';
  return null;
}

const adviceKey = (s: GameState, seat: number, topic: AdviceTopic) =>
  topic === 'place' ? `place:${s.seats[seat]!.peeked.length}` : topic;

/** 同じ判断について、もう相談していればその記録 */
export function currentAdvice(s: GameState, seat: number): AdviceRecord | null {
  const topic = adviceTopic(s, seat);
  if (!topic) return null;
  const key = adviceKey(s, seat, topic);
  return (s.seats[seat]!.advice ?? []).find((a) => a.key === key) ?? null;
}

function consult(s: GameState, seat: number, rng: Rng): GameState {
  const p = seatOf(s, seat);
  const topic = adviceTopic(s, seat) ?? fail('今は相談できる場面ではない');
  if (!s.extraPeeks) fail('このゲームでは相談できない');
  if (currentAdvice(s, seat)) fail('この判断はもう相談した');
  const prices = advicePriceFor(s.bet);
  const fee = topic === 'place' || topic === 'arrange' ? prices.placement : prices.challenge;
  // チャレンジの判断は、払った後に参加費を出せる持ち点が残らないと意味がないので、料金より多く要る
  if (topic === 'declare' || topic === 'join' ? p.stack <= fee : p.stack < fee) fail('持ち点が足りないので相談できない');
  p.stack -= fee;
  p.adviceFee = (p.adviceFee ?? 0) + fee;
  let advice: Advice;
  if (topic === 'place' || topic === 'arrange') {
    advice = advisePlacement(
      {
        hand: p.hand,
        peeked: p.peeked,
        boardIndex: p.boardIndex,
        initBoard: s.initialBoard,
        players: s.seats.length,
        withPeek: s.extraPeeks && p.stack >= s.peekPrice,
      },
      rng,
    );
  } else {
    advice = adviseChallengeFor(s, seat, topic);
  }
  p.advice = [...(p.advice ?? []), { key: adviceKey(s, seat, topic), topic, fee, advice }];
  return s;
}

/** チャレンジの相談: 公開済みの札だけから、入れ替えの全パターンを数え上げる（山札の順番は使わない） */
function adviseChallengeFor(s: GameState, me: number, topic: 'declare' | 'join'): Advice {
  const prov = s.provisional!;
  const seen = new Set<Card>([...s.board, ...s.seats.flatMap((p) => setIndices(p).map((k) => p.hand[k]!))]);
  const unseen = Array.from({ length: 52 }, (_, c) => c).filter((c) => !seen.has(c));
  const deciders =
    topic === 'declare'
      ? s.seats.map((_, i) => i).filter((i) => i !== me && !prov.firsts.includes(i) && s.seats[i]!.stack > 0)
      : s.challenge!.optional.filter((i) => i !== me);
  const base = [...s.board];
  const simulate = (meIn: boolean, others: number[]): ChallengeOutcome[] => {
    const t = clone(s);
    if (topic === 'declare') {
      if (!meIn) {
        const r = finish(t).result!;
        return [{ stacks: r.stacks, winners: r.winners }];
      }
      payFee(t.seats[me]!, t.bet);
      for (const i of prov.firsts) payFee(t.seats[i]!, t.bet);
      t.challenge = { declarers: [me], forced: [...prov.firsts], optional: deciders, joiners: [], swap: null };
    }
    const joiners = [...others, ...(topic === 'join' && meIn ? [me] : [])];
    for (const i of joiners) payFee(t.seats[i]!, t.bet);
    t.challenge = { ...t.challenge!, joiners };
    const outs: ChallengeOutcome[] = [];
    for (let r = 0; r < base.length; r++)
      for (const d of unseen) {
        t.board = [...base];
        t.board[r] = d;
        const res = finish(t).result!;
        outs.push({ stacks: res.stacks, winners: res.winners });
      }
    return outs;
  };
  return adviseChallenge(topic, me, s.seats[me]!.stack, deciders, simulate);
}

function finish(s: GameState): GameState {
  const n = s.seats.length;
  const ch = s.challenge;
  const evals = s.seats.map((p) => bestSet(setCards(p), s.board));
  const scores = evals.map((e) => e.score);
  const candidates = ch ? [...new Set([...ch.forced, ...ch.declarers, ...ch.joiners])].sort((a, b) => a - b) : s.seats.map((_, i) => i);
  const order = seatOrder(s);
  const contrib = s.seats.map((p) => p.baseBet + p.challengeFee);
  const mainPayout = distributeLayers({
    contrib,
    eligibleLevel: contrib.map((c, i) => (candidates.includes(i) ? c : -1)),
    score: scores,
    tieOrder: order,
  });
  const top = Math.max(...candidates.map((i) => scores[i]!));
  const winners = order.filter((i) => candidates.includes(i) && scores[i] === top);

  // 持ち越しポット: 勝者で等分（端数は親から席順に）
  const carryPayout = new Array<number>(n).fill(0);
  if (s.carryIn > 0) {
    const each = Math.floor(s.carryIn / winners.length);
    let rest = s.carryIn - each * winners.length;
    for (const w of winners) {
      carryPayout[w]! += each + (rest > 0 ? 1 : 0);
      if (rest > 0) rest--;
    }
  }

  // ナッツ増額: 敗者 1 人あたり min(勝者の基本ベットの最大, 敗者の残り) を集め、勝者の基本ベット額を上限に分ける
  const nut = top === nutScore(s.board);
  const nutPaid = new Array<number>(n).fill(0);
  let nutPayout = new Array<number>(n).fill(0);
  const stacks = s.seats.map((p, i) => p.stack + mainPayout[i]! + carryPayout[i]!);
  if (nut) {
    const cap = Math.max(...winners.map((w) => s.seats[w]!.baseBet));
    s.seats.forEach((_, i) => {
      if (!winners.includes(i)) nutPaid[i] = Math.min(cap, s.seats[i]!.stack);
    });
    nutPayout = distributeLayers({
      contrib: nutPaid,
      eligibleLevel: s.seats.map((p, i) => (winners.includes(i) ? p.baseBet : -1)),
      score: scores,
      tieOrder: order,
    });
    for (let i = 0; i < n; i++) stacks[i]! += nutPayout[i]! - nutPaid[i]!;
  }
  const before = s.seats.map((p) => p.stack + p.baseBet + p.challengeFee + paidExtras(p));
  s.result = {
    board: [...s.board],
    scores,
    bestSet: evals.map((e) => e.index),
    candidates,
    winners,
    nut,
    delta: stacks.map((v, i) => v - before[i]!),
    stacks,
    mainPayout,
    nutPayout,
    nutPaid,
    carryPayout,
    carryOut: s.seats.reduce((a, p) => a + paidExtras(p), 0),
  };
  s.phase = 'result';
  return s;
}

function timeout(s: GameState, rng: Rng): GameState {
  let cur = s;
  switch (s.phase) {
    case 'placement':
      for (let i = 0; i < s.seats.length; i++) {
        const p = () => cur.seats[i]!;
        while (p().peeked.length < FREE_PEEKS) {
          const next = [...Array(HAND_SIZE).keys()].find((k) => !p().peeked.includes(k))!;
          cur = apply(cur, { type: 'peek', seat: i, index: next }, rng);
        }
        if (p().boardIndex === null) {
          const known = p().peeked.map((index) => ({ index, card: p().hand[index]! }));
          cur = apply(cur, { type: 'place', seat: i, index: chooseBoardIndex(known) }, rng);
        }
        if (p().sets === null) {
          const known = p().peeked.filter((k) => k !== p().boardIndex).map((index) => ({ index, card: p().hand[index]! }));
          const unknown = setIndices(p()).filter((k) => !p().peeked.includes(k));
          cur = apply(cur, { type: 'arrange', seat: i, sets: arrangeSets(known, unknown) }, rng);
        }
      }
      return cur;
    case 'reveal': {
      const p = cur.seats[cur.revealTurn]!;
      const left = setIndices(p).filter((k) => !p.revealed.includes(k));
      const index = left[Math.floor(rng() * left.length)]!;
      return apply(cur, { type: 'flip', seat: cur.revealTurn, index }, rng);
    }
    case 'declare':
      for (const i of cur.provisional!.lasts)
        if (cur.seats[i]!.declare === null) cur = apply(cur, { type: 'declare', seat: i, yes: false }, rng);
      return cur;
    case 'join':
      for (const i of cur.challenge!.optional)
        if (cur.seats[i]!.join === null) cur = apply(cur, { type: 'join', seat: i, yes: false }, rng);
      return cur;
    default:
      return fail(`このフェーズ（${s.phase}）に持ち時間はない`);
  }
}

/** 今のフェーズで操作が必要な席（演出フェーズは空） */
export function pendingSeats(s: GameState): number[] {
  switch (s.phase) {
    case 'placement':
      return s.seats.flatMap((p, i) => (p.sets === null ? [i] : []));
    case 'reveal':
      return [s.revealTurn];
    case 'declare':
      return s.provisional!.lasts.filter((i) => s.seats[i]!.declare === null);
    case 'join':
      return s.challenge!.optional.filter((i) => s.seats[i]!.join === null);
    default:
      return [];
  }
}
