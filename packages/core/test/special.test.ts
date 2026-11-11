import { describe, expect, it } from 'vitest';
import {
  apply,
  chooseSpecial,
  createMatch,
  dealSpecials,
  newGame,
  pendingSeats,
  seededRng,
  settleGame,
  startGame,
  suitOf,
  viewFor,
  GameError,
  SPECIAL_KINDS,
  type GameAction,
  type GameState,
  type PlayerStats,
  type Rng,
  type SpecialKind,
} from '../src/index.ts';

const players = (n: number, held: (SpecialKind | null)[] = []) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, chips: 1000, held: held[i] ?? null }));

function game(n: number, held: (SpecialKind | null)[], seed = 1, extraPeeks = true) {
  return newGame({ players: players(n, held), bet: 100, dealer: 0, specials: true, extraPeeks }, seededRng(seed));
}

/** 時間切れと演出の進行で、結果まで進める */
const finish = (g: GameState, rng: Rng) => {
  let steps = 0;
  while (g.phase !== 'result') {
    if (++steps > 300) throw new Error('進まない');
    g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
  }
  return g;
};

const peek3 = (g: GameState, seat: number, rng: Rng) => {
  for (const k of [0, 1, 2]) g = apply(g, { type: 'peek', seat, index: k }, rng);
  return g;
};

