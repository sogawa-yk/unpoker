// カード表現: card = rank * 4 + suit（rank 0=2 … 12=A、suit 0=♠ 1=♥ 2=♦ 3=♣）
export type Card = number;

export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'] as const;

export const rankOf = (c: Card): number => c >> 2;
export const suitOf = (c: Card): number => c & 3;

export const cardToString = (c: Card): string => `${RANKS[rankOf(c)]}${SUITS[suitOf(c)]}`;

export function parseCard(s: string): Card {
  const r = RANKS.indexOf(s[0] ?? '');
  const su = SUITS.indexOf(s[1] ?? '');
  if (r < 0 || su < 0 || s.length !== 2) throw new Error(`不正なカード: ${s}`);
  return r * 4 + su;
}

export const parseCards = (s: string): Card[] => s.trim().split(/\s+/).map(parseCard);

export const fullDeck = (): Card[] => Array.from({ length: 52 }, (_, i) => i);

/** 0 以上 1 未満の乱数を返す関数。サーバーでは暗号論的乱数、テストでは種付きの乱数を渡す */
export type Rng = () => number;

export function shuffle<T>(a: T[], rng: Rng): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/** 種付きの乱数（mulberry32）。テストとシミュレーション用 */
export function seededRng(seed: number): Rng {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 状態は JSON で表せる形にしているので、JSON で深いコピーを取る */
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
