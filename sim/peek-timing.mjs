// 追加めくり（B-5）をどんな場面でするとよいかの試算
// 使い方: node sim/peek-timing.mjs [ゲーム数=4000] [人数=4] [並列数=10]
//
// 同じ配り方で、席 0 だけ「めくる枚数（3〜7 枚。3 枚＝追加めくりなし）」と「AI を使うか」を変えて比べる。
// ほかの席は 3 枚めくって smart 戦略。チャレンジは採用ルール（最下位だけが宣言、1 位は強制参加で参加費）で、
// 全員の札が公開された後に全員が期待収支で判断する（challenge.mjs）。
// 場面は「最初にめくった 3 枚」で分ける（追加でめくるかは、この 3 枚を見てから決めるため）。
// 料金: 追加めくり 1 枚 0.25B、配置の AI 相談は「場に出す札」と「組み方」で 0.1B × 2。
//   払ったお金は次のゲームの持ち越しポットに入り 1/人数 の確率で戻るので、実質の負担は ×(人数−1)/人数。
// このゲームの持ち越しポット C（B 単位）は、勝ったときに受け取る額として「勝率 × C」で足す。
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate } from './evaluator.mjs';
import { setSeed, shuffle, chooseBoard, pairing, rank, suit, keepScore } from './game.mjs';
import { RULES, buildGame, decide, ev } from './challenge.mjs';
import { shares } from './game.mjs';

const RULE = RULES.lastPay;
const KS = [3, 4, 5, 6, 7];
const CARRY = [0, 1, 2, 4];
const PEEK_FEE = 0.25;
const AI_FEE = 0.2;

// ---- 最初の 3 枚の分類（一番かみ合う 2 枚で決める） ----
const CLASSES = ['ペアあり', '同じマーク', '続き番号', '10 以上同士', 'かみ合わない'];
function classify(three) {
  let best = 4;
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const a = three[i], b = three[j];
      const c = rank(a) === rank(b) ? 0 : suit(a) === suit(b) ? 1 : Math.abs(rank(a) - rank(b)) <= 2 ? 2 : Math.min(rank(a), rank(b)) >= 8 ? 3 : 4;
      if (c < best) best = c;
    }
  return best;
}

// ---- 人間の戦略（k 枚知っているとき）。盤面は見ない簡単な目安 ----
const strong = (a, b) => rank(a) === rank(b) || suit(a) === suit(b) || Math.min(rank(a), rank(b)) >= 8;
function bestPairScore(cards) {
  let v = -Infinity;
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) v = Math.max(v, keepScore(cards[i], cards[j]));
  return v;
}
function humanPlace(known, unknown) {
  if (known.length === 3) {
    const bi = chooseBoard.smart(known);
    return { b: known[bi], sets: pairing.adaptive(known.filter((_, j) => j !== bi), unknown) };
  }
  // 場に出す札: 残りでできる一番良い 2 枚が最大になるもの
  let bi = 0, bv = -Infinity;
  known.forEach((_, i) => {
    const v = bestPairScore(known.filter((__, j) => j !== i));
    if (v > bv) { bv = v; bi = i; }
  });
  const b = known[bi];
  let L = known.filter((_, j) => j !== bi);
  const U = unknown.slice();
  const sets = [];
  // 強い 2 枚を良い順にまとめる
  while (L.length >= 2 && sets.length < 3) {
    let pi = -1, pj = -1, pv = -Infinity;
    for (let i = 0; i < L.length; i++)
      for (let j = i + 1; j < L.length; j++)
        if (strong(L[i], L[j]) && keepScore(L[i], L[j]) > pv) { pv = keepScore(L[i], L[j]); pi = i; pj = j; }
    if (pi < 0) break;
    sets.push([L[pi], L[pj]]);
    L = L.filter((_, k) => k !== pi && k !== pj);
  }
  // 残りの既知の札は未知の札と組む（弱い札どうしは分ける）
  while (L.length && U.length) sets.push([L.shift(), U.shift()]);
  const rest = [...L, ...U];
  while (rest.length) sets.push([rest.shift(), rest.shift()]);
  return { b, sets };
}

