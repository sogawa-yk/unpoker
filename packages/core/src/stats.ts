// 対局の成績（プレイヤーごと）。次の対局で特殊効果カードを配る条件に使う（rules.md B-10）
import type { MatchState } from './match.ts';

export interface PlayerStats {
  id: string;
  /** 最終順位（1 始まり。持ち点が同じなら同じ順位） */
  rank: number;
  players: number;
  /** 持ち点が 0 になったゲームの番号（脱落していなければ null） */
  bustedAt: number | null;
  /** 勝ったゲームの数（引き分けを含む） */
  wins: number;
  /** チャレンジに加わって勝てなかった回数 */
  challengeLosses: number;
  /** 仮 1 位から、チャレンジで逆転された回数 */
  reversed: number;
  /** チャレンジを宣言して勝った（逆転勝ち）回数 */
  comebacks: number;
  /** 相手のナッツで負けた回数 */
  nutLosses: number;
  /** 自分の札が役を上げなかったゲームの数 */
  boardOnly: number;
  /** 追加めくりと AI 相談に使った額 */
  spent: number;
  /** 遊んだゲームの数 */
  games: number;
}

/** 終わった対局の成績 */
export function matchStats(m: MatchState): PlayerStats[] {
  const ranking = m.ranking ?? [...m.players].sort((a, b) => b.chips - a.chips).map((p) => p.id);
  const chips = new Map(m.players.map((p) => [p.id, p.chips]));
  return m.players.map((p) => {
    const st: PlayerStats = {
      id: p.id,
      rank: 1 + ranking.filter((id) => (chips.get(id) ?? 0) > (chips.get(p.id) ?? 0)).length,
      players: m.players.length,
      bustedAt: null,
      wins: 0,
      challengeLosses: 0,
      reversed: 0,
      comebacks: 0,
      nutLosses: 0,
      boardOnly: 0,
      spent: 0,
      games: 0,
    };
    let stack = m.config.initialChips;
    for (const h of m.history) {
      if (!h.seatIds.includes(p.id)) continue;
      st.games++;
      stack += h.delta[p.id] ?? 0;
      if (stack <= 0 && st.bustedAt === null) st.bustedAt = h.gameNo;
      const won = h.winners.includes(p.id);
      if (won) st.wins++;
      const d = h.detail;
      if (!d) continue;
      const inChallenge = [...d.declarers, ...d.forced, ...d.joiners].includes(p.id);
      if (inChallenge && !won) st.challengeLosses++;
      if (d.reversed.includes(p.id)) st.reversed++;
      if (d.declarers.includes(p.id) && won) st.comebacks++;
      if (d.nutLosers.includes(p.id)) st.nutLosses++;
      if (d.boardOnly.includes(p.id)) st.boardOnly++;
      st.spent += d.spent[p.id] ?? 0;
    }
    return st;
  });
}
