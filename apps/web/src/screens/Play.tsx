// 手札（スマホ・縦向き）。自分の操作は手元で静かに行う
import { AnimatePresence, LayoutGroup, motion, type PanInfo } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { arrangeSets, chooseBoardIndex, handName, type Card as CardT, type GameView, type SeatView } from '@unpoker/core';
import type { GameActionMsg } from '../../../server/src/protocol.ts';
import { Card } from '../components/Card.tsx';
import { Chips, ConnBadge, Gauge, HoldButton, signed, Toast } from '../components/bits.tsx';
import { provisionalRank } from '../game.ts';
import { savedToken, useRoom, type Room, type RoomView } from '../net.ts';
import './play.css';

export function PlayScreen({ roomId }: { roomId: string }) {
  const params = new URLSearchParams(location.search);
  // 開発用: ?name=xxx で自動参加、?bot=1 で自動操作
  const autoName = params.get('name');
  const room = useRoom(roomId, 'player', (send) => {
    if (autoName) send({ t: 'join', roomId, name: autoName });
  });
  const s = room.state;
  useBot(room, params.get('bot') === '1');
  const hasToken = savedToken(roomId, 'player') !== null;
  const notFound = room.error?.code === 'room_not_found';
  return (
    <div className="ply felt">
      <ConnBadge room={room} />
      <Toast room={room} />
      {notFound ? (
        <Centered>
          <p>このテーブルは見つかりません。テーブルの QR コードをもう一度読み取ってください。</p>
        </Centered>
      ) : !s || s.you.role !== 'player' ? (
        hasToken && room.error?.code !== 'bad_token' ? <Centered>つないでいます…</Centered> : <JoinForm room={room} roomId={roomId} />
      ) : s.status === 'lobby' ? (
        <Waiting s={s} />
      ) : s.status === 'finished' ? (
        <PhoneFinished s={s} />
      ) : (
        <PhoneGame room={room} s={s} />
      )}
    </div>
  );
}

const Centered = ({ children }: { children: React.ReactNode }) => <div className="ply-center">{children}</div>;

function JoinForm({ room, roomId }: { room: Room; roomId: string }) {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('unpoker:name') ?? '';
    } catch {
      return '';
    }
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try {
      localStorage.setItem('unpoker:name', n);
    } catch {
      /* noop */
    }
    room.send({ t: 'join', roomId, name: n });
  };
  return (
    <form className="join" onSubmit={submit}>
      <h1 className="ply-wordmark">unpoker</h1>
      <label className="join-label" htmlFor="name">
        テーブルでの呼び名
      </label>
      <input id="name" className="field" maxLength={12} autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} placeholder="例: ゆき" />
      <button className="btn btn-wide" type="submit" disabled={!name.trim() || room.status !== 'open'}>
        卓につく
      </button>
      <p className="muted join-room">テーブル {roomId}</p>
    </form>
  );
}

function Waiting({ s }: { s: RoomView }) {
  const me = s.players.find((p) => s.you.role === 'player' && p.id === s.you.playerId);
  return (
    <Centered>
      <p className="ply-big">{me?.name} さん、ようこそ</p>
      <p className="muted">テーブルで対局が始まるのを待っています（{s.players.length} / 4 人）</p>
      <p className="muted small">ホーム画面に追加すると、全画面で遊べます</p>
    </Centered>
  );
}

function PhoneFinished({ s }: { s: RoomView }) {
  const myId = s.you.role === 'player' ? s.you.playerId : '';
  const rank = (s.ranking ?? []).indexOf(myId) + 1;
  const me = s.players.find((p) => p.id === myId);
  return (
    <Centered>
      <span className={`seal${rank === 1 ? ' kin' : ''} ply-seal`}>{rank}位</span>
      <p className="ply-big">
        <Chips n={me?.chips ?? 0} />
      </p>
      <p className="muted">対局が終わりました。結果はテーブルで</p>
    </Centered>
  );
}

// ---------------------------------------------------------------- 対局中

