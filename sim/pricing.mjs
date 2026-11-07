// 料金の試算: 追加めくり（B-5）と AI 相談（B-6）の価値を、期待収支（B 単位）で測る
// 使い方:
//   node sim/pricing.mjs peek [ゲーム数=3000] [seed=1] [人数=4]   … 追加めくりと配置フェーズの AI 相談
//   node sim/pricing.mjs advice [ゲーム数=20000] [seed=1]         … チャレンジ判断の AI 相談
//
// 期待収支は、チャレンジ（採用ルール: 最下位だけが宣言、1 位は強制参加で参加費を払う）まで含めて、
// 全員が手札を公開した後に合理的に判断する前提で計算する（challenge.mjs）。
import { evaluate, CATEGORY, categoryOf } from './evaluator.mjs';
import { setSeed, shuffle, chooseBoard, pairing, STRATS } from './game.mjs';
import { RULES, buildGame, ev, decide, settle } from './challenge.mjs';

const RULE = RULES.lastPay;
const mode = process.argv[2] ?? 'peek';

// ---- 配置フェーズ: モンテカルロで最善手を選ぶ「AI」 ----

// 6 個の要素を 3 組に分ける 15 通り
const MATCHINGS = (() => {
  const out = [];
  const rec = (rest, acc) => {
    if (!rest.length) return out.push(acc);
    const [a, ...r] = rest;
    for (let i = 0; i < r.length; i++) rec(r.filter((_, j) => j !== i), [...acc, [a, r[i]]]);
  };
  rec([0, 1, 2, 3, 4, 5], []);
  return out;
})();

