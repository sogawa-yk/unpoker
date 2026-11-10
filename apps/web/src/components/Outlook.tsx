// チャレンジ中の勝ち筋表示（rules.md B-9）。見ている人が盛り上がるための表示で、参加者が決まった後にだけ出る。
// ① ルーレットが回っている間: 場札ごとに「この札が消えたら、誰が勝つ見込みか」
// ② 外れる札が決まった後: 次にめくる札を「誰が勝つ札か」で色分け。めくれたら答え合わせ
// 言葉は rules.md「確率の書き方」に合わせる（何に勝つのか、いつの話か、10 回やったら何回）
import type { Card as CardT, ChallengeOutlook, GameView } from '@unpoker/core';
import { motion } from 'motion/react';
import { Card, cardName, isRed } from './Card.tsx';
import type { SwapAnim } from './TableBits.tsx';
import './outlook.css';

export const pct = (p: number) => `${Math.round(p * 100)}%`;

/** 「10 回やったら何回」。0 回と 10 回は、ほぼ無い・ほぼ確実と言い換える */
export function tenTimes(p: number): string {
  const n = Math.round(p * 10);
  if (p > 0 && n === 0) return '10 回に 1 回もない';
  if (p < 1 && n === 10) return 'ほぼ確実';
  if (p === 0) return '勝てない';
  if (p === 1) return '必ず勝つ';
  return `10 回やったら ${n} 回くらい`;
}

export type OutlookStage = 'before' | 'after' | 'answer';

/** 画面の演出に合わせた段階。顔ぶれの発表中は出さない。光が止まって札が燃え始めたら ②、新しい札がめくれたら答え合わせ */
export function outlookStage(g: GameView, swap: SwapAnim): OutlookStage | null {
  if (g.phase !== 'swap' || !g.outlook || swap.intro) return null;
  if (swap.revealNew) return 'answer';
  if (g.outlook.afterSwap && (swap.burning || swap.done)) return 'after';
  return 'before';
}

/** 席ごとの色（名前の前の点と、色分けの帯） */
export const seatClass = (i: number) => `seat-c${i % 4}`;

function Who({ seats, name, you }: { seats: number[]; name: (i: number) => string; you?: number | null }) {
  return (
    <span className="ol-who">
      {seats.map((i) => (
        <span key={i} className={`ol-name ${seatClass(i)}`}>
          <i aria-hidden="true" />
          {i === you ? 'あなた' : name(i)}
        </span>
      ))}
    </span>
  );
}

/** ① 場札 1 枚の下: この札が消えたら、参加者それぞれが勝つ見込み（高い順） */
export function SlotOdds({ o, k, name, you }: { o: ChallengeOutlook; k: number; name: (i: number) => string; you?: number | null }) {
  const x = o.byIndex[k];
  if (!x) return null;
  const rows = o.candidates.map((i) => ({ i, p: x.win[i] ?? 0 })).sort((a, b) => b.p - a.p || a.i - b.i);
  return (
    <motion.div className="ol-slot" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} aria-label="この札が消えたら">
      <span className="ol-slot-head">消えたら</span>
      {rows.map((r, j) => (
        <span key={r.i} className={`ol-slot-row${j === 0 && r.p > 0 ? ' top' : ''}`}>
          <Who seats={[r.i]} name={name} you={you} />
          <b>{pct(r.p)}</b>
        </span>
      ))}
    </motion.div>
  );
}

/** 札を小さな文字の札で（例: ♥5）。札の絵より場所を取らない */
function Chip({ c, hit }: { c: CardT; hit?: boolean }) {
  return <span className={`ol-chip${isRed(c) ? ' red' : ''}${hit ? ' hit' : ''}`}>{cardName(c)}</span>;
}

/**
 * ② 次にめくる札で、誰が勝つか（色分け）。1 人勝ちは人ごとに 1 行、引き分けはまとめて 1 行。
 * stage が answer なら、引いた札の行を光らせる
 */
