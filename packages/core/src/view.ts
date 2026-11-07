// 端末ごとに見てよい情報だけを取り出す（不正防止。architecture.md 3 章）
import type { Card } from './cards.ts';
import type { GameResult, GameState, Phase, Provisional } from './game.ts';

export type Viewer = { kind: 'table' } | { kind: 'seat'; seat: number };

export interface SeatView {
  id: string;
  stack: number;
  baseBet: number;
  challengeFee: number;
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
  /** 場札を出した席（初期の場札は null） */
  boardOwners: (number | null)[];
  deckCount: number;
  revealTurn: number;
  provisional: Provisional | null;
  challenge: GameState['challenge'];
  result: GameResult | null;
  carryIn: number;
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
  if (placementDone) {
    s.board.forEach((c, k) => {
      if (k >= s.initialBoard.length) {
        board.push(c);
        boardOwners.push(k - s.initialBoard.length);
      }
    });
    // 入れ替え後は現在の場札をそのまま見せる
    if (s.challenge?.swap) for (let k = 0; k < board.length; k++) board[k] = s.board[k]!;
  } else {
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
  };
}
