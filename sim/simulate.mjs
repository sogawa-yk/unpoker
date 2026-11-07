// unpoker 戦略シミュレーション
// 使い方: node sim/simulate.mjs [ゲーム数=20000] [seed=1]
import { categoryOf, CATEGORY, nutScore } from './evaluator.mjs';
import { setSeed, STRATS, deal, bestOf, shares, challengeOdds } from './game.mjs';

const N = Number(process.argv[2] ?? 20000);
setSeed(Number(process.argv[3] ?? 1));

// ---- 実験 ----

const pct = (x) => (x * 100).toFixed(1) + '%';
const quantile = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function strategyExperiment(n) {
  // 席 0 だけ戦略を変え、他は smart。仮 1 位の取り分を比べる
  const res = {};
  for (const name of Object.keys(STRATS)) {
    let win = 0;
    for (let g = 0; g < N; g++) {
      const strategies = [name, ...Array(n - 1).fill('smart')];
      const { players, board } = deal(n, strategies);
      const scores = players.map((p) => bestOf(p.sets, board));
      const sh = shares(scores, players.map((_, i) => i));
      win += sh.get(0) ?? 0;
    }
    res[name] = win / N;
  }
  return res;
}

function challengeExperiment(n) {
  const byRank = {}; // 仮順位（1 始まり。同率は上位側の順位）→ 単独チャレンジ勝率の配列
  const allIn = {}; // 1 位以外の全員がチャレンジしたときの勝率
  const catCount = new Array(9).fill(0);
  let nutCount = 0, tieFirst = 0;
  for (let g = 0; g < N; g++) {
    const { players, board, deck } = deal(n, Array(n).fill('smart'));
    const scores = players.map((p) => bestOf(p.sets, board));
    const top = Math.max(...scores);
    const firsts = scores.map((s, i) => i).filter((i) => scores[i] === top);
    if (firsts.length > 1) tieFirst++;
    catCount[categoryOf(top)]++;
    if (top === nutScore(board)) nutCount++;

    const others = scores.map((_, i) => i).filter((i) => !firsts.includes(i));
    for (const i of others) {
      const r = 1 + scores.filter((s) => s > scores[i]).length;
      const label = r === n ? '最下位' : `${r}位`;
      const odds = challengeOdds(players, board, deck, [...firsts, i]);
      (byRank[label] ??= []).push(odds.get(i));
    }
    if (others.length) {
      const odds = challengeOdds(players, board, deck, [...firsts, ...others]);
      for (const i of others) {
        const r = 1 + scores.filter((s) => s > scores[i]).length;
        const label = r === n ? '最下位' : `${r}位`;
        (allIn[label] ??= []).push(odds.get(i));
      }
    }
  }
  return { byRank, allIn, catCount, nutCount, tieFirst };
}

for (const n of [3, 4]) {
  console.log(`\n========== ${n} 人プレイ（${N} ゲーム） ==========`);

  const se = strategyExperiment(n);
  console.log(`\n[配置フェーズの戦略] 席 0 の仮 1 位率（他は smart。公平な取り分は ${pct(1 / n)}）`);
  for (const [k, v] of Object.entries(se)) console.log(`  ${k.padEnd(9)} ${pct(v)}`);

  const ce = challengeExperiment(n);
  const breakEven = 1 / (n + 1); // 単独チャレンジ: ポット (n+1)B に対し追加 B
  console.log(`\n[仮 1 位の役の分布]`);
  ce.catCount.forEach((c, i) => c && console.log(`  ${CATEGORY[i].padEnd(10)} ${pct(c / N)}`));
  console.log(`  ナッツ率（チャレンジなし）: ${pct(ce.nutCount / N)}   仮 1 位の同率: ${pct(ce.tieFirst / N)}`);

  console.log(`\n[単独チャレンジの勝率]（損益分岐 ${pct(breakEven)}）`);
  for (const [label, arr] of Object.entries(ce.byRank).sort()) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const over = arr.filter((p) => p > breakEven).length / arr.length;
    const zero = arr.filter((p) => p === 0).length / arr.length;
    const ev = arr.reduce((a, p) => a + Math.max(0, p * (n + 1) - 1), 0) / arr.length;
    console.log(
      `  ${label.padEnd(4)} 平均 ${pct(mean)}  中央値 ${pct(quantile(arr, 0.5))}  上位10% ${pct(quantile(arr, 0.9))}` +
        `  分岐超え ${pct(over)}  勝率0% ${pct(zero)}  得な時だけ挑戦した期待値 +${ev.toFixed(3)}B`,
    );
  }
  console.log(`\n[1 位以外の全員がチャレンジしたときの勝率]`);
  for (const [label, arr] of Object.entries(ce.allIn).sort()) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log(`  ${label.padEnd(4)} 平均 ${pct(mean)}  中央値 ${pct(quantile(arr, 0.5))}`);
  }
}
