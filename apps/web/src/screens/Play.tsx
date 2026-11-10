// 手札（スマホ・縦向き）。自分の操作は手元で静かに行う
import { AnimatePresence, LayoutGroup, motion, type PanInfo } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { arrangeSets, chooseBoardIndex, handName, type Card as CardT, type GameView, type SeatView } from '@unpoker/core';
import type { GameActionMsg } from '../../../server/src/protocol.ts';
import { Card, cardName } from '../components/Card.tsx';
import { AdvicePanel, adviceNow, arrangePlan, topicNow } from '../components/Advice.tsx';
import { Chips, ConnBadge, Gauge, HoldButton, PaidButton, StackChips, signed, Toast } from '../components/bits.tsx';
import { carryNext, challengeHands, potNow, provisionalRank, shownBoard, walletOf, type ChallengeRole } from '../game.ts';
import { useSwapAnimation } from '../components/TableBits.tsx';
import { outlookStage, PhoneOutlook } from '../components/Outlook.tsx';
import { PassPicker, SpecialOffer, SpecialPanel, usableNow } from '../components/Special.tsx';
import { savedToken, useRoom, type Room, type RoomView } from '../net.ts';
import { FinalList, HostControls, HostLobby, NextGame, SwapBoard, TableStrip, TablelessCtx, tablelessOf, useTableless } from './PlayTable.tsx';
import { sfx } from '../sound.ts';
import './play.css';

export function PlayScreen({ roomId }: { roomId: string }) {
  const params = new URLSearchParams(location.search);
  // 開発用: ?name=xxx で自動参加、?bot=1 で自動操作、?mash=1 でルーレットを連打する（演出が飛ばないかの確認用）
  const autoName = params.get('name');
  const room = useRoom(roomId, 'player', (send) => {
    if (autoName) send({ t: 'join', roomId, name: autoName });
  });
  const s = room.state;
  useBot(room, params.get('bot') === '1', params.get('mash') === '1', params.get('consult') === '1');
  const hasToken = savedToken(roomId, 'player') !== null;
  const notFound = room.error?.code === 'room_not_found';
  return (
    <TablelessCtx.Provider value={tablelessOf(s)}>
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
        s.hostId === s.you.playerId ? <HostLobby room={room} s={s} /> : <Waiting s={s} />
      ) : s.status === 'finished' ? (
        <PhoneFinished room={room} s={s} />
      ) : (
        <PhoneGame room={room} s={s} />
      )}
    </div>
    </TablelessCtx.Provider>
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
      <p className="muted">
        {tablelessOf(s).on ? `${tablelessOf(s).hostName} さんが対局を始めるのを待っています` : 'テーブルで対局が始まるのを待っています'}（{s.players.length} / 4 人）
      </p>
      <p className="muted small">ホーム画面に追加すると、全画面で遊べます</p>
    </Centered>
  );
}

function PhoneFinished({ room, s }: { room: Room; s: RoomView }) {
  const myId = s.you.role === 'player' ? s.you.playerId : '';
  const rank = (s.ranking ?? []).indexOf(myId) + 1;
  const me = s.players.find((p) => p.id === myId);
  return (
    <Centered>
      <span className={`seal${rank === 1 ? ' kin' : ''} ply-seal`}>{rank}位</span>
      <p className="ply-big">
        <Chips n={me?.chips ?? 0} />
      </p>
      {tablelessOf(s).on ? <FinalList s={s} /> : <p className="muted">対局が終わりました。結果はテーブルで</p>}
      {tablelessOf(s).on && s.hostId === myId && (
        <button className="btn btn-shu btn-wide" onClick={() => room.send({ t: 'rematch' })}>
          同じメンバーで次の対局
        </button>
      )}
    </Centered>
  );
}

// ---------------------------------------------------------------- 前払いクレジット（B-11）

