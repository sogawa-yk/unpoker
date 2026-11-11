import { describe, expect, it } from 'vitest';
import { apply, bestSet, newGame, seededRng, viewFor, type GameAction, type GameState } from '@unpoker/core';
import { carryNext, challengeHands, potNow, shownBoard } from '../src/game.ts';

/** 全員が 3 枚めくって組み、最下位が宣言、便乗できる人は乗る。ルーレットを止めた直後まで進める */
function toSwapStopped(seed: number, n = 4): GameState {
  const rng = seededRng(seed);
  let g = newGame({ players: [...Array(n)].map((_, i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0 }, rng);
  const run = (a: GameAction) => (g = apply(g, a, rng));
  for (let i = 0; i < n; i++) {
    for (const k of [0, 1, 2]) run({ type: 'peek', seat: i, index: k });
    run({ type: 'place', seat: i, index: 0 });
    run({ type: 'arrange', seat: i, sets: [[1, 2], [3, 4], [5, 6]] });
  }
  run({ type: 'advance' });
  while (g.phase === 'reveal') {
    const p = g.seats[g.revealTurn]!;
    run({ type: 'flip', seat: g.revealTurn, index: [1, 2, 3, 4, 5, 6].find((k) => !p.revealed.includes(k))! });
  }
  run({ type: 'advance' });
  for (const i of g.provisional!.lasts) if (g.phase === 'declare') run({ type: 'declare', seat: i, yes: true });
  if (g.phase === 'join') for (const i of g.challenge!.optional) run({ type: 'join', seat: i, yes: true });
  run({ type: 'roulette', seat: g.challenge!.roller!, cmd: 'start' });
  run({ type: 'roulette', seat: g.challenge!.roller!, cmd: 'stop' });
  return g;
}

describe('チャレンジ中の表示', () => {
  it('入れ替えの演出が新しい札をめくるまでは、入れ替える前の場札で役を出す', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = toSwapStopped(seed);
      const v = viewFor(g, { kind: 'seat', seat: 0 });
      const sw = v.challenge!.swap!;
      const before = shownBoard(v, false);
      const after = shownBoard(v, true);
      expect(before[sw.index]).toBe(sw.removed);
      expect(after[sw.index]).toBe(sw.added);
      // 役は core の判定と一致し、参加者だけが並ぶ
      const rows = challengeHands(v, after);
      const ch = v.challenge!;
      expect(new Set(rows.map((r) => r.seat))).toEqual(new Set([...ch.declarers, ...ch.forced, ...ch.joiners]));
      for (const r of rows) {
        const sets = g.seats[r.seat]!.sets!.map(([a, b]) => [g.seats[r.seat]!.hand[a]!, g.seats[r.seat]!.hand[b]!] as [number, number]);
        expect(r.score).toBe(bestSet(sets, after).score);
      }
      // 強い順で、先頭が優勢
      expect(rows[0]!.leader).toBe(true);
      rows.forEach((r, i) => i > 0 && expect(r.score).toBeLessThanOrEqual(rows[i - 1]!.score));
    }
  });

  it('現在のポットは基本ベットと参加費の合計、次への持ち越しは追加めくりと相談の料金', () => {
    const g = toSwapStopped(3);
    const v = viewFor(g, { kind: 'table' });
    const fees = g.seats.reduce((a, s) => a + s.challengeFee, 0);
    expect(potNow(v)).toBe(400 + fees);
    expect(carryNext(v)).toBe(0);
  });
});
