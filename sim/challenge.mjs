// チャレンジ判断の共通処理（期待値計算と、任意参加者の同時選択）
import { deal, bestOf, shares } from './game.mjs';

export const RULES = {
  current: { name: '現行: 1位以外が誰でも発生させられる。1位は払わない', lastOnly: false, firstPays: false },
  lastPay: { name: '新案A: 最下位だけが発生させる。1位も参加費を払う', lastOnly: true, firstPays: true },
  lastFree: { name: '新案B: 最下位だけが発生させる。1位は払わない', lastOnly: true, firstPays: false },
};

export function analyzeGame(n, strategies) {
  const { players, board, deck } = deal(n, strategies ?? Array(n).fill('smart'));
  return buildGame(n, players, board, deck);
}

// 配り終えた状態から、仮順位と入れ替え後の全パターンを計算する
export function buildGame(n, players, board, deck) {
  const base = players.map((p) => bestOf(p.sets, board));
  const top = Math.max(...base);
  const firsts = base.map((_, i) => i).filter((i) => base[i] === top);
  const others = base.map((_, i) => i).filter((i) => base[i] !== top);
  // 入れ替え後の全パターンについて、各プレイヤーの役を先に計算しておく
  const outcomes = [];
  for (let r = 0; r < 5; r++)
    for (const d of deck) {
      const nb = board.slice();
      nb[r] = d;
      outcomes.push(players.map((p) => bestOf(p.sets, nb)));
    }
  return { n, base, firsts, others, outcomes };
}

// プレイヤー p の期待収支（B 単位）。S はチャレンジ費を払った 1 位以外の参加者
export function ev(g, rule, p, S) {
  const { n, base, firsts, outcomes } = g;
  const allIdx = base.map((_, i) => i);
  if (S.size === 0) {
    const sh = shares(base, allIdx).get(p) ?? 0;
    return sh * n - 1;
  }
  const cand = [...firsts, ...S];
  const pot = n + S.size + (rule.firstPays ? firsts.length : 0);
  const paid = 1 + (S.has(p) ? 1 : 0) + (rule.firstPays && firsts.includes(p) ? 1 : 0);
  let acc = 0;
  for (const sc of outcomes) acc += shares(sc, cand).get(p) ?? 0;
  return (acc / outcomes.length) * pot - paid;
}

// 任意参加者 opt の同時選択（forced は参加確定）
export function settle(g, rule, forced, opt) {
  let S = new Set(forced);
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (const i of opt) {
      const withI = new Set(S); withI.add(i);
      const without = new Set(S); without.delete(i);
      const join = ev(g, rule, i, withI) > ev(g, rule, i, without);
      if (join !== S.has(i)) { S = join ? withI : without; changed = true; }
    }
    if (!changed) break;
  }
  return S;
}

export function decide(g, rule) {
  const { base, others } = g;
  if (others.length === 0) return new Set();
  const byRank = [...others].sort((a, b) => base[b] - base[a]); // 高い順
  if (!rule.lastOnly) return settle(g, rule, [], byRank);
  const last = byRank[byRank.length - 1];
  const opt = byRank.filter((i) => i !== last);
  const S = settle(g, rule, [last], opt);
  return ev(g, rule, last, S) > ev(g, rule, last, new Set()) ? S : new Set();
}

