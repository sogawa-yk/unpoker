// テーブル（iPad・横向き）。公開情報だけを受け取り、演出を担当する
import { AnimatePresence, motion } from 'motion/react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DEFAULT_CONFIG, handName, type Card as CardT, type GameView, type SeatView } from '@unpoker/core';
import { Card } from '../components/Card.tsx';
import { Chips, ConnBadge, Gauge, signed, Toast } from '../components/bits.tsx';
import { provisionalRank, revealOdds, type HandOdds } from '../game.ts';
import { useRoom, type Room, type RoomView } from '../net.ts';
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
  const joinUrl = `${location.origin}/play/${s.roomId}`;
  const [qr, setQr] = useState('');
  useEffect(() => {
    void QRCode.toString(joinUrl, { type: 'svg', margin: 0, color: { dark: '#221d19', light: '#f2ecdc' } }).then(setQr);
  }, [joinUrl]);
  // 古いルームの設定には持ち回りの項目が無いので、既定値で補う
  const c = { ...DEFAULT_CONFIG, ...s.config };
  const set = (patch: Partial<typeof c>) => room.send({ t: 'configure', config: { ...c, ...patch } });
  const rotating = c.betMode === 'rotating';
  const n = s.players.length;
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
        <div className="settings">
          <Stepper label="最初の持ち点" value={c.initialChips} step={100} big={1000} min={500} max={10000} onChange={(v) => set({ initialChips: v })} />
          <Segmented
            label="ベット方式"
            value={c.betMode ?? 'fixed'}
            options={[
              ['fixed', '固定'],
              ['rotating', '持ち回り'],
            ]}
            onChange={(v) => set({ betMode: v })}
          />
          {!rotating ? (
            <Stepper label="ベット額" value={c.bet} step={10} big={100} min={10} max={1000} onChange={(v) => set({ bet: v })} />
          ) : (
            <>
              <Stepper
                label="最低ベット"
                value={c.minBet!}
                step={10}
                big={100}
                min={10}
                max={1000}
                onChange={(v) => set({ minBet: v, maxBet: c.maxBet !== null && c.maxBet! < v ? v : c.maxBet })}
              />
              <Stepper
                label="最高ベット"
                value={c.maxBet ?? 1010}
                step={10}
                big={100}
                min={c.minBet!}
                max={1010}
                format={(v) => (v > 1000 ? '上限なし' : v.toLocaleString())}
                onChange={(v) => set({ maxBet: v > 1000 ? null : v })}
              />
              <Segmented
                label="刻み幅"
                value={String(c.betStep)}
                options={[
                  ['10', '10'],
                  ['50', '50'],
                  ['100', '100'],
                ]}
                onChange={(v) => set({ betStep: Number(v) })}
              />
            </>
          )}
          <Stepper
            label="ゲーム数"
            value={c.maxGames ?? 0}
            step={1}
            big={5}
            min={0}
            max={50}
            format={(v) => (v === 0 ? '無制限' : `${v} ゲーム`)}
            onChange={(v) => set({ maxGames: v === 0 ? null : v })}
          />
        </div>
        <button className="btn btn-shu btn-wide start" disabled={n < 3} onClick={() => room.send({ t: 'start' })}>
          {n < 3 ? `あと ${3 - n} 人で始められます` : `${n} 人で対局を始める`}
        </button>
        {rotating && <p className="lobby-hint">持ち回り: ゲームごとに親がスマホでベット額を決めます（30 秒で決まらなければ最低ベット）</p>}
      </section>
    </div>
  );
}

