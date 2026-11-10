// 初期の場札を見て「場に出す札」を選ぶ打ち方を、相手の打ち方別に比べる（同じ配り方、3 枚めくり）
// 使い方: npx tsx sim/board-card.ts ゲーム数 人数 [席0の打ち方をカンマ区切り]（相手を絞るなら OPP=smart など）
import { apply, arrangeSets, categoryOf, currentAdvice, keepScore, newGame, pendingSeats, rankOf, suitOf, seededRng, type Card, type GameAction, type GameState } from '../packages/core/src/index.ts';
const N = Number(process.argv[2] ?? 2000), PL = Number(process.argv[3] ?? 4), B = 100;
type K = { index: number; card: Card };
type Style = 'smart' | 'feed' | 'deny' | 'mine' | 'ai';
const MINE: Style[] = (process.argv[4] ?? 'smart,feed,deny,mine,ai').split(',') as Style[];
const OPP: Style[] = (process.env.OPP ?? 'smart,feed,deny,mine').split(',') as Style[];

const pairVal = (kept: K[]) => { let v = -1e9; for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) v = Math.max(v, keepScore(kept[i]!.card, kept[j]!.card)); return v; };
// 場札と同じマーク or 同じ数字
const hitsBoard = (c: Card, board: Card[]) => board.some((b) => suitOf(b) === suitOf(c) || rankOf(b) === rankOf(c));
// 残す 2 枚とつながる（同じマーク or 同じ数字）
const connects = (c: Card, kept: K[]) => kept.some((k) => suitOf(k.card) === suitOf(c) || rankOf(k.card) === rankOf(c));

function pickBoard(peeked: K[], board: Card[], st: Style): number {
  let best = -1e9, pick = peeked[0]!.index;
  for (const p of peeked) {
    const kept = peeked.filter((q) => q !== p);
    let v = pairVal(kept);
    const hit = hitsBoard(p.card, board), con = connects(p.card, kept);
    if (st === 'feed' && hit) v += 8; // 場札に合う札を出して場を育てる
    if (st === 'deny' && hit) v -= 8; // 場札に合う札は出さない
    if (st === 'mine' && hit) v += con ? 8 : -8; // 自分の残す札とつながるなら出し、つながらないなら出さない
    if (v > best) { best = v; pick = p.index; }
  }
  return pick;
}

function act(s: GameState, i: number, st: Style): GameAction {
  const p = s.seats[i]!;
  switch (s.phase) {
    case 'placement': {
      if (p.peeked.length < 3) return { type: 'peek', seat: i, index: [0, 1, 2, 3, 4, 5, 6].find((k) => !p.peeked.includes(k))! };
      const known = p.peeked.map((index) => ({ index, card: p.hand[index]! }));
      const unknown = [0, 1, 2, 3, 4, 5, 6].filter((k) => !p.peeked.includes(k) );
      if (st === 'ai') {
        if (p.boardIndex === null) { const a = currentAdvice(s, i); if (!a) return { type: 'consult', seat: i } as GameAction; return { type: 'place', seat: i, index: (a.advice as any).boardIndex }; }
        return { type: 'arrange', seat: i, sets: ((p.advice ?? []).find((x) => x.topic === 'place')!.advice as any).sets };
      }
      if (p.boardIndex === null) return { type: 'place', seat: i, index: pickBoard(known, s.initialBoard, st) };
      return { type: 'arrange', seat: i, sets: arrangeSets(known.filter((k) => k.index !== p.boardIndex), unknown.filter((k) => k !== p.boardIndex)) };
    }
    case 'reveal': return { type: 'flip', seat: i, index: p.sets!.flat().find((k) => !p.revealed.includes(k))! };
    case 'declare': return { type: 'declare', seat: i, yes: p.stack > 0 };
    case 'join': { const prov = s.provisional!; return { type: 'join', seat: i, yes: categoryOf(prov.scores[prov.firsts[0]!]!) - categoryOf(prov.scores[i]!) <= 1 }; }
    case 'swap': return { type: 'roulette', seat: i, cmd: s.challenge!.roulette === 'ready' ? 'start' : 'stop' };
    default: throw new Error(s.phase);
  }
}

console.log(`${PL} 人、${N} ゲーム。値は席0の 仮1位率 / 最終勝率（同率は等分）。公平 ${(100 / PL).toFixed(1)}%`);
console.log(['相手＼席0', ...MINE].join(' | '));
for (const opp of OPP) {
  const row: string[] = [opp];
  for (const me of MINE) {
    let prov = 0, fin = 0;
    for (let k = 0; k < N; k++) {
      const rng = seededRng(k + 1);
      let s = newGame({ players: Array.from({ length: PL }, (_, i) => ({ id: 'p' + i, chips: 100000 })), bet: B, dealer: k % PL, carryIn: 0 }, rng);
      let gotProv = false;
      while (s.phase !== 'result') {
        if (!gotProv && s.provisional) { const f = s.provisional.firsts; if (f.includes(0)) prov += 1 / f.length; gotProv = true; }
        const pend = pendingSeats(s);
        s = apply(s, pend.length ? act(s, pend[0]!, pend[0] === 0 ? me : opp) : { type: 'advance' }, rng);
      }
      const w = s.result!.winners; if (w.includes(0)) fin += 1 / w.length;
    }
    row.push(`${(prov / N * 100).toFixed(1)}% / ${(fin / N * 100).toFixed(1)}%`);
  }
  console.log(row.join(' | '));
}
