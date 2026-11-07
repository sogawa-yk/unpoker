// 7 枚（または 5〜7 枚）から最強 5 枚の役を数値化する。値が大きいほど強い。
// カード表現: card = rank * 4 + suit（rank 0=2 … 12=A、suit 0..3）

export const CATEGORY = [
  'ハイカード', 'ワンペア', 'ツーペア', 'スリーカード', 'ストレート',
  'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ',
];

const pack = (cat, ks) => {
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 16 + (ks[i] ?? 0);
  return v;
};

export const categoryOf = (score) => Math.floor(score / 16 ** 5);

// 13 ビットの rank マスクから最も高いストレートの最上位 rank を返す（無ければ -1）
const straightTop = (mask) => {
  for (let top = 12; top >= 4; top--) {
    const m = 0b11111 << (top - 4);
    if ((mask & m) === m) return top;
  }
  // A-2-3-4-5
  if ((mask & 0b1000000001111) === 0b1000000001111) return 3;
  return -1;
};

export function evaluate(cards) {
  const cnt = new Array(13).fill(0);
  const suitMask = [0, 0, 0, 0];
  const suitCnt = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) {
    const r = c >> 2, s = c & 3;
    cnt[r]++;
    suitMask[s] |= 1 << r;
    suitCnt[s]++;
    mask |= 1 << r;
  }

  // フラッシュ系
  for (let s = 0; s < 4; s++) {
    if (suitCnt[s] >= 5) {
      const sf = straightTop(suitMask[s]);
      if (sf >= 0) return pack(8, [sf]);
      const ks = [];
      for (let r = 12; r >= 0 && ks.length < 5; r--) if (suitMask[s] & (1 << r)) ks.push(r);
      // フラッシュより強いのはフォーカード/フルハウスのみ。下で判定するため保留
      var flush = pack(5, ks);
      break;
    }
  }

  const quads = [], trips = [], pairs = [], singles = [];
  for (let r = 12; r >= 0; r--) {
    if (cnt[r] === 4) quads.push(r);
    else if (cnt[r] === 3) trips.push(r);
    else if (cnt[r] === 2) pairs.push(r);
    else if (cnt[r] === 1) singles.push(r);
  }

  if (quads.length) {
    const q = quads[0];
    let k = -1;
    for (let r = 12; r >= 0; r--) if (r !== q && cnt[r] > 0) { k = r; break; }
    return pack(7, [q, k]);
  }
  if (trips.length && (trips.length >= 2 || pairs.length)) {
    const t = trips[0];
    const p = Math.max(trips[1] ?? -1, pairs[0] ?? -1);
    return pack(6, [t, p]);
  }
  if (flush !== undefined) return flush;
  const st = straightTop(mask);
  if (st >= 0) return pack(4, [st]);
  if (trips.length) {
    const ks = [];
    for (let r = 12; r >= 0 && ks.length < 2; r--) if (r !== trips[0] && cnt[r] > 0) ks.push(r);
    return pack(3, [trips[0], ...ks]);
  }
  if (pairs.length >= 2) {
    const [a, b] = pairs;
    let k = -1;
    for (let r = 12; r >= 0; r--) if (r !== a && r !== b && cnt[r] > 0) { k = r; break; }
    return pack(2, [a, b, k]);
  }
  if (pairs.length === 1) {
    const ks = [];
    for (let r = 12; r >= 0 && ks.length < 3; r--) if (r !== pairs[0] && cnt[r] > 0) ks.push(r);
    return pack(1, [pairs[0], ...ks]);
  }
  return pack(0, singles.slice(0, 5));
}

// 場札 5 枚に対して、場以外の全カードから作れる 2 枚の組み合わせのうち最強の値（ナッツ判定用）
export function nutScore(board) {
  const used = new Set(board);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  let best = 0;
  const seven = [...board, 0, 0];
  for (let i = 0; i < rest.length; i++) {
    seven[5] = rest[i];
    for (let j = i + 1; j < rest.length; j++) {
      seven[6] = rest[j];
      const v = evaluate(seven);
      if (v > best) best = v;
    }
  }
  return best;
}
