// 試合単位（初期 30B、G ゲーム、持ち点 0 で脱落、最終ゲームは追加めくり・相談なし）で席 0 の打ち方を比べる。4 人、B=100
// 使い方: npx tsx sim/match-styles.ts 試合数 0 乱数の種のずらし ゲーム数
// 席 0: carry（ポット 2B 以上で 7 枚＋AI）/ base3（3 枚）/ mid（4 枚、ポット 1B 以上なら 5 枚＋AI）/ all7ai（毎回 7 枚＋AI）。相手: all7ai, carry, rule3
import { apply, arrangeSets, chooseBoardIndex, currentAdvice, keepScore, newGame, paidExtras, pendingSeats, rankOf, suitOf, seededRng, type Card, type GameAction, type GameState, type ChallengeAdvice } from '../packages/core/src/index.ts';
const N = Number(process.argv[2] ?? 100), CB = Number(process.argv[3] ?? 0), OFF = Number(process.argv[4] ?? 0), B = 100;
type K = { index: number; card: Card };
// 人の組み方: 知っている札を keepScore の高い順に 2 枚ずつ組み、余りは知らない札と組む
function greedySets(known: K[], unknown: number[]): { sets: [number, number][]; v: number } {
  const k = [...known]; const sets: [number, number][] = []; let v = 0, w = 1;
  while (k.length >= 2) {
    let bi = 0, bj = 1, bs = -1;
    for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) { const s = keepScore(k[i]!.card, k[j]!.card); if (s > bs) { bs = s; bi = i; bj = j; } }
    if (sets.length > 0 && bs < 12) break; // 2 組目以降は弱いなら無理に組まない
    sets.push([k[bi]!.index, k[bj]!.index]); v += w * bs; w = 0.3;
    k.splice(bj, 1); k.splice(bi, 1);
  }
  const rest = [...k.map((x) => x.index), ...unknown];
  while (rest.length) sets.push([rest.shift()!, rest.pop()!]);
  return { sets, v };
}
function humanPlace(known: K[], unknown: number[]) {
  let best = { board: known[0]!.index, sets: [] as [number, number][], v: -1e9 };
  for (const b of known) {
    const g = greedySets(known.filter((x) => x !== b), unknown);
    const v = g.v - rankOf(b.card) * 0.01; // 同じなら低い札を場へ
    if (v > best.v) best = { board: b.index, sets: g.sets, v };
  }
  return best;
}
const strong = (k: K[]) => k.some((a, i) => k.some((b, j) => j > i && (rankOf(a.card) === rankOf(b.card) || (suitOf(a.card) === suitOf(b.card) && Math.min(rankOf(a.card), rankOf(b.card)) >= 8))));
type Style = 'base3' | 'five' | 'carry' | 'fiveCarry' | 'all7ai' | 'rule3' | 'mid';
function peekTarget(s: GameState, p: GameState['seats'][number], st: Style): number {
  if (!s.extraPeeks) return 3;
  const bigPot = s.carryIn >= 2 * s.bet;
  if (st === 'all7ai' || ((st === 'carry' || st === 'fiveCarry') && bigPot)) return 7;
  if (st === 'mid') return p.peeked.length < 4 ? 4 : (p.hand.length && s.carryIn >= s.bet ? 5 : 4);
  if (st === 'five' || st === 'fiveCarry') {
    const known = p.peeked.map((index) => ({ index, card: p.hand[index]! }));
    if (p.peeked.length < 5) return 5;
    return strong(known) ? 6 : 5;
  }
  return 3;
}
const useAI = (s: GameState, st: Style) => s.extraPeeks && (st === 'all7ai' || st === 'mid' || ((st === 'carry' || st === 'fiveCarry') && s.carryIn >= 2 * s.bet));
function act(s: GameState, i: number, st: Style): GameAction {
  const p = s.seats[i]!;
  switch (s.phase) {
    case 'placement': {
      const t = peekTarget(s, p, st);
      if (p.peeked.length < t && (p.peeked.length < 3 || p.stack >= s.peekPrice)) return { type: 'peek', seat: i, index: [0,1,2,3,4,5,6].find((k) => !p.peeked.includes(k))! };
      const known = p.peeked.map((index) => ({ index, card: p.hand[index]! }));
      const unknown = [0,1,2,3,4,5,6].filter((k) => !p.peeked.includes(k));
      if (useAI(s, st)) {
        if (p.boardIndex === null) { const a = currentAdvice(s, i); if (!a) return { type: 'consult', seat: i } as GameAction; return { type: 'place', seat: i, index: (a.advice as any).boardIndex }; }
        return { type: 'arrange', seat: i, sets: ((p.advice ?? []).find((x) => x.topic === 'place')!.advice as any).sets };
      }
      if (st === 'rule3') {
        if (p.boardIndex === null) return { type: 'place', seat: i, index: chooseBoardIndex(known) };
        return { type: 'arrange', seat: i, sets: arrangeSets(known.filter((k) => k.index !== p.boardIndex), unknown) };
      }
      const h = humanPlace(known, unknown);
      if (p.boardIndex === null) return { type: 'place', seat: i, index: h.board };
      return { type: 'arrange', seat: i, sets: h.sets };
    }
    case 'reveal': return { type: 'flip', seat: i, index: p.sets!.flat().find((k) => !p.revealed.includes(k))! };
    case 'declare': case 'join': {
      if (!s.extraPeeks || p.stack <= Math.ceil(s.bet / 4)) return s.phase === 'declare' ? { type: 'declare', seat: i, yes: p.stack > 0 } : { type: 'join', seat: i, yes: false };
      const a = currentAdvice(s, i);
      if (!a) return { type: 'consult', seat: i } as GameAction;
      return { type: s.phase, seat: i, yes: (a.advice as ChallengeAdvice).recommend } as GameAction;
    }
    case 'swap': return { type: 'roulette', seat: i, cmd: s.challenge!.roulette === 'ready' ? 'start' : 'stop' };
  }
  throw new Error(s.phase);
}

