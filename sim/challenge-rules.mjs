// チャレンジの仕組みの比較シミュレーション
// 使い方: node sim/challenge-rules.mjs [ゲーム数=20000] [seed=1]
//
// 前提
// - 全員が手札（3 セット）を公開した後にチャレンジを判断する（完全情報）
// - 各自は期待値が最大になるように参加/不参加を選ぶ（金額は B 単位）
// - 任意参加者どうしは同時に選ぶ。その組み合わせは「誰も参加しない」から始めて、
//   仮順位の高い順に最善の選択へ更新し、変化がなくなるまで繰り返して決める
// - ナッツボーナスとオールインは計算に入れない
import { setSeed, shares } from './game.mjs';
import { RULES, analyzeGame, ev, decide } from './challenge.mjs';

const N = Number(process.argv[2] ?? 20000);
setSeed(Number(process.argv[3] ?? 1));

const label = (g, i) => {
  const { n, base, firsts } = g;
  if (firsts.includes(i)) return '1位';
  if (base[i] === Math.min(...base)) return '最下位';
  return `${1 + base.filter((s) => s > base[i]).length}位`;
};
const pct = (x) => (x * 100).toFixed(1) + '%';
const sgn = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);

for (const n of [3, 4]) {
  const games = [];
  for (let k = 0; k < N; k++) games.push(analyzeGame(n));
  console.log(`\n========== ${n} 人プレイ（${N} ゲーム） ==========`);
  for (const [key, rule] of Object.entries(RULES)) {
    let challenged = 0, lastWins = 0, firstKeeps = 0;
    const net = {}, cnt = {}, join = {}, eligible = {};
    for (const g of games) {
      const S = decide(g, rule);
      if (S.size) challenged++;
      const allIdx = g.base.map((_, i) => i);
      for (const i of allIdx) {
        const L = label(g, i);
        net[L] = (net[L] ?? 0) + ev(g, rule, i, S);
        cnt[L] = (cnt[L] ?? 0) + 1;
        if (!g.firsts.includes(i)) {
          eligible[L] = (eligible[L] ?? 0) + 1;
          if (S.has(i)) join[L] = (join[L] ?? 0) + 1;
        }
      }
      // 最下位の逆転率と 1 位の防衛率（期待値ベース）
      const lastIdx = allIdx.filter((i) => label(g, i) === '最下位');
      const cand = S.size ? [...g.firsts, ...S] : allIdx;
      const winShare = (i) => {
        if (!S.size) return shares(g.base, allIdx).get(i) ?? 0;
        let a = 0;
        for (const sc of g.outcomes) a += shares(sc, cand).get(i) ?? 0;
        return a / g.outcomes.length;
      };
      for (const i of lastIdx) lastWins += winShare(i);
      for (const i of g.firsts) firstKeeps += winShare(i);
    }
    console.log(`\n[${rule.name}]`);
    console.log(`  チャレンジ発生率 ${pct(challenged / N)}   最下位の逆転率 ${pct(lastWins / N)}   1位の防衛率 ${pct(firstKeeps / N)}`);
    const order = ['1位', '2位', '3位', '最下位'].filter((L) => cnt[L]);
    console.log('  仮順位   参加率   1ゲームあたりの期待収支');
    for (const L of order) {
      const jr = eligible[L] ? pct((join[L] ?? 0) / eligible[L]) : '  -  ';
      console.log(`  ${L.padEnd(4)}  ${jr.padStart(6)}   ${sgn(net[L] / cnt[L])}B`);
    }
  }
}