function PhoneGame({ room, s }: { room: Room; s: RoomView }) {
  const g = s.game;
  const myId = s.you.role === 'player' ? s.you.playerId : '';
  // 二重送信を防ぐ: 同じ状態（サーバー時刻）の間は 1 回だけ送る
  const sentAt = useRef({ key: -1, at: 0 });
  if (!g || g.you === null) {
    const me = s.players.find((p) => p.id === myId);
    return (
      <Centered>
        <p className="ply-big">観戦中</p>
        <p className="muted">{me && me.chips <= 0 ? '持ち点がなくなりました。テーブルで続きを見守りましょう' : '次のゲームから参加します'}</p>
      </Centered>
    );
  }
  const me = g.seats[g.you]!;
  const name = (i: number) => s.players.find((p) => p.id === g.seats[i]?.id)?.name ?? '？';
  const act = (a: GameActionMsg) => {
    // 拒否されたときに押し直せるよう、1.5 秒たてば同じ状態でも送れる
    if (sentAt.current.key === s.serverTime && Date.now() - sentAt.current.at < 1500) return;
    sentAt.current = { key: s.serverTime, at: Date.now() };
    room.send({ t: 'action', action: a });
  };
  return (
    <div className="pg">
      <header className="pg-head">
        <span className="pg-name">{name(g.you)}</span>
        {g.dealer === g.you && <span className="dealer">親</span>}
        <Chips n={g.result ? g.result.stacks[g.you]! : me.stack} />
        <span className="pg-bet muted">ベット {g.bet}</span>
      </header>
      <MyGauge room={room} g={g} />
      <main className="pg-main">
        {g.phase === 'placement' ? (
          <Placement g={g} me={me} act={act} />
        ) : (
          <AfterPlacement g={g} me={me} act={act} name={name} />
        )}
      </main>
    </div>
  );
}

function MyGauge({ room, g }: { room: Room; g: GameView }) {
  const mine =
    (g.phase === 'placement' && !g.seats[g.you!]!.arranged) ||
    (g.phase === 'reveal' && g.revealTurn === g.you) ||
    (g.phase === 'declare' && g.provisional?.lasts.includes(g.you!) && !g.seats[g.you!]!.declareDone) ||
    (g.phase === 'join' && g.challenge?.optional.includes(g.you!) && !g.seats[g.you!]!.joinDone);
  return <div className="pg-gauge">{mine ? <Gauge room={room} /> : <div className="gauge" style={{ visibility: 'hidden' }} />}</div>;
}

const ALL = [0, 1, 2, 3, 4, 5, 6];

