// AI 相談（rules.md B-6）。相談した本人に見えている情報だけを使って、数字で答える。
// - 配置（場に出す札、組み方、追加でめくる価値）: 見えていない札をランダムに配ったモンテカルロ
// - チャレンジ（宣言、便乗）: 全員の札が公開済みなので、入れ替えの全パターン（場札の位置 × 山札）を数え上げる
import type { Card, Rng } from './cards.ts';
import { evaluate } from './evaluator.ts';

/** 6 枚を 2 枚ずつ 3 組に分ける 15 通り（位置 0〜5） */
const MATCHINGS: [number, number][][] = (() => {
  const out: [number, number][][] = [];
  const rec = (rest: number[], acc: [number, number][]) => {
    if (rest.length === 0) return void out.push(acc);
    const [a, ...r] = rest;
    for (let i = 0; i < r.length; i++) rec(r.filter((_, j) => j !== i), [...acc, [a!, r[i]!]]);
  };
  rec([0, 1, 2, 3, 4, 5], []);
  return out;
})();

export interface PlaceCandidate {
  /** 場に出す札の位置（手札の位置） */
  index: number;
  /** 仮順位で 1 位になる見込み（同率は 0.5 として数える） */
  win: number;
}

export interface PlacementAdvice {
  topic: 'place' | 'arrange';
  /** 場に出す札の候補（見込みの高い順）。arrange では空 */
  candidates: PlaceCandidate[];
  /** おすすめの場に出す札（arrange では出した札） */
  boardIndex: number;
  /** おすすめの組み方（手札の位置の組）。中身を知らない札どうしは区別しない */
  sets: [number, number][];
  /** おすすめどおりにしたときの見込み */
  win: number;
  /** 1 枚追加でめくった場合の見込み（追加でめくれないときは null） */
  peekWin: number | null;
}

export interface ChallengeScenario {
  /** 自分以外で乗る席 */
  others: number[];
  /** 最終勝者になる確率 */
  win: number;
  /** 期待収支（相談した時点の持ち点からの増減。点） */
  ev: number;
}

export interface ChallengeOption {
  /** 他の人の判断を予想したときの勝率と期待収支 */
  win: number;
  ev: number;
  /** 予想した「自分以外で乗る席」 */
  predicted: number[];
  /** 他の人の判断ごとの内訳 */
  scenarios: ChallengeScenario[];
}

export interface ChallengeAdvice {
  topic: 'declare' | 'join';
  yes: ChallengeOption;
  no: ChallengeOption;
  recommend: boolean;
}

export type Advice = PlacementAdvice | ChallengeAdvice;

// ---- 配置 ----

interface World {
  own: Card[];
  oppBoard: Card[];
  opps: Card[][];
}

function sampleWorlds(unseen: Card[], nUnknown: number, nOpp: number, count: number, rng: Rng): World[] {
  const worlds: World[] = [];
  const u = unseen.slice();
  const need = nUnknown + nOpp * 7;
  for (let w = 0; w < count; w++) {
    // 必要な枚数だけ部分シャッフル
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rng() * (u.length - i));
      [u[i], u[j]] = [u[j]!, u[i]!];
    }
    let p = 0;
    const own = u.slice(p, (p += nUnknown));
    const oppBoard = u.slice(p, (p += nOpp));
    const opps: Card[][] = [];
    for (let o = 0; o < nOpp; o++) opps.push(u.slice(p, (p += 6)));
    worlds.push({ own, oppBoard, opps });
  }
  return worlds;
}

/**
 * 場に出す札 b と、組に使う既知の札 rest を決めたとき、最善の組み方とその見込み。
 * 組み方は worlds で選び、見込みは別の scoreWorlds で測る（同じサンプルで選んで測ると、見込みが高めに出るため）
 */
function bestMatching(
  rest: Card[],
  b: Card,
  initBoard: Card[],
  worlds: World[],
  scoreWorlds: World[],
): { win: number; matching: [number, number][] } {
  const chosen = chooseMatching(rest, b, initBoard, worlds);
  return { win: scoreMatching(rest, b, initBoard, scoreWorlds, chosen), matching: chosen };
}

function oppBestOf(b: Card, initBoard: Card[], worlds: World[]) {
  const boards = worlds.map((w) => [...initBoard, b, ...w.oppBoard]);
  // 相手は 6 枚を配られた順に組む近似（シミュレーションと同じ）
  const oppBest = worlds.map((w, wi) => {
    let m = 0;
    for (const o of w.opps)
      for (let s = 0; s < 3; s++) {
        const v = evaluate([...boards[wi]!, o[2 * s]!, o[2 * s + 1]!]);
        if (v > m) m = v;
      }
    return m;
  });
  return { boards, oppBest };
}

