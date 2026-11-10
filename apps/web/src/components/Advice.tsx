// AI 相談（rules.md B-6）。相談ボタンと、返ってきた答えの表示
import type { AdviceRecord, AdviceTopic, ChallengeAdvice, ChallengeOption, GameView, PlacementAdvice, SeatView } from '@unpoker/core';
import type { GameActionMsg } from '../../../server/src/protocol.ts';
import { Card, cardName } from './Card.tsx';
import { PaidButton } from './bits.tsx';
import { tenTimes } from './Outlook.tsx';

/** 今この席が相談できる判断（core の adviceTopic と同じ判定） */
export function topicNow(g: GameView, me: SeatView): AdviceTopic | null {
  const you = g.you!;
  if (g.phase === 'placement' && !me.arranged) return me.peekedCount < 3 ? null : me.placed ? 'arrange' : 'place';
  if (g.phase === 'declare' && g.provisional?.lasts.includes(you) && !me.declareDone && me.stack > 0) return 'declare';
  if (g.phase === 'join' && g.challenge?.optional.includes(you) && !me.joinDone) return 'join';
  return null;
}

/** 組み方のおすすめ（枠の順に 6 つの手札の位置）。組み方の相談か、同じ札を場に出した配置の相談の答えから取る */
export function arrangePlan(g: GameView, me: SeatView): number[] | null {
  const rec = adviceNow(g, me);
  const a =
    rec && 'sets' in rec.advice
      ? rec.advice
      : [...me.advice].reverse().find((r) => 'sets' in r.advice && r.advice.boardIndex === me.boardIndex)?.advice;
  return a && 'sets' in a ? a.sets.flat() : null;
}

