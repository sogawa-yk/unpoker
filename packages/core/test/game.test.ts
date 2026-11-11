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
  matchStats,
  buyCredit,
  creditMaxUnits,
  wallet,
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
    g = apply(g, { type: 'roulette', seat: 3, cmd: 'start' }, rng);
    g = apply(g, { type: 'roulette', seat: 3, cmd: 'stop' }, rng);
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
    g = apply(g, { type: 'roulette', seat: last, cmd: 'start' }, rng);
    g = apply(g, { type: 'roulette', seat: last, cmd: 'stop' }, rng);
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
function playMatch(seed: number, n: number, headsUp = false, prepaid = false) {
  const rng = seededRng(seed);
  let m = createMatch(
    { initialChips: 500, bet: 10 * (1 + Math.floor(rng() * 30)), maxGames: 8, headsUp, prepaid },
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
  );
  const total = m.players.reduce((a, p) => a + p.chips, 0);
  const credits = () => Object.values(m.credits ?? {}).reduce((a, b) => a + b, 0);
  if (prepaid) {
    // 前払いクレジットを買う。1 人は時間切れで 0
    for (const p of m.players.slice(1)) m = buyCredit(m, p.id, Math.floor(rng() * (creditMaxUnits(m.config, p.chips) + 1)));
    m = buyCredit(m, null, null);
    expect(m.buying).toBeNull();
    expect(m.players.reduce((a, p) => a + p.chips, 0) + credits()).toBe(total);
  }
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
    // 前払い制では料金をクレジットから払うので、持ち点の増減には入らない
    const fromCredit = g.prepaid ? r.carryOut : 0;
    expect(r.delta.reduce((a, b) => a + b, 0)).toBe(g.carryIn - r.carryOut + fromCredit);
    if (g.prepaid) g.seats.forEach((p) => expect(p.credit!).toBeGreaterThanOrEqual(0));
    expect(r.stacks.every((x) => x >= 0)).toBe(true);
    m = settleGame({ ...m, game: g });
    // 持ち点とクレジットと持ち越しポットの合計は変わらない
    expect(m.players.reduce((a, p) => a + p.chips, 0) + credits() + (m.carry?.amount ?? 0)).toBe(total);
    games++;
  }
  expect(m.ranking).toHaveLength(n);
  // 終わる条件（B-1）: 規定数、残り 1 人、ヘッズアップを続けない設定で 3 人以上から残り 2 人
  // 払い戻しで脱落者の持ち点が戻ることがあるので、払い戻しを除いて数える
  const left = m.players.filter((p) => p.chips - (m.refund?.[p.id] ?? 0) > 0).length;
  if (m.gameNo <= 8) expect(left === 1 || (left === 2 && n >= 3 && !headsUp), JSON.stringify({ seed, n, headsUp, left, gameNo: m.gameNo, chips: m.players.map((p) => p.chips) })).toBe(true);
  // 終わったら持ち越しポットは払い戻されている（残り 1 人なら、その人が受け取っている）
  expect(m.carry?.amount ?? 0).toBe(0);
  expect(credits()).toBe(0);
  expect(m.players.reduce((a, p) => a + p.chips, 0)).toBe(total);
  return games;
}

