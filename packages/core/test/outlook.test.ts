import { describe, expect, it } from 'vitest';
import { apply, challengeOutlook, newGame, pendingSeats, seededRng, viewFor, type GameState } from '../src/index.ts';

/** チャレンジが起きるまで時間切れで進め、宣言する。起きなければ null */
function toSwap(seed: number, n: number): GameState | null {
  const rng = seededRng(seed);
  let g = newGame({ players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0 }, rng);
  while (g.phase !== 'declare' && g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
  if (g.phase !== 'declare') return null;
  for (const i of g.provisional!.lasts) g = apply(g, { type: 'declare', seat: i, yes: true }, rng);
  if (g.phase === 'join') for (const i of g.challenge!.optional) g = apply(g, { type: 'join', seat: i, yes: seed % 2 === 0 }, rng);
  return g.phase === 'swap' ? g : null;
}

describe('チャレンジ中の勝ち筋（B-9）', () => {
  it('参加者が決まる前（宣言・便乗の場面）には送らない', () => {
    const rng = seededRng(1);
    let g = newGame({ players: [0, 1, 2].map((i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0 }, rng);
    while (g.phase !== 'swap' && g.phase !== 'result') {
      expect(viewFor(g, { kind: 'table' }).outlook).toBeNull();
      if (g.phase === 'declare') {
        for (const i of g.provisional!.lasts) g = apply(g, { type: 'declare', seat: i, yes: true }, rng);
        continue;
      }
      g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
    }
  });

  it('見込みの合計は 100%。外れる札が決まったら、補充の札の色分けが実際の勝者と一致する', () => {
    let checked = 0;
    for (let seed = 1; seed <= 80 && checked < 25; seed++) {
      for (const n of [2, 3, 4]) {
        let g = toSwap(seed * 7 + n, n);
        if (!g) continue;
        const before = challengeOutlook(g)!;
        expect(before.afterSwap).toBeNull();
        const sum = Object.values(before.overall).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1, 9);
        for (const x of before.byIndex) expect(Object.values(x.win).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
        // 回して止める
        const roller = g.challenge!.roller!;
        g = apply(g, { type: 'roulette', seat: roller, cmd: 'start' }, seededRng(seed));
        g = apply(g, { type: 'roulette', seat: roller, cmd: 'stop' }, seededRng(seed));
        const after = challengeOutlook(g)!;
        const sw = g.challenge!.swap!;
        expect(after.afterSwap!.index).toBe(sw.index);
        // 外れる札が決まる前の、その位置の見込みと同じ
        expect(after.afterSwap!.win).toEqual(before.byIndex[sw.index]!.win);
        // 色分けの札の合計は、山札の残り（引いた札を含む）
        const cards = after.afterSwap!.groups.flatMap((x) => x.cards);
        expect(cards.length).toBe(g.deck.length + 1);
        expect(new Set(cards)).toEqual(new Set([sw.added, ...g.deck]));
        // 引いた札のグループの勝者が、結果の勝者
        g = apply(g, { type: 'advance' }, seededRng(seed));
        const grp = after.afterSwap!.groups.find((x) => x.cards.includes(sw.added))!;
        expect(grp.winners).toEqual(g.result!.winners);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(25);
  });
});