function scoreMatching(rest: Card[], b: Card, initBoard: Card[], worlds: World[], m: [number, number][]): number {
  const { boards, oppBest } = oppBestOf(b, initBoard, worlds);
  let score = 0;
  worlds.forEach((w, wi) => {
    const card = (i: number) => (i < rest.length ? rest[i]! : w.own[i - rest.length]!);
    let mine = 0;
    for (const [x, y] of m) {
      const v = evaluate([...boards[wi]!, card(x), card(y)]);
      if (v > mine) mine = v;
    }
    score += mine > oppBest[wi]! ? 1 : mine === oppBest[wi]! ? 0.5 : 0;
  });
  return score / worlds.length;
}

function chooseMatching(rest: Card[], b: Card, initBoard: Card[], worlds: World[]): [number, number][] {
  const boards = worlds.map((w) => [...initBoard, b, ...w.oppBoard]);
  // 相手は 6 枚を配られた順に組む近似（シミュレーションと同じ）
  const oppBest = worlds.map((w, wi) => {
    let m = 0;
    for (const o of w.opps)
      for (let s = 0; s < 3; s++) {
        const v = evaluate([...boards[wi]!, o[2 * s]!, o[2 * s + 1]!]);
        if (v > m) m = v;
      }
    return m;
  });
  let best: { win: number; matching: [number, number][] } | null = null;
  const seen = new Set<string>();
  for (const m of MATCHINGS) {
    // 中身を知らない札どうしは区別できないので、同じ形の組み方は 1 回だけ数える
    const key = m
      .map((pr) => pr.map((i) => (i < rest.length ? String(rest[i]) : 'u')).sort().join(','))
      .sort()
      .join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    let score = 0;
    worlds.forEach((w, wi) => {
      const card = (i: number) => (i < rest.length ? rest[i]! : w.own[i - rest.length]!);
      let mine = 0;
      for (const [x, y] of m) {
        const v = evaluate([...boards[wi]!, card(x), card(y)]);
        if (v > mine) mine = v;
      }
      score += mine > oppBest[wi]! ? 1 : mine === oppBest[wi]! ? 0.5 : 0;
    });
    if (!best || score > best.win) best = { win: score, matching: m };
  }
  return best!.matching;
}

export interface PlacementInput {
  hand: Card[];
  /** めくった札の位置 */
  peeked: number[];
  /** 場に出した札の位置（出す前は null） */
  boardIndex: number | null;
  initBoard: Card[];
  players: number;
  /** 1 枚追加でめくった場合の見込みも出すか */
  withPeek: boolean;
  /** モンテカルロの回数 */
  samples?: number;
}

export function advisePlacement(inp: PlacementInput, rng: Rng): PlacementAdvice {
  const S = inp.samples ?? 300;
  const nOpp = inp.players - 1;
  const known = inp.peeked.map((k) => inp.hand[k]!);
  const unseenFor = (extra: Card[] = []) => {
    const seen = new Set([...known, ...inp.initBoard, ...extra]);
    return Array.from({ length: 52 }, (_, c) => c).filter((c) => !seen.has(c));
  };
  const unknownIdx = [...Array(7).keys()].filter((k) => !inp.peeked.includes(k));

  /** 既知の札と場に出す札の候補から、一番よい選び方を出す */
  const evaluateChoices = (knownCards: Card[], choices: number[], worlds: World[], scoreWorlds: World[]) =>
    choices.map((ci) => {
      const b = knownCards[ci]!;
      const rest = knownCards.filter((_, j) => j !== ci);
      return { ci, ...bestMatching(rest, b, inp.initBoard, worlds, scoreWorlds) };
    });

  const nUnknown = unknownIdx.length;
  const worlds = sampleWorlds(unseenFor(), nUnknown, nOpp, S, rng);
  const scoreWorlds = sampleWorlds(unseenFor(), nUnknown, nOpp, S * 2, rng);
  const choices = inp.boardIndex === null ? known.map((_, i) => i) : [inp.peeked.indexOf(inp.boardIndex)];
  const results = evaluateChoices(known, choices, worlds, scoreWorlds).sort((a, b) => b.win - a.win);
  const top = results[0]!;
  const boardIndex = inp.peeked[top.ci]!;
  // 位置の対応: 組に使う既知の札（場に出す札を除いた順）→ 中身を知らない札
  const restIdx = inp.peeked.filter((_, j) => j !== top.ci);
  const slotToHand = (i: number) => (i < restIdx.length ? restIdx[i]! : unknownIdx[i - restIdx.length]!);
  const sets = top.matching.map(([x, y]) => [slotToHand(x), slotToHand(y)] as [number, number]);

  // 1 枚追加でめくったら: 中身をランダムに仮定して、そのときの一番よい選び方の見込みを平均する
  let peekWin: number | null = null;
  if (inp.withPeek && inp.boardIndex === null && nUnknown > 0) {
    // 選ぶのも測るのも、めくった後に分かる情報だけで行う。場に出す札は「選ぶ用」の見込みで決め、「測る用」で見込みを出す
    const M = 12;
    let acc = 0;
    const pool = unseenFor();
    for (let t = 0; t < M; t++) {
      const c = pool[Math.floor(rng() * pool.length)]!;
      const k2 = [...known, c];
      const w2 = sampleWorlds(unseenFor([c]), nUnknown - 1, nOpp, Math.round(S / 2), rng);
      const v2 = sampleWorlds(unseenFor([c]), nUnknown - 1, nOpp, Math.round(S / 2), rng);
      const picks = k2.map((_, ci) => {
        const rest = k2.filter((_, j) => j !== ci);
        const m = chooseMatching(rest, k2[ci]!, inp.initBoard, w2);
        return { ci, m, sel: scoreMatching(rest, k2[ci]!, inp.initBoard, w2, m) };
      });
      const pick = picks.sort((a, b) => b.sel - a.sel)[0]!;
      acc += scoreMatching(k2.filter((_, j) => j !== pick.ci), k2[pick.ci]!, inp.initBoard, v2, pick.m);
    }
    peekWin = acc / M;
  }

  return {
    topic: inp.boardIndex === null ? 'place' : 'arrange',
    candidates: inp.boardIndex === null ? results.map((r) => ({ index: inp.peeked[r.ci]!, win: r.win })) : [],
    boardIndex,
    sets,
    win: top.win,
    peekWin,
  };
}