function randomAction(g: GameState, seat: number, rng: Rng): GameAction {
  const p = g.seats[seat]!;
  const pick = <T>(a: T[]) => a[Math.floor(rng() * a.length)]!;
  if (g.phase === 'swap') return { type: 'roulette', seat, cmd: g.challenge!.roulette === 'ready' ? 'start' : 'stop' };
  switch (g.phase) {
    case 'placement': {
      if (p.peeked.length < 3) return { type: 'peek', seat, index: pick([...Array(HAND_SIZE).keys()].filter((k) => !p.peeked.includes(k))) };
      const rest = [...Array(HAND_SIZE).keys()].filter((k) => !p.peeked.includes(k));
      if (p.boardIndex === null && g.extraPeeks && wallet(g, p) >= g.peekPrice && rest.length > 0 && rng() < 0.3)
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
  expect(json).not.toContain('hiddenBoard');
  // 伏せたランダムの場札は、場札公開まで誰にも見せない（B-8）
  for (const viewer of [{ kind: 'table' as const }, ...g.seats.map((_, i) => ({ kind: 'seat' as const, seat: i }))]) {
    const v = viewFor(g, viewer);
    expect(v.board).toHaveLength(g.phase === 'placement' ? 1 + (g.hiddenBoard ?? []).length + g.seats.filter((p) => p.boardIndex !== null).length : 5);
    v.boardOwners.forEach((o, k) => {
      if (o === -1 && g.phase === 'placement') expect(v.board[k]).toBeNull();
    });
  }
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
  it('持ち点の合計が保たれ、マイナスにならず、情報が漏れない（2〜4 人、ヘッズアップあり・なし）', () => {
    let games = 0;
    for (let seed = 1; seed <= 40; seed++) {
      games += playMatch(2000 + seed, 2);
      games += playMatch(seed, 3);
      games += playMatch(3000 + seed, 3, true);
      games += playMatch(1000 + seed, 4);
      games += playMatch(4000 + seed, 4, true);
      games += playMatch(5000 + seed, 3, false, true);
      games += playMatch(6000 + seed, 4, true, true);
      games += playMatch(7000 + seed, 2, false, true);
    }
    expect(games).toBeGreaterThan(300);
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
    let m = createMatch({ initialChips: 1000, bet: 100, maxGames: 10 }, [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}` })));
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

describe('場札入れ替えのルーレット（宣言した人が回して止める）', () => {
  it('回す → 止める で入れ替える札が決まり、止めるまでは札を見せない', () => {
    for (let seed = 1; seed < 200; seed++) {
      const rng = seededRng(seed);
      let g = newGame({ players: [0, 1, 2].map((i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0 }, rng);
      while (g.phase !== 'declare' && g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
      if (g.phase !== 'declare') continue;
      const last = g.provisional!.lasts[0]!;
      for (const i of g.provisional!.lasts) g = apply(g, { type: 'declare', seat: i, yes: i === last }, rng);
      while (g.phase === 'join') g = apply(g, { type: 'timeout' }, rng);
      expect(g.phase).toBe('swap');
      const ch = g.challenge!;
      expect(ch.roller).toBe(last);
      expect(ch.roulette).toBe('ready');
      expect(ch.swap).toBeNull();
      expect(pendingSeats(g)).toEqual([last]);
      const other = [0, 1, 2].find((i) => i !== last)!;
      expect(() => apply(g, { type: 'roulette', seat: other, cmd: 'start' }, rng)).toThrow('宣言した人だけ');
      expect(() => apply(g, { type: 'roulette', seat: last, cmd: 'stop' }, rng)).toThrow('回っていない');
      expect(() => apply(g, { type: 'advance' }, rng)).toThrow('止まっていない');
      g = apply(g, { type: 'roulette', seat: last, cmd: 'start' }, rng);
      expect(g.challenge!.roulette).toBe('spinning');
      // 回っている間も、入れ替える札は誰にも見えない
      expect(viewFor(g, { kind: 'table' }).challenge!.swap).toBeNull();
      g = apply(g, { type: 'roulette', seat: last, cmd: 'stop' }, rng);
      expect(g.challenge!.roulette).toBe('stopped');
      expect(g.challenge!.swap).not.toBeNull();
      expect(pendingSeats(g)).toEqual([]);
      g = apply(g, { type: 'advance' }, rng);
      expect(g.phase).toBe('result');
      return;
    }
    throw new Error('宣言フェーズにならない');
  });

  it('時間切れなら自動で回し、自動で止める', () => {
    for (let seed = 1; seed < 200; seed++) {
      const rng = seededRng(seed);
      let g = newGame({ players: [0, 1, 2].map((i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0 }, rng);
      while (g.phase !== 'declare' && g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
      if (g.phase !== 'declare') continue;
      for (const i of g.provisional!.lasts) g = apply(g, { type: 'declare', seat: i, yes: true }, rng);
      while (g.phase === 'join') g = apply(g, { type: 'timeout' }, rng);
      g = apply(g, { type: 'timeout' }, rng);
      expect(g.challenge!.roulette).toBe('spinning');
      g = apply(g, { type: 'timeout' }, rng);
      expect(g.challenge!.roulette).toBe('stopped');
      return;
    }
  });
});

describe('人数と場札（B-8）', () => {
  it('どの人数でも場札は 5 枚。表 1 枚 ＋ 伏せたランダムの札（2 人 2 枚、3 人 1 枚、4 人 0 枚）＋ 各自の札', () => {
    for (const [n, hidden, deck] of [
      [2, 2, 35],
      [3, 1, 29],
      [4, 0, 23],
    ] as const) {
      const rng = seededRng(n);
      let g = newGame({ players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0 }, rng);
      expect(g.initialBoard).toHaveLength(1);
      expect(g.hiddenBoard).toHaveLength(hidden);
      expect(g.deck).toHaveLength(deck);
      const v0 = viewFor(g, { kind: 'table' });
      expect(v0.board).toEqual([g.initialBoard[0], ...Array(hidden).fill(null)]);
      expect(v0.boardOwners).toEqual([null, ...Array(hidden).fill(-1)]);
      for (let i = 0; i < n; i++) {
        g = run(g, [0, 1, 2].map((k) => ({ type: 'peek', seat: i, index: k }) as GameAction), rng);
        g = apply(g, { type: 'place', seat: i, index: 0 }, rng);
        g = apply(g, { type: 'arrange', seat: i, sets: [[1, 2], [3, 4], [5, 6]] }, rng);
      }
      expect(g.phase).toBe('boardReveal');
      expect(g.board).toEqual([...g.initialBoard, ...g.hiddenBoard!, ...g.seats.map((p) => p.hand[0]!)]);
      const v = viewFor(g, { kind: 'table' });
      expect(v.board).toEqual(g.board);
      expect(v.boardOwners).toEqual([null, ...Array(hidden).fill(-1), ...g.seats.map((_, i) => i)]);
    }
  });

  it('2 人ではチャレンジは一騎打ち（便乗なし）', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rng = seededRng(seed);
      let g = newGame({ players: [0, 1].map((i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0 }, rng);
      while (g.phase !== 'declare' && g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
      if (g.phase !== 'declare') continue;
      const last = g.provisional!.lasts[0]!;
      g = apply(g, { type: 'declare', seat: last, yes: true }, rng);
      expect(g.phase).toBe('swap');
      expect(g.challenge!.optional).toEqual([]);
      return;
    }
    throw new Error('宣言の場面に一度もならなかった');
  });
});

describe('ヘッズアップ（B-1）', () => {
  /** 席 loser の持ち点を 0 にしてゲームを終える */
  const bust = (m: ReturnType<typeof createMatch>, rng: Rng, loserId: string) => {
    let g = m.game!;
    while (g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
    const i = m.seatIds.indexOf(loserId);
    const r = g.result!;
    // 失った分は勝者へ（合計を保つ）
    const w = r.winners[0] === i ? r.winners.find((x) => x !== i) ?? (i + 1) % r.stacks.length : r.winners[0]!;
    r.stacks[w]! += r.stacks[i]!;
    r.stacks[i] = 0;
    return settleGame({ ...m, game: g });
  };

  it('続けない設定: 3 人で始めて残り 2 人になったら終える', () => {
    const rng = seededRng(5);
    let m = createMatch({ initialChips: 1000, bet: 100, maxGames: 10 }, [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}` })));
    m = startGame(m, rng);
    m = bust(m, rng, 'p2');
    expect(m.finished).toBe(true);
  });

  it('続ける設定: 残り 2 人でも続け、残り 1 人で終える。残った人が持ち越しポットを受け取る', () => {
    const rng = seededRng(6);
    let m = createMatch({ initialChips: 1000, bet: 100, maxGames: 10, headsUp: true }, [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}` })));
    m = startGame(m, rng);
    m = bust(m, rng, 'p2');
    expect(m.finished).toBe(false);
    m = startGame(m, rng);
    expect(m.game!.seats).toHaveLength(2);
    expect(m.game!.hiddenBoard).toHaveLength(2); // 2 人の場札
    // 持ち越しポットがある状態で、もう 1 人が脱落する
    m.game!.seats[0]!.stack -= 30;
    m.game!.seats[0]!.peekFee += 30;
    const survivor = m.seatIds[0]!;
    const total = m.players.reduce((a, p) => a + p.chips, 0);
    m = bust(m, rng, m.seatIds[1]!);
    expect(m.finished).toBe(true);
    expect(m.refund ?? null).toBeNull();
    expect(m.carry!.amount).toBe(0);
    expect(m.players.find((p) => p.id === survivor)!.chips).toBe(total);
  });

  it('2 人で始めた対局は、設定に関係なく続ける。規定ゲーム数の無制限は使えない', () => {
    const rng = seededRng(7);
    let m = createMatch({ initialChips: 1000, bet: 100, maxGames: 3 }, [0, 1].map((i) => ({ id: `p${i}`, name: `P${i}` })));
    for (let k = 0; k < 3; k++) {
      m = startGame(m, rng);
      expect(m.finished).toBe(false);
      let g = m.game!;
      while (g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
      m = settleGame({ ...m, game: g });
    }
    expect(m.finished).toBe(true);
    expect(() => validateConfig({ initialChips: 1000, bet: 100, maxGames: null })).toThrow(GameError);
  });
});

describe('対局の成績（特殊効果カードの配布条件）', () => {
  it('ゲームの詳細から、勝ち数・脱落・使った額などを数える', () => {
    const rng = seededRng(21);
    let m = createMatch({ initialChips: 500, bet: 100, maxGames: 6 }, [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}` })));
    while (!m.finished) {
      m = startGame(m, rng);
      if (m.finished) break;
      let g = m.game!;
      while (g.phase !== 'result') {
        const pend = pendingSeats(g);
        if (pend.length === 0) g = apply(g, { type: 'advance' }, rng);
        else g = apply(g, randomAction(g, pend[0]!, rng), rng);
      }
      m = settleGame({ ...m, game: g });
    }
    const st = matchStats(m);
    expect(st).toHaveLength(3);
    const games = m.history.length;
    // 勝ち数の合計は、ゲーム数以上（引き分けで複数人が勝つことがある）
    expect(st.reduce((a, x) => a + x.wins, 0)).toBeGreaterThanOrEqual(games);
    for (const x of st) {
      expect(x.games).toBe(m.history.filter((h) => h.seatIds.includes(x.id)).length);
      expect(x.spent).toBe(m.history.reduce((a, h) => a + (h.detail?.spent[x.id] ?? 0), 0));
      expect(x.rank).toBeGreaterThanOrEqual(1);
      if (x.bustedAt !== null) expect(x.bustedAt).toBeLessThanOrEqual(games);
    }
    // 順位 1 は持ち点が最も多い人
    const top = st.find((x) => x.rank === 1)!;
    expect(m.players.find((p) => p.id === top.id)!.chips).toBe(Math.max(...m.players.map((p) => p.chips)));
  });
});