/** 今の判断について、もう相談していればその記録 */
export function adviceNow(g: GameView, me: SeatView): AdviceRecord | null {
  const topic = topicNow(g, me);
  if (!topic) return null;
  const key = topic === 'place' ? `place:${me.peekedCount}` : topic;
  return me.advice.find((a) => a.key === key) ?? null;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** 相談ボタン（料金がかかるので長押し）。相談済みなら答えを出す */
export function AdvicePanel({
  g,
  me,
  act,
  name,
  compact,
}: {
  g: GameView;
  me: SeatView;
  act: (a: GameActionMsg) => void;
  name: (i: number) => string;
  /** 組み方の画面用: 答えは 1 行だけ（おすすめは枠の中に薄く出す） */
  compact?: boolean;
}) {
  const topic = topicNow(g, me);
  if (!topic) return null;
  const rec = adviceNow(g, me);
  if (rec) {
    const a = rec.advice;
    if (compact && 'sets' in a)
      return (
        <div className="advice">
          <p className="advice-line">
            <span className="advice-tag">AI</span>
            <span>
              枠に薄く出ている組み方がおすすめ。仮順位で 1 位になる見込み <b>{pct(a.win)}</b>
            </span>
          </p>
          <Explanation rec={rec} folded />
        </div>
      );
    return (
      <section className="advice" aria-label="AI の答え">
        {'sets' in a ? <PlacementAnswer a={a} me={me} g={g} /> : <ChallengeAnswer a={a} name={name} />}
        <Explanation rec={rec} />
      </section>
    );
  }
  const challenge = topic === 'declare' || topic === 'join';
  const fee = challenge ? g.advicePrice.challenge : g.advicePrice.placement;
  const enough = challenge ? me.stack > fee : me.stack >= fee;
  const what = topic === 'place' ? 'どの札を場に出すか' : topic === 'arrange' ? 'どう組むか' : topic === 'declare' ? 'チャレンジするか' : '乗るか';
  const note = !g.extraPeeks
    ? '最終ゲームなので、相談できません'
    : !enough
      ? '持ち点が足りないので、相談できません'
      : compact
        ? undefined
        : `${what}を数字で答えます。相談したことは全員に表示されます`;
  return (
    <PaidButton cost={fee} stack={me.stack} onDone={() => act({ type: 'consult' })} disabled={!g.extraPeeks || !enough} note={note}>
      長押しで AI に相談
    </PaidButton>
  );
}

/** 生成 AI の説明文。数字の後から届く。作れなかったときは何も出さない */
function Explanation({ rec, folded }: { rec: AdviceRecord; folded?: boolean }) {
  if (rec.explaining)
    return (
      <p className="advice-explain pending" aria-live="polite">
        AI が理由を書いています…
      </p>
    );
  if (!rec.explanation) return null;
  if (folded)
    return (
      <details className="advice-more">
        <summary>AI の説明を読む</summary>
        <p className="advice-explain">{rec.explanation}</p>
      </details>
    );
  return (
    <p className="advice-explain" aria-live="polite">
      {rec.explanation}
    </p>
  );
}

function PlacementAnswer({ a, me, g }: { a: PlacementAdvice; me: SeatView; g: GameView }) {
  const mini = (k: number) => {
    const known = me.known.includes(k);
    return <Card key={k} card={known ? (me.cards[k] ?? null) : null} faceUp={known} unknown={!known} width={30} />;
  };
  return (
    <>
      {a.topic === 'place' ? (
        <p className="advice-line">
          <span className="advice-tag">AI</span>
          {mini(a.boardIndex)}
          <span>
            を場に出すのがおすすめ。仮順位で 1 位になる見込み <b>{pct(a.win)}</b>（{tenTimes(a.win)}）
          </span>
        </p>
      ) : (
        <p className="advice-line">
          <span className="advice-tag">AI</span>
          <span>
            この組み方がおすすめ。仮順位で 1 位になる見込み <b>{pct(a.win)}</b>（{tenTimes(a.win)}）
          </span>
        </p>
      )}
      <div className="advice-sets" aria-label="おすすめの組み方">
        {a.sets.map(([x, y], i) => (
          <div className="advice-pair" key={i}>
            {mini(x)}
            {mini(y)}
          </div>
        ))}
      </div>
      {a.topic === 'place' && a.candidates.length > 1 && (
        <p className="advice-sub">
          ほかの札を出すと:{' '}
          {a.candidates
            .slice(1)
            .map((c) => `${me.cards[c.index] != null ? cardName(me.cards[c.index]!) : '？'} ${pct(c.win)}`)
            .join('、')}
        </p>
      )}
      {a.peekWin !== null && (
        <p className="advice-sub">
          1 枚追加でめくると、見込みは {pct(a.win)} → <b>{pct(a.peekWin)}</b>（料金 {g.peekPrice} 点）
        </p>
      )}
      <p className="advice-foot">相手は札を適当に組むと仮定した推定です。勝てるかは運次第</p>
    </>
  );
}

/** 「平均すると 1 ゲームで何点得（損）」 */
const gainText = (d: number) => {
  const n = Math.round(d);
  return n === 0 ? 'どちらでも平均はほぼ同じ' : `平均すると 1 ゲームで ${Math.abs(n).toLocaleString()} 点${n > 0 ? '得' : '損'}`;
};

/**
 * チャレンジの相談の答え（rules.md「確率の書き方」）。
 * 一番大きく出すのは「ほかに誰も乗らなかった場合」。ほかの場合は小さく添える
 */
function ChallengeAnswer({ a, name }: { a: ChallengeAdvice; name: (i: number) => string }) {
  const declare = a.topic === 'declare';
  const yesLabel = declare ? 'チャレンジする' : '乗る';
  const alone = (o: ChallengeOption) => o.scenarios.find((x) => x.others.length === 0) ?? o.scenarios[0] ?? { others: [], win: o.win, ev: o.ev };
  const y = alone(a.yes);
  const n = alone(a.no);
  const vs = declare ? '1 位の人とだけ戦った場合' : '宣言した人と 1 位の人とだけ戦った場合';
  const others = a.yes.scenarios.filter((x) => x.others.length > 0);
  const who = (xs: number[]) => xs.map(name).join('・');
  return (
    <>
      <p className="advice-main">
        <span className="advice-tag">AI</span>
        {yesLabel}と、あなたが最後に 1 位になる見込み <b>{pct(y.win)}</b>
        <small>
          （{tenTimes(y.win)}。{vs}）
        </small>
      </p>
      <p className="advice-line">
        {yesLabel}ほうが、見送るより{gainText(y.ev - n.ev)}
      </p>
      {others.length > 0 && (
        <p className="advice-sub">
          {others.map((x) => `${who(x.others)} も乗ってきたら ${pct(x.win)}`).join('、')}
        </p>
      )}
      <p className="advice-sub">
        {a.yes.predicted.length
          ? `AI の予想: ${who(a.yes.predicted)} も乗る。そのときは${a.recommend ? `${yesLabel}ほう` : '見送るほう'}が得（${gainText(Math.abs(a.yes.ev - a.no.ev))}）`
          : 'AI の予想: ほかに誰も乗らない（上の数字のとおり）'}
      </p>
      <p className="advice-foot">入れ替わる札の全パターンから数えています。勝てるかは運次第</p>
    </>
  );
}
