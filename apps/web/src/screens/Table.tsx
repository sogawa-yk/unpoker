// テーブル（iPad・横向き）。公開情報だけを受け取り、演出を担当する
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { handName, type Card as CardT, type GameView, type SeatView } from '@unpoker/core';
import { Card } from '../components/Card.tsx';
import { Chips, ConnBadge, Gauge, signed, Toast } from '../components/bits.tsx';
import { provisionalRank, revealOdds, type HandOdds } from '../game.ts';
import { useRoom, type Room, type RoomView } from '../net.ts';
import { RuleSettings, useJoinQr } from '../components/RoomSettings.tsx';
import { Board, PauseButton, SoundButton, stampDelay, useSwapAnimation, useTableSounds } from '../components/TableBits.tsx';
import { sfx } from '../sound.ts';
import './table.css';

export function TableScreen({ roomId, navigate }: { roomId: string | null; navigate: (path: string, replace?: boolean) => void }) {
  const room = useRoom(roomId, 'table', (send) => {
    if (!roomId) send({ t: 'createRoom' });
  });
  const s = room.state;
  useEffect(() => {
    if (s && !roomId) navigate(`/table/${s.roomId}`, true);
  }, [s, roomId, navigate]);
  useWakeLock();

  return (
    <div className="tbl felt">
      <ConnBadge room={room} />
      <Toast room={room} />
      {!s ? (
        <div className="tbl-center muted">{room.error?.code === 'room_not_found' ? <NotFound navigate={navigate} /> : 'テーブルを準備しています…'}</div>
      ) : s.status === 'lobby' ? (
        <Lobby room={room} s={s} />
      ) : s.status === 'finished' ? (
        <Finished s={s} navigate={navigate} />
      ) : s.game ? (
        <TableGame room={room} s={s} g={s.game} />
      ) : s.betting ? (
        <TableBetting room={room} s={s} />
      ) : null}
    </div>
  );
}

function NotFound({ navigate }: { navigate: (p: string) => void }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <p>このテーブルは見つかりません。期限が切れたか、URL が違います。</p>
      <button className="btn" onClick={() => navigate('/table')}>
        新しいテーブルを作る
      </button>
    </div>
  );
}

/** iPad の画面が暗くならないようにする（未対応なら何もしない） */
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const req = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        lock = (await wl?.request('screen')) ?? null;
      } catch {
        /* 設定の「自動ロック：なし」で代用 */
      }
    };
    void req();
    const onVis = () => document.visibilityState === 'visible' && void req();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, []);
}

// ---------------------------------------------------------------- 待機

