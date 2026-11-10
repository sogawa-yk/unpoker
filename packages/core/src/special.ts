// 特殊効果カード（rules.md B-10。効果の細目は暫定で、遊んでみて調整する）
// ゲーム中の効果（useSpecial / passPick）と、対局の始めに配る仕組み（distributeSpecials）
import { suitOf, type Card, type Rng } from './cards.ts';
import type { PlayerStats } from './stats.ts';

export type SpecialKind =
  | 'extraSet' // 1. 1 組増やす（2 枚 × 4 組）
  | 'reroll' // 2. 自分の札 1 枚をランダムに変える
  | 'freeChallenge' // 3. チャレンジを無料にする
  | 'anyChallenge' // 4. 最下位以外でもチャレンジ
  | 'nut4x' // 5. ナッツの獲得を 4 倍
  | 'suitReroll' // 6. マークを指定して自分の札 1 枚を変える
  | 'ban' // 7. 特殊効果カードの使用を禁止
  | 'passRight' // 8. 右回りに 1 枚渡す
  | 'passLeft' // 9. 左回りに 1 枚渡す
  | 'surge'; // 10. 今のゲーム 2 組増やし、次のゲーム 1 組減らす

/** 使える時機 */
export type SpecialTiming = 'placement' | 'declare' | 'challenge';

export interface SpecialInfo {
  no: number;
  name: string;
  /** 効果の説明（スマホと iPad に出す） */
  desc: string;
  timing: SpecialTiming;
}

export const SPECIALS: Record<SpecialKind, SpecialInfo> = {
  extraSet: { no: 1, name: '1 組増やす', desc: '札を 2 枚多く配り、2 枚 × 4 組にする。場に札を出す前に使う', timing: 'placement' },
  reroll: { no: 2, name: '札を入れ替える', desc: '自分の札を 1 枚選び、山札からランダムな 1 枚に変える。組み方を決める前に使う', timing: 'placement' },
  freeChallenge: { no: 3, name: 'チャレンジ無料', desc: 'チャレンジの参加費を払わない（宣言・便乗・挑まれたとき）', timing: 'challenge' },
  anyChallenge: { no: 4, name: 'どこからでも挑戦', desc: '最下位でなくてもチャレンジを宣言できる（1 位は使えない）', timing: 'declare' },
  nut4x: { no: 5, name: 'ナッツ 4 倍', desc: '勝ったときにナッツなら、負けた人 1 人あたり 3B を受け取る。場札の公開の前に使う', timing: 'placement' },
  suitReroll: { no: 6, name: 'マーク指定の入れ替え', desc: 'マークを指定して、自分の札 1 枚を山札のそのマークの札に変える。組み方を決める前に使う', timing: 'placement' },
  ban: { no: 7, name: '使用禁止', desc: 'このゲームの間、ほかの人は特殊効果カードを使えない', timing: 'placement' },
  passRight: { no: 8, name: '右回りに渡す', desc: '全員が札を 1 枚選び、右隣へ渡す。場に札を出した後に使う', timing: 'placement' },
  passLeft: { no: 9, name: '左回りに渡す', desc: '全員が札を 1 枚選び、左隣へ渡す。場に札を出した後に使う', timing: 'placement' },
  surge: { no: 10, name: '今 2 組増やす', desc: 'このゲームは札を 4 枚多く（2 枚 × 5 組）、次のゲームは 2 枚 × 2 組。最終ゲームでは使えない', timing: 'placement' },
};

export const SPECIAL_KINDS = Object.keys(SPECIALS) as SpecialKind[];

/** 札を増やす効果の後に、山札に残しておく枚数（チャレンジの補充用） */
export const MIN_DECK_AFTER_DEAL = 10;

/** ゲーム中の特殊効果カードの状態 */
export interface SpecialGame {
  /** 席ごとに持っているカード（使ったら null） */
  held: (SpecialKind | null)[];
  /** 使われたカード（全員に公開） */
  used: { seat: number; kind: SpecialKind }[];
  /** 使用禁止を使った席 */
  banned: number | null;
  /** ナッツ 4 倍を使った席 */
  nut4x: number[];
  /** チャレンジ無料を使った席 */
  free: number[];
  /** 最下位でなくても宣言した席 */
  extraDeclarers: number[];
  /** 「今 2 組増やす」を使った席（次のゲームで 1 組減らす） */
  surged: number[];
  /** 札を渡している間（dir は +1 が右隣、-1 が左隣）。picks は各席が渡す札の位置 */
  passing: { dir: 1 | -1; picks: (number | null)[] } | null;
}