function Placement({ g, me, act }: { g: GameView; me: SeatView; act: (a: GameActionMsg) => void }) {
  const [sel, setSel] = useState<number | null>(null);
  /** 追加でめくろうとしている札（料金がかかるので、長押しで確定する） */
  const [buy, setBuy] = useState<number | null>(null);
  const boardKnown = g.board.filter((c): c is CardT => c !== null);
  if (me.arranged) return <MySets g={g} me={me} hint="配置しました。他の人を待っています" />;
  if (me.placed) return <Arrange me={me} act={act} />;

  const peeking = me.peekedCount < 3;
  const price = g.peekPrice;
  const canBuy = !peeking && g.extraPeeks && me.stack >= price;
  const extra = Math.max(0, me.peekedCount - 3);
  const buyNote = !g.extraPeeks
    ? '最終ゲームなので、追加ではめくれません'
    : me.stack < price
      ? '持ち点が足りないので、追加ではめくれません'
      : `伏せた札は 1 枚 ${price} 点で追加でめくれます。料金は次のゲームの持ち越しポットに入ります`;
  return (
    <>
      <Instruction
        main={peeking ? `めくる札を選ぶ（あと ${3 - me.peekedCount} 枚）` : '場に出す札を選ぶ'}
        sub={peeking ? '中身は誰にも見えません' : `選んだ札を上にはじくと、場に出ます。${buyNote}`}
      />
      {extra > 0 && (
        <p className="pg-note">
          追加で {extra} 枚めくりました（{extra * price} 点）。めくった枚数は iPad に出ます
        </p>
      )}
      {boardKnown.length > 0 && <MiniBoard cards={boardKnown} label="場札" />}
      <div className="hand7">
        {ALL.map((k) => {
          const known = me.known.includes(k);
          const card = me.cards[k] ?? null;
          const selectable = !peeking && known;
          const isSel = sel === k;
          const isBuy = buy === k;
          const onClick = peeking
            ? known
              ? undefined
              : () => act({ type: 'peek', index: k })
            : selectable
              ? () => {
                  setSel(isSel ? null : k);
                  setBuy(null);
                }
              : canBuy
                ? () => {
                    setBuy(isBuy ? null : k);
                    setSel(null);
                  }
                : undefined;
          const node = (
            <Card
              card={card}
              faceUp={known && card !== null}
              width={76}
              selected={isSel || isBuy}
              dim={!peeking && !known && !canBuy}
              onClick={onClick}
              label={known ? undefined : peeking ? 'めくる' : canBuy ? `${price} 点で追加でめくる` : '伏せ札'}
            >
              {!known && canBuy && <span className="price-tag">{price}</span>}
            </Card>
          );
          if (!isSel) return <div key={k}>{node}</div>;
          return (
            <motion.div
              key={k}
              drag="y"
              dragConstraints={{ top: -220, bottom: 0 }}
              dragElastic={0.2}
              dragSnapToOrigin
              onDragEnd={(_: unknown, info: PanInfo) => {
                if (info.offset.y < -90 || info.velocity.y < -500) act({ type: 'place', index: k });
              }}
              style={{ touchAction: 'none' }}
            >
              {node}
            </motion.div>
          );
        })}
      </div>
      <div className="pg-actions">
        {!peeking && buy !== null && (
          <HoldButton
            className="btn btn-wide btn-buy"
            onDone={() => {
              act({ type: 'peek', index: buy });
              setBuy(null);
            }}
          >
            長押しで {price} 点払ってめくる
          </HoldButton>
        )}
        {!peeking && buy === null && (
          <button className="btn btn-wide" disabled={sel === null} onClick={() => sel !== null && act({ type: 'place', index: sel })}>
            この札を場に出す
          </button>
        )}
      </div>
    </>
  );
}

/**
 * 3 組を自分で作る。6 枚は下の手元に並び、タップかドラッグで上の 3 組の枠へ 1 枚ずつ置いていく。
 * 伏せ札は確率的にはどこに置いても同じだが、自分で置いて決めることを大事にする（おまかせの初期配置はしない）
 */
