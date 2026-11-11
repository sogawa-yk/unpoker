// チャレンジ中の勝ち筋表示（rules.md B-9）。見ている人が盛り上がるための表示で、判断には使わせない。
// 参加者が決まった後（入れ替えの場面）にだけ計算して配る。全員の札が公開済みなので、山札の中身は確定している。
// 外れる札 5 通り × 補充の札（山札の残り）をすべて数える。
import type { Card } from './cards.ts';
import { evaluate } from './evaluator.ts';
import type { GameState } from './game.ts';

export interface OutlookGroup {
  /** この札が出たら勝つ席（2 人以上なら引き分けで等分） */
  winners: number[];
  cards: Card[];
}

export interface ChallengeOutlook {
  /** 勝負に加わっている席（宣言・強制参加・便乗） */
  candidates: number[];
  /** 今の場札のまま（入れ替える前）で勝っている席 */
  leaders: number[];
  /** 外れる札が決まる前: 外れる位置ごとに、参加者それぞれが勝つ見込み（引き分けは等分して数える） */
  byIndex: { index: number; win: Record<number, number> }[];
  /** 外れる札が決まる前の、参加者それぞれが勝つ見込み（5 通りの平均） */
  overall: Record<number, number>;
  /** 外れる札が決まった後: 補充の札を、誰が勝つ札かでまとめる（多い順）。決まる前は null */
  afterSwap: { index: number; groups: OutlookGroup[]; win: Record<number, number> } | null;
}

function bestOf(g: GameState, seat: number, board: Card[]): number {
  const p = g.seats[seat]!;
  let best = -1;
  for (const [a, b] of p.sets ?? []) best = Math.max(best, evaluate([...board, p.hand[a]!, p.hand[b]!]));
  return best;
}

const winnersOn = (g: GameState, cands: number[], board: Card[]) => {
  const scores = cands.map((i) => bestOf(g, i, board));
  const top = Math.max(...scores);
  return cands.filter((_, k) => scores[k] === top);
};

/** 入れ替えの場面で計算する。それ以外の場面、チャレンジが無いときは null */
export function challengeOutlook(g: GameState): ChallengeOutlook | null {
  const ch = g.challenge;
  if (g.phase !== 'swap' || !ch) return null;
  const candidates = [...new Set([...ch.declarers, ...ch.forced, ...ch.joiners])].sort((a, b) => a - b);
  // 補充に使われうる札: 場札・全員の手札に無い札（＝山札の残り。入れ替えた後は引いた札も含める）
  const used = new Set<Card>([...g.board, ...g.seats.flatMap((p) => p.hand)]);
  if (ch.swap) {
    used.delete(ch.swap.added);
    used.add(ch.swap.removed); // 外した札は以降使わない
  }
  const pool: Card[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) pool.push(c);
  // 入れ替える前の場札
  const board = [...g.board];
  if (ch.swap) board[ch.swap.index] = ch.swap.removed;

  const zero = () => Object.fromEntries(candidates.map((i) => [i, 0])) as Record<number, number>;
  const tally = (index: number) => {
    const win = zero();
    const groups = new Map<string, OutlookGroup>();
    for (const c of pool) {
      const b = [...board];
      b[index] = c;
      const w = winnersOn(g, candidates, b);
      for (const i of w) win[i]! += 1 / w.length / pool.length;
      const key = w.join(',');
      const grp = groups.get(key) ?? { winners: w, cards: [] };
      grp.cards.push(c);
      groups.set(key, grp);
    }
    return { win, groups: [...groups.values()].sort((a, b) => b.cards.length - a.cards.length) };
  };

  const byIndex = board.map((_, index) => ({ index, win: tally(index).win }));
  const overall = zero();
  for (const x of byIndex) for (const i of candidates) overall[i]! += x.win[i]! / byIndex.length;
  let afterSwap: ChallengeOutlook['afterSwap'] = null;
  if (ch.swap) {
    const t = tally(ch.swap.index);
    afterSwap = { index: ch.swap.index, groups: t.groups, win: t.win };
  }
  return { candidates, leaders: winnersOn(g, candidates, board), byIndex, overall, afterSwap };
}