// ---- AI（pricing.mjs と同じモンテカルロ。相手は 6 枚を適当に組むと近似） ----
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
let s2 = 1;
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
function aiPlace(known, unknownCards, n, initBoard, S = 40) {
  const k = known.length;
  const seen = new Set([...known, ...initBoard]);
  const unseen = [];
  for (let c = 0; c < 52; c++) if (!seen.has(c)) unseen.push(c);
  const worlds = [];
  for (let w = 0; w < S; w++) {
    const u = shuffle2(unseen.slice());
    let p = 0;
    const own = u.slice(p, (p += 7 - k));
    const oppBoard = u.slice(p, (p += n - 1));
    const opps = [];
    for (let o = 0; o < n - 1; o++) opps.push(u.slice(p, (p += 6)));
    worlds.push({ own, oppBoard, opps });
  }
  let best = null;
  for (let bi = 0; bi < k; bi++) {
    const b = known[bi];
    const rest = known.filter((_, j) => j !== bi);
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
      const key = m.map((pr) => pr.map((i) => (i < rest.length ? String(rest[i]) : 'u')).sort().join(',')).sort().join('|');
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
      if (!best || score > best.score) best = { score, b, m, rest };
    }
  }
  // 未知の札の位置には、実際の（本人は見ていない）札を当てる
  const card = (i) => (i < best.rest.length ? best.rest[i] : unknownCards[i - best.rest.length]);
  return { b: best.b, sets: best.m.map(([x, y]) => [card(x), card(y)]) };
}

// ---- 1 ゲーム（席 0 の構成を全部試す） ----
const CONFIGS = [...KS.map((k) => ({ ai: false, k })), ...KS.map((k) => ({ ai: true, k }))];
const label = (c) => `${c.ai ? 'AI' : '人間'}・${c.k}枚`;

function winShare(g, S) {
  if (S.size === 0) return shares(g.base, g.base.map((_, i) => i)).get(0) ?? 0;
  const cand = [...g.firsts, ...S];
  let acc = 0;
  for (const sc of g.outcomes) acc += shares(sc, cand).get(0) ?? 0;
  return acc / g.outcomes.length;
}

function playAll(n, gameIndex) {
  const deck0 = shuffle([...Array(52).keys()]);
  const hands = [];
  for (let i = 0; i < n; i++) hands.push(deck0.splice(0, 7));
  const initBoard = deck0.splice(0, n === 3 ? 2 : 1);
  const others = hands.slice(1).map((h) => {
    const peeked = h.slice(0, 3);
    const bi = chooseBoard.smart(peeked);
    return { b: peeked[bi], sets: pairing.adaptive(peeked.filter((_, j) => j !== bi), h.slice(3)) };
  });
  const h0 = hands[0];
  const cls = classify(h0.slice(0, 3));
  const out = CONFIGS.map((c) => {
    s2 = gameIndex * 7919 + 17; // AI の乱数も、構成によらず同じにする
    const known = h0.slice(0, c.k), unknown = h0.slice(c.k);
    const me = c.ai ? aiPlace(known, unknown, n, initBoard) : humanPlace(known, unknown);
    const players = [me, ...others];
    const board = [...initBoard, ...players.map((p) => p.b)];
    const g = buildGame(n, players, board, deck0);
    const S = decide(g, RULE);
    const isFirst = g.firsts.includes(0) ? 1 / g.firsts.length : 0;
    return { ev: ev(g, RULE, 0, S), win: winShare(g, S), first: isFirst };
  });
  return { cls, out };
}

