// 時間切れのときの自動操作に使う簡易戦略（sim の smart 戦略）
import { rankOf, suitOf, type Card } from './cards.ts';

/** 手元に残す 2 枚の価値（盤面は見ない簡易評価） */
export function keepScore(a: Card, b: Card): number {
  const hi = Math.max(rankOf(a), rankOf(b));
  const lo = Math.min(rankOf(a), rankOf(b));
  if (hi === lo) return 100 + hi;
  let s = hi + lo / 2;
  if (suitOf(a) === suitOf(b)) s += 6;
  if (hi - lo <= 2) s += 3 - (hi - lo);
  return s;
}

/** 強い 2 枚（ペア、同じマーク、10 以上同士）ならまとめる */
export const strongKeep = (a: Card, b: Card): boolean =>
  rankOf(a) === rankOf(b) || suitOf(a) === suitOf(b) || Math.min(rankOf(a), rankOf(b)) >= 8;

/** めくった札（位置と中身）の中から、場に出す札の位置を選ぶ */
export function chooseBoardIndex(peeked: { index: number; card: Card }[]): number {
  let best = -Infinity;
  let pick = peeked[0]!.index;
  for (const p of peeked) {
    const kept = peeked.filter((q) => q !== p);
    // 残す札が 2 枚以上ある場合は、上位 2 枚の組の価値で比べる
    let v = -Infinity;
    for (let i = 0; i < kept.length; i++)
      for (let j = i + 1; j < kept.length; j++) v = Math.max(v, keepScore(kept[i]!.card, kept[j]!.card));
    if (v > best) {
      best = v;
      pick = p.index;
    }
  }
  return pick;
}

/** 既知の札（位置と中身）と未知の札の位置から 3 セットを作る */
export function arrangeSets(known: { index: number; card: Card }[], unknown: number[]): [number, number][] {
  const sets: [number, number][] = [];
  const k = [...known];
  const u = [...unknown];
  if (k.length >= 2 && strongKeep(k[0]!.card, k[1]!.card)) {
    sets.push([k.shift()!.index, k.shift()!.index]);
  }
  const rest = [...k.map((x) => x.index), ...u];
  while (rest.length) sets.push([rest.shift()!, rest.pop()!]);
  return sets;
}
