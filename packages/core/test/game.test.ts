import { describe, expect, it } from 'vitest';
import {
  apply,
  createMatch,
  fullDeck,
  GameError,
  newGame,
  parseCard,
  parseCards,
  pendingSeats,
  seededRng,
  betOptions,
  chooseBet,
  validateConfig,
  settleGame,
  startGame,
  viewFor,
  HAND_SIZE,
  type GameAction,
  type GameState,
  type Rng,
} from '../src/index.ts';

/** 手札・初期場札・山札を指定してゲームを作る */
function rigged(hands: string[], initialBoard: string, deckTop: string, bet = 100, chips = 1000): GameState {
  const g = newGame({ players: hands.map((_, i) => ({ id: `p${i}`, chips })), bet, dealer: 0 }, seededRng(1));
  const used = new Set<number>();
  g.seats.forEach((s, i) => {
    s.hand = parseCards(hands[i]!);
    s.hand.forEach((c) => used.add(c));
  });
  g.initialBoard = parseCards(initialBoard);
  g.board = [...g.initialBoard];
  g.initialBoard.forEach((c) => used.add(c));
  const top = parseCards(deckTop);
  top.forEach((c) => used.add(c));
  g.deck = [...top, ...fullDeck().filter((c) => !used.has(c))];
  expect(used.size).toBe(hands.length * 7 + g.initialBoard.length + top.length);
  return g;
}

const run = (g: GameState, actions: GameAction[], rng: Rng) => actions.reduce((s, a) => apply(s, a, rng), g);