// ---- チャレンジ ----

export interface ChallengeOutcome {
  /** 各席の最終の持ち点 */
  stacks: number[];
  winners: number[];
}

/**
 * 乗る席の組み合わせごとに、入れ替えの全パターンでの平均（各席の最終持ち点と勝率）を出す。
 * simulate(joiners) は、その組み合わせで起こりうる全パターンの結果を返す（game.ts が用意する）
 */
export function adviseChallenge(
  topic: 'declare' | 'join',
  me: number,
  stackNow: number,
  deciders: number[],
  /** 自分が乗る／乗らないと、他の乗る席を渡すと、全パターンの結果を返す。乗らない宣言（declare の no）は challenge なし */
  simulate: (meIn: boolean, others: number[]) => ChallengeOutcome[],
): ChallengeAdvice {
  const cache = new Map<string, { ev: number[]; win: number[] }>();
  const stats = (meIn: boolean, others: number[]) => {
    const key = `${meIn}:${[...others].sort().join(',')}`;
    let v = cache.get(key);
    if (!v) {
      const outs = simulate(meIn, others);
      const n = outs[0]!.stacks.length;
      const ev = new Array<number>(n).fill(0);
      const win = new Array<number>(n).fill(0);
      for (const o of outs) {
        o.stacks.forEach((x, i) => (ev[i]! += x / outs.length));
        for (const w of o.winners) win[w]! += 1 / outs.length;
      }
      v = { ev, win };
      cache.set(key, v);
    }
    return v;
  };
  const subsets = (xs: number[]): number[][] =>
    xs.reduce<number[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

  /** 他の人も期待収支で判断すると仮定した、乗る席の予想（シミュレーションと同じ繰り返し） */
  const predict = (meIn: boolean): number[] => {
    if (topic === 'declare' && !meIn) return [];
    let S = new Set<number>();
    for (let iter = 0; iter < 20; iter++) {
      let changed = false;
      for (const i of deciders) {
        const withI = [...S, i].filter((x, k, a) => a.indexOf(x) === k);
        const without = [...S].filter((x) => x !== i);
        const join = stats(meIn, withI).ev[i]! > stats(meIn, without).ev[i]!;
        if (join !== S.has(i)) {
          S = new Set(join ? withI : without);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return [...S].sort((a, b) => a - b);
  };

  const option = (meIn: boolean): ChallengeOption => {
    const predicted = predict(meIn);
    const p = stats(meIn, predicted);
    const scen = topic === 'declare' && !meIn ? [[]] : subsets(deciders);
    return {
      win: p.win[me]!,
      ev: p.ev[me]! - stackNow,
      predicted,
      scenarios: scen.map((others) => {
        const st = stats(meIn, others);
        return { others: [...others].sort((a, b) => a - b), win: st.win[me]!, ev: st.ev[me]! - stackNow };
      }),
    };
  };
  const yes = option(true);
  const no = option(false);
  return { topic, yes, no, recommend: yes.ev > no.ev };
}