function Lobby({ room, s }: { room: Room; s: RoomView }) {
  const qr = useJoinQr(s.roomId);
  return (
    <div className="lobby">
      <section className="lobby-join">
        <h1 className="wordmark">unpoker</h1>
        <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} aria-label="参加用の QR コード" />
        <p className="lobby-hint">スマホのカメラで読み取って参加</p>
        <p className="room-code" aria-label="ルームコード">
          {s.roomId}
        </p>
      </section>
      <section className="lobby-side">
        <h2 className="lobby-h">卓につく人</h2>
        <ul className="lobby-players">
          {[0, 1, 2, 3].map((i) => {
            const p = s.players[i];
            return (
              <li key={p?.id ?? `empty-${i}`} className={p ? '' : 'empty'}>
                {p ? (
                  <>
                    <span className={`dot${p.connected ? ' on' : ''}`} aria-label={p.connected ? '接続中' : '切断中'} />
                    <span className="lp-name">{p.name}</span>
                    <button className="lp-kick" onClick={() => room.send({ t: 'kick', playerId: p.id })} aria-label={`${p.name} を外す`}>
                      外す
                    </button>
                  </>
                ) : (
                  <span className="muted">空席</span>
                )}
              </li>
            );
          })}
        </ul>
        <h2 className="lobby-h">ルール設定</h2>
        <RuleSettings room={room} s={s} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- 対局

const SIDES: Record<number, ('bottom' | 'left' | 'top' | 'right')[]> = {
  3: ['bottom', 'left', 'right'],
  4: ['bottom', 'left', 'top', 'right'],
};

function TableGame({ room, s, g }: { room: Room; s: RoomView; g: GameView }) {
  const names = g.seats.map((sv) => s.players.find((p) => p.id === sv.id)?.name ?? '？');
  const sides = SIDES[g.seats.length] ?? SIDES[4]!;
  const swapDone = useSwapAnimation(g, s.gameNo);
  const nextCarry = g.seats.reduce((a, x) => a + x.peekFee, 0);
  useTableSounds(s, g);
  // 公開フェーズの見込み: テーブルに見えている札（場札とめくれた札）だけから計算する
  const visibleKey = g.phase === 'reveal' ? JSON.stringify([g.board, g.seats.map((x) => x.cards)]) : '';
  const odds = useMemo(() => {
    if (g.phase !== 'reveal') return null;
    const visible = new Set<CardT>();
    g.board.forEach((c) => c !== null && visible.add(c));
    g.seats.forEach((x) => x.cards.forEach((c) => c !== null && visible.add(c)));
    return g.seats.map((x) => revealOdds(x, g.board, visible));
  }, [visibleKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`game${g.phase === 'swap' && !swapDone.intro && !swapDone.revealNew ? ' swapping' : ''}`} data-phase={g.phase}>
      <header className="game-head">
        <span>
          {s.gameNo} ゲーム目{s.config.maxGames ? ` ／ ${s.config.maxGames}` : ''}
        </span>
        <span className={rotatingBet(s) ? 'bet-now' : undefined}>
          ベット <Chips n={g.bet} />
        </span>
        {g.carryIn > 0 && (
          <span className="carry" title="このゲームの勝者が受け取る">
            持ち越しポット <Chips n={g.carryIn} />
          </span>
        )}
        {nextCarry > 0 && (
          <span className="carry next" title="追加めくりの料金。次のゲームの勝者が受け取る">
            次へ <Chips n={nextCarry} />
          </span>
        )}
      </header>
      <div className="game-ctrl">
        {g.phase !== 'result' && s.config.timeLimit !== false && <PauseButton room={room} s={s} />}
        <SoundButton />
      </div>
      <div className="arena">
        {g.seats.map((sv, i) => (
          <SeatPanel key={sv.id} g={g} seat={i} sv={sv} name={names[i]!} side={sides[i]!} swapDone={swapDone.done} odds={odds?.[i] ?? null} />
        ))}
        <div className="center">
          <Banner g={g} names={names} />
          <Board g={g} swap={swapDone} />
          <div className="center-gauge">
            <Gauge room={room} />
          </div>
          {g.phase === 'result' && (
            <motion.button
              className="btn next"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, transition: { delay: 1.6 } }}
              onClick={() => room.send({ t: 'nextGame' })}
            >
              {s.config.maxGames !== null && s.gameNo >= s.config.maxGames ? '最終結果を見る' : '次のゲームへ'}
            </motion.button>
          )}
        </div>
      </div>
      <NutOverlay g={g} />
      <ChallengeBanner g={g} s={s} names={names} />
      <ChallengeIntro g={g} names={names} show={g.phase === 'swap' && swapDone.intro} />
      <BetAnnounce s={s} g={g} names={names} />
    </div>
  );
}

const rotatingBet = (s: RoomView) => s.config.betMode === 'rotating';

/** 持ち回り方式: 親がベット額を選んでいる間のテーブル */
function TableBetting({ room, s }: { room: Room; s: RoomView }) {
  const b = s.betting!;
  const name = s.players.find((p) => p.id === b.dealerId)?.name ?? '？';
  const lo = b.options[0]!;
  const hi = b.options[b.options.length - 1]!;
  return (
    <div className="game">
      <header className="game-head">
        <span>
          {s.gameNo} ゲーム目{s.config.maxGames ? ` ／ ${s.config.maxGames}` : ''}
        </span>
      </header>
      <div className="game-ctrl">
        {s.config.timeLimit !== false && <PauseButton room={room} s={s} />}
        <SoundButton />
      </div>
      <div className="betting">
        <span className="dealer big" aria-hidden="true">
          親
        </span>
        <p className="betting-title">
          <b>{name}</b> がベット額を決めています
        </p>
        <p className="muted">{lo === hi ? `${lo}（親の持ち点に合わせて）` : `${lo.toLocaleString()} 〜 ${hi.toLocaleString()} から選びます`}</p>
        <div className="center-gauge">
          <Gauge room={room} />
        </div>
      </div>
    </div>
  );
}

