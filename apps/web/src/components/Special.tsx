// 特殊効果カード（rules.md B-10。効果の細目は暫定）。スマホ: 持っているカード、使う確認、対象の札を選ぶ、札を渡す。iPad: 配布と使用の発表
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { SPECIALS, type GameView, type SeatView, type SpecialKind } from '@unpoker/core';
import type { GameActionMsg } from '../../../server/src/protocol.ts';
import type { Room, RoomView } from '../net.ts';
import { Card } from './Card.tsx';
import { HoldButton } from './bits.tsx';
import './special.css';

const SUITS = ['♠', '♥', '♦', '♣'];
/** 「使いますか？」の確認の持ち時間（rules.md B-10） */
export const SPECIAL_ASK_MS = 10_000;

/** 今この席がカードを使えるか（core の useSpecial と同じ条件をざっくり先に見る。最後はサーバーが決める） */
export function usableNow(g: GameView, me: SeatView, kind: SpecialKind): boolean {
  const sp = g.special;
  const you = g.you;
  if (!sp || you === null || sp.mine !== kind) return false;
  if (sp.banned !== null && sp.banned !== you) return false;
  const placing = g.phase === 'placement' && !me.arranged;
  const prov = g.provisional;
  const ch = g.challenge;
  switch (kind) {
    case 'extraSet':
      return placing && !me.placed;
    case 'surge':
      return placing && !me.placed && g.extraPeeks;
    case 'reroll':
    case 'suitReroll':
      return placing;
    case 'nut4x':
    case 'ban':
      return g.phase === 'placement';
    case 'passRight':
    case 'passLeft':
      return placing && me.placed && !sp.passing;
    case 'freeChallenge':
      return (
        (g.phase === 'declare' && !!prov && ((prov.lasts.includes(you) && !me.declareDone) || prov.firsts.includes(you))) ||
        (g.phase === 'join' && !!ch && ((ch.optional.includes(you) && !me.joinDone) || ch.forced.includes(you) || ch.declarers.includes(you)))
      );
    case 'anyChallenge':
      return g.phase === 'declare' && !!prov && !prov.firsts.includes(you) && !prov.lasts.includes(you) && me.stack > 0;
  }
}

const needsCard = (k: SpecialKind) => k === 'reroll' || k === 'suitReroll';

/**
 * スマホ: 持っているカードの表示と、使える時機の「使いますか？」（10 秒で使わない）。
 * 確認を閉じても、使える間は「カードを使う」ボタンで使える
 */
