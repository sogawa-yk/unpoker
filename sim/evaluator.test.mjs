// 役判定の検証: 手作りケース + 5 枚組み合わせ総当たりの参照実装との突き合わせ + 7 枚の役の出現率
import assert from 'node:assert/strict';
import { evaluate, categoryOf, CATEGORY } from './evaluator.mjs';

const R = '23456789TJQKA', S = 'shdc';
const c = (s) => R.indexOf(s[0]) * 4 + S.indexOf(s[1]);
const h = (str) => str.split(' ').map(c);
const cat = (str) => CATEGORY[categoryOf(evaluate(h(str)))];

// 手作りケース
assert.equal(cat('As Ks Qs Js Ts 2d 3c'), 'ストレートフラッシュ');
assert.equal(cat('As 2s 3s 4s 5s Kd Kc'), 'ストレートフラッシュ');
assert.equal(cat('9h 9d 9s 9c 2d 3c 4h'), 'フォーカード');
assert.equal(cat('9h 9d 9s 2c 2d 3c 3h'), 'フルハウス');
assert.equal(cat('9h 9d 9s 2c 2d 2h 3h'), 'フルハウス');
assert.equal(cat('Ah 9h 7h 4h 2h Kd Kc'), 'フラッシュ');
assert.equal(cat('Ad 2c 3h 4s 5d Kd Qc'), 'ストレート');
assert.equal(cat('Td Jc Qh Ks Ad 2d 3c'), 'ストレート');
assert.equal(cat('7d 7c 7h Ks 2d 4d 9c'), 'スリーカード');
assert.equal(cat('7d 7c 2h 2s Kd Kh 9c'), 'ツーペア');
assert.equal(cat('7d 7c 2h 3s Jd Kh 9c'), 'ワンペア');
assert.equal(cat('7d 8c 2h 3s Jd Kh 9c'), 'ハイカード');
// 比較
assert.ok(evaluate(h('6d 2c 3h 4s 5d Kd Qc')) > evaluate(h('Ad 2c 3h 4s 5d Kd Qc')), '6 ハイストレート > 5 ハイ');
assert.ok(evaluate(h('Ad Ac Kh Ks 2d 3h 4c')) > evaluate(h('Ad Ac Qh Qs Kd 3h 4c')), 'AAKK > AAQQ');
assert.ok(evaluate(h('Ad Ac Qh Qs Kd 3h 4c')) > evaluate(h('Ad Ac Qh Qs Jd 3h 4c')), 'キッカー K > J');
assert.equal(evaluate(h('Ad Ac Qh Qs Kd 3h 4c')), evaluate(h('Ah As Qd Qc Kh 2h 5c')), '同じ役は同値');

// 参照実装: 21 通りの 5 枚の中から最強（5 枚専用の素朴な実装）
const eval5 = (cards) => {
  const rs = cards.map((x) => x >> 2).sort((a, b) => b - a);
  const flush = cards.every((x) => (x & 3) === (cards[0] & 3));
  const uniq = [...new Set(rs)];
  let straight = -1;
  if (uniq.length === 5) {
    if (rs[0] - rs[4] === 4) straight = rs[0];
    else if (rs.join() === '12,3,2,1,0') straight = 3;
  }
  const groups = uniq.map((r) => [rs.filter((x) => x === r).length, r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const ks = groups.map((g) => g[1]);
  const shape = groups.map((g) => g[0]).join('');
  let catv;
  if (straight >= 0 && flush) return [8, straight];
  if (shape === '41') catv = 7;
  else if (shape === '32') catv = 6;
  else if (flush) return [5, ...rs];
  else if (straight >= 0) return [4, straight];
  else if (shape === '311') catv = 3;
  else if (shape === '221') catv = 2;
  else if (shape === '2111') catv = 1;
  else catv = 0;
  return [catv, ...ks];
};
const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
};
const ref7 = (cards) => {
  let best = null;
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++) {
      const v = eval5(cards.filter((_, i) => i !== a && i !== b));
      if (!best || cmp(v, best) > 0) best = v;
    }
  return best;
};

let seed = 7;
const rand = Math.random; // LCG は偏りがあり出現率がずれたため標準乱数を使う
const draw7 = () => {
  const d = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d.slice(0, 7);
};

// 2 つの手の大小関係が参照実装と一致するか
for (let t = 0; t < 200000; t++) {
  const a = draw7(), b = draw7();
  const mine = Math.sign(evaluate(a) - evaluate(b));
  const ref = Math.sign(cmp(ref7(a), ref7(b)));
  assert.equal(mine, ref, `不一致: ${a} vs ${b}`);
  assert.equal(categoryOf(evaluate(a)), ref7(a)[0]);
}

// 7 枚の役の出現率（理論値と比較）
const theory = [17.41, 43.82, 23.5, 4.83, 4.62, 3.03, 2.6, 0.168, 0.0311];
const M = 1000000;
const cnt = new Array(9).fill(0);
for (let t = 0; t < M; t++) cnt[categoryOf(evaluate(draw7()))]++;
console.log('役        実測     理論');
cnt.forEach((x, i) => console.log(`${CATEGORY[i].padEnd(10)} ${(x / M * 100).toFixed(3)}%  ${theory[i]}%`));
console.log('OK: 手作りケース、参照実装との 20 万組比較に合格');
