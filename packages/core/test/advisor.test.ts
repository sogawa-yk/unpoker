import { describe, expect, it } from 'vitest';
import {
  apply,
  newGame,
  pendingSeats,
  seededRng,
  viewFor,
  type ChallengeAdvice,
  type GameAction,
  type GameState,
  type PlacementAdvice,
  type Rng,
} from '../src/index.ts';

const run = (g: GameState, actions: GameAction[], rng: Rng) => actions.reduce((s, a) => apply(s, a, rng), g);
const peek3 = (seat: number) => [0, 1, 2].map((k) => ({ type: 'peek', seat, index: k }) as GameAction);

/** 宣言フェーズまで進める（最下位に持ち点が残る配札が出るまで種を変える） */
function toDeclare(n: number): { g: GameState; rng: Rng } {
  for (let seed = 1; seed < 200; seed++) {
    const rng = seededRng(seed);
    let g = newGame({ players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0 }, rng);
    while (g.phase !== 'declare' && g.phase !== 'result') g = apply(g, pendingSeats(g).length ? { type: 'timeout' } : { type: 'advance' }, rng);
    if (g.phase === 'declare') return { g, rng };
  }
  throw new Error('宣言フェーズにならない');
}

describe('AI 相談', () => {
  it('配置: 場に出す札と組み方を答え、料金 0.1B は持ち越しへ。中身は本人だけが見る', () => {
    const rng = seededRng(21);
    let g = newGame({ players: [0, 1, 2, 3].map((i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0 }, rng);
    expect(() => apply(g, { type: 'consult', seat: 0 }, rng)).toThrow('相談できる場面ではない');
    g = run(g, peek3(0), rng);
    const t0 = Date.now();
    g = apply(g, { type: 'consult', seat: 0 }, rng);
    const ms = Date.now() - t0;
    const p = g.seats[0]!;
    expect(p.stack).toBe(900 - 10);
    expect(p.adviceFee).toBe(10);
    const a = p.advice[0]!.advice as PlacementAdvice;
    expect(a.topic).toBe('place');
    expect(a.candidates).toHaveLength(3);
    expect([0, 1, 2]).toContain(a.boardIndex);
    expect(a.sets.flat().sort()).toEqual([0, 1, 2, 3, 4, 5, 6].filter((k) => k !== a.boardIndex));
    expect(a.win).toBeGreaterThan(0);
    expect(a.win).toBeLessThanOrEqual(1);
    expect(a.peekWin).not.toBeNull();
    expect(ms).toBeLessThan(3000);
    // 同じ判断で二度は払わない
    expect(() => apply(g, { type: 'consult', seat: 0 }, rng)).toThrow('もう相談した');
    // 相談したことは公開、中身は本人だけ
    expect(viewFor(g, { kind: 'table' }).seats[0]!.consulted).toEqual(['place']);
    expect(viewFor(g, { kind: 'table' }).seats[0]!.advice).toEqual([]);
    expect(viewFor(g, { kind: 'seat', seat: 1 }).seats[0]!.advice).toEqual([]);
    expect(viewFor(g, { kind: 'seat', seat: 0 }).seats[0]!.advice).toHaveLength(1);
    // 追加でめくれば、別の判断として相談できる
    g = apply(g, { type: 'peek', seat: 0, index: 3 }, rng);
    g = apply(g, { type: 'consult', seat: 0 }, rng);
    expect(g.seats[0]!.advice).toHaveLength(2);
    // 場に出した後は「組み方」の相談
    g = apply(g, { type: 'place', seat: 0, index: 1 }, rng);
    g = apply(g, { type: 'consult', seat: 0 }, rng);
    const arr = g.seats[0]!.advice[2]!.advice as PlacementAdvice;
    expect(arr.topic).toBe('arrange');
    expect(arr.boardIndex).toBe(1);
    expect(arr.peekWin).toBeNull();
    expect(arr.sets.flat().sort()).toEqual([0, 2, 3, 4, 5, 6]);
  });

  it('チャレンジ: 宣言する／しないの勝率と期待収支を、入れ替えの全パターンから出す', () => {
    const { g, rng } = toDeclare(4);
    const me = g.provisional!.lasts[0]!;
    const t0 = Date.now();
    const g2 = apply(g, { type: 'consult', seat: me }, rng);
    const ms = Date.now() - t0;
    expect(g2.seats[me]!.stack).toBe(g.seats[me]!.stack - 25);
    const a = g2.seats[me]!.advice[0]!.advice as ChallengeAdvice;
    expect(a.topic).toBe('declare');
    // 宣言しなければ必ず負け（チャレンジなしで仮 1 位が勝つ）
    expect(a.no.win).toBe(0);
    expect(a.no.scenarios).toHaveLength(1);
    expect(a.yes.win).toBeGreaterThan(0);
    expect(a.yes.win).toBeLessThan(1);
    // 他の 2 人（仮 2 位・3 位）の乗る・乗らないの 4 通り
    const deciders = [0, 1, 2, 3].filter((i) => i !== me && !g.provisional!.firsts.includes(i));
    expect(a.yes.scenarios).toHaveLength(2 ** deciders.length);
    expect(a.recommend).toBe(a.yes.ev > a.no.ev);
    expect(ms).toBeLessThan(3000);
    // 相談しても進行は変わらない
    expect(g2.phase).toBe('declare');
    expect(() => apply(g2, { type: 'consult', seat: me }, rng)).toThrow('もう相談した');
  });

  it('便乗: 乗る／乗らないを、他の人の判断ごとに出す。相談料は次のゲームへ持ち越す', () => {
    let found: { g: GameState; rng: Rng } | null = null;
    for (let n = 0; n < 30 && !found; n++) {
      const { g, rng } = toDeclare(4);
      const lasts = g.provisional!.lasts;
      let h = g;
      for (const i of lasts) h = apply(h, { type: 'declare', seat: i, yes: true }, rng);
      if (h.phase === 'join') found = { g: h, rng };
      break;
    }
    expect(found).not.toBeNull();
    const { g, rng } = found!;
    const me = g.challenge!.optional[0]!;
    let h = apply(g, { type: 'consult', seat: me }, rng);
    const a = h.seats[me]!.advice[0]!.advice as ChallengeAdvice;
    expect(a.topic).toBe('join');
    expect(a.yes.scenarios).toHaveLength(2 ** (g.challenge!.optional.length - 1));
    while (h.phase !== 'result') h = apply(h, pendingSeats(h).length ? { type: 'timeout' } : { type: 'advance' }, rng);
    expect(h.result!.carryOut).toBe(25);
    expect(h.result!.delta.reduce((x, y) => x + y, 0)).toBe(h.carryIn - h.result!.carryOut);
  });

  it('最終ゲームでは相談できない', () => {
    const rng = seededRng(3);
    let g = newGame({ players: [0, 1, 2].map((i) => ({ id: `p${i}`, chips: 1000 })), bet: 100, dealer: 0, extraPeeks: false }, rng);
    g = run(g, peek3(0), rng);
    expect(() => apply(g, { type: 'consult', seat: 0 }, rng)).toThrow('このゲームでは相談できない');
  });
});