describe('特殊効果カード: ゲーム中の効果（B-10、暫定）', () => {
  it('1 組増やす: 9 枚で 4 組。山札が足りなければ使えない。使ったら手元から消え、全員に公開される', () => {
    const rng = seededRng(2);
    let g = game(3, ['extraSet']);
    g = apply(g, { type: 'special', seat: 0, kind: 'extraSet' }, rng);
    expect(g.seats[0]!.hand).toHaveLength(9);
    expect(viewFor(g, { kind: 'table' }).special!.used).toEqual([{ seat: 0, kind: 'extraSet' }]);
    expect(viewFor(g, { kind: 'seat', seat: 0 }).special!.mine).toBeNull();
    expect(() => apply(g, { type: 'special', seat: 0, kind: 'extraSet' }, rng)).toThrow(GameError);
    g = peek3(g, 0, rng);
    g = apply(g, { type: 'place', seat: 0, index: 0 }, rng);
    expect(() => apply(g, { type: 'arrange', seat: 0, sets: [[1, 2], [3, 4], [5, 6]] }, rng)).toThrow('セットは 4 つ');
    g = apply(g, { type: 'arrange', seat: 0, sets: [[1, 2], [3, 4], [5, 6], [7, 8]] }, rng);
    g = finish(g, rng);
    expect(g.result!.delta.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('今 2 組増やす: このゲームは 11 枚、次のゲームは 5 枚（2 組）。最終ゲームでは使えない', () => {
    const rng = seededRng(3);
    let m = createMatch({ initialChips: 1000, bet: 100, maxGames: 3, specialCards: true }, [0, 1, 2].map((i) => ({ id: `p${i}`, name: `P${i}` })), { p1: 'surge' });
    m = startGame(m, rng);
    const s1 = m.seatIds.indexOf('p1');
    let g = apply(m.game!, { type: 'special', seat: s1, kind: 'surge' }, rng);
    expect(g.seats[s1]!.hand).toHaveLength(11);
    g = finish(g, rng);
    m = settleGame({ ...m, game: g });
    expect(m.shrinkNext).toEqual(['p1']);
    m = startGame(m, rng);
    expect(m.game!.seats[m.seatIds.indexOf('p1')]!.hand).toHaveLength(5);
    const g2 = finish(m.game!, rng);
    expect(g2.result).not.toBeNull();
    // 最終ゲームでは使えない
    const last = game(3, ['surge'], 4, false);
    expect(() => apply(last, { type: 'special', seat: 0, kind: 'surge' }, rng)).toThrow('最終ゲーム');
  });

  it('札を入れ替える・マーク指定: 新しい札は本人だけが見え、外した札は戻らない', () => {
    const rng = seededRng(5);
    let g = game(3, ['reroll', 'suitReroll']);
    const before = g.seats[0]!.hand[4]!;
    g = apply(g, { type: 'special', seat: 0, kind: 'reroll', index: 4 }, rng);
    expect(g.seats[0]!.hand[4]).not.toBe(before);
    expect(g.deck).not.toContain(before);
    expect(viewFor(g, { kind: 'seat', seat: 0 }).seats[0]!.cards[4]).toBe(g.seats[0]!.hand[4]);
    expect(viewFor(g, { kind: 'seat', seat: 1 }).seats[0]!.cards[4]).toBeNull();
    expect(viewFor(g, { kind: 'table' }).seats[0]!.cards[4]).toBeNull();
    g = apply(g, { type: 'special', seat: 1, kind: 'suitReroll', index: 2, suit: 3 }, rng);
    expect(suitOf(g.seats[1]!.hand[2]!)).toBe(3);
    // 52 枚がそろっている（外した 2 枚を除く）
    const all = [...g.seats.flatMap((p) => p.hand), ...g.initialBoard, ...(g.hiddenBoard ?? []), ...g.deck];
    expect(new Set(all).size).toBe(50);
  });

  it('使用禁止: ほかの人はこのゲームで使えない', () => {
    const rng = seededRng(6);
    let g = game(3, ['ban', 'extraSet']);
    g = apply(g, { type: 'special', seat: 0, kind: 'ban' }, rng);
    expect(() => apply(g, { type: 'special', seat: 1, kind: 'extraSet' }, rng)).toThrow('使用禁止');
  });

  it('右回りに渡す: 全員が 1 枚選び、右隣へ。受け取った札は本人だけが見え、選ばない人は時間切れでランダム', () => {
    const rng = seededRng(7);
    let g = game(3, ['passRight']);
    for (let i = 0; i < 3; i++) {
      g = peek3(g, i, rng);
      g = apply(g, { type: 'place', seat: i, index: 0 }, rng);
    }
    const hands = g.seats.map((p) => [...p.hand]);
    expect(() => apply(g, { type: 'pass', seat: 0, index: 3 }, rng)).toThrow(GameError);
    g = apply(g, { type: 'special', seat: 0, kind: 'passRight' }, rng);
    expect(pendingSeats(g)).toEqual([0, 1, 2]);
    expect(() => apply(g, { type: 'pass', seat: 0, index: 0 }, rng)).toThrow('渡せない札'); // 場に出した札
    g = apply(g, { type: 'pass', seat: 0, index: 3 }, rng);
    g = apply(g, { type: 'pass', seat: 1, index: 5 }, rng);
    expect(viewFor(g, { kind: 'table' }).special!.passing!.picked).toEqual([true, true, false]);
    g = apply(g, { type: 'timeout' }, rng); // 席 2 はランダムに選び、組み方も自動
    const pick2 = hands[2]!.findIndex((c, k) => g.seats[2]!.hand[k] !== c);
    // 席 0 の 3 番 → 席 1 の 5 番、席 1 の 5 番 → 席 2、席 2 → 席 0 の 3 番
    expect(g.seats[1]!.hand[5]).toBe(hands[0]![3]);
    expect(g.seats[2]!.hand[pick2]).toBe(hands[1]![5]);
    expect(g.seats[0]!.hand[3]).toBe(hands[2]![pick2]);
    expect(viewFor(g, { kind: 'seat', seat: 1 }).seats[1]!.known).toContain(5);
  });

  it('チャレンジ無料と、どこからでも挑戦', () => {
    // 4 人で、2 位か 3 位の人が「どこからでも挑戦」を使い、最下位は見送る → チャレンジが起きる
    for (let seed = 1; seed < 60; seed++) {
      const rng = seededRng(seed);
      const held: (SpecialKind | null)[] = ['anyChallenge', 'anyChallenge', 'anyChallenge', 'anyChallenge'];
      let g = game(4, held, seed);
      while (g.phase !== 'declare' && g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
      if (g.phase !== 'declare') continue;
      const prov = g.provisional!;
      const mid = [0, 1, 2, 3].find((i) => !prov.firsts.includes(i) && !prov.lasts.includes(i));
      if (mid === undefined) continue;
      expect(() => apply(g, { type: 'special', seat: prov.firsts[0]!, kind: 'anyChallenge' }, rng)).toThrow('仮 1 位');
      g = apply(g, { type: 'special', seat: mid, kind: 'anyChallenge' }, rng);
      for (const i of prov.lasts) g = apply(g, { type: 'declare', seat: i, yes: false }, rng);
      expect(g.challenge!.declarers).toEqual([mid]);
      expect(g.seats[mid]!.challengeFee).toBe(100);
      // 強制参加の 1 位が「チャレンジ無料」を使えば、払った参加費が戻る
      const first = prov.firsts[0]!;
      if (g.phase === 'join') {
        const gg: GameState = { ...g, special: { ...g.special!, held: g.special!.held.map((h, i) => (i === first ? 'freeChallenge' : h)) } };
        const g2 = apply(gg, { type: 'special', seat: first, kind: 'freeChallenge' }, rng);
        expect(g2.seats[first]!.challengeFee).toBe(0);
        expect(g2.seats[first]!.stack).toBe(900);
      }
      return;
    }
    throw new Error('条件に合うゲームがなかった');
  });

  it('ナッツ 4 倍: 勝者がナッツなら、敗者 1 人あたり 3B', () => {
    for (let seed = 1; seed < 4000; seed++) {
      const rng = seededRng(seed);
      let g = game(3, ['nut4x', 'nut4x', 'nut4x'], seed);
      for (let i = 0; i < 3; i++) g = apply(g, { type: 'special', seat: i, kind: 'nut4x' }, rng);
      g = finish(g, rng);
      const r = g.result!;
      if (!r.nut) continue;
      const losers = [0, 1, 2].filter((i) => !r.winners.includes(i));
      for (const i of losers) expect(r.nutPaid[i]).toBe(Math.min(300, g.seats[i]!.stack));
      expect(r.delta.reduce((a, b) => a + b, 0)).toBe(0);
      return;
    }
    throw new Error('ナッツのゲームがなかった');
  });

  it('どのカードをランダムに使っても、持ち点の合計が保たれ、結果まで進む', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rng = seededRng(seed);
      const n = 2 + (seed % 3);
      const held = Array.from({ length: n }, () => SPECIAL_KINDS[Math.floor(rng() * SPECIAL_KINDS.length)]!);
      let g = game(n, held, seed);
      let steps = 0;
      while (g.phase !== 'result') {
        if (++steps > 400) throw new Error('進まない');
        // 持っている人は、使えそうなら使ってみる（失敗したら無視）
        for (let i = 0; i < n; i++) {
          const k = g.special!.held[i];
          if (!k || rng() > 0.3) continue;
          try {
            g = apply(g, { type: 'special', seat: i, kind: k, index: Math.floor(rng() * g.seats[i]!.hand.length), suit: Math.floor(rng() * 4) } as GameAction, rng);
          } catch (e) {
            if (!(e instanceof GameError)) throw e;
          }
        }
        g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
      }
      expect(g.result!.delta.reduce((a, b) => a + b, 0)).toBe(0);
      expect(g.result!.stacks.every((x) => x >= 0)).toBe(true);
    }
  });
});

describe('特殊効果カード: 対局の始めに配る（B-10）', () => {
  const stats = (over: Partial<PlayerStats>[]): PlayerStats[] =>
    over.map((o, i) => ({
      id: `p${i}`,
      rank: i + 1,
      players: over.length,
      bustedAt: null,
      wins: 1,
      challengeLosses: 0,
      reversed: 0,
      comebacks: 0,
      nutLosses: 0,
      boardOnly: 0,
      spent: 0,
      games: 3,
      ...o,
    }));

  it('条件 2〜3 個で、条件 1 つにつき 1 枚。前の対局にいない人には配らない', () => {
    const counts: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      let m = createMatch({ initialChips: 1000, bet: 100, maxGames: 5, specialCards: true }, [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}` })));
      m = dealSpecials(m, stats([{}, {}, { challengeLosses: 2 }]), seededRng(seed)); // p3 は前の対局にいない
      counts.push(m.specialDeals!.length);
      expect(m.specialDeals!.length).toBeLessThanOrEqual(3);
      for (const d of m.specialDeals!) {
        expect(d.candidates).toContain(d.recipient);
        expect(d.recipient).not.toBe('p3');
      }
      const held = Object.values(m.specials!).filter(Boolean).length;
      expect(held + m.specialOffers!.length).toBe(m.specialDeals!.length);
    }
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(2);
  });

  it('持っている人がまた当たったら、どちらを持つか選ぶ。選ぶまで最初のゲームは始まらない', () => {
    const rng = seededRng(9);
    let m = createMatch({ initialChips: 1000, bet: 100, maxGames: 5, specialCards: true }, [0, 1].map((i) => ({ id: `p${i}`, name: `P${i}` })), { p0: 'ban', p1: 'ban' });
    for (let seed = 1; ; seed++) {
      const d = dealSpecials(m, stats([{}, {}]), seededRng(seed));
      if (d.specialOffers!.length) {
        m = d;
        break;
      }
    }
    expect(() => startGame(m, rng)).toThrow(GameError);
    const o = m.specialOffers![0]!;
    m = chooseSpecial(m, o.playerId, true);
    if (!m.specialOffers!.length) expect(m.specials![o.playerId]).toBeDefined();
    m = chooseSpecial({ ...m, specialOffers: m.specialOffers!.length ? m.specialOffers : [{ ...o }] }, null, false);
    expect(m.specialOffers).toEqual([]);
    expect(startGame(m, rng).game).not.toBeNull();
  });
});