const G = Number(process.argv[5] ?? 10);
const OPP: Style[] = ['all7ai', 'carry', 'rule3'];
const ME: Style[] = ['carry', 'base3', 'mid', 'all7ai'];
const res = Object.fromEntries(ME.map((m) => [m, { first: 0, rankSum: 0, chips: 0, n: 0 }]));
for (let k = 0; k < N; k++) {
  for (const me of ME) {
    const rng = seededRng(OFF + k + 1);
    const styles: Style[] = [me, ...OPP];
    let alive = [0, 1, 2, 3]; const chips = [5000, 5000, 5000, 5000].map((c) => c * B / 100 * 0 + 30 * B); let carry = 0; const out: number[] = [];
    for (let g = 1; g <= G; g++) {
      alive = alive.filter((i) => chips[i]! > 0);
      if (alive.length < 3) break;
      let s = newGame({ players: alive.map((i) => ({ id: 'p' + i, chips: chips[i]! })), bet: B, dealer: (g - 1) % alive.length, carryIn: carry, extraPeeks: g < G }, rng);
      while (s.phase !== 'result') { const pend = pendingSeats(s); s = apply(s, pend.length ? act(s, pend[0]!, styles[alive[pend[0]!]!]!) : { type: 'advance' }, rng); }
      carry = s.seats.reduce((t, p) => t + paidExtras(p), 0);
      s.seats.forEach((_, j) => { chips[alive[j]!] = s.result!.stacks[j]!; });
    }
    const order = [0, 1, 2, 3].sort((a, b) => chips[b]! - chips[a]!);
    const rank = order.indexOf(0) + 1; const t = res[me]!;
    t.n++; t.rankSum += rank; t.first += rank === 1 ? 1 / order.filter((i) => chips[i] === chips[0] && rank === 1).length : 0; t.chips += chips[0]! / B;
  }
}
console.log('RAW', JSON.stringify({ N, CB: G, acc: res }));