/** 対局の最初に、前払いクレジットを買う */
function PhoneBuying({ room, s }: { room: Room; s: RoomView }) {
  const myId = s.you.role === 'player' ? s.you.playerId : '';
  const me = s.players.find((p) => p.id === myId);
  const b = s.buying ?? { done: [], unit: s.config.bet };
  const [units, setUnits] = useState(0);
  const unit = b.unit;
  const max = me ? Math.max(0, Math.min(10, Math.floor(me.chips / 2 / unit))) : 0;
  const peek = Math.ceil(unit / 4);
  const advice = [Math.ceil(unit / 10), Math.ceil(unit / 4)];
  const done = !s.buying || b.done.includes(myId);
  const waiting = s.players.filter((p) => !b.done.includes(p.id)).map((p) => p.name);
  if (done)
    return (
      <Centered>
        <SpecialOffer room={room} s={s} />
        {s.buying && <p className="ply-big">クレジット {(me?.credit ?? 0).toLocaleString()}</p>}
        <p className="muted">{waiting.length ? `${waiting.join('・')} が選んでいます` : 'まもなく始まります'}</p>
        <MyGaugeLite room={room} />
      </Centered>
    );
  return (
    <div className="pg buying">
      <MyGaugeLite room={room} />
      <SpecialOffer room={room} s={s} />
      <h2 className="decision-title">前払いクレジットを買う</h2>
      <p className="decision-body">
        追加でめくる（1 枚 {peek}）と AI 相談（{advice[0]}〜{advice[1]}）の料金は、この対局ではクレジットから払います。買えるのは今だけです。
      </p>
      <ul className="buy-notes">
        <li>使った分は、次のゲームの持ち越しポットに入ります</li>
        <li>最終ゲームでは使えません。使い残しは最終ゲームの持ち越しポットに全部入ります</li>
      </ul>
      <div className="buy-stepper" role="group" aria-label="買う量">
        <button className="st-btn" aria-label="1 単位減らす" disabled={units <= 0} onClick={() => setUnits(units - 1)}>
          −
        </button>
        <span className="buy-value">
          <b>{(units * unit).toLocaleString()}</b>
          <small>
            {units} × {unit}
          </small>
        </span>
        <button className="st-btn" aria-label="1 単位増やす" disabled={units >= max} onClick={() => setUnits(units + 1)}>
          ＋
        </button>
      </div>
      <p className="muted small">
        持ち点 {(me?.chips ?? 0).toLocaleString()} → {((me?.chips ?? 0) - units * unit).toLocaleString()}（買えるのは持ち点の半分まで）
      </p>
      <HoldButton className="btn btn-shu btn-wide" onDone={() => room.send({ t: 'buy', units })} ms={500}>
        {units === 0 ? '長押しで買わずに始める' : `長押しで ${(units * unit).toLocaleString()} 買う`}
      </HoldButton>
    </div>
  );
}

/** 持ち時間のゲージだけ（ゲームが始まる前の画面用） */
function MyGaugeLite({ room }: { room: Room }) {
  return (
    <div className="pg-gauge">
      <Gauge room={room} />
    </div>
  );
}

// ---------------------------------------------------------------- 対局中

function PhoneGame({ room, s }: { room: Room; s: RoomView }) {
  const g = s.game;
  const myId = s.you.role === 'player' ? s.you.playerId : '';
  // 二重送信を防ぐ: 同じ状態（サーバー時刻）の間は 1 回だけ送る
  const sentAt = useRef({ key: -1, at: 0 });
  if (s.buying || s.special?.offer) return <PhoneBuying room={room} s={s} />;
  if (s.betting) return <PhoneBetting room={room} s={s} />;
  if (!g || g.you === null) {
    const me = s.players.find((p) => p.id === myId);
    return (
      <Centered>
        <p className="ply-big">観戦中</p>
        <p className="muted">{me && me.chips <= 0 ? '持ち点がなくなりました。続きを見守りましょう' : '次のゲームから参加します'}</p>
        <HostControls room={room} s={s} g={g} />
        {g && tablelessOf(s).on && <TableStrip s={s} g={g} />}
        {g && tablelessOf(s).on && g.phase === 'result' && <NextGame room={room} s={s} />}
      </Centered>
    );
  }
  const me = g.seats[g.you]!;
  const name = (i: number) => s.players.find((p) => p.id === g.seats[i]?.id)?.name ?? '？';
  return <PhoneGameBody room={room} s={s} g={g} me={me} name={name} sentAt={sentAt} />;
}

