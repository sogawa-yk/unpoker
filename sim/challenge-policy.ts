// 席 0 のチャレンジの判断を比べる（同じ配り方、4 人、B=100、配置は 3 枚めくり）
// 使い方: npx tsx sim/challenge-policy.ts 試合数 持ち越し(B単位) 乱数の種のずらし
// never（宣言・便乗しない）/ rule（最下位は宣言、便乗は役の段階差 1 以内）/ always / ai（AI 相談に従う）/ oracle（ai と同じで相談料を返す）
import { categoryOf, apply, arrangeSets, chooseBoardIndex, currentAdvice, keepScore, newGame, paidExtras, pendingSeats, rankOf, suitOf, seededRng, type Card, type GameAction, type GameState, type ChallengeAdvice } from '../packages/core/src/index.ts';
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
type Style = 'base3' | 'five' | 'carry' | 'fiveCarry' | 'all7ai' | 'rule3';
function peekTarget(s: GameState, p: GameState['seats'][number], st: Style): number {
  if (!s.extraPeeks) return 3;
  const bigPot = s.carryIn >= 2 * s.bet;
  if (st === 'all7ai' || ((st === 'carry' || st === 'fiveCarry') && bigPot)) return 7;
  if (st === 'five' || st === 'fiveCarry') {
    const known = p.peeked.map((index) => ({ index, card: p.hand[index]! }));
    if (p.peeked.length < 5) return 5;
    return strong(known) ? 6 : 5;
  }
  return 3;
}
const useAI = (s: GameState, st: Style) => s.extraPeeks && (st === 'all7ai' || ((st === 'carry' || st === 'fiveCarry') && s.carryIn >= 2 * s.bet));
let POL = 'ai';
function act(s: GameState, i: number, st: Style): GameAction {
  const p = s.seats[i]!;
  if (i === 0 && (s.phase === 'declare' || s.phase === 'join')) {
    const prov = s.provisional!;
    const gap = categoryOf(prov.scores[prov.firsts[0]!]!) - categoryOf(prov.scores[i]!);
    const yes = POL === 'never' ? false : POL === 'always' ? true : POL === 'rule' ? (s.phase === 'declare' ? true : gap <= 1) : null;
    if (yes !== null) return { type: s.phase, seat: i, yes: yes && p.stack > 0 } as GameAction;
    const a = currentAdvice(s, i);
    if (!a) {
      if (!s.extraPeeks || p.stack <= Math.ceil(s.bet / 4)) return { type: s.phase, seat: i, yes: false } as GameAction;
      return { type: 'consult', seat: i } as GameAction;
    }
    return { type: s.phase, seat: i, yes: (a.advice as ChallengeAdvice).recommend } as GameAction;
  }
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
const OPP: Style[] = ['all7ai', 'carry', 'rule3'];
const ME = ['never', 'rule', 'always', 'ai', 'oracle'];
const acc = Object.fromEntries(ME.map((m) => [m, { d: 0, w: 0, fee: 0, nut: 0, peeks: 0, ch: 0, chw: 0 }]));
for (let k = 0; k < N; k++) {
  for (const me of ME) {
    POL = me;
    const rng = seededRng(OFF + k + 1);
    const styles: Style[] = ['rule3', ...OPP];
    let s = newGame({ players: styles.map((_, i) => ({ id: 'p' + i, chips: 5000 })), bet: B, dealer: k % 4, carryIn: CB * B }, rng);
    while (s.phase !== 'result') { const pend = pendingSeats(s); const a0 = pend.length ? act(s, pend[0]!, styles[pend[0]!]!) : ({ type: 'advance' } as GameAction);
      s = apply(s, a0, rng);
      if (POL === 'oracle' && a0.type === 'consult' && (a0 as any).seat === 0 && (s.phase === 'declare' || s.phase === 'join')) { const f = Math.ceil(B / 4); s.seats[0]!.stack += f; s.seats[0]!.adviceFee -= f; } }
    const r = s.result!; const a = acc[me]!;
    a.d += (r.stacks[0]! - 5000) / B; a.w += r.winners.includes(0) ? 1 / r.winners.length : 0; a.fee += paidExtras(s.seats[0]!) / B; a.nut += r.nut && r.winners.includes(0) ? 1 : 0; a.peeks += s.seats[0]!.peeked.length; const inCh = !!s.challenge && [...s.challenge.declarers, ...s.challenge.joiners].includes(0); a.ch += +inCh; a.chw += +(inCh && r.winners.includes(0));
  }
}
console.log('RAW', JSON.stringify({ N, CB, acc }));
