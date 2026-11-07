// AI 相談（rules.md B-6）。相談ボタンと、返ってきた答えの表示
import type { AdviceRecord, AdviceTopic, ChallengeAdvice, ChallengeOption, GameView, PlacementAdvice, SeatView } from '@unpoker/core';
import type { GameActionMsg } from '../../../server/src/protocol.ts';
import { Card, cardName } from './Card.tsx';
import { PaidButton, signed } from './bits.tsx';

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
        <p className="advice advice-line">
          <span className="advice-tag">AI</span>
          <span>
            枠に薄く出ている組み方がおすすめ。1 位の見込み <b>{pct(a.win)}</b>
          </span>
        </p>
      );
    return (
      <section className="advice" aria-label="AI の答え">
        {'sets' in a ? <PlacementAnswer a={a} me={me} g={g} /> : <ChallengeAnswer a={a} name={name} />}
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
            を場に出すのがおすすめ。1 位の見込み <b>{pct(a.win)}</b>
          </span>
        </p>
      ) : (
        <p className="advice-line">
          <span className="advice-tag">AI</span>
          <span>
            この組み方がおすすめ。1 位の見込み <b>{pct(a.win)}</b>
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

function ChallengeAnswer({ a, name }: { a: ChallengeAdvice; name: (i: number) => string }) {
  const yesLabel = a.topic === 'declare' ? 'チャレンジする' : '乗る';
  const others = (xs: number[]) => (xs.length ? `${xs.map(name).join('・')} も乗る` : '誰も乗らない');
  const row = (label: string, o: ChallengeOption, rec: boolean, showWin: boolean) => (
    <div className={`advice-opt${rec ? ' rec' : ''}`}>
      <span className="advice-opt-label">
        {rec && <span className="advice-tag">AI</span>}
        {label}
      </span>
      <span className="advice-opt-num">
        {showWin && <>勝率 <b>{pct(o.win)}</b>・</>}期待 <b>{signed(Math.round(o.ev))}</b> 点
      </span>
    </div>
  );
  const showScen = (o: ChallengeOption) => o.scenarios.length > 1;
  return (
    <>
      {row(yesLabel, a.yes, a.recommend, true)}
      {row('見送る', a.no, !a.recommend, a.topic === 'join')}
      <p className="advice-sub">予想: {others(a.yes.predicted)}（他の人も期待収支で決めると仮定）</p>
      {(showScen(a.yes) || showScen(a.no)) && (
        <details className="advice-more">
          <summary>他の人の判断ごとの内訳</summary>
          <table>
            <thead>
              <tr>
                <th>他の人</th>
                <th>{yesLabel}</th>
                <th>見送る</th>
              </tr>
            </thead>
            <tbody>
              {a.yes.scenarios.map((s, i) => {
                const n = a.no.scenarios.find((x) => x.others.join() === s.others.join()) ?? a.no.scenarios[0]!;
                return (
                  <tr key={i}>
                    <td>{others(s.others)}</td>
                    <td>
                      {pct(s.win)}・{signed(Math.round(s.ev))}
                    </td>
                    <td>{signed(Math.round(n.ev))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
      <p className="advice-foot">入れ替わる札の全パターンから計算しています。勝てるかは運次第</p>
    </>
  );
}
