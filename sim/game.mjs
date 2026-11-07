// ゲーム進行の共通処理（シミュレーター用）
import { evaluate } from './evaluator.mjs';

// 再現性のための乱数（mulberry32）
let seed = 1;
export const setSeed = (s) => { seed = s; };
export const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
export const rank = (c) => c >> 2;
export const suit = (c) => c & 3;

// ---- 配置フェーズの戦略 ----

// 手元に残す 2 枚の価値（盤面は見ない簡易評価）
export const keepScore = (a, b) => {
  const hi = Math.max(rank(a), rank(b)), lo = Math.min(rank(a), rank(b));
  if (hi === lo) return 100 + hi;
  let s = hi + lo / 2;
  if (suit(a) === suit(b)) s += 6;
  if (hi - lo <= 2) s += 3 - (hi - lo);
  return s;
};
const strongKeep = (a, b) =>
  rank(a) === rank(b) || suit(a) === suit(b) || Math.min(rank(a), rank(b)) >= 8; // 10 以上同士

// 3 枚のうち場に出す 1 枚を決める
export const chooseBoard = {
  random: (p) => Math.floor(rand() * 3),
  // 残す 2 枚の価値が最大になるように出す
  smart: (p) => {
    let best = -1, idx = 0;
    for (let i = 0; i < 3; i++) {
      const k = p.filter((_, j) => j !== i);
      const v = keepScore(k[0], k[1]);
      if (v > best) { best = v; idx = i; }
    }
    return idx;
  },
  // 比較用: 一番高い札を場に出す（悪手のはず）
  giveHigh: (p) => p.indexOf(p.reduce((m, c) => (rank(c) > rank(m) ? c : m))),
};

// 既知 2 枚 k と未知 4 枚 u から 3 セットを作る
export const pairing = {
  random: (k, u) => {
    const all = shuffle([...k, ...u]);
    return [[all[0], all[1]], [all[2], all[3]], [all[4], all[5]]];
  },
  together: (k, u) => [[k[0], k[1]], [u[0], u[1]], [u[2], u[3]]],
  split: (k, u) => [[k[0], u[0]], [k[1], u[1]], [u[2], u[3]]],
  adaptive: (k, u) => (strongKeep(k[0], k[1]) ? pairing.together(k, u) : pairing.split(k, u)),
};

export const STRATS = {
  random: { board: 'random', pair: 'random' },
  smart: { board: 'smart', pair: 'adaptive' },
  together: { board: 'smart', pair: 'together' },
  split: { board: 'smart', pair: 'split' },
  giveHigh: { board: 'giveHigh', pair: 'adaptive' },
};

// ---- 1 ゲーム ----

export const bestOf = (sets, board) => {
  let best = 0;
  for (const s of sets) {
    const v = evaluate([...board, s[0], s[1]]);
    if (v > best) best = v;
  }
  return best;
};

export function deal(n, strategies) {
  const deck = shuffle([...Array(52).keys()]);
  const hands = [];
  for (let i = 0; i < n; i++) hands.push(deck.splice(0, 7));
  const board = deck.splice(0, n === 3 ? 2 : 1);
  const players = hands.map((h, i) => {
    const st = STRATS[strategies[i]];
    const peeked = h.slice(0, 3); // 7 枚は裏向きでランダムなので先頭 3 枚を「めくった」とみなす
    const unknown = h.slice(3);
    const bi = chooseBoard[st.board](peeked);
    board.push(peeked[bi]);
    const kept = peeked.filter((_, j) => j !== bi);
    return { sets: pairing[st.pair](kept, unknown) };
  });
  return { players, board, deck };
}

// 勝者候補 cand の中で、各プレイヤーの取り分（同点は等分）
export const shares = (scores, cand) => {
  let top = -1;
  for (const i of cand) if (scores[i] > top) top = scores[i];
  const winners = cand.filter((i) => scores[i] === top);
  const out = new Map();
  for (const i of winners) out.set(i, 1 / winners.length);
  return out;
};

// チャレンジ時の全パターン（外す 5 枚 × 山札から引く 1 枚）を数え上げ、各候補の勝率を返す
export function challengeOdds(players, board, deck, cand) {
  const acc = new Map(cand.map((i) => [i, 0]));
  let total = 0;
  for (let r = 0; r < 5; r++) {
    for (const d of deck) {
      const nb = board.slice();
      nb[r] = d;
      const scores = players.map((p, i) => (cand.includes(i) ? bestOf(p.sets, nb) : -1));
      for (const [i, s] of shares(scores, cand)) acc.set(i, acc.get(i) + s);
      total++;
    }
  }
  for (const [i, v] of acc) acc.set(i, v / total);
  return acc;
}