export function SpecialPanel({ g, me, act, gameNo }: { g: GameView; me: SeatView; act: (a: GameActionMsg) => void; gameNo: number }) {
  const kind = g.special?.mine ?? null;
  const usable = kind !== null && usableNow(g, me, kind);
  // 確認を出す時機ごとの鍵（同じ時機では 1 回だけ聞く）
  const askKey = usable ? `${gameNo}:${g.phase}:${me.placed}:${kind}` : null;
  const [asked, setAsked] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = askKey !== null && asked !== askKey && !choosing;
  useEffect(() => {
    if (!open) return;
    timer.current = setTimeout(() => setAsked(askKey), SPECIAL_ASK_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, askKey]);
  useEffect(() => {
    if (!usable) {
      setChoosing(false);
      setTarget(null);
    }
  }, [usable]);
  if (!kind) return null;
  const info = SPECIALS[kind];
  const use = () => {
    setAsked(askKey);
    if (needsCard(kind)) setChoosing(true);
    else act({ type: 'special', kind });
  };
  return (
    <section className="sp-panel" aria-label="特殊効果カード">
      <div className="sp-mine">
        <span className="sp-card" aria-hidden="true">
          {info.no}
        </span>
        <span className="sp-name">
          {info.name}
          <small>{info.desc}</small>
        </span>
        {usable && !open && !choosing && (
          <button className="btn btn-small" onClick={use}>
            使う
          </button>
        )}
      </div>
      <AnimatePresence>
        {open && (
          <motion.div className="sp-ask" role="dialog" aria-label="特殊効果カードを使いますか" initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ opacity: 0 }}>
            <p className="sp-ask-title">「{info.name}」を使いますか？</p>
            <div className="sp-ask-bar">
              <motion.i initial={{ scaleX: 1 }} animate={{ scaleX: 0 }} transition={{ duration: SPECIAL_ASK_MS / 1000, ease: 'linear' }} />
            </div>
            <div className="sp-ask-btns">
              <HoldButton className="btn btn-shu" onDone={use} ms={400}>
                長押しで使う
              </HoldButton>
              <button className="btn btn-ghost" onClick={() => setAsked(askKey)}>
                使わない
              </button>
            </div>
            <p className="muted small">10 秒たつと閉じます（使える間は、上の「使う」で使えます）</p>
          </motion.div>
        )}
      </AnimatePresence>
      {choosing && usable && (
        <div className="sp-choose">
          <p className="sp-ask-title">{target === null ? '入れ替える札を選ぶ' : kind === 'suitReroll' ? 'マークを選ぶ' : ''}</p>
          <div className="sp-hand">
            {me.cards.map((c, k) =>
              k === me.boardIndex ? null : (
                <Card
                  key={k}
                  card={c}
                  faceUp={me.known.includes(k) && c !== null}
                  unknown={!me.known.includes(k)}
                  width={44}
                  selected={target === k}
                  onClick={() => {
                    if (kind === 'reroll') {
                      act({ type: 'special', kind, index: k });
                      setChoosing(false);
                    } else setTarget(k);
                  }}
                />
              ),
            )}
          </div>
          {kind === 'suitReroll' && target !== null && (
            <div className="sp-suits">
              {SUITS.map((m, suit) => (
                <button
                  key={m}
                  className={`btn sp-suit${suit === 1 || suit === 2 ? ' red' : ''}`}
                  onClick={() => {
                    act({ type: 'special', kind, index: target, suit });
                    setChoosing(false);
                    setTarget(null);
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
          <button className="btn btn-ghost btn-small" onClick={() => setChoosing(false)}>
            やめる
          </button>
        </div>
      )}
    </section>
  );
}

/** スマホ: 札を渡している間、渡す札を選ぶ（場に出した札は渡せない） */
export function PassPicker({ g, me, act, name }: { g: GameView; me: SeatView; act: (a: GameActionMsg) => void; name: (i: number) => string }) {
  const p = g.special?.passing;
  if (!p || g.you === null) return null;
  const n = g.seats.length;
  const to = (g.you + p.dir + n) % n;
  if (p.myPick !== null)
    return (
      <section className="sp-choose">
        <p className="sp-ask-title">札を選びました。全員が選ぶと {name(to)} に渡ります</p>
      </section>
    );
  return (
    <section className="sp-choose" role="dialog" aria-label="渡す札を選ぶ">
      <p className="sp-ask-title">
        {p.dir === 1 ? '右' : '左'}隣（{name(to)}）へ渡す札を選ぶ
      </p>
      <p className="muted small">受け取った札は、渡した札の場所に入ります。20 秒で選ばなければランダムです</p>
      <div className="sp-hand">
        {me.cards.map((c, k) =>
          k === me.boardIndex ? null : (
            <Card key={k} card={c} faceUp={me.known.includes(k) && c !== null} unknown={!me.known.includes(k)} width={44} onClick={() => act({ type: 'pass', index: k })} />
          ),
        )}
      </div>
    </section>
  );
}

/** スマホ（対局の始め）: 持っているカードと新しいカードのどちらを持つか */
export function SpecialOffer({ room, s }: { room: Room; s: RoomView }) {
  const o = s.special?.offer;
  if (!o) return null;
  const cur = SPECIALS[o.current];
  const neu = SPECIALS[o.offered];
  return (
    <section className="sp-choose" aria-label="特殊効果カードを選ぶ">
      <p className="sp-ask-title">条件に当てはまったので、特殊効果カードが配られました。持てるのは 1 枚です</p>
      <div className="sp-offer">
        <button className="sp-opt" onClick={() => room.send({ t: 'specialPick', take: false })}>
          <small>持っているカード</small>
          <b>{cur.name}</b>
          <span>{cur.desc}</span>
        </button>
        <button className="sp-opt new" onClick={() => room.send({ t: 'specialPick', take: true })}>
          <small>新しいカード</small>
          <b>{neu.name}</b>
          <span>{neu.desc}</span>
        </button>
      </div>
    </section>
  );
}

/** iPad: 使われたカードを大きく発表する（新しく使われたときだけ） */
export function SpecialUsedBanner({ g, names }: { g: GameView; names: string[] }) {
  const used = g.special?.used ?? [];
  const [show, setShow] = useState<{ seat: number; kind: SpecialKind } | null>(null);
  const seen = useRef(used.length);
  useEffect(() => {
    if (used.length > seen.current) {
      setShow(used[used.length - 1]!);
      const t = setTimeout(() => setShow(null), 2600);
      seen.current = used.length;
      return () => clearTimeout(t);
    }
    seen.current = used.length;
  }, [used.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="sp-used" initial={{ opacity: 0, scale: 1.2 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
          <span className="sp-card big">{SPECIALS[show.kind].no}</span>
          <p>
            <b>{names[show.seat]}</b> が特殊効果カード「{SPECIALS[show.kind].name}」を使いました
          </p>
          <small>{SPECIALS[show.kind].desc}</small>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * iPad（対局の始め）: 配った特殊効果カードの発表。当てはまった人が複数なら、名前の上を光が回って 1 人に止まる。
 * どの条件で配ったか、カードの種類は伏せる
 */
export function SpecialDealShow({ s }: { s: RoomView }) {
  const deals = s.special?.deals ?? [];
  const name = (id: string) => s.players.find((p) => p.id === id)?.name ?? '？';
  const [step, setStep] = useState(0); // 何件目まで決まったか
  const [lit, setLit] = useState<string | null>(null);
  useEffect(() => {
    setStep(0);
  }, [s.matchNo]);
  useEffect(() => {
    const d = deals[step];
    if (!d) return;
    let i = 0;
    const order = d.candidates.length > 1 ? d.candidates : [d.recipient];
    const spins = d.candidates.length > 1 ? 12 + order.indexOf(d.recipient) : 0;
    const iv = setInterval(() => {
      setLit(order[i % order.length]!);
      if (i >= spins) {
        clearInterval(iv);
        setLit(d.recipient);
        setTimeout(() => setStep((x) => x + 1), 900);
      }
      i++;
    }, 110);
    return () => clearInterval(iv);
  }, [step, deals.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (deals.length === 0) return null;
  return (
    <section className="sp-deals" aria-label="特殊効果カードの配布">
      <p className="sp-deals-title">特殊効果カードを配ります（前の対局の成績から）</p>
      {deals.map((d, k) => (
        <div key={k} className={`sp-deal${k < step ? ' done' : ''}`}>
          <span className="muted small">条件 {k + 1}</span>
          <span className="sp-cands">
            {d.candidates.map((id) => (
              <span key={id} className={`sp-cand${(k === step && lit === id) || (k < step && id === d.recipient) ? ' lit' : ''}`}>
                {name(id)}
              </span>
            ))}
          </span>
          {k < step && <span className="sp-got">→ {name(d.recipient)} に配布</span>}
        </div>
      ))}
    </section>
  );
}
