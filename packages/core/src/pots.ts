// ポットの分配（rules.md 付録 B-3 のサイドポット、B-4 のナッツ増額）

export interface LayerInput {
  /** 各プレイヤーがこのポットに出した額 */
  contrib: number[];
  /** 受け取り資格の上限額。-1 なら資格なし。通常は自分の拠出額と同じ */
  eligibleLevel: number[];
  /** 役の強さ（大きいほど強い）。資格のある人だけ見る */
  score: number[];
  /** 端数を渡す優先順（席順。先頭ほど優先） */
  tieOrder: number[];
}

/**
 * 拠出額を段に分けて、各段を資格のある人の中で最も強い人に渡す。
 * 同点は等分し、割り切れない端数は tieOrder の早い勝者へ。資格者のいない段は出した人へ返す。
 * 返り値は各プレイヤーの受取額。
 */
export function distributeLayers({ contrib, eligibleLevel, score, tieOrder }: LayerInput): number[] {
  const n = contrib.length;
  const payout = new Array<number>(n).fill(0);
  const levels = [...new Set([...contrib, ...eligibleLevel].filter((x) => x > 0))].sort((a, b) => a - b);
  let prev = 0;
  for (const level of levels) {
    const parts = contrib.map((c) => Math.max(0, Math.min(c, level) - prev));
    const amount = parts.reduce((a, b) => a + b, 0);
    if (amount > 0) {
      const eligible = [...Array(n).keys()].filter((i) => eligibleLevel[i]! >= level);
      if (eligible.length === 0) {
        parts.forEach((p, i) => (payout[i]! += p));
      } else {
        const top = Math.max(...eligible.map((i) => score[i]!));
        const winners = tieOrder.filter((i) => eligible.includes(i) && score[i] === top);
        const each = Math.floor(amount / winners.length);
        let rest = amount - each * winners.length;
        for (const w of winners) {
          payout[w]! += each + (rest > 0 ? 1 : 0);
          if (rest > 0) rest--;
        }
      }
    }
    prev = level;
  }
  return payout;
}