describe('ゲーム進行', () => {
  it('rules.md B-4 の計算例: 最下位が宣言し 2 位が便乗、1 位が強制参加、勝者がナッツ → 勝者の獲得 1000', () => {
    // 場: 3c ＋ As Ks Qs Js。席 0 は Ts でロイヤル、席 1 は A のスリーカード、席 2 は K のスリーカード、席 3 は 3 のワンペア
    let g = rigged(
      ['As Ts 7h 8d 9c 6h 2c', 'Ks Ah Ad 7d 8c 9h 6d', 'Qs Kh Kd 7c 8h 9d 6c', 'Js 4h 5d 2h 3d 4d 5h'],
      '3c',
      '2d',
    );
    const rng = () => 0; // 入れ替えは場札の 0 番（3c）、山札の先頭（2d）を引く
    for (let i = 0; i < 4; i++) {
      g = run(g, [0, 1, 2].map((k) => ({ type: 'peek', seat: i, index: k }) as GameAction), rng);
      g = apply(g, { type: 'place', seat: i, index: 0 }, rng);
      g = apply(g, { type: 'arrange', seat: i, sets: [[1, 2], [3, 4], [5, 6]] }, rng);
    }
    expect(g.phase).toBe('boardReveal');
    g = apply(g, { type: 'advance' }, rng);
    while (g.phase === 'reveal') {
      const p = g.seats[g.revealTurn]!;
      const idx = [1, 2, 3, 4, 5, 6].find((k) => !p.revealed.includes(k))!;
      g = apply(g, { type: 'flip', seat: g.revealTurn, index: idx }, rng);
    }
    expect(g.phase).toBe('ranking');
    expect(g.provisional!.firsts).toEqual([0]);
    expect(g.provisional!.lasts).toEqual([3]);
    g = apply(g, { type: 'advance' }, rng);
    expect(g.phase).toBe('declare');
    expect(() => apply(g, { type: 'declare', seat: 1, yes: true }, rng)).toThrow(GameError);
    g = apply(g, { type: 'declare', seat: 3, yes: true }, rng);
    expect(g.phase).toBe('join');
    expect(g.challenge!.optional).toEqual([1, 2]);
    expect(g.seats[0]!.challengeFee).toBe(100); // 強制参加
    g = apply(g, { type: 'join', seat: 1, yes: true }, rng);
    g = apply(g, { type: 'join', seat: 2, yes: false }, rng);
    expect(g.phase).toBe('swap');
    expect(g.challenge!.swap).toEqual({ index: 0, removed: parseCard('3c'), added: parseCard('2d') });
    g = apply(g, { type: 'advance' }, rng);
    const r = g.result!;
    expect(r.candidates).toEqual([0, 1, 3]);
    expect(r.winners).toEqual([0]);
    expect(r.nut).toBe(true);
    expect(r.mainPayout[0]! + r.nutPayout[0]!).toBe(1000);
    expect(r.delta).toEqual([800, -300, -200, -300]);
  });

  it('非参加者は最強でも勝者にならない', () => {
    // 席 2（非参加）が入れ替え後に最強でも、勝者候補は 1 位・宣言者・便乗者だけ
    let g = rigged(
      ['As Ts 7h 8d 9c 6h 2c', 'Ks Ah Ad 7d 8c 9h 6d', 'Qs Kh Kd 7c 8h 9d 6c'],
      '3c 4c',
      '5c',
    );
    const rng = () => 0;
    for (let i = 0; i < 3; i++) {
      g = run(g, [0, 1, 2].map((k) => ({ type: 'peek', seat: i, index: k }) as GameAction), rng);
      g = apply(g, { type: 'place', seat: i, index: 0 }, rng);
      g = apply(g, { type: 'arrange', seat: i, sets: [[1, 2], [3, 4], [5, 6]] }, rng);
    }
    g = apply(g, { type: 'advance' }, rng);
    while (g.phase === 'reveal') g = apply(g, { type: 'timeout' }, rng);
    g = apply(g, { type: 'advance' }, rng);
    const last = g.provisional!.lasts[0]!;
    g = apply(g, { type: 'declare', seat: last, yes: true }, rng);
    if (g.phase === 'join') g = apply(g, { type: 'timeout' }, rng); // 便乗は時間切れで見送り
    g = apply(g, { type: 'advance' }, rng);
    const r = g.result!;
    const nonPart = [0, 1, 2].filter((i) => !r.candidates.includes(i));
    for (const i of nonPart) expect(r.winners).not.toContain(i);
  });

  it('不正な操作は拒否する', () => {
    const rng = seededRng(3);
    let g = newGame({ players: [1, 2, 3].map((i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0 }, rng);
    expect(() => apply(g, { type: 'place', seat: 0, index: 0 }, rng)).toThrow('先に 3 枚めくる');
    g = run(g, [0, 1, 2].map((k) => ({ type: 'peek', seat: 0, index: k }) as GameAction), rng);
    expect(() => apply(g, { type: 'peek', seat: 0, index: 1 }, rng)).toThrow('すでにめくった');
    expect(() => apply(g, { type: 'place', seat: 0, index: 5 }, rng)).toThrow('めくった札の中から');
    g = apply(g, { type: 'place', seat: 0, index: 1 }, rng);
    expect(() => apply(g, { type: 'arrange', seat: 0, sets: [[1, 2], [3, 4], [5, 6]] }, rng)).toThrow('ちょうど 1 回ずつ');
    expect(() => apply(g, { type: 'flip', seat: 0, index: 2 }, rng)).toThrow('公開フェーズではない');
  });
});

/** ランダムに合法手を選んで対局を最後まで進める */
function playMatch(seed: number, n: number) {
  const rng = seededRng(seed);
  let m = createMatch(
    { initialChips: 500, bet: 10 * (1 + Math.floor(rng() * 30)), maxGames: 8 },
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
  );
  const total = m.players.reduce((a, p) => a + p.chips, 0);
  let games = 0;
  while (!m.finished) {
    m = startGame(m, rng);
    if (m.finished) break;
    let g = m.game!;
    let steps = 0;
    while (g.phase !== 'result') {
      if (++steps > 500) throw new Error('進行が止まった');
      checkViews(g);
      const pend = pendingSeats(g);
      if (pend.length === 0) {
        g = apply(g, { type: 'advance' }, rng);
        continue;
      }
      if (rng() < 0.15) {
        g = apply(g, { type: 'timeout' }, rng);
        continue;
      }
      const seat = pend[Math.floor(rng() * pend.length)]!;
      g = apply(g, randomAction(g, seat, rng), rng);
    }
    checkViews(g);
    const r = g.result!;
    expect(r.delta.reduce((a, b) => a + b, 0)).toBe(g.carryIn - r.carryOut);
    expect(r.stacks.every((x) => x >= 0)).toBe(true);
    m = settleGame({ ...m, game: g });
    // 持ち点と持ち越しポットの合計は変わらない
    expect(m.players.reduce((a, p) => a + p.chips, 0) + (m.carry?.amount ?? 0)).toBe(total);
    games++;
  }
  expect(m.ranking).toHaveLength(n);
  // 終わったら持ち越しポットは払い戻されている
  expect(m.carry?.amount ?? 0).toBe(0);
  expect(m.players.reduce((a, p) => a + p.chips, 0)).toBe(total);
  return games;
}

function randomAction(g: GameState, seat: number, rng: Rng): GameAction {
  const p = g.seats[seat]!;
  const pick = <T>(a: T[]) => a[Math.floor(rng() * a.length)]!;
  switch (g.phase) {
    case 'placement': {
      if (p.peeked.length < 3) return { type: 'peek', seat, index: pick([...Array(HAND_SIZE).keys()].filter((k) => !p.peeked.includes(k))) };
      const rest = [...Array(HAND_SIZE).keys()].filter((k) => !p.peeked.includes(k));
      if (p.boardIndex === null && g.extraPeeks && p.stack >= g.peekPrice && rest.length > 0 && rng() < 0.3)
        return { type: 'peek', seat, index: pick(rest) };
      if (p.boardIndex === null) return { type: 'place', seat, index: pick(p.peeked) };
      const idx = [...Array(HAND_SIZE).keys()].filter((k) => k !== p.boardIndex);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [idx[i], idx[j]] = [idx[j]!, idx[i]!];
      }
      return { type: 'arrange', seat, sets: [[idx[0]!, idx[1]!], [idx[2]!, idx[3]!], [idx[4]!, idx[5]!]] };
    }
    case 'reveal': {
      const left = [...Array(HAND_SIZE).keys()].filter((k) => k !== p.boardIndex && !p.revealed.includes(k));
      return { type: 'flip', seat, index: pick(left) };
    }
    case 'declare':
      return { type: 'declare', seat, yes: p.stack > 0 && rng() < 0.6 };
    case 'join':
      return { type: 'join', seat, yes: rng() < 0.5 };
    default:
      throw new Error(`想定外のフェーズ ${g.phase}`);
  }
}

/** 他人の伏せ札と山札が端末に漏れていないか */
function checkViews(g: GameState) {
  const json = JSON.stringify(viewFor(g, { kind: 'table' }));
  expect(json).not.toContain('"deck"');
  for (let me = 0; me < g.seats.length; me++) {
    const v = viewFor(g, { kind: 'seat', seat: me });
    v.seats.forEach((sv, i) => {
      const real = g.seats[i]!;
      sv.cards.forEach((c, k) => {
        if (c === null) return;
        expect(c).toBe(real.hand[k]);
        const open =
          ['ranking', 'declare', 'join', 'swap', 'result'].includes(g.phase) ||
          real.revealed.includes(k) ||
          (g.phase !== 'placement' && k === real.boardIndex) ||
          (i === me && real.peeked.includes(k));
        expect(open).toBe(true);
      });
      if (i !== me) expect(sv.known).toEqual([]);
    });
  }
}

describe('ランダム対局（不変条件）', () => {
  it('持ち点の合計が保たれ、マイナスにならず、情報が漏れない（3 人・4 人 × 60 対局）', () => {
    let games = 0;
    for (let seed = 1; seed <= 60; seed++) {
      games += playMatch(seed, 3);
      games += playMatch(1000 + seed, 4);
    }
    expect(games).toBeGreaterThan(200);
  });
});

describe('追加でめくる（有料）と持ち越しポット', () => {
  it('4 枚目から 1 枚ごとに 0.25B を払い、持ち点が足りなければめくれない', () => {
    const rng = seededRng(5);
    let g = newGame({ players: [0, 1, 2].map((i) => ({ id: `p${i}`, chips: i === 2 ? 130 : 1000 })), bet: 100, dealer: 0 }, rng);
    expect(g.peekPrice).toBe(25);
    g = run(g, [0, 1, 2, 3, 4].map((k) => ({ type: 'peek', seat: 0, index: k }) as GameAction), rng);
    expect(g.seats[0]!.stack).toBe(900 - 50);
    expect(g.seats[0]!.peekFee).toBe(50);
    // 席 2 は基本ベット 100 を出して残り 30: 1 枚だけ追加できる
    g = run(g, [0, 1, 2, 3].map((k) => ({ type: 'peek', seat: 2, index: k }) as GameAction), rng);
    expect(g.seats[2]!.stack).toBe(5);
    expect(() => apply(g, { type: 'peek', seat: 2, index: 4 }, rng)).toThrow('持ち点が足りない');
    // 場に出した後はめくれない
    g = apply(g, { type: 'place', seat: 0, index: 4 }, rng);
    expect(() => apply(g, { type: 'peek', seat: 0, index: 5 }, rng)).toThrow('場に札を出した後');
    // 他の人には枚数と料金だけ見え、中身は見えない
    const tv = viewFor(g, { kind: 'table' });
    expect(tv.seats[0]!.peekedCount).toBe(5);
    expect(tv.seats[0]!.peekFee).toBe(50);
    expect(tv.seats[0]!.cards.every((c) => c === null)).toBe(true);
  });

  it('料金は次のゲームの勝者が受け取り、最終ゲームでは追加でめくれない', () => {
    const rng = seededRng(9);
    let m = createMatch({ initialChips: 1000, bet: 100, maxGames: 2 }, [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}` })));
    m = startGame(m, rng);
    let g = m.game!;
    expect(g.extraPeeks).toBe(true);
    g = run(g, [0, 1, 2, 3].map((k) => ({ type: 'peek', seat: 1, index: k }) as GameAction), rng);
    while (g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
    expect(g.result!.carryOut).toBe(25);
    m = settleGame({ ...m, game: g });
    expect(m.carry).toEqual({ amount: 25, from: { [m.seatIds[1]!]: 25 } });
    m = startGame(m, rng);
    g = m.game!;
    expect(g.carryIn).toBe(25);
    expect(g.extraPeeks).toBe(false);
    g = run(g, [0, 1, 2].map((k) => ({ type: 'peek', seat: 0, index: k }) as GameAction), rng);
    expect(() => apply(g, { type: 'peek', seat: 0, index: 3 }, rng)).toThrow('追加でめくれない');
    while (g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
    const r = g.result!;
    expect(r.carryPayout.reduce((a, b) => a + b, 0)).toBe(25);
    for (const w of r.winners) expect(r.carryPayout[w]!).toBeGreaterThan(0);
    m = settleGame({ ...m, game: g });
    expect(m.finished).toBe(true);
    expect(m.players.reduce((a, p) => a + p.chips, 0)).toBe(3000);
  });

  it('対局が途中で終わったら、残った持ち越しポットは払った人へ返す', () => {
    const rng = seededRng(11);
    let m = createMatch({ initialChips: 1000, bet: 100, maxGames: null }, [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}` })));
    m = startGame(m, rng);
    let g = m.game!;
    g = run(g, [0, 1, 2, 3, 4].map((k) => ({ type: 'peek', seat: 0, index: k }) as GameAction), rng);
    while (g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
    // 1 人を脱落させて、残り 2 人で対局を終わらせる
    const r = g.result!;
    const loser = [0, 1, 2].find((i) => i !== 0 && !r.winners.includes(i)) ?? [0, 1, 2].find((i) => !r.winners.includes(i))!;
    r.stacks[loser] = 0;
    m = settleGame({ ...m, game: g });
    expect(m.finished).toBe(true);
    expect(m.refund).toEqual({ [m.seatIds[0]!]: 50 });
    expect(m.carry!.amount).toBe(0);
  });
});