// ---- 集計 ----
function emptyAcc() {
  return CLASSES.map(() => ({ n: 0, cfg: CONFIGS.map(() => ({ first: 0, win: 0, d: CARRY.map(() => [0, 0]) })) }));
}
function run(N, n, seed) {
  setSeed(seed);
  const acc = emptyAcc();
  for (let t = 0; t < N; t++) {
    const { cls, out } = playAll(n, seed * 1_000_003 + t);
    const a = acc[cls];
    a.n++;
    const base = out[0]; // 人間・3 枚（追加めくりなし）
    out.forEach((r, ci) => {
      const x = a.cfg[ci];
      x.first += r.first;
      x.win += r.win;
      CARRY.forEach((C, k) => {
        const d = r.ev + r.win * C - (base.ev + base.win * C);
        x.d[k][0] += d;
        x.d[k][1] += d * d;
      });
    });
  }
  return acc;
}
function merge(a, b) {
  a.forEach((x, i) => {
    x.n += b[i].n;
    x.cfg.forEach((c, j) => {
      c.first += b[i].cfg[j].first;
      c.win += b[i].cfg[j].win;
      c.d.forEach((v, k) => { v[0] += b[i].cfg[j].d[k][0]; v[1] += b[i].cfg[j].d[k][1]; });
    });
  });
  return a;
}

const cost = (c, n) => ((c.k - 3) * PEEK_FEE + (c.ai ? AI_FEE : 0)) * (n - 1) / n;
const sgn = (x, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);

function report(acc, n, N) {
  const total = acc.reduce((s, a) => s + a.n, 0);
  const all = emptyAcc()[0];
  all.n = total;
  acc.forEach((a) => a.cfg.forEach((c, j) => {
    all.cfg[j].first += c.first; all.cfg[j].win += c.win;
    c.d.forEach((v, k) => { all.cfg[j].d[k][0] += v[0]; all.cfg[j].d[k][1] += v[1]; });
  }));
  const rows = [...acc.map((a, i) => ({ name: CLASSES[i], a })), { name: '全体', a: all }];
  console.log(`\n=== ${n} 人・${N} ゲーム ===`);
  console.log('値は「人間・3 枚（追加めくりなし、AI なし）」と比べた 1 ゲームあたりの得（B 単位）。料金の実質負担を引いた後。カッコは標準誤差');
  for (const [k, C] of CARRY.entries()) {
    console.log(`\n--- このゲームの持ち越しポット ${C}B ---`);
    console.log(['最初の 3 枚', '割合', ...CONFIGS.map(label), '一番良い'].join(' | '));
    for (const { name, a } of rows) {
      const vals = CONFIGS.map((c, j) => {
        const m = a.cfg[j].d[k][0] / a.n;
        const se = Math.sqrt(Math.max(0, a.cfg[j].d[k][1] / a.n - m * m) / a.n);
        return { v: m - cost(c, n), se };
      });
      const bi = vals.reduce((b, x, i) => (x.v > vals[b].v ? i : b), 0);
      console.log([name, `${((a.n / total) * 100).toFixed(0)}%`, ...vals.map((x) => `${sgn(x.v)}(${x.se.toFixed(2)})`), label(CONFIGS[bi])].join(' | '));
    }
  }
  console.log('\n--- 仮 1 位率（料金に関係なし） ---');
  console.log(['最初の 3 枚', ...CONFIGS.map(label)].join(' | '));
  for (const { name, a } of rows) console.log([name, ...a.cfg.map((c) => `${((c.first / a.n) * 100).toFixed(1)}%`)].join(' | '));
}

// ---- 並列実行 ----
const self = fileURLToPath(import.meta.url);
if (process.argv[2] === '--worker') {
  const [N, n, seed] = process.argv.slice(3).map(Number);
  process.send(run(N, n, seed));
} else {
  const N = Number(process.argv[2] ?? 4000);
  const n = Number(process.argv[3] ?? 4);
  const W = Number(process.argv[4] ?? 10);
  const per = Math.ceil(N / W);
  const parts = await Promise.all(
    [...Array(W).keys()].map(
      (w) =>
        new Promise((res, rej) => {
          const ch = fork(self, ['--worker', String(per), String(n), String(w + 1)]);
          ch.on('message', res);
          ch.on('error', rej);
        }),
    ),
  );
  report(parts.reduce(merge), n, per * W);
}