// 独立した乱数（配札の乱数と分けて、戦略を変えても同じ配札で比べられるようにする）
let s2 = 12345;
const rand2 = () => {
  s2 = (s2 + 0x6d2b79f5) | 0;
  let t = Math.imul(s2 ^ (s2 >>> 15), 1 | s2);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle2 = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand2() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// known: めくった k 枚、initBoard: 初期場札。返り値: { b: 場に出す札, sets: [[x, y]...] }（未知の札は 'u0'..'u3'）
function mcChoose(known, n, initBoard, S = 40) {
  const k = known.length;
  const seen = new Set([...known, ...initBoard]);
  const unseen = [];
  for (let c = 0; c < 52; c++) if (!seen.has(c)) unseen.push(c);
  const nUnknown = 7 - k;
  // 世界をサンプル: 自分の未知札、他人が場に出す札、他人の 6 枚
  const worlds = [];
  for (let w = 0; w < S; w++) {
    const u = shuffle2(unseen.slice());
    let p = 0;
    const own = u.slice(p, (p += nUnknown));
    const oppBoard = u.slice(p, (p += n - 1));
    const opps = [];
    for (let o = 0; o < n - 1; o++) opps.push(u.slice(p, (p += 6)));
    worlds.push({ own, oppBoard, opps });
  }
  let best = null;
  for (let bi = 0; bi < k; bi++) {
    const b = known[bi];
    const rest = known.filter((_, j) => j !== bi);
    // 各世界の場札と、相手の最強役（相手は 6 枚をランダムに組む近似）
    const boards = worlds.map((w) => [...initBoard, b, ...w.oppBoard]);
    const oppBest = worlds.map((w, wi) => {
      let m = 0;
      for (const o of w.opps)
        for (let s = 0; s < 3; s++) {
          const v = evaluate([...boards[wi], o[2 * s], o[2 * s + 1]]);
          if (v > m) m = v;
        }
      return m;
    });
    const seenKeys = new Set();
    for (const m of MATCHINGS) {
      // 未知札どうしは区別できないので、同じ形の組み方は 1 回だけ評価する
      const key = m
        .map((pr) => pr.map((i) => (i < rest.length ? String(rest[i]) : 'u')).sort().join(','))
        .sort()
        .join('|');
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      let score = 0;
      worlds.forEach((w, wi) => {
        const card = (i) => (i < rest.length ? rest[i] : w.own[i - rest.length]);
        let mine = 0;
        for (const [x, y] of m) {
          const v = evaluate([...boards[wi], card(x), card(y)]);
          if (v > mine) mine = v;
        }
        score += mine > oppBest[wi] ? 1 : mine === oppBest[wi] ? 0.5 : 0;
      });
      if (!best || score > best.score)
        best = { score, b, sets: m.map((pr) => pr.map((i) => (i < rest.length ? rest[i] : `u${i - rest.length}`))) };
    }
  }
  return best;
}

// 席 0 の戦略: { peeks: めくる枚数, ai: true なら mcChoose、false なら smart 戦略（3 枚のみ） }
function playGame(n, seat0) {
  const deck = shuffle([...Array(52).keys()]);
  const hands = [];
  for (let i = 0; i < n; i++) hands.push(deck.splice(0, 7));
  const initBoard = deck.splice(0, n === 3 ? 2 : 1);
  const board = initBoard.slice();
  const players = hands.map((h, i) => {
    if (i === 0 && seat0.ai) {
      const known = h.slice(0, seat0.peeks);
      const unknown = h.slice(seat0.peeks);
      const c = mcChoose(known, n, initBoard);
      board.push(c.b);
      const sets = c.sets.map((pr) => pr.map((x) => (typeof x === 'string' ? unknown[Number(x.slice(1))] : x)));
      return { sets };
    }
    const st = STRATS[i === 0 ? seat0.strat : 'smart'];
    const peeked = h.slice(0, 3);
    const bi = chooseBoard[st.board](peeked);
    board.push(peeked[bi]);
    const kept = peeked.filter((_, j) => j !== bi);
    return { sets: pairing[st.pair](kept, h.slice(3)) };
  });
  const g = buildGame(n, players, board, deck);
  const S = decide(g, RULE);
  const firstShare = g.firsts.includes(0) ? 1 / g.firsts.length : 0;
  return { ev: ev(g, RULE, 0, S), first: firstShare };
}

function peekExperiment(N, seed, n) {
  const configs = [
    { label: '人間（ランダム）', strat: 'random' },
    { label: '人間（smart）', strat: 'smart' },
    ...[3, 4, 5, 6, 7].map((k) => ({ label: `AI・${k}枚めくる`, ai: true, peeks: k })),
  ];
  console.log(`\n=== 配置フェーズ（${n} 人・${N} ゲーム・席 0 以外は smart） ===`);
  console.log('戦略               仮1位率   期待収支（チャレンジ込み）');
  const res = {};
  for (const c of configs) {
    setSeed(seed); // 全戦略で同じ配札
    s2 = 12345;
    let evSum = 0, evSq = 0, first = 0;
    for (let g = 0; g < N; g++) {
      const r = playGame(n, c);
      evSum += r.ev; evSq += r.ev * r.ev; first += r.first;
    }
    const mean = evSum / N;
    const se = Math.sqrt((evSq / N - mean * mean) / N);
    res[c.label] = mean;
    console.log(`${c.label.padEnd(16)} ${(first / N * 100).toFixed(1).padStart(5)}%   ${mean >= 0 ? '+' : ''}${mean.toFixed(3)}B (±${se.toFixed(3)})`);
  }
  return res;
}

// ---- チャレンジ判断の AI 相談 ----

// 人間の目安: 役の段階（ワンペア、ツーペア…）の差が gap 以下なら挑む
const humanDeclare = (g, i, gap) => categoryOf(g.base[g.firsts[0]]) - categoryOf(g.base[i]) <= gap;

function adviceExperiment(N, seed) {
  for (const n of [3, 4]) {
    setSeed(seed);
    const H = { 'いつも挑む': 99, '差1段階まで': 1, '同じ段階のみ': 0, '挑まない': -1 };
    const lastVal = Object.fromEntries(Object.keys(H).map((k) => [k, { v: 0, diff: 0, c: 0 }]));
    const joinVal = Object.fromEntries(Object.keys(H).map((k) => [k, { v: 0, diff: 0, c: 0 }]));
    for (let t = 0; t < N; t++) {
      const { players, board, deck } = dealSmart(n);
      const g = buildGame(n, players, board, deck);
      if (!g.others.length) continue;
      const byRank = [...g.others].sort((a, b) => g.base[b] - g.base[a]);
      const last = byRank[byRank.length - 1];
      const opt = byRank.filter((i) => i !== last);
      // 最下位: 宣言した場合の結果（任意参加者は合理的に反応）
      const Sdecl = settle(g, RULE, [last], opt);
      const evDecl = ev(g, RULE, last, Sdecl);
      const evNo = ev(g, RULE, last, new Set());
      const aiEv = Math.max(evDecl, evNo);
      for (const [name, gap] of Object.entries(H)) {
        const hum = humanDeclare(g, last, gap);
        const hEv = hum ? evDecl : evNo;
        lastVal[name].v += aiEv - hEv;
        lastVal[name].diff += (evDecl > evNo) !== hum ? 1 : 0;
        lastVal[name].c++;
      }
      // 便乗（2 位・3 位）: 最下位が宣言した局面だけ
      if (evDecl > evNo) {
        for (const i of opt) {
          const others = new Set(Sdecl); others.delete(i);
          const withI = new Set(others); withI.add(i);
          const evJoin = ev(g, RULE, i, withI), evSkip = ev(g, RULE, i, others);
          for (const [name, gap] of Object.entries(H)) {
            const hum = humanDeclare(g, i, gap);
            joinVal[name].v += Math.max(evJoin, evSkip) - (hum ? evJoin : evSkip);
            joinVal[name].diff += (evJoin > evSkip) !== hum ? 1 : 0;
            joinVal[name].c++;
          }
        }
      }
    }
    console.log(`\n=== チャレンジ判断の AI 相談（${n} 人・${N} ゲーム） ===`);
    console.log('人間の判断の目安     最下位: 相談1回の価値（AIと判断が違う割合）   便乗: 相談1回の価値（違う割合）');
    for (const name of Object.keys(H)) {
      const L = lastVal[name], J = joinVal[name];
      console.log(
        `${name.padEnd(10)}  +${(L.v / L.c).toFixed(3)}B（${(L.diff / L.c * 100).toFixed(0)}%）` +
          `                     +${(J.v / J.c).toFixed(3)}B（${(J.diff / J.c * 100).toFixed(0)}%）`,
      );
    }
  }
}

function dealSmart(n) {
  const deck = shuffle([...Array(52).keys()]);
  const hands = [];
  for (let i = 0; i < n; i++) hands.push(deck.splice(0, 7));
  const board = deck.splice(0, n === 3 ? 2 : 1);
  const players = hands.map((h) => {
    const peeked = h.slice(0, 3);
    const bi = chooseBoard.smart(peeked);
    board.push(peeked[bi]);
    const kept = peeked.filter((_, j) => j !== bi);
    return { sets: pairing.adaptive(kept, h.slice(3)) };
  });
  return { players, board, deck };
}

if (mode === 'peek') {
  peekExperiment(Number(process.argv[3] ?? 3000), Number(process.argv[4] ?? 1), Number(process.argv[5] ?? 4));
} else {
  adviceExperiment(Number(process.argv[3] ?? 20000), Number(process.argv[4] ?? 1));
}
