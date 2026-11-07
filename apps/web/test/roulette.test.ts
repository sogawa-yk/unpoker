import { describe, expect, it } from 'vitest';
import { rouletteSchedule } from '../src/game.ts';

describe('場札入れ替えのルーレット', () => {
  it('どこから減速を始めても、最後に光る札が燃える札と一致する', () => {
    for (let start = -1; start < 5; start++)
      for (let target = 0; target < 5; target++) {
        const s = rouletteSchedule(target, 5, 2, start);
        expect(s[s.length - 1]!.index).toBe(target);
        // 今の位置の次から、1 枚ずつ順に進む
        expect(s[0]!.index).toBe((start + 1 + 5) % 5);
        s.forEach((x, i) => i > 0 && expect(x.index).toBe((s[i - 1]!.index + 1) % 5));
        // 少なくとも 2 周する
        expect(s.length).toBeGreaterThanOrEqual(10);
        // だんだん遅くなる
        const gaps = s.map((x, i) => x.at - (s[i - 1]?.at ?? 0));
        expect(gaps[gaps.length - 1]!).toBeGreaterThan(gaps[1]!);
      }
  });
});