/** 持ち回り方式: 配った直後に、そのゲームのベット額を大きく発表する（B-0） */
function BetAnnounce({ s, g, names }: { s: RoomView; g: GameView; names: string[] }) {
  const [shown, setShown] = useState<number | null>(null);
  const seen = useRef(0);
  useEffect(() => {
    if (!rotatingBet(s) || g.phase !== 'placement' || seen.current === s.gameNo) return;
    seen.current = s.gameNo;
    setShown(s.gameNo);
    sfx.stamp(0.15);
    const t = setTimeout(() => setShown(null), 2600);
    return () => clearTimeout(t);
  }, [s.gameNo, g.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AnimatePresence>
      {shown !== null && (
        <motion.div className="bet-announce" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            className="bet-announce-card"
            initial={{ scale: 1.6, rotate: -8, opacity: 0 }}
            animate={{ scale: 1, rotate: -3, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 320, damping: 18 }}
          >
            <span className="bet-announce-label">親 {names[g.dealer]} が決めたベット</span>
            <span className="bet-announce-value">{g.bet.toLocaleString()}</span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Banner({ g, names }: { g: GameView; names: string[] }) {
  const listNames = (xs: number[]) => xs.map((i) => names[i]).join('・');
  let text: string;
  switch (g.phase) {
    case 'placement':
      text = '手元で札を配置しています';
      break;
    case 'boardReveal':
      text = '場札を公開';
      break;
    case 'reveal':
      text = `${names[g.revealTurn]} がめくる番`;
      break;
    case 'ranking':
      text = '仮順位';
      break;
    case 'declare':
      text = `${listNames(g.provisional!.lasts)} がチャレンジを考えています`;
      break;
    case 'join':
      text = '便乗するか考えています';
      break;
    case 'swap': {
      const r = g.challenge?.roulette;
      const who = names[g.challenge?.roller ?? -1] ?? '';
      text = r === 'ready' ? `${who} がルーレットを回します` : r === 'spinning' ? `${who} がストップを押します` : '場札を 1 枚入れ替えます';
      break;
    }
    case 'result':
      text = `${listNames(g.result!.winners)} の勝ち`;
      break;
  }
  return (
    <div className="banner-wrap">
      <AnimatePresence mode="wait">
        <motion.p
          key={text}
          className={`banner${g.phase === 'result' ? ' win' : ''}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.35 }}
        >
          {text}
        </motion.p>
      </AnimatePresence>
      {g.challenge && ['join', 'swap'].includes(g.phase) && (
        <motion.span className="seal challenge" initial={{ scale: 2.2, opacity: 0, rotate: -14 }} animate={{ scale: 1, opacity: 1, rotate: -6 }} transition={{ type: 'spring', stiffness: 320, damping: 16 }}>
          CHALLENGE
        </motion.span>
      )}
    </div>
  );
}

/** 宣言の瞬間（便乗を待つ間）: 「挑戦」の印を大きく押す */
function ChallengeBanner({ g, s, names }: { g: GameView; s: RoomView; names: string[] }) {
  const [shown, setShown] = useState(false);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (g.phase !== 'join' || !g.challenge || seen.current === s.gameNo) return;
    seen.current = s.gameNo;
    setShown(true);
    const t = setTimeout(() => setShown(false), 2600);
    return () => clearTimeout(t);
  }, [g.phase, s.gameNo]); // eslint-disable-line react-hooks/exhaustive-deps
  const ch = g.challenge;
  return (
    <AnimatePresence>
      {shown && ch && (
        <motion.div className="ch-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.span
            className="seal ch-seal"
            initial={{ scale: 2.6, rotate: -18, opacity: 0 }}
            animate={{ scale: 1, rotate: -6, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 14 }}
          >
            挑戦
          </motion.span>
          <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.5 } }}>
            {ch.declarers.map((i) => names[i]).join('・')} が {ch.forced.map((i) => names[i]).join('・')} に勝負を挑みました
          </motion.p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 入れ替えの前: 勝負の顔ぶれを 1 人ずつ押印して見せる */
function ChallengeIntro({ g, names, show }: { g: GameView; names: string[]; show: boolean }) {
  const ch = g.challenge;
  const rows = ch
    ? [
        ...ch.declarers.map((i) => ({ i, tag: '挑戦' })),
        ...ch.forced.map((i) => ({ i, tag: '受けて立つ' })),
        ...ch.joiners.map((i) => ({ i, tag: '便乗' })),
      ]
    : [];
  const step = Math.min(0.55, 2.0 / Math.max(1, rows.length));
  useEffect(() => {
    if (!show) return;
    rows.forEach((_, k) => sfx.stamp(0.25 + k * step));
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="ch-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.4 } }}>
          <p className="ch-title">勝負の顔ぶれ</p>
          <div className="ch-rows">
            {rows.map((r, k) => (
              <motion.div
                key={`${r.tag}-${r.i}`}
                className="ch-row"
                initial={{ opacity: 0, scale: 1.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.25 + k * step, type: 'spring', stiffness: 380, damping: 18 }}
              >
                <span className={`seal${r.tag === '挑戦' ? '' : r.tag === '受けて立つ' ? ' kin' : ' ai'}`}>{r.tag}</span>
                <span className="ch-name">{names[r.i]}</span>
              </motion.div>
            ))}
          </div>
          <p className="ch-sub">場札が 1 枚、ランダムに入れ替わります</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const SEAT_CARD = 58;

function SeatPanel({ g, seat, sv, name, side, swapDone, odds }: { g: GameView; seat: number; sv: SeatView; name: string; side: string; swapDone: boolean; odds: HandOdds | null }) {
  const prov = g.provisional;
  const res = g.result;
  const isTurn = g.phase === 'reveal' && g.revealTurn === seat;
  const isLast = prov?.lasts.includes(seat);
  const ch = g.challenge;
  const spotlight = (g.phase === 'declare' && isLast && !sv.declareDone) || (g.phase === 'join' && ch?.optional.includes(seat) && !sv.joinDone) || isTurn;
  const out = res && !res.candidates.includes(seat);
  const winner = res?.winners.includes(seat);
  // 結果では入れ替え後の役、仮順位〜入れ替え中は仮の役
  const showResult = res && swapDone;
  const score = showResult ? res.scores[seat]! : prov?.scores[seat];
  const bestSetIdx = showResult ? res.bestSet[seat] : prov?.bestSet[seat];
  const rank = provisionalRank(g, seat);
  const status = (() => {
    if (g.phase === 'placement') {
      if (sv.arranged) return '配置完了';
      if (sv.placed) return '組を作っています';
      return sv.peekedCount > 3 ? `めくった札 3 ＋ 追加 ${sv.peekedCount - 3}` : `めくった札 ${sv.peekedCount} / 3`;
    }
    if (g.phase === 'declare' && isLast) return sv.declareDone ? '決めました' : '考え中…';
    if (g.phase === 'join' && ch?.optional.includes(seat)) return sv.joinDone ? '決めました' : '考え中…';
    return null;
  })();
  const tags: string[] = [];
  if (ch?.declarers.includes(seat)) tags.push('挑戦');
  if (ch?.forced.includes(seat)) tags.push('受けて立つ');
  if (ch?.joiners.includes(seat)) tags.push('便乗');
  if (sv.peekedCount > 3) tags.push(`追加めくり ${sv.peekedCount - 3}`);
  // AI に相談したことは公開する（B-6）。今の判断で相談していれば「相談中」
  const nowTopics = g.phase === 'placement' ? ['place', 'arrange'] : g.phase === 'declare' || g.phase === 'join' ? [g.phase] : [];
  const consulting = sv.consulted.some((t) => nowTopics.includes(t)) && (g.phase !== 'placement' || !sv.arranged);
  if (consulting) tags.push('AI 相談中');
  else if (sv.consulted.length > 0) tags.push(`AI 相談 ${sv.consulted.length}`);

  return (
    <div className={`seat side-${side}${spotlight ? ' spot' : ''}${out ? ' out' : ''}${winner ? ' winner' : ''}`}>
      <div className="seat-head">
        <span className="seat-name">{name}</span>
        {g.dealer === seat && <span className="dealer" aria-label="親">親</span>}
        <Chips n={res ? res.stacks[seat]! : sv.stack} />
        {tags.map((t) => (
          <span key={t} className={`tag${t.startsWith('AI') ? ' ai' : t.startsWith('追加') ? ' kin' : ''}`}>
            {t}
          </span>
        ))}
      </div>
      <div className="seat-cards">
        {sv.sets ? (
          sv.sets.map((pair, si) => (
            <div key={si} className={`pair${bestSetIdx === si && score !== undefined ? ' best' : ''}`}>
              {pair.map((k) => (
                <Card key={k} card={sv.cards[k] ?? null} faceUp={sv.cards[k] !== null} width={SEAT_CARD} win={!!winner && bestSetIdx === si} />
              ))}
            </div>
          ))
        ) : (
          <div className="pair loose">
            {Array.from({ length: 7 }, (_, k) => (
              <motion.div key={k} animate={{ y: k < sv.peekedCount ? -6 : 0, opacity: sv.placed && k === 0 ? 0.25 : 1 }}>
                <Card card={null} faceUp={false} width={SEAT_CARD - 10} />
              </motion.div>
            ))}
          </div>
        )}
      </div>
      <div className="seat-foot">
        {status && <span className="muted">{status}</span>}
        {odds && <OddsLine odds={odds} />}
        <AnimatePresence>
          {score !== undefined && (g.phase !== 'reveal' && g.phase !== 'boardReveal') && (
            <motion.span
              key={showResult ? 'final' : 'prov'}
              className={`seal${winner ? ' kin' : ''}`}
              initial={{ scale: 2, opacity: 0, rotate: -16 }}
              animate={{ scale: 1, opacity: 1, rotate: -6 }}
              transition={{ type: 'spring', stiffness: 380, damping: 18, delay: g.phase === 'ranking' ? stampDelay(g, seat) : 0 }}
            >
              {showResult ? (winner ? `勝 ${handName(score)}` : handName(score)) : `${rank}位 ${handName(score)}`}
            </motion.span>
          )}
        </AnimatePresence>
        {res && swapDone && (
          <motion.span className={`delta${res.delta[seat]! >= 0 ? ' plus' : ' minus'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.8 } }}>
            {signed(res.delta[seat]!)}
          </motion.span>
        )}
      </div>
    </div>
  );
}

function NutOverlay({ g }: { g: GameView }) {
  const [show, setShow] = useState(false);
  const nut = g.phase === 'result' && g.result?.nut;
  useEffect(() => {
    if (!nut) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 2600);
    return () => clearTimeout(t);
  }, [nut]);
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="nut" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.span className="seal kin nut-seal" initial={{ scale: 3, rotate: -20 }} animate={{ scale: 1, rotate: -6 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }}>
            ナッツ
          </motion.span>
          <p>この場で作れる最強の役。ベット分が倍になります</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------- 終了

function Finished({ s, navigate }: { s: RoomView; navigate: (p: string) => void }) {
  const ranked = useMemo(() => (s.ranking ?? []).map((id) => s.players.find((p) => p.id === id)!).filter(Boolean), [s]);
  return (
    <div className="finished">
      <h1 className="wordmark small">最終結果</h1>
      <ol className="final-list">
        {ranked.map((p, i) => (
          <motion.li key={p.id} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0, transition: { delay: 0.3 + (ranked.length - i) * 0.5 } }}>
            <span className={`seal${i === 0 ? ' kin' : ''}`} style={{ '--i': i } as CSSProperties}>
              {i + 1}位
            </span>
            <span className="final-name">{p.name}</span>
            <Chips n={p.chips} />
          </motion.li>
        ))}
      </ol>
      <p className="muted">{s.history.length} ゲーム遊びました</p>
      {s.refund && Object.keys(s.refund).length > 0 && (
        <p className="muted">
          受け取る人がいなかった持ち越しポットは、払った人へ返しました（
          {Object.entries(s.refund)
            .map(([id, v]) => `${s.players.find((p) => p.id === id)?.name ?? '?'} ${v}`)
            .join('、')}
          ）
        </p>
      )}
      <button className="btn" onClick={() => navigate('/table')}>
        新しい対局を始める
      </button>
    </div>
  );
}

/** 公開フェーズの途中経過: 今の役と、この先なりそうな役（めくるたびに更新） */
function OddsLine({ odds }: { odds: HandOdds }) {
  return (
    <div className="odds">
      <span className="live-hand">{odds.current.name}</span>
      <AnimatePresence initial={false}>
        {odds.chances.slice(0, 3).map((c) => (
          <motion.span
            key={c.category}
            layout
            className={`chance${c.category >= 6 ? ' big' : ''}`}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
          >
            {c.name}
            <b>{Math.round(c.p * 100)}%</b>
          </motion.span>
        ))}
      </AnimatePresence>
      {odds.settled && <span className="muted">確定</span>}
    </div>
  );
}