function PhoneGameBody({
  room,
  s,
  g,
  me,
  name,
  sentAt,
}: {
  room: Room;
  s: RoomView;
  g: GameView;
  me: SeatView;
  name: (i: number) => string;
  sentAt: React.MutableRefObject<{ key: number; at: number }>;
}) {
  usePhoneSounds(s.gameNo, me);
  const tableless = useTableless();
  const you = g.you!;
  const act = (a: GameActionMsg) => {
    // 拒否されたときに押し直せるよう、1.5 秒たてば同じ状態でも送れる
    if (sentAt.current.key === s.serverTime && Date.now() - sentAt.current.at < 1500) return;
    sentAt.current = { key: s.serverTime, at: Date.now() };
    room.send({ t: 'action', action: a });
  };
  return (
    <div className="pg">
      <header className="pg-head">
        <span className="pg-name">{name(you)}</span>
        {g.dealer === you && <span className="dealer">親</span>}
        <StackChips n={g.result ? g.result.stacks[you]! : me.stack} />
        {me.peekFee + me.adviceFee > 0 && (
          <span className="paid-pill" title="追加めくりと AI 相談に払った額。次のゲームの持ち越しポットに入ります">
            <i className="coin" aria-hidden="true" />
            払った {me.peekFee + me.adviceFee}
          </span>
        )}
        {me.credit !== null && (
          <span className="paid-pill" title="前払いクレジットの残り。追加めくりと AI 相談に使えます">
            クレジット {me.credit.toLocaleString()}
          </span>
        )}
        <span className="pg-bet muted">ベット {g.bet}</span>
      </header>
      <PotRow g={g} />
      <SpecialPanel g={g} me={me} act={act} gameNo={s.gameNo} />
      <PassPicker g={g} me={me} act={act} name={name} />
      <MyGauge room={room} g={g} />
      <HostControls room={room} s={s} g={g} />
      <main className="pg-main">
        {tableless.on && <TableStrip s={s} g={g} />}
        {g.phase === 'placement' ? (
          <Placement g={g} me={me} act={act} name={name} />
        ) : (
          <AfterPlacement room={room} s={s} g={g} me={me} act={act} name={name} />
        )}
      </main>
    </div>
  );
}

/** 手札の効果音: 自分がめくったときと、お金を払ったとき（小判） */
function usePhoneSounds(gameNo: number, me: SeatView) {
  const prev = useRef<{ gameNo: number; peeked: number; revealed: number; paid: number } | null>(null);
  useEffect(() => {
    const cur = { gameNo, peeked: me.peekedCount, revealed: me.revealed.length, paid: me.peekFee + me.adviceFee };
    const p = prev.current;
    prev.current = cur;
    if (!p || p.gameNo !== gameNo) return;
    if (cur.paid > p.paid) sfx.coin();
    if (cur.peeked > p.peeked || cur.revealed > p.revealed) sfx.flip();
  });
}