export const newSpecialGame = (held: (SpecialKind | null)[]): SpecialGame => ({
  held,
  used: [],
  banned: null,
  nut4x: [],
  free: [],
  extraDeclarers: [],
  surged: [],
  passing: null,
});

/** 山札から指定のマークの札をランダムに 1 枚抜く（無ければ null） */
export function drawWhere(deck: Card[], rng: Rng, pred: (c: Card) => boolean): Card | null {
  const idx = deck.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return null;
  const k = idx[Math.floor(rng() * idx.length)]!;
  return deck.splice(k, 1)[0]!;
}

export const suitIs = (suit: number) => (c: Card) => suitOf(c) === suit;

// ---- 対局の始めに配る（B-10） ----

export interface SpecialCondition {
  key: string;
  /** 条件の説明（記録と分析用。プレイヤーには見せない） */
  label: string;
  /** 当てはまる人の ID */
  pick: (stats: PlayerStats[]) => string[];
}

const mostOf = (stats: PlayerStats[], f: (s: PlayerStats) => number) => {
  const top = Math.max(...stats.map(f));
  return top > 0 ? stats.filter((s) => f(s) === top).map((s) => s.id) : [];
};
const leastOf = (stats: PlayerStats[], f: (s: PlayerStats) => number) => {
  const low = Math.min(...stats.map(f));
  return stats.filter((s) => f(s) === low).map((s) => s.id);
};

export const SPECIAL_CONDITIONS: SpecialCondition[] = [
  { key: 'last', label: '最終順位が最下位', pick: (st) => st.filter((s) => s.rank === Math.max(...st.map((x) => x.rank)) && s.rank > 1).map((s) => s.id) },
  { key: 'second', label: '最終順位が 2 位', pick: (st) => (st.length >= 3 ? st.filter((s) => s.rank === 2).map((s) => s.id) : []) },
  {
    key: 'firstBust',
    label: '最初に脱落した',
    pick: (st) => {
      const b = st.filter((s) => s.bustedAt !== null);
      if (!b.length) return [];
      const first = Math.min(...b.map((s) => s.bustedAt!));
      return b.filter((s) => s.bustedAt === first).map((s) => s.id);
    },
  },
  { key: 'fewestWins', label: '勝ったゲームが最も少ない', pick: (st) => leastOf(st, (s) => s.wins) },
  { key: 'challengeLosses', label: 'チャレンジで負けた回数が最も多い', pick: (st) => mostOf(st, (s) => s.challengeLosses) },
  { key: 'reversed', label: '仮 1 位から逆転された回数が最も多い', pick: (st) => mostOf(st, (s) => s.reversed) },
  { key: 'nutLosses', label: '相手のナッツで負けた回数が最も多い', pick: (st) => mostOf(st, (s) => s.nutLosses) },
  { key: 'boardOnly', label: '自分の札が役を上げなかったゲームが最も多い', pick: (st) => mostOf(st, (s) => s.boardOnly) },
  { key: 'comebacks', label: 'チャレンジで逆転勝ちした回数が最も多い', pick: (st) => mostOf(st, (s) => s.comebacks) },
  { key: 'leastSpent', label: '使ったクレジットが最も少ない', pick: (st) => leastOf(st, (s) => s.spent) },
];

/** 配った結果（公開するのは recipient と candidates だけ。条件と種類は伏せる） */
export interface SpecialDeal {
  condition: string;
  candidates: string[];
  recipient: string;
  kind: SpecialKind;
}

/**
 * 条件を 2〜3 個引き、条件 1 つにつき 1 枚を、当てはまる人（複数ならランダムに 1 人）に配る。
 * 前の対局にいなかった人は対象外（stats に無い）。当てはまる人がいない条件では配らない
 */
export function drawSpecialDeals(stats: PlayerStats[], present: string[], rng: Rng): SpecialDeal[] {
  const st = stats.filter((s) => present.includes(s.id));
  if (st.length === 0) return [];
  const pool = [...SPECIAL_CONDITIONS];
  const count = 2 + Math.floor(rng() * 2);
  const out: SpecialDeal[] = [];
  for (let k = 0; k < count && pool.length; k++) {
    const cond = pool.splice(Math.floor(rng() * pool.length), 1)[0]!;
    const candidates = cond.pick(st);
    if (candidates.length === 0) continue;
    const recipient = candidates[Math.floor(rng() * candidates.length)]!;
    const kind = SPECIAL_KINDS[Math.floor(rng() * SPECIAL_KINDS.length)]!;
    out.push({ condition: cond.key, candidates, recipient, kind });
  }
  return out;
}