export function OutlookGroups({
  o,
  name,
  you,
  added,
  stage,
}: {
  o: ChallengeOutlook;
  name: (i: number) => string;
  you?: number | null;
  added: CardT | null;
  stage: 'after' | 'answer';
}) {
  const a = o.afterSwap;
  if (!a) return null;
  const total = a.groups.reduce((s, x) => s + x.cards.length, 0);
  const solo = a.groups.filter((x) => x.winners.length === 1).sort((x, y) => y.cards.length - x.cards.length);
  const ties = a.groups.filter((x) => x.winners.length > 1);
  const rows = [
    ...solo.map((x) => ({ key: String(x.winners[0]), winners: x.winners, cards: x.cards, tie: false })),
    ...(ties.length ? [{ key: 'tie', winners: [...new Set(ties.flatMap((x) => x.winners))].sort(), cards: ties.flatMap((x) => x.cards), tie: true }] : []),
  ];
  return (
    <motion.section className="ol-groups" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} aria-label="次にめくる札で決まる">
      <p className="ol-title">{stage === 'answer' ? '答え合わせ' : `次にめくる札で決まる（残り ${total} 枚）`}</p>
      {rows.map((r) => {
        const hit = stage === 'answer' && added !== null && r.cards.includes(added);
        return (
          <div key={r.key} className={`ol-group ${r.tie ? 'tie' : seatClass(r.winners[0]!)}${hit ? ' hit' : ''}${stage === 'answer' && !hit ? ' miss' : ''}`}>
            <span className="ol-group-label">
              {r.tie ? <span>引き分け（等分）</span> : <Who seats={r.winners} name={name} you={you} />}
              {!r.tie && 'の勝ち'}
              <small>
                {r.cards.length} 枚・{pct(r.cards.length / total)}
              </small>
            </span>
            <span className="ol-cards">
              {[...r.cards].sort((x, y) => x - y).map((c) => (
                <Chip key={c} c={c} hit={hit && c === added} />
              ))}
            </span>
          </div>
        );
      })}
    </motion.section>
  );
}

/** スマホ用: 自分の見込みを中心に、短く */
export function PhoneOutlook({ g, swap, name, board, showCards = true }: { g: GameView; swap: SwapAnim; name: (i: number) => string; board: CardT[]; showCards?: boolean }) {
  const stage = outlookStage(g, swap);
  const o = g.outlook;
  if (!stage || !o) return null;
  const you = g.you;
  const mine = you !== null && o.candidates.includes(you);
  if (stage === 'before') {
    const p = mine ? o.overall[you!]! : null;
    return (
      <section className="ol-phone" aria-label="勝ち筋">
        {p !== null ? (
          <p className="ol-big">
            このチャレンジで、あなたが最後に勝つ見込み <b>{pct(p)}</b>
            <small>（{tenTimes(p)}。どの札が消えるかは運次第）</small>
          </p>
        ) : (
          <p className="ol-big">どの札が消えると誰が勝つか</p>
        )}
        <div className="ol-phone-slots">
          {o.byIndex.map((x) => (
            <div key={x.index} className={`ol-phone-slot${swap.highlight === x.index ? ' lit' : ''}`}>
              {showCards && board[x.index] !== undefined && <Card card={board[x.index]!} faceUp width={44} />}
              <SlotOdds o={o} k={x.index} name={name} you={you} />
            </div>
          ))}
        </div>
      </section>
    );
  }
  const a = o.afterSwap!;
  const p = mine ? a.win[you!]! : null;
  return (
    <section className="ol-phone" aria-label="勝ち筋">
      {p !== null && stage === 'after' && (
        <p className="ol-big">
          次にめくる札で、あなたが勝つ見込み <b>{pct(p)}</b>
          <small>（{tenTimes(p)}）</small>
        </p>
      )}
      <OutlookGroups o={o} name={name} you={you} added={g.challenge?.swap?.added ?? null} stage={stage} />
    </section>
  );
}