/** 持ち回り方式: 親はベット額を選び、ほかの人は待つ（B-0） */
function PhoneBetting({ room, s }: { room: Room; s: RoomView }) {
  const b = s.betting!;
  const myId = s.you.role === 'player' ? s.you.playerId : '';
  const me = s.players.find((p) => p.id === myId);
  const dealerName = s.players.find((p) => p.id === b.dealerId)?.name ?? '？';
  const isDealer = b.dealerId === myId;
  const [i, setI] = useState(0);
  const opts = b.options;
  const idx = Math.min(i, opts.length - 1);
  const v = opts[idx]!;
  return (
    <div className="pg">
      <header className="pg-head">
        <span className="pg-name">{me?.name}</span>
        {isDealer && <span className="dealer">親</span>}
        <StackChips n={me?.chips ?? 0} />
        <span className="pg-bet muted">{s.gameNo} ゲーム目</span>
      </header>
      <div className="pg-gauge">{isDealer ? <Gauge room={room} /> : <div className="gauge" style={{ visibility: 'hidden' }} />}</div>
      <main className="pg-main">
        {!isDealer ? (
          <Instruction main={`${dealerName} がベット額を決めています`} sub={`${opts[0]!.toLocaleString()} 〜 ${opts[opts.length - 1]!.toLocaleString()} の中から選びます`} />
        ) : (
          <>
            <Instruction
              main="あなたが親です。ベット額を決める"
              sub="全員がこの額を賭けます。チャレンジの参加費や、追加めくり・AI 相談の料金もこの額で決まります。持ち点が足りない人はオールインになります"
            />
            <div className="bet-pick">
              <button type="button" className="st-btn big" aria-label="ベット額を下げる" disabled={idx === 0} onClick={() => setI(idx - 1)}>
                −
              </button>
              <motion.span key={v} className="bet-value" initial={{ scale: 1.15 }} animate={{ scale: 1 }}>
                {v.toLocaleString()}
              </motion.span>
              <button type="button" className="st-btn big" aria-label="ベット額を上げる" disabled={idx === opts.length - 1} onClick={() => setI(idx + 1)}>
                ＋
              </button>
            </div>
            {opts.length > 1 && (
              <input
                className="bet-range"
                type="range"
                min={0}
                max={opts.length - 1}
                step={1}
                value={idx}
                onChange={(e) => setI(Number(e.target.value))}
                aria-label="ベット額"
              />
            )}
            <dl className="bet-derived">
              <div>
                <dt>チャレンジ参加費</dt>
                <dd>{v.toLocaleString()}</dd>
              </div>
              <div>
                <dt>追加めくり</dt>
                <dd>{Math.ceil(v / 4)}</dd>
              </div>
              <div>
                <dt>AI 相談</dt>
                <dd>
                  {Math.ceil(v / 10)} ／ {Math.ceil(v / 4)}
                </dd>
              </div>
            </dl>
            <div className="pg-actions">
              <HoldButton className="btn btn-shu btn-wide" ms={600} onDone={() => room.send({ t: 'bet', amount: v })}>
                長押しで {v.toLocaleString()} に決めて配る
              </HoldButton>
              {s.config.timeLimit !== false && <p className="paid-note">30 秒で決まらなければ、最低の {opts[0]!.toLocaleString()} になります</p>}
            </div>
          </>
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
    (g.phase === 'join' && g.challenge?.optional.includes(g.you!) && !g.seats[g.you!]!.joinDone) ||
    (g.phase === 'swap' && g.challenge?.roller === g.you && g.challenge.roulette !== 'stopped');
  return <div className="pg-gauge">{mine ? <Gauge room={room} /> : <div className="gauge" style={{ visibility: 'hidden' }} />}</div>;
}

/** 手札の位置（ふつうは 7 枚。特殊効果カードで 5・9・11 枚になる） */
const handIdx = (me: SeatView) => [...Array(me.cards.length).keys()];

function Placement({ g, me, act, name }: { g: GameView; me: SeatView; act: (a: GameActionMsg) => void; name: (i: number) => string }) {
  const tableless = useTableless();
  const [sel, setSel] = useState<number | null>(null);
  /** 追加でめくろうとしている札（料金がかかるので、長押しで確定する） */
  const [buy, setBuy] = useState<number | null>(null);
  const boardKnown = g.board.filter((c): c is CardT => c !== null);
  if (me.arranged) return <MySets g={g} me={me} hint="配置しました。他の人を待っています" />;
  if (me.placed) return <Arrange g={g} me={me} act={act} name={name} />;
  const rec = adviceNow(g, me);
  const aiPick = rec && rec.advice.topic === 'place' ? rec.advice.boardIndex : null;

  const peeking = me.peekedCount < 3;
  const price = g.peekPrice;
  const w = walletOf(me);
  const canBuy = !peeking && g.extraPeeks && w.amount >= price;
  const extra = Math.max(0, me.peekedCount - 3);
  const buyNote = !g.extraPeeks
    ? '最終ゲームなので、追加ではめくれません'
    : w.amount < price
      ? `${w.label}が足りないので、追加ではめくれません`
      : `伏せた札は 1 枚 ${price} 点で追加でめくれます（${w.label}から払う）。料金は次のゲームの持ち越しポットに入ります`;
  return (
    <>
      <Instruction
        main={peeking ? `めくる札を選ぶ（あと ${3 - me.peekedCount} 枚）` : '場に出す札を選ぶ'}
        sub={peeking ? '中身は誰にも見えません' : `選んだ札を上にはじくと、場に出ます。${buyNote}`}
      />
      {extra > 0 && (
        <p className="paid-note">
          追加で {extra} 枚めくりました（{extra * price} 点）。めくった枚数は{tableless.on ? 'ほかの人のスマホ' : ' iPad '}に出ます
        </p>
      )}
      {boardKnown.length > 0 && <MiniBoard cards={boardKnown} hidden={g.boardOwners.filter((o) => o === -1).length} label="場札" />}
      <div className={`hand7${me.cards.length !== 7 ? ' many' : ''}`}>
        {handIdx(me).map((k) => {
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
              width={me.cards.length > 7 ? 64 : 76}
              selected={isSel || isBuy}
              dim={!peeking && !known && !canBuy}
              onClick={onClick}
              label={known ? undefined : peeking ? 'めくる' : canBuy ? `${price} 点で追加でめくる` : '伏せ札'}
            >
              {!known && canBuy && (
                <span className="price-tag" aria-hidden="true">
                  <i className="coin" />
                  {price}
                </span>
              )}
              {aiPick === k && <span className="ai-mark">AI</span>}
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
        {!peeking && buy === null && <AdvicePanel g={g} me={me} act={act} name={name} />}
        {!peeking && buy !== null && (
          <PaidButton
            cost={price}
            stack={w.amount}
            walletLabel={w.label}
            onDone={() => {
              act({ type: 'peek', index: buy });
              setBuy(null);
            }}
            note="もう一度タップすると、選ぶのをやめます"
          >
            長押しでこの札をめくる
          </PaidButton>
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
function Arrange({ g, me, act, name }: { g: GameView; me: SeatView; act: (a: GameActionMsg) => void; name: (i: number) => string }) {
  const hand = handIdx(me).filter((k) => k !== me.boardIndex);
  const nSets = hand.length / 2;
  // slots[pos] = 置いた札の位置（手札の index）。pos 0-1 が 1 組目、2-3 が 2 組目、…
  const [slots, setSlots] = useState<(number | null)[]>(() => Array(hand.length).fill(null));
  const [sel, setSel] = useState<number | null>(null); // 選んでいる札（手札の index）
  // ドラッグを離した直後のタップは無視する（離した瞬間にタップ扱いになって札が選ばれてしまうため）
  const draggedAt = useRef(0);
  const tray = hand.filter((k) => !slots.includes(k));
  const plan = arrangePlan(g, me);
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
        main={full ? `長押しでこの ${nSets} 組に決める` : `札を ${nSets} 組に分ける（あと ${tray.length} 枚）`}
        sub="札をドラッグするか、札→枠の順にタップして置きます。置いた札も動かせます"
      />
      <div className="placed-row">
        <span className="muted">場に出した札</span>
        <Card card={me.cards[me.boardIndex!] ?? null} faceUp width={40} />
      </div>
      <LayoutGroup>
        <div className="sets3">
          {[...Array(nSets).keys()].map((si) => (
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
                    {k !== null && k !== undefined ? (
                      cardNode(k, 64)
                    ) : plan ? (
                      <span className="slot-ghost" aria-hidden="true">
                        {me.known.includes(plan[pos]!) && me.cards[plan[pos]!] != null ? cardName(me.cards[plan[pos]!]!) : '？'}
                      </span>
                    ) : null}
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
        <AdvicePanel g={g} me={me} act={act} name={name} compact />
        <HoldButton
          className="btn btn-wide"
          disabled={!full}
          onDone={() => act({ type: 'arrange', sets: [...Array(nSets).keys()].map((i) => [slots[i * 2]!, slots[i * 2 + 1]!] as [number, number]) })}
        >
          {full ? '長押しでこの組に決める' : `${hand.length} 枚すべて置くと決められます`}
        </HoldButton>
      </div>
    </>
  );
}

function AfterPlacement({
  room,
  s,
  g,
  me,
  act,
  name,
}: {
  room: Room;
  s: RoomView;
  g: GameView;
  me: SeatView;
  act: (a: GameActionMsg) => void;
  name: (i: number) => string;
}) {
  const tableless = useTableless();
  const you = g.you!;
  const prov = g.provisional;
  const res = g.result;
  // 入れ替えの演出が新しい札をめくるまでは、入れ替える前の場札を見せる（iPad より先にネタばらししない）
  const swapAnim = useSwapAnimation(g, s.gameNo, false);
  const board = shownBoard(g, swapAnim.revealNew);
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
          {tableless.on && g.phase === 'swap' ? (
            <SwapBoard s={s} g={g} />
          ) : outlookStage(g, swapAnim) === 'before' ? null : (
            <MiniBoard cards={board} label={g.phase === 'swap' && swapAnim.revealNew ? '入れ替え後の場札' : '場札'} />
          )}
          <PhoneOutlook g={g} swap={swapAnim} name={name} board={board} showCards={!tableless.on} />
          {(g.phase === 'join' || g.phase === 'swap') && g.challenge && <ChallengeHands g={g} board={board} name={name} />}
          <SetsView me={me} compact best={prov!.bestSet[you]} />
          {g.phase === 'declare' && lastMe && !me.declareDone && (
            <Decision
              title="チャレンジしますか？"
              body={`場札がランダムに 1 枚入れ替わり、1 位と勝負し直せます。参加費は ${g.bet}（持ち点が足りなければ残り全部）。1 位も強制参加します`}
              yes={`長押しでチャレンジする（${g.bet}）`}
              onYes={() => act({ type: 'declare', yes: true })}
              onNo={() => act({ type: 'declare', yes: false })}
              disabledYes={me.stack <= 0}
              advice={<AdvicePanel g={g} me={me} act={act} name={name} />}
            />
          )}
          {g.phase === 'swap' && g.challenge?.roller === you && (g.challenge.roulette === 'ready' || g.challenge.roulette === 'spinning') && (
            <RouletteControl spinning={g.challenge.roulette === 'spinning'} where={tableless.on ? '上の場札' : 'iPad の場札'} onPress={(cmd) => act({ type: 'roulette', cmd })} />
          )}
          {g.phase === 'join' && optMe && !me.joinDone && (
            <Decision
              title="チャレンジに乗りますか？"
              body={`乗ると、入れ替え後の勝負に加われます。参加費は ${g.bet}。見送ると今回は勝てません`}
              yes={`長押しで乗る（${g.bet}）`}
              onYes={() => act({ type: 'join', yes: true })}
              onNo={() => act({ type: 'join', yes: false })}
              advice={<AdvicePanel g={g} me={me} act={act} name={name} />}
            />
          )}
          <p className="muted pg-note">{waitingNote(g, you, name, tableless.on)}</p>
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
          {tableless.on ? <NextGame room={room} s={s} /> : <p className="muted pg-note">テーブルで次のゲームへ進みます</p>}
        </>
      );
    }
  }
  return null;
}

function waitingNote(g: GameView, you: number, name: (i: number) => string, tableless: boolean): string {
  const prov = g.provisional!;
  const lasts = prov.lasts.map(name).join('・');
  switch (g.phase) {
    case 'ranking':
      return tableless ? '仮順位を発表しています' : 'テーブルで仮順位を発表しています';
    case 'declare':
      return prov.lasts.includes(you) && g.seats[you]!.declareDone ? '決めました。結果を待っています' : prov.lasts.includes(you) ? '' : `${lasts} がチャレンジを考えています`;
    case 'join':
      return g.challenge!.optional.includes(you) && !g.seats[you]!.joinDone ? '' : '便乗する人を待っています';
    case 'swap': {
      const ch = g.challenge!;
      if (ch.roller === you && (ch.roulette === 'ready' || ch.roulette === 'spinning')) return '';
      if (ch.roulette === 'ready') return `${name(ch.roller!)} がルーレットを回します`;
      if (ch.roulette === 'spinning') return `${name(ch.roller!)} がストップを押します`;
      return tableless ? '場札を入れ替えています' : 'テーブルで場札を入れ替えています';
    }
    default:
      return '';
  }
}

/** 今のポットと持ち越しポットを分けて出す */
function PotRow({ g }: { g: GameView }) {
  const next = carryNext(g);
  return (
    <div className="pg-pots" aria-label="ポット">
      <span title="全員の基本ベットとチャレンジの参加費。このゲームの勝者が受け取ります">
        現在のポット <b>{potNow(g).toLocaleString()}</b>
      </span>
      <span title="前のゲームの追加めくりと AI 相談の料金。このゲームの勝者が受け取ります">
        持ち越しポット <b>{g.carryIn.toLocaleString()}</b>
      </span>
      {next > 0 && (
        <span className="muted" title="このゲームの追加めくりと AI 相談の料金。次のゲームの勝者が受け取ります">
          次へ {next.toLocaleString()}
        </span>
      )}
    </div>
  );
}

const ROLE_LABEL: Record<ChallengeRole, string> = { declarer: '挑戦', forced: '受けて立つ', joiner: '便乗' };

/** チャレンジ中: 参加している人ごとの今の役（場札がめくれるたびに更新） */
function ChallengeHands({ g, board, name }: { g: GameView; board: CardT[]; name: (i: number) => string }) {
  const rows = challengeHands(g, board);
  if (rows.length === 0) return null;
  return (
    <ul className="chh-list" aria-label="勝負の顔ぶれと今の役">
      {rows.map((r) => (
        <motion.li key={r.seat} layout className={`${r.leader ? 'leader' : ''}${r.seat === g.you ? ' me' : ''}`}>
          <span className="chh-role">{ROLE_LABEL[r.role]}</span>
          <span className="chh-name">{r.seat === g.you ? 'あなた' : name(r.seat)}</span>
          <motion.span key={r.name} className="chh-hand" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
            {r.name}
          </motion.span>
          {r.leader && <span className="chh-lead">いま優勢</span>}
        </motion.li>
      ))}
    </ul>
  );
}

/** チャレンジを宣言した人のスマホ: 場札入れ替えのルーレットを回して、止める */
function RouletteControl({ spinning, where, onPress }: { spinning: boolean; where: string; onPress: (cmd: 'start' | 'stop') => void }) {
  // 押した後、サーバーが受け付けるまで（顔ぶれの発表中や、回り始めた直後）は「まもなく」と出し、連打しても 1 回だけ送る
  const [pressed, setPressed] = useState(false);
  useEffect(() => setPressed(false), [spinning]);
  const press = () => {
    if (pressed) return;
    setPressed(true);
    onPress(spinning ? 'stop' : 'start');
  };
  return (
    <motion.section className="decision roulette-ctl" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
      <h2 className="decision-title">{spinning ? 'いつでも止められます' : 'ルーレットを回してください'}</h2>
      <p className="decision-body">
        {spinning ? `${where}の上を光が回っています。ストップを押すと、だんだん遅くなって 1 枚で止まり、その札が入れ替わります` : '場札 5 枚のどれか 1 枚が入れ替わります。どの札になるかは運次第です'}
      </p>
      <motion.button
        key={spinning ? 'stop' : 'start'}
        type="button"
        className={`roulette-btn${spinning ? ' stop' : ''}`}
        initial={{ scale: 0.8 }}
        animate={{ scale: 1 }}
        whileTap={{ scale: 0.92 }}
        onClick={press}
        disabled={pressed}
        aria-busy={pressed}
      >
        {spinning ? 'ストップ' : '回す'}
      </motion.button>
      {pressed && <p className="muted roulette-wait">{spinning ? 'まもなく止まります…' : 'まもなく回ります…'}</p>}
    </motion.section>
  );
}

function Decision(props: { title: string; body: string; yes: string; onYes: () => void; onNo: () => void; disabledYes?: boolean; advice?: React.ReactNode }) {
  return (
    <motion.section className="decision" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
      <h2 className="decision-title">{props.title}</h2>
      <p className="decision-body">{props.body}</p>
      {props.advice}
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

/** 場札の小さな表示。hidden は伏せたランダムの場札の枚数（配置中は裏向きで並べる） */
function MiniBoard({ cards, label, hidden = 0 }: { cards: CardT[]; label: string; hidden?: number }) {
  return (
    <div className="miniboard" aria-label={label}>
      {cards.map((c, i) => (
        <Card key={`${i}:${c}`} card={c} faceUp width={44} />
      ))}
      {Array.from({ length: hidden }, (_, i) => (
        <Card key={`h${i}`} card={null} faceUp={false} width={44} label="伏せたランダムの場札" />
      ))}
    </div>
  );
}

function MySets({ g, me, hint, showBoard }: { g: GameView; me: SeatView; hint: string; showBoard?: boolean }) {
  const board = g.board.filter((c): c is CardT => c !== null);
  return (
    <>
      <Instruction main={hint} />
      {(showBoard || board.length > 0) && <MiniBoard cards={board} hidden={g.phase === 'placement' ? g.boardOwners.filter((o) => o === -1).length : 0} label="場札" />}
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
function useBot(room: Room, on: boolean, mash = false, consult = false) {
  const g = room.state?.game;
  const key = room.state ? `${room.state.serverTime}` : '';
  useEffect(() => {
    const st = room.state;
    if (on && st?.buying && st.you.role === 'player' && !st.buying.done.includes(st.you.playerId)) {
      // 開発用: 前払いクレジットは 0〜2 単位をランダムに買う（相談するボットは 2 単位）
      const units = consult ? 2 : Math.floor(Math.random() * 3);
      const t = setTimeout(() => room.send({ t: 'buy', units }), 800);
      return () => clearTimeout(t);
    }
    if (on && st?.betting && st.you.role === 'player' && st.betting.dealerId === st.you.playerId) {
      const opts = st.betting.options;
      const amount = opts[Math.floor(Math.random() * opts.length)]!;
      const t = setTimeout(() => room.send({ t: 'bet', amount }), 1200);
      return () => clearTimeout(t);
    }
    if (on && st?.special?.offer) {
      const t = setTimeout(() => room.send({ t: 'specialPick', take: Math.random() < 0.5 }), 800);
      return () => clearTimeout(t);
    }
    if (!on || !g || g.you === null) return;
    const me = g.seats[g.you]!;
    let a: GameActionMsg | null = null;
    // 開発用: 特殊効果カードは、使える時機が来たら半分の確率で使う。札を渡すときはランダムに選ぶ
    const pass = g.special?.passing;
    const kind = g.special?.mine;
    if (pass && pass.myPick === null) {
      const left = handIdx(me).filter((k) => k !== me.boardIndex);
      a = { type: 'pass', index: left[Math.floor(Math.random() * left.length)]! };
    } else if (kind && usableNow(g, me, kind) && Math.random() < 0.5) {
      const idx = handIdx(me).filter((k) => k !== me.boardIndex);
      a = { type: 'special', kind, index: idx[Math.floor(Math.random() * idx.length)]!, suit: Math.floor(Math.random() * 4) };
    } else
    if (g.phase === 'placement') {
      if (me.peekedCount < 3) a = { type: 'peek', index: handIdx(me).find((k) => !me.known.includes(k))! };
      else if (!me.placed) {
        const known = me.known.map((index) => ({ index, card: me.cards[index]! }));
        a = { type: 'place', index: chooseBoardIndex(known) };
      } else if (!me.arranged) {
        const known = me.known.filter((k) => k !== me.boardIndex).map((index) => ({ index, card: me.cards[index]! }));
        const unknown = handIdx(me).filter((k) => k !== me.boardIndex && !me.known.includes(k));
        a = { type: 'arrange', sets: arrangeSets(known, unknown) };
      }
    } else if (g.phase === 'reveal' && g.revealTurn === g.you) {
      const left = handIdx(me).filter((k) => k !== me.boardIndex && !me.revealed.includes(k));
      a = { type: 'flip', index: left[Math.floor(Math.random() * left.length)]! };
    } else if (consult && (g.phase === 'declare' || g.phase === 'join') && g.extraPeeks && topicNow(g, me) && !adviceNow(g, me) && me.stack > g.advicePrice.challenge) {
      // 開発用: チャレンジの判断の前に AI に相談し、答えを見てから（数秒後に）決める
      a = { type: 'consult' };
    } else if (g.phase === 'declare' && g.provisional?.lasts.includes(g.you) && !me.declareDone) {
      a = { type: 'declare', yes: me.stack > 0 && Math.random() < 0.6 };
    } else if (g.phase === 'join' && g.challenge?.optional.includes(g.you) && !me.joinDone) {
      a = { type: 'join', yes: Math.random() < 0.4 };
    } else if (g.phase === 'swap' && g.challenge?.roller === g.you && g.challenge.roulette !== 'stopped') {
      if (mash) {
        // 画面が切り替わった直後に、回す・止めるを何度も押す
        for (let i = 0; i < 4; i++) {
          room.send({ t: 'action', action: { type: 'roulette', cmd: 'start' } });
          room.send({ t: 'action', action: { type: 'roulette', cmd: 'stop' } });
        }
        return;
      }
      const cmd = g.challenge.roulette === 'ready' ? 'start' : 'stop';
      const t = setTimeout(() => room.send({ t: 'action', action: { type: 'roulette', cmd } }), cmd === 'start' ? 3500 : 2500);
      return () => clearTimeout(t);
    }
    if (!a) return;
    const action = a;
    const wait = consult && (action.type === 'declare' || action.type === 'join') ? 4000 : 700 + Math.random() * 900;
    const t = setTimeout(() => room.send({ t: 'action', action }), wait);
    return () => clearTimeout(t);
  }, [key, on]); // eslint-disable-line react-hooks/exhaustive-deps
}