function Arrange({ me, act }: { me: SeatView; act: (a: GameActionMsg) => void }) {
  const hand = ALL.filter((k) => k !== me.boardIndex);
  // slots[pos] = 置いた札の位置（手札の index）。pos 0-1 が 1 組目、2-3 が 2 組目、4-5 が 3 組目
  const [slots, setSlots] = useState<(number | null)[]>([null, null, null, null, null, null]);
  const [sel, setSel] = useState<number | null>(null); // 選んでいる札（手札の index）
  // ドラッグを離した直後のタップは無視する（離した瞬間にタップ扱いになって札が選ばれてしまうため）
  const draggedAt = useRef(0);
  const tray = hand.filter((k) => !slots.includes(k));
  const full = slots.every((x) => x !== null);

  /** 札 k を枠 pos に置く。枠に別の札があれば入れ替える（k が枠にあった場合は位置を交換、手元から来た場合は元の札を手元へ） */
  const place = (k: number, pos: number) => {
    setSlots((cur) => {
      const next = [...cur];
      const from = next.indexOf(k);
      const other = next[pos] ?? null;
      if (from >= 0) next[from] = other;
      next[pos] = k;
      return next;
    });
    setSel(null);
  };
  const toTray = (k: number) => {
    setSlots((cur) => cur.map((x) => (x === k ? null : x)));
    setSel(null);
  };
  const recentDrag = () => Date.now() - draggedAt.current < 300;
  const tapCard = (k: number) => {
    if (!recentDrag()) setSel((s) => (s === k ? null : k));
  };
  const tapSlot = (pos: number) => {
    if (recentDrag()) return;
    const occupant = slots[pos];
    if (sel !== null) return place(sel, pos);
    if (occupant !== null && occupant !== undefined) setSel(occupant);
  };
  /** ドラッグを離した位置にある枠（無ければ手元） */
  const drop = (k: number, e: MouseEvent | TouchEvent | PointerEvent) => {
    const pt = 'changedTouches' in e ? e.changedTouches[0]! : (e as PointerEvent);
    const el = document.elementsFromPoint(pt.clientX, pt.clientY).find((x) => (x as HTMLElement).dataset?.slot !== undefined) as HTMLElement | undefined;
    if (el) place(k, Number(el.dataset.slot));
    else if (document.elementsFromPoint(pt.clientX, pt.clientY).some((x) => (x as HTMLElement).dataset?.tray !== undefined)) toTray(k);
  };

  const cardNode = (k: number, width: number) => {
    const known = me.known.includes(k);
    return (
      <motion.div
        key={k}
        layoutId={`arr-${k}`}
        drag
        dragSnapToOrigin
        dragElastic={0.6}
        whileDrag={{ scale: 1.08, zIndex: 20 }}
        onDragStart={() => setSel(null)}
        onDragEnd={(e) => {
          draggedAt.current = Date.now();
          drop(k, e as PointerEvent);
        }}
        onTap={() => tapCard(k)}
        transition={{ type: 'spring', stiffness: 520, damping: 36 }}
        style={{ touchAction: 'none', position: 'relative', zIndex: sel === k ? 5 : 1 }}
      >
        <Card card={me.cards[k] ?? null} faceUp={known} secret={known} unknown={!known} width={width} selected={sel === k} label={known ? undefined : '中身のわからない札'} />
      </motion.div>
    );
  };

  return (
    <>
      <Instruction
        main={full ? '長押しでこの 3 組に決める' : `札を 3 組に分ける（あと ${tray.length} 枚）`}
        sub="札をドラッグするか、札→枠の順にタップして置きます。置いた札も動かせます"
      />
      <div className="placed-row">
        <span className="muted">場に出した札</span>
        <Card card={me.cards[me.boardIndex!] ?? null} faceUp width={40} />
      </div>
      <LayoutGroup>
        <div className="sets3">
          {[0, 1, 2].map((si) => (
            <div className={`set slotset${slots[si * 2] !== null && slots[si * 2 + 1] !== null ? ' done' : ''}`} key={si}>
              {[0, 1].map((j) => {
                const pos = si * 2 + j;
                const k = slots[pos];
                return (
                  <button
                    type="button"
                    key={pos}
                    className={`slot${sel !== null && k === null ? ' ready' : ''}`}
                    data-slot={pos}
                    onClick={() => tapSlot(pos)}
                    aria-label={`${si + 1} 組目の ${j + 1} 枚目${k === null ? '（空き）' : ''}`}
                  >
                    {k !== null && k !== undefined ? cardNode(k, 64) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="tray" data-tray="" onClick={(e) => e.target === e.currentTarget && sel !== null && toTray(sel)}>
          {tray.length === 0 ? <span className="muted tray-empty">手元の札はすべて置きました</span> : tray.map((k) => cardNode(k, 46))}
        </div>
      </LayoutGroup>
      <div className="pg-actions">
        <HoldButton className="btn btn-wide" disabled={!full} onDone={() => act({ type: 'arrange', sets: [[slots[0]!, slots[1]!], [slots[2]!, slots[3]!], [slots[4]!, slots[5]!]] })}>
          {full ? '長押しでこの組に決める' : '6 枚すべて置くと決められます'}
        </HoldButton>
      </div>
    </>
  );
}

function AfterPlacement({ g, me, act, name }: { g: GameView; me: SeatView; act: (a: GameActionMsg) => void; name: (i: number) => string }) {
  const you = g.you!;
  const prov = g.provisional;
  const res = g.result;
  switch (g.phase) {
    case 'boardReveal':
      return <MySets g={g} me={me} hint="場札を公開しています" showBoard />;
    case 'reveal': {
      const mine = g.revealTurn === you;
      return (
        <>
          <Instruction main={mine ? 'めくる札を選ぶ' : `${name(g.revealTurn)} がめくっています`} sub={mine ? '「？」の札は、あなたも中身を知りません' : undefined} />
          <MiniBoard cards={g.board.filter((c): c is CardT => c !== null)} label="場札" />
          <SetsView me={me} onFlip={mine ? (k) => act({ type: 'flip', index: k }) : undefined} />
        </>
      );
    }
    case 'ranking':
    case 'declare':
    case 'join':
    case 'swap': {
      const rank = provisionalRank(g, you)!;
      const score = prov!.scores[you]!;
      const lastMe = prov!.lasts.includes(you);
      const optMe = g.challenge?.optional.includes(you);
      return (
        <>
          <div className="rank-box">
            <span className={`seal ply-seal${rank === 1 ? ' kin' : ''}`}>{rank}位</span>
            <span className="rank-hand">{handName(score)}</span>
          </div>
          <MiniBoard cards={g.board.filter((c): c is CardT => c !== null)} label={g.phase === 'swap' ? '入れ替え後の場札' : '場札'} />
          <SetsView me={me} compact best={prov!.bestSet[you]} />
          {g.phase === 'declare' && lastMe && !me.declareDone && (
            <Decision
              title="チャレンジしますか？"
              body={`場札がランダムに 1 枚入れ替わり、1 位と勝負し直せます。参加費は ${g.bet}（持ち点が足りなければ残り全部）。1 位も強制参加します`}
              yes={`長押しでチャレンジする（${g.bet}）`}
              onYes={() => act({ type: 'declare', yes: true })}
              onNo={() => act({ type: 'declare', yes: false })}
              disabledYes={me.stack <= 0}
            />
          )}
          {g.phase === 'join' && optMe && !me.joinDone && (
            <Decision
              title="チャレンジに乗りますか？"
              body={`乗ると、入れ替え後の勝負に加われます。参加費は ${g.bet}。見送ると今回は勝てません`}
              yes={`長押しで乗る（${g.bet}）`}
              onYes={() => act({ type: 'join', yes: true })}
              onNo={() => act({ type: 'join', yes: false })}
            />
          )}
          <p className="muted pg-note">{waitingNote(g, you, name)}</p>
        </>
      );
    }
    case 'result': {
      const win = res!.winners.includes(you);
      const d = res!.delta[you]!;
      return (
        <>
          <div className="rank-box">
            <span className={`seal ply-seal${win ? ' kin' : ''}`}>{win ? '勝ち' : res!.candidates.includes(you) ? '負け' : '見送り'}</span>
            <span className="rank-hand">{handName(res!.scores[you]!)}</span>
          </div>
          <motion.p className={`ply-delta${d >= 0 ? ' plus' : ' minus'}`} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
            {signed(d)}
          </motion.p>
          {res!.nut && <p className="ply-nut">ナッツ！ ベット分が倍になりました</p>}
          <MiniBoard cards={res!.board} label="最終の場札" />
          <SetsView me={me} compact best={res!.bestSet[you]} />
          <p className="muted pg-note">テーブルで次のゲームへ進みます</p>
        </>
      );
    }
  }
  return null;
}

function waitingNote(g: GameView, you: number, name: (i: number) => string): string {
  const prov = g.provisional!;
  const lasts = prov.lasts.map(name).join('・');
  switch (g.phase) {
    case 'ranking':
      return 'テーブルで仮順位を発表しています';
    case 'declare':
      return prov.lasts.includes(you) && g.seats[you]!.declareDone ? '決めました。結果を待っています' : prov.lasts.includes(you) ? '' : `${lasts} がチャレンジを考えています`;
    case 'join':
      return g.challenge!.optional.includes(you) && !g.seats[you]!.joinDone ? '' : '便乗する人を待っています';
    case 'swap':
      return 'テーブルで場札を入れ替えています';
    default:
      return '';
  }
}

function Decision(props: { title: string; body: string; yes: string; onYes: () => void; onNo: () => void; disabledYes?: boolean }) {
  return (
    <motion.section className="decision" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
      <h2 className="decision-title">{props.title}</h2>
      <p className="decision-body">{props.body}</p>
      <HoldButton className="btn btn-shu btn-wide" onDone={props.onYes} disabled={props.disabledYes} ms={700}>
        {props.yes}
      </HoldButton>
      <button className="btn btn-ghost btn-wide" onClick={props.onNo}>
        見送る
      </button>
    </motion.section>
  );
}

function Instruction({ main, sub }: { main: string; sub?: string }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div key={main} className="instr" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
        <p className="instr-main">{main}</p>
        {sub && <p className="instr-sub">{sub}</p>}
      </motion.div>
    </AnimatePresence>
  );
}

function MiniBoard({ cards, label }: { cards: CardT[]; label: string }) {
  return (
    <div className="miniboard" aria-label={label}>
      {cards.map((c, i) => (
        <Card key={`${i}:${c}`} card={c} faceUp width={44} />
      ))}
    </div>
  );
}

function MySets({ g, me, hint, showBoard }: { g: GameView; me: SeatView; hint: string; showBoard?: boolean }) {
  const board = g.board.filter((c): c is CardT => c !== null);
  return (
    <>
      <Instruction main={hint} />
      {(showBoard || board.length > 0) && <MiniBoard cards={board} label="場札" />}
      <SetsView me={me} />
    </>
  );
}

/** 自分の 3 セット。onFlip があれば、伏せている札をタップしてめくれる */
function SetsView({ me, onFlip, compact, best }: { me: SeatView; onFlip?: (k: number) => void; compact?: boolean; best?: number }) {
  if (!me.sets) return null;
  return (
    <div className={`sets3${compact ? ' compact' : ''}`}>
      {me.sets.map((pair, si) => (
        <div className={`set${best === si ? ' best' : ''}`} key={si}>
          {pair.map((k) => {
            const revealed = me.revealed.includes(k);
            const known = me.known.includes(k);
            const card = me.cards[k] ?? null;
            return (
              <Card
                key={k}
                card={card}
                faceUp={card !== null}
                secret={known && !revealed}
                unknown={!known && !revealed}
                width={compact ? 44 : 70}
                onClick={onFlip && !revealed ? () => onFlip(k) : undefined}
                label={revealed ? undefined : onFlip ? 'この札をめくる' : undefined}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}


/** 開発用のボット: 状態を見て、少し間を置いて合法手を 1 つ送る */
function useBot(room: Room, on: boolean) {
  const g = room.state?.game;
  const key = room.state ? `${room.state.serverTime}` : '';
  useEffect(() => {
    if (!on || !g || g.you === null) return;
    const me = g.seats[g.you]!;
    let a: GameActionMsg | null = null;
    if (g.phase === 'placement') {
      if (me.peekedCount < 3) a = { type: 'peek', index: ALL.find((k) => !me.known.includes(k))! };
      else if (!me.placed) {
        const known = me.known.map((index) => ({ index, card: me.cards[index]! }));
        a = { type: 'place', index: chooseBoardIndex(known) };
      } else if (!me.arranged) {
        const known = me.known.filter((k) => k !== me.boardIndex).map((index) => ({ index, card: me.cards[index]! }));
        const unknown = ALL.filter((k) => k !== me.boardIndex && !me.known.includes(k));
        a = { type: 'arrange', sets: arrangeSets(known, unknown) };
      }
    } else if (g.phase === 'reveal' && g.revealTurn === g.you) {
      const left = ALL.filter((k) => k !== me.boardIndex && !me.revealed.includes(k));
      a = { type: 'flip', index: left[Math.floor(Math.random() * left.length)]! };
    } else if (g.phase === 'declare' && g.provisional?.lasts.includes(g.you) && !me.declareDone) {
      a = { type: 'declare', yes: me.stack > 0 && Math.random() < 0.6 };
    } else if (g.phase === 'join' && g.challenge?.optional.includes(g.you) && !me.joinDone) {
      a = { type: 'join', yes: Math.random() < 0.4 };
    }
    if (!a) return;
    const action = a;
    const t = setTimeout(() => room.send({ t: 'action', action }), 700 + Math.random() * 900);
    return () => clearTimeout(t);
  }, [key, on]); // eslint-disable-line react-hooks/exhaustive-deps
}
