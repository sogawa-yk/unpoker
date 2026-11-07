// 画面用の小さな計算（core の役判定を使う）
import { evaluate, handName, type Card, type GameView, type HandScore, type SeatView } from '@unpoker/core';

/** 見えている札だけで、その席が今作れている一番強い役（公開フェーズの途中経過。ux.md 3 章） */
export function visibleBest(seat: SeatView, board: (Card | null)[]): { score: HandScore; name: string } | null {
  const b = board.filter((c): c is Card => c !== null);
  if (b.length < 5 || !seat.sets) return null;
  let best = -1;
  for (const [x, y] of seat.sets) {
    const cx = seat.cards[x];
    const cy = seat.cards[y];
    const known = [cx, cy].filter((c): c is Card => c !== null && c !== undefined);
    // めくれていない札は数えない（場札 5 枚＋見えている札）
    const v = evaluate([...b, ...known]);
    if (v > best) best = v;
  }
  return best < 0 ? null : { score: best, name: handName(best) };
}

/** 仮順位（1 始まり。同率は上位側の順位） */
export function provisionalRank(g: GameView, seat: number): number | null {
  const p = g.provisional;
  if (!p) return null;
  return 1 + p.scores.filter((s) => s > p.scores[seat]!).length;
}

export const finalRank = (g: GameView, seat: number): number | null => {
  const r = g.result;
  if (!r) return null;
  return 1 + r.scores.filter((s) => s > r.scores[seat]!).length;
};

export const PHASE_LABEL: Record<GameView['phase'], string> = {
  placement: '配置',
  boardReveal: '場札を公開',
  reveal: '公開',
  ranking: '仮順位',
  declare: 'チャレンジ',
  join: 'チャレンジ',
  swap: '場札の入れ替え',
  result: '結果',
};

export interface HandOdds {
  /** 今の時点で確定している役（見えている札だけで作れる役） */
  current: { score: HandScore; name: string };
  /** 伏せ札がめくれたときに、最終的にそれぞれの役になる確率（今の役より強いものだけ、確率の高い順） */
  chances: { category: number; name: string; p: number }[];
  /** 伏せ札が残っていない */
  settled: boolean;
}

/**
 * 公開フェーズの見込み（テーブル用）。テーブルから見えない札は、見えていない札の山からランダムに引いたと仮定して
 * モンテカルロで数える。テーブルが知らない情報（持ち主だけが知る札）は使わない
 */
export function revealOdds(seat: SeatView, board: (Card | null)[], visible: Set<Card>, samples = 400): HandOdds | null {
  const b = board.filter((c): c is Card => c !== null);
  if (b.length < 5 || !seat.sets) return null;
  const cur = visibleBest(seat, board)!;
  const hidden = seat.sets.flat().filter((k) => seat.cards[k] === null);
  if (hidden.length === 0) return { current: cur, chances: [], settled: true };
  const pool: Card[] = [];
  for (let c = 0; c < 52; c++) if (!visible.has(c)) pool.push(c);
  // 同じ局面では同じ結果になるよう、見えている札から種を作る
  let seed = [...visible].reduce((a, c) => (a * 31 + c + 7) | 0, hidden.length);
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const counts = new Array<number>(9).fill(0);
  const cards = [...seat.cards];
  for (let i = 0; i < samples; i++) {
    // 部分的なシャッフルで hidden.length 枚を引く
    for (let j = 0; j < hidden.length; j++) {
      const r = j + Math.floor(rnd() * (pool.length - j));
      [pool[j], pool[r]] = [pool[r]!, pool[j]!];
      cards[hidden[j]!] = pool[j]!;
    }
    let best = 0;
    for (const [x, y] of seat.sets) {
      const v = evaluate([...b, cards[x]!, cards[y]!]);
      if (v > best) best = v;
    }
    counts[Math.floor(best / 16 ** 5)]!++;
  }
  const curCat = Math.floor(cur.score / 16 ** 5);
  const chances = counts
    .map((n, category) => ({ category, name: handName(category * 16 ** 5), p: n / samples }))
    .filter((c) => c.category > curCat && c.p >= 0.03)
    .sort((a, b) => b.category - a.category);
  return { current: cur, chances, settled: false };
}

/**
 * 場札入れ替えのルーレット（減速して止まるまで）: 光が場札を 1 枚ずつ進み、だんだん遅くなって target で止まる。
 * start は今光っている位置（まだ光っていなければ -1）。返り値は光を動かす時刻（ミリ秒、減速の開始から）と、そのとき光る位置。
 * 最後の位置は必ず target
 */
export function rouletteSchedule(target: number, slots = 5, laps = 2, start = -1, base = 85): { at: number; index: number }[] {
  // 少なくとも laps 周してから target で止まるよう、進む歩数を決める
  const mod = (x: number) => ((x % slots) + slots) % slots;
  const n = laps * slots + mod(target - start - 1) + 1;
  const out: { at: number; index: number }[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    t += base + (i / (n - 1)) ** 2.4 * 420;
    out.push({ at: t, index: mod(start + 1 + i) });
  }
  return out;
}

/** ルーレットが回り続けている間、光が 1 枚進む間隔（ミリ秒） */
export const ROULETTE_SPIN_MS = 85;