describe('持ち回りベット（B-0）', () => {
  const rot = { initialChips: 1000, bet: 100, maxGames: 3, betMode: 'rotating' as const, minBet: 100, maxBet: 300, betStep: 50 };
  const finishGame = (g: GameState, rng: Rng) => {
    while (g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
    return g;
  };

  it('親がベット額を選ぶまで配らず、選んだ額がそのゲームの B になる', () => {
    const rng = seededRng(4);
    let m = createMatch(rot, [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}` })));
    m = startGame(m, rng);
    expect(m.game).toBeNull();
    expect(m.betting?.dealerId).toBe(m.dealerId);
    expect(betOptions(m)).toEqual([100, 150, 200, 250, 300]);
    const other = m.players.find((p) => p.id !== m.dealerId)!.id;
    expect(() => chooseBet(m, other, 200, rng)).toThrow('親だけ');
    expect(() => chooseBet(m, m.dealerId, 120, rng)).toThrow('選べない');
    m = chooseBet(m, m.dealerId, 250, rng);
    expect(m.betting).toBeNull();
    expect(m.game!.bet).toBe(250);
    expect(m.game!.peekPrice).toBe(63);
    expect(m.game!.seats.every((s) => s.baseBet === 250)).toBe(true);
    // 次のゲームは親が交代し、時間切れなら最低ベット
    const firstDealer = m.dealerId;
    m = settleGame({ ...m, game: finishGame(m.game!, rng) });
    expect(m.history[0]!.bet).toBe(250);
    m = startGame(m, rng);
    expect(m.dealerId).not.toBe(firstDealer);
    m = chooseBet(m, null, null, rng);
    expect(m.game!.bet).toBe(100);
  });

  it('親の持ち点が最高ベットより少なければ、そこまでしか選べない（最低ベット未満なら最低ベットだけ）', () => {
    const rng = seededRng(6);
    let m = createMatch({ ...rot, maxBet: null }, [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}` })));
    m = startGame(m, rng);
    const d = m.players.find((p) => p.id === m.dealerId)!;
    d.chips = 270;
    expect(betOptions(m)).toEqual([100, 150, 200, 250]);
    d.chips = 60;
    expect(betOptions(m)).toEqual([100]);
  });

  it('設定の検査', () => {
    expect(() => validateConfig({ ...rot, betStep: 30 })).toThrow('持ち回り');
    expect(() => validateConfig({ ...rot, maxBet: 50 })).toThrow('持ち回り');
    expect(() => validateConfig({ ...rot, maxBet: null })).not.toThrow();
    // 固定方式では持ち回りの値は見ない
    expect(() => validateConfig({ ...rot, betMode: 'fixed', betStep: 30 })).not.toThrow();
  });
});
