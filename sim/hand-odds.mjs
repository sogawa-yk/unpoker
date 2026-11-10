// 役ごとの勝率: 自分の 3 セットで一番強い役（仮順位のときの役）ごとに、仮 1 位になる率と、チャレンジ後に最終的に勝つ率
// 使い方: node sim/hand-odds.mjs [ゲーム数=40000] [seed=7]
// 全員 smart 戦略で 3 枚めくり。チャレンジは採用ルール（最下位だけが宣言、1 位は強制参加）で、全員が期待収支で判断する
import { CATEGORY, categoryOf } from './evaluator.mjs';
import { setSeed, shares } from './game.mjs';
import { RULES, analyzeGame, decide } from './challenge.mjs';

const N = Number(process.argv[2] ?? 40000);
const seed = Number(process.argv[3] ?? 7);
for (const n of [3, 4]) {
  setSeed(seed);
  const acc = CATEGORY.map(() => ({ c: 0, first: 0, win: 0, keep: 0, keepN: 0 }));
  for (let t = 0; t < N; t++) {
    const g = analyzeGame(n);
    const S = decide(g, RULES.lastPay);
    const all = g.base.map((_, i) => i);
    const prov = shares(g.base, all);
    let fin;
    if (S.size === 0) fin = prov;
    else {
      const cand = [...g.firsts, ...S];
      fin = new Map();
      for (const sc of g.outcomes) for (const [i, v] of shares(sc, cand)) fin.set(i, (fin.get(i) ?? 0) + v / g.outcomes.length);
    }
    for (const i of all) {
      const a = acc[categoryOf(g.base[i])];
      a.c++;
      a.first += prov.get(i) ?? 0;
      a.win += fin.get(i) ?? 0;
      if (prov.has(i)) { a.keepN += prov.get(i); a.keep += fin.get(i) ?? 0; }
    }
  }
  const tot = acc.reduce((s, a) => s + a.c, 0);
  console.log(`\n=== ${n} 人・${N} ゲーム（公平な勝率 ${(100 / n).toFixed(1)}%） ===`);
  console.log('自分の一番強い役 | 出る割合 | 仮1位になる率 | 最終的に勝つ率 | 仮1位のとき守り切る率');
  acc.forEach((a, k) => {
    if (!a.c) return;
    const p = (x) => `${(x * 100).toFixed(1)}%`;
    console.log([CATEGORY[k], p(a.c / tot), p(a.first / a.c), p(a.win / a.c), a.keepN ? p(a.keep / a.keepN) : '-'].join(' | '));
  });
}
