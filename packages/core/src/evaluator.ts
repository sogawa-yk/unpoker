// 5〜7 枚から最強 5 枚の役を数値化する。値が大きいほど強い（sim/evaluator.mjs の移植）
import type { Card } from './cards.ts';

export const CATEGORY_NAMES = [
  'ハイカード',
  'ワンペア',
  'ツーペア',
  'スリーカード',
  'ストレート',
  'フラッシュ',
  'フルハウス',
  'フォーカード',
  'ストレートフラッシュ',
] as const;

export type HandScore = number;

const BASE = 16 ** 5;

const pack = (cat: number, ks: number[]): HandScore => {
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 16 + (ks[i] ?? 0);
  return v;
};

export const categoryOf = (score: HandScore): number => Math.floor(score / BASE);

export function handName(score: HandScore): string {
  const cat = categoryOf(score);
  if (cat === 8 && Math.floor(score / 16 ** 4) % 16 === 12) return 'ロイヤルストレートフラッシュ';
  return CATEGORY_NAMES[cat] ?? '不明';
}

// 13 ビットの rank マスクから最も高いストレートの最上位 rank を返す（無ければ -1）
function straightTop(mask: number): number {
  for (let top = 12; top >= 4; top--) {
    const m = 0b11111 << (top - 4);
    if ((mask & m) === m) return top;
  }
  if ((mask & 0b1000000001111) === 0b1000000001111) return 3; // A-2-3-4-5
  return -1;
}

export function evaluate(cards: readonly Card[]): HandScore {
  const cnt = new Array<number>(13).fill(0);
  const suitMask = [0, 0, 0, 0];
  const suitCnt = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) {
    const r = c >> 2;
    const s = c & 3;
    cnt[r]!++;
    suitMask[s]! |= 1 << r;
    suitCnt[s]!++;
    mask |= 1 << r;
  }

  let flush: HandScore | undefined;
  for (let s = 0; s < 4; s++) {
    if (suitCnt[s]! >= 5) {
      const sf = straightTop(suitMask[s]!);
      if (sf >= 0) return pack(8, [sf]);
      const ks: number[] = [];
      for (let r = 12; r >= 0 && ks.length < 5; r--) if (suitMask[s]! & (1 << r)) ks.push(r);
      flush = pack(5, ks);
      break;
    }
  }

  const quads: number[] = [];
  const trips: number[] = [];
  const pairs: number[] = [];
  const singles: number[] = [];
  for (let r = 12; r >= 0; r--) {
    const n = cnt[r]!;
    if (n === 4) quads.push(r);
    else if (n === 3) trips.push(r);
    else if (n === 2) pairs.push(r);
    else if (n === 1) singles.push(r);
  }
  const kickers = (exclude: number[], count: number): number[] => {
    const ks: number[] = [];
    for (let r = 12; r >= 0 && ks.length < count; r--) if (!exclude.includes(r) && cnt[r]! > 0) ks.push(r);
    return ks;
  };

  if (quads.length) return pack(7, [quads[0]!, ...kickers([quads[0]!], 1)]);
  if (trips.length && (trips.length >= 2 || pairs.length)) {
    return pack(6, [trips[0]!, Math.max(trips[1] ?? -1, pairs[0] ?? -1)]);
  }
  if (flush !== undefined) return flush;
  const st = straightTop(mask);
  if (st >= 0) return pack(4, [st]);
  if (trips.length) return pack(3, [trips[0]!, ...kickers([trips[0]!], 2)]);
  if (pairs.length >= 2) return pack(2, [pairs[0]!, pairs[1]!, ...kickers([pairs[0]!, pairs[1]!], 1)]);
  if (pairs.length === 1) return pack(1, [pairs[0]!, ...kickers([pairs[0]!], 3)]);
  return pack(0, singles.slice(0, 5));
}

/** 3 セットのうち最強のセットの値と、その番号 */
export function bestSet(sets: readonly (readonly [Card, Card])[], board: readonly Card[]): { score: HandScore; index: number } {
  let score = -1;
  let index = 0;
  sets.forEach((s, i) => {
    const v = evaluate([...board, s[0], s[1]]);
    if (v > score) {
      score = v;
      index = i;
    }
  });
  return { score, index };
}

/** 場札 5 枚に対して、場以外の全カードから作れる最強の値（ナッツ判定用。B-4） */
export function nutScore(board: readonly Card[]): HandScore {
  const used = new Set(board);
  const rest: Card[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  let best = 0;
  const seven = [...board, 0, 0];
  for (let i = 0; i < rest.length; i++) {
    seven[5] = rest[i]!;
    for (let j = i + 1; j < rest.length; j++) {
      seven[6] = rest[j]!;
      const v = evaluate(seven);
      if (v > best) best = v;
    }
  }
  return best;
}