describe('前払いクレジット（B-11）', () => {
  const finish = (g: GameState, rng: Rng) => {
    while (g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
    return g;
  };

  it('料金はクレジットから払い、使った分は次のゲームの持ち越しポットへ。最終ゲームでは使い残しが全部ポットに入る', () => {
    const rng = seededRng(31);
    let m = createMatch({ initialChips: 1000, bet: 100, maxGames: 2, prepaid: true }, [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}` })));
    expect(() => startGame(m, rng)).toThrow(GameError);
    m = buyCredit(m, 'p0', 3);
    expect(() => buyCredit(m, 'p0', 1)).toThrow(GameError); // 買えるのは 1 回だけ
    expect(() => buyCredit(m, 'p1', 6)).toThrow(GameError); // 持ち点の半分まで
    m = buyCredit(m, 'p1', 1);
    m = buyCredit(m, null, null); // p2 は時間切れで 0
    expect(m.credits).toEqual({ p0: 300, p1: 100, p2: 0 });
    expect(m.players.map((p) => p.chips)).toEqual([700, 900, 1000]);
    m = startGame(m, rng);
    let g = m.game!;
    const s0 = m.seatIds.indexOf('p0');
    const s2 = m.seatIds.indexOf('p2');
    g = run(g, [0, 1, 2, 3].map((k) => ({ type: 'peek', seat: s0, index: k }) as GameAction), rng);
    expect(g.seats[s0]!.credit).toBe(275);
    expect(g.seats[s0]!.stack).toBe(600); // 持ち点はベットの分だけ減る
    g = run(g, [0, 1, 2].map((k) => ({ type: 'peek', seat: s2, index: k }) as GameAction), rng);
    expect(() => apply(g, { type: 'peek', seat: s2, index: 3 }, rng)).toThrow('クレジットが足りない');
    g = finish(g, rng);
    m = settleGame({ ...m, game: g });
    expect(m.credits!.p0).toBe(275);
    expect(m.carry!.amount).toBe(25);
    // 最終ゲーム: 使い残し（275 ＋ 100）が持ち越しポットに入り、追加めくりはできない
    m = startGame(m, rng);
    expect(m.game!.carryIn).toBe(25 + 375);
    expect(m.credits).toEqual({ p0: 0, p1: 0, p2: 0 });
    expect(m.game!.extraPeeks).toBe(false);
  });

  it('脱落した人の使い残しは次のゲームの持ち越しポットへ。残り 1 人で終わったら、その人が全部受け取る', () => {
    const rng = seededRng(32);
    let m = createMatch({ initialChips: 1000, bet: 100, maxGames: 10, prepaid: true, headsUp: true }, [0, 1].map((i) => ({ id: `p${i}`, name: `P${i}` })));
    m = buyCredit(m, 'p0', 2);
    m = buyCredit(m, 'p1', 4);
    m = startGame(m, rng);
    const total = 2000;
    let g = finish(m.game!, rng);
    // p1 を脱落させる（失った分は p0 へ）
    const i1 = m.seatIds.indexOf('p1');
    const i0 = m.seatIds.indexOf('p0');
    g.result!.stacks[i0]! += g.result!.stacks[i1]!;
    g.result!.stacks[i1] = 0;
    m = settleGame({ ...m, game: g });
    expect(m.finished).toBe(true);
    expect(m.players.find((p) => p.id === 'p0')!.chips).toBe(total);
    expect(m.players.find((p) => p.id === 'p1')!.chips).toBe(0);
  });
});
