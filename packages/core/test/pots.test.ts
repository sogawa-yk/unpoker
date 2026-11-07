import { describe, expect, it } from 'vitest';
import { distributeLayers } from '../src/index.ts';

describe('distributeLayers', () => {
  it('rules.md B-3 の例: A がオールイン 120、B と C が 300、A が最強', () => {
    const out = distributeLayers({
      contrib: [120, 300, 300],
      eligibleLevel: [120, 300, 300],
      score: [3, 2, 1],
      tieOrder: [0, 1, 2],
    });
    expect(out).toEqual([360, 360, 0]);
  });

  it('同点は等分し、端数は席順の早い勝者へ', () => {
    const out = distributeLayers({ contrib: [100, 100, 101], eligibleLevel: [100, 100, 101], score: [5, 5, 1], tieOrder: [1, 2, 0] });
    // 0〜100 の段 300 を 0 と 1 で等分。100〜101 の段 1 は 2 だけが資格者
    expect(out).toEqual([150, 150, 1]);
    const odd = distributeLayers({ contrib: [1, 1, 1], eligibleLevel: [1, 1, 1], score: [5, 5, 1], tieOrder: [1, 0, 2] });
    expect(odd).toEqual([1, 2, 0]);
  });

  it('資格者のいない段は出した人へ返す', () => {
    // 非参加者（資格なし）が多く出している
    const out = distributeLayers({ contrib: [100, 200], eligibleLevel: [100, -1], score: [1, 9], tieOrder: [0, 1] });
    expect(out).toEqual([200, 100]);
  });
});