function Segmented<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="stepper" role="radiogroup" aria-label={props.label}>
      <span className="st-label">{props.label}</span>
      <div className="seg">
        {props.options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={props.value === v} className={`seg-btn${props.value === v ? ' on' : ''}`} onClick={() => props.onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Stepper(props: {
  label: string;
  value: number;
  step: number;
  big: number;
  min: number;
  max: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { label, value, step, big, min, max, format = (v) => v.toLocaleString(), onChange } = props;
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="stepper">
      <span className="st-label">{label}</span>
      <button className="st-btn" aria-label={`${label}を ${big} 減らす`} onClick={() => onChange(clamp(value - big))}>
        «
      </button>
      <button className="st-btn" aria-label={`${label}を ${step} 減らす`} onClick={() => onChange(clamp(value - step))}>
        −
      </button>
      <span className="st-value">{format(value)}</span>
      <button className="st-btn" aria-label={`${label}を ${step} 増やす`} onClick={() => onChange(clamp(value + step))}>
        ＋
      </button>
      <button className="st-btn" aria-label={`${label}を ${big} 増やす`} onClick={() => onChange(clamp(value + big))}>
        »
      </button>
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
    <div className="game">
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
        {g.phase !== 'result' && <PauseButton room={room} s={s} />}
      </header>
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
      <BetAnnounce s={s} g={g} names={names} />
    </div>
  );
}

const rotatingBet = (s: RoomView) => s.config.betMode === 'rotating';

function PauseButton({ room, s }: { room: Room; s: RoomView }) {
  return (
    <button type="button" className={`pause-btn${s.paused ? ' on' : ''}`} aria-pressed={s.paused} onClick={() => room.send({ t: 'pause', paused: !s.paused })}>
      {s.paused ? '▶ 持ち時間を再開' : 'Ⅱ 持ち時間を止める'}
    </button>
  );
}

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
        <PauseButton room={room} s={s} />
      </header>
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
    case 'swap':
      text = '場札を 1 枚入れ替えます';
      break;
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

const BOARD_W = 92;

function Board({ g, swap }: { g: GameView; swap: SwapAnim }) {
  const initialCount = g.boardOwners.filter((o) => o === null).length;
  const slots = 5;
  return (
    <div className="board" aria-label="場札">
      {Array.from({ length: slots }, (_, k) => {
        let card: CardT | null = g.board[k] ?? null;
        const exists = k < g.board.length;
        const isSwapTarget = g.challenge?.swap?.index === k;
        if (isSwapTarget && !swap.done) card = g.challenge!.swap!.removed;
        // 場札公開: 伏せ札を 1 枚ずつ間を置いてめくる
        const delay = g.phase === 'boardReveal' && k >= initialCount ? 0.4 + (k - initialCount) * 1.1 : 0;
        return (
          <div className="board-slot" key={k}>
            {exists ? (
              <motion.div
                initial={{ opacity: 0, y: -30, scale: 0.9 }}
                animate={{
                  opacity: isSwapTarget && swap.burning ? 0 : 1,
                  y: 0,
                  scale: isSwapTarget && swap.burning ? 0.6 : 1,
                  filter: isSwapTarget && swap.burning ? 'brightness(2) sepia(1) hue-rotate(-30deg)' : 'none',
                }}
                transition={{ duration: isSwapTarget && swap.burning ? 0.7 : 0.4 }}
              >
                <Card
                  key={isSwapTarget && swap.done ? 'added' : 'orig'}
                  card={card}
                  faceUp={card !== null && (!isSwapTarget || !swap.done || swap.revealNew)}
                  width={BOARD_W}
                  delay={delay}
                  win={g.phase === 'result'}
                />
              </motion.div>
            ) : (
              <div className="card-slot" style={{ ['--card-w' as string]: `${BOARD_W}px` }} />
            )}
            {g.phase === 'swap' && swap.highlight === k && <motion.div layoutId="roulette" className="roulette" transition={{ duration: 0.08 }} />}
          </div>
        );
      })}
    </div>
  );
}

interface SwapAnim {
  highlight: number | null;
  burning: boolean;
  done: boolean;
  revealNew: boolean;
}

/** 入れ替えの演出: 光がルーレットのように回って止まる → 札が燃えて消える → 新しい札をめくる（約 5 秒） */
function useSwapAnimation(g: GameView, gameNo: number): SwapAnim {
  const target = g.challenge?.swap?.index ?? null;
  const [st, setSt] = useState<SwapAnim>({ highlight: null, burning: false, done: false, revealNew: false });
  const key = `${gameNo}:${target}`;
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (target === null) {
      setSt({ highlight: null, burning: false, done: false, revealNew: false });
      return;
    }
    if (g.phase !== 'swap') {
      // 途中から開いた場合や結果の画面は、入れ替え後の状態で見せる
      if (started.current !== key) setSt({ highlight: null, burning: false, done: true, revealNew: true });
      return;
    }
    if (started.current === key) return;
    started.current = key;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // 減速しながら回り、target で止まる
    const steps = 18 + target;
    let t = 0;
    for (let i = 0; i <= steps; i++) {
      t += 60 + (i / steps) ** 2.2 * 260;
      const idx = i % 5;
      timers.push(setTimeout(() => setSt((p) => ({ ...p, highlight: idx })), t));
    }
    timers.push(setTimeout(() => setSt((p) => ({ ...p, burning: true })), t + 500));
    timers.push(setTimeout(() => setSt({ highlight: null, burning: false, done: true, revealNew: false }), t + 1250));
    timers.push(setTimeout(() => setSt((p) => ({ ...p, revealNew: true })), t + 1450));
    return () => timers.forEach(clearTimeout);
  }, [key, g.phase, target]);
  return st;
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

/** 仮順位は最下位から順に押印し、1 位は最後（ux.md 3 章） */
function stampDelay(g: GameView, seat: number): number {
  const p = g.provisional!;
  const order = [...p.scores.keys()].sort((a, b) => p.scores[a]! - p.scores[b]!);
  return 0.3 + order.indexOf(seat) * 0.9;
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
