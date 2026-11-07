import { describe, expect, it } from 'vitest';
import { categoryOf, evaluate, handName, nutScore, parseCards, seededRng, shuffle, fullDeck } from '../src/index.ts';
// @ts-expect-error: 型定義のない検証済みの JS 実装（sim/evaluator.test.mjs で参照実装と照合済み）
import { evaluate as simEvaluate } from '../../../sim/evaluator.mjs';

const name = (s: string) => handName(evaluate(parseCards(s)));

describe('evaluate', () => {
  it('役の名前', () => {
    expect(name('As Ks Qs Js Ts 2d 3c')).toBe('ロイヤルストレートフラッシュ');
    expect(name('As 2s 3s 4s 5s Kd Kc')).toBe('ストレートフラッシュ');
    expect(name('9h 9d 9s 9c 2d 3c 4h')).toBe('フォーカード');
    expect(name('9h 9d 9s 2c 2d 2h 3h')).toBe('フルハウス');
    expect(name('Ah 9h 7h 4h 2h Kd Kc')).toBe('フラッシュ');
    expect(name('Ad 2c 3h 4s 5d Kd Qc')).toBe('ストレート');
    expect(name('7d 7c 7h Ks 2d 4d 9c')).toBe('スリーカード');
    expect(name('7d 7c 2h 2s Kd Kh 9c')).toBe('ツーペア');
    expect(name('7d 7c 2h 3s Jd Kh 9c')).toBe('ワンペア');
    expect(name('7d 8c 2h 3s Jd Kh 9c')).toBe('ハイカード');
  });

  it('大小関係', () => {
    const v = (s: string) => evaluate(parseCards(s));
    expect(v('6d 2c 3h 4s 5d Kd Qc')).toBeGreaterThan(v('Ad 2c 3h 4s 5d Kd Qc'));
    expect(v('Ad Ac Kh Ks 2d 3h 4c')).toBeGreaterThan(v('Ad Ac Qh Qs Kd 3h 4c'));
    expect(v('Ad Ac Qh Qs Kd 3h 4c')).toBe(v('Ah As Qd Qc Kh 2h 5c'));
  });

  it('シミュレーターの実装（参照実装と照合済み）と 10 万組で一致する', () => {
    const rng = seededRng(99);
    for (let t = 0; t < 100000; t++) {
      const cards = shuffle(fullDeck(), rng).slice(0, 7);
      expect(evaluate(cards)).toBe(simEvaluate(cards));
    }
  });

  it('ナッツ: ロイヤルが作れる場ならロイヤル', () => {
    const board = parseCards('As Ks Qs 2d 7c');
    expect(handName(nutScore(board))).toBe('ロイヤルストレートフラッシュ');
    expect(categoryOf(nutScore(parseCards('2c 3d 8h 9s Kc')))).toBe(3); // ペアもストレートもフラッシュも作れない場はスリーカードが最強
  });
});
