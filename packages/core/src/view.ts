// 端末ごとに見てよい情報だけを取り出す（不正防止。architecture.md 3 章）
import type { Card } from './cards.ts';
import { challengeOutlook, type ChallengeOutlook } from './outlook.ts';
import { advicePriceFor, type AdviceRecord, type AdviceTopic, type GameResult, type GameState, type Phase, type Provisional } from './game.ts';

export type Viewer = { kind: 'table' } | { kind: 'seat'; seat: number };

export interface SeatView {
  id: string;
  stack: number;
  baseBet: number;
  challengeFee: number;
  /** 追加でめくった料金（枚数は peekedCount から分かる。中身は見せない） */
  peekFee: number;
  /** AI 相談の料金の合計と、相談した判断（相談したことは全員に公開。B-6） */
  adviceFee: number;
  consulted: AdviceTopic[];
  /** 相談の中身（自分の席だけ。他人の席は空） */
  advice: AdviceRecord[];
  peekedCount: number;
  placed: boolean;
  arranged: boolean;
  /** 手札 7 枚。見えない札は null */
  cards: (Card | null)[];
  /** 持ち主にとって中身がわかっている位置（自分の席だけ。他人の席は空） */
  known: number[];
  boardIndex: number | null;
  sets: [number, number][] | null;
  revealed: number[];
  /** 選び終えたか（中身は全員が決めるまで伏せる） */
  declareDone: boolean;
  declare: boolean | null;
  joinDone: boolean;
  join: boolean | null;
}

export interface GameView {
  phase: Phase;
  bet: number;
  dealer: number;
  you: number | null;
  seats: SeatView[];
  /** 場札。伏せている札は null */
  board: (Card | null)[];
  /** 場札を出した席（最初から表の札は null、伏せたランダムの札は -1） */
  boardOwners: (number | null)[];
  deckCount: number;
  revealTurn: number;
  provisional: Provisional | null;
  challenge: GameState['challenge'];
  result: GameResult | null;
  carryIn: number;
  peekPrice: number;
  /** 追加めくりと AI 相談ができるか（規定数の最終ゲームではできない） */
  extraPeeks: boolean;
  advicePrice: { placement: number; challenge: number };
  /** チャレンジ中の勝ち筋（B-9）。参加者が決まった後（入れ替えの場面）だけ。判断の場面には送らない */
  outlook: ChallengeOutlook | null;
}

const AFTER_REVEAL: Phase[] = ['ranking', 'declare', 'join', 'swap', 'result'];

export function viewFor(s: GameState, viewer: Viewer): GameView {
  const you = viewer.kind === 'seat' ? viewer.seat : null;
  const placementDone = s.phase !== 'placement';
  const allOpen = AFTER_REVEAL.includes(s.phase);

  const seats: SeatView[] = s.seats.map((p, i) => {
    const mine = i === you;
    const visible = (k: number) =>
      allOpen ||
      p.revealed.includes(k) ||
      (mine && p.peeked.includes(k)) ||
      (placementDone && k === p.boardIndex);
    const hideChoice = (phase: Phase) => s.phase === phase && !mine;
    return {
      id: p.id,
      stack: p.stack,
      baseBet: p.baseBet,
      challengeFee: p.challengeFee,
      peekFee: p.peekFee ?? 0,
      adviceFee: p.adviceFee ?? 0,
      consulted: (p.advice ?? []).map((a) => a.topic),
      advice: mine ? (p.advice ?? []) : [],
      peekedCount: p.peeked.length,
      placed: p.boardIndex !== null,
      arranged: p.sets !== null,
      cards: p.hand.map((c, k) => (visible(k) ? c : null)),
      known: mine ? [...p.peeked] : [],
      boardIndex: mine || placementDone ? p.boardIndex : null,
      sets: p.sets,
      revealed: [...p.revealed],
      declareDone: p.declare !== null,
      declare: hideChoice('declare') ? null : p.declare,
      joinDone: p.join !== null,
      join: hideChoice('join') ? null : p.join,
    };
  });

  const board: (Card | null)[] = [...s.initialBoard];
  const boardOwners: (number | null)[] = s.initialBoard.map(() => null);
  const hidden = s.hiddenBoard ?? [];
  if (placementDone) {
    const head = s.initialBoard.length + hidden.length;
    s.board.forEach((c, k) => {
      if (k >= s.initialBoard.length) {
        board.push(c);
        boardOwners.push(k < head ? -1 : k - head);
      }
    });
    // 入れ替え後は現在の場札をそのまま見せる
    if (s.challenge?.swap) for (let k = 0; k < board.length; k++) board[k] = s.board[k]!;
  } else {
    // 配置中: 伏せたランダムの札は誰にも見せない
    hidden.forEach(() => {
      board.push(null);
      boardOwners.push(-1);
    });
    s.seats.forEach((p, i) => {
      if (p.boardIndex !== null) {
        board.push(i === you ? p.hand[p.boardIndex]! : null);
        boardOwners.push(i);
      }
    });
  }

  return {
    phase: s.phase,
    bet: s.bet,
    dealer: s.dealer,
    you,
    seats,
    board,
    boardOwners,
    deckCount: s.deck.length,
    revealTurn: s.revealTurn,
    provisional: allOpen ? s.provisional : null,
    challenge: s.challenge,
    result: s.result,
    carryIn: s.carryIn,
    peekPrice: s.peekPrice,
    extraPeeks: s.extraPeeks,
    advicePrice: advicePriceFor(s.bet),
    outlook: challengeOutlook(s),
  };
}
