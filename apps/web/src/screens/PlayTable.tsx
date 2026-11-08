// テーブルなしで遊ぶとき（iPad が無いとき）のスマホの部品。
// ルームを作ったスマホが親機になり、iPad の代わりに設定・開始・次のゲーム・持ち時間の一時停止を受け持つ。
// テーブルに出ていた公開情報（場札、ほかの人のめくれた札、順位、結果）は、全員のスマホに出す。
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { handName, type Card as CardT, type GameView, type SeatView } from '@unpoker/core';
import { Card } from '../components/Card.tsx';
import { Chips, signed } from '../components/bits.tsx';
import { RuleSettings, useJoinQr } from '../components/RoomSettings.tsx';
import './play-table.css';
import { Board, PauseButton, SoundButton, useSwapAnimation, useTableSounds } from '../components/TableBits.tsx';
import { provisionalRank, revealOdds } from '../game.ts';
import { useRoom, type Room, type RoomView } from '../net.ts';

export interface Tableless {
  /** iPad なしのルーム */
  on: boolean;
  /** この端末が親機 */
  isHost: boolean;
  hostName: string;
}

export const TablelessCtx = createContext<Tableless>({ on: false, isHost: false, hostName: '' });
export const useTableless = () => useContext(TablelessCtx);

export function tablelessOf(s: RoomView | null): Tableless {
  if (!s?.hostId) return { on: false, isHost: false, hostName: '' };
  return {
    on: true,
    isHost: s.you.role === 'player' && s.you.playerId === s.hostId,
    hostName: s.players.find((p) => p.id === s.hostId)?.name ?? '親機',
  };
}

// ---------------------------------------------------------------- 待機

/** 親機の待機画面: 参加用のコードと QR、参加者、ルール設定 */
export function HostLobby({ room, s }: { room: Room; s: RoomView }) {
  const qr = useJoinQr(s.roomId);
  return (
    <div className="host-lobby">
      <section className="hl-join">
        <div className="qr hl-qr" dangerouslySetInnerHTML={{ __html: qr }} aria-label="参加用の QR コード" />
        <div>
          <p className="muted small">ほかの人はカメラで読み取るか、コードを入れて参加</p>
          <p className="room-code hl-code" aria-label="ルームコード">
            {s.roomId}
          </p>
        </div>
      </section>
      <h2 className="hl-h">卓につく人（{s.players.length} / 4）</h2>
      <ul className="hl-players">
        {s.players.map((p) => (
          <li key={p.id}>
            <span className={`dot${p.connected ? ' on' : ''}`} aria-label={p.connected ? '接続中' : '切断中'} />
            <span className="hl-name">{p.name}</span>
            {p.id === s.hostId ? (
              <span className="muted small">親機</span>
            ) : (
              <button className="hl-kick" onClick={() => room.send({ t: 'kick', playerId: p.id })} aria-label={`${p.name} を外す`}>
                外す
              </button>
            )}
          </li>
        ))}
      </ul>
      <h2 className="hl-h">ルール設定</h2>
      <div className="hl-settings">
        <RuleSettings room={room} s={s} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 対局中

/** 親機の操作（持ち時間の一時停止、音）。テーブルの右上にあったもの */
export function HostControls({ room, s, g }: { room: Room; s: RoomView; g: GameView | null }) {
  const t = useTableless();
  if (!t.isHost) return null;
  return (
    <div className="host-ctrl">
      {s.config.timeLimit !== false && g?.phase !== 'result' && <PauseButton room={room} s={s} />}
      <SoundButton />
    </div>
  );
}

/** 卓の様子: ほかの人のめくれた札と、今の状況。テーブルの席の代わり */
export function TableStrip({ s, g }: { s: RoomView; g: GameView }) {
  const t = useTableless();
  // テーブルの効果音は親機だけで鳴らす（全員のスマホで鳴ると重なる）
  useTableSounds(s, g, t.isHost);
  const visibleKey = g.phase === 'reveal' ? JSON.stringify([g.board, g.seats.map((x) => x.cards)]) : '';
  const odds = useMemo(() => {
    if (g.phase !== 'reveal') return null;
    const visible = new Set<CardT>();
    g.board.forEach((c) => c !== null && visible.add(c));
    g.seats.forEach((x) => x.cards.forEach((c) => c !== null && visible.add(c)));
    return g.seats.map((x) => revealOdds(x, g.board, visible, 200));
  }, [visibleKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (i: number) => s.players.find((p) => p.id === g.seats[i]?.id)?.name ?? '？';
  return (
    <section className="strip" aria-label="ほかの人の札">
      {g.seats.map((sv, i) =>
        i === g.you ? null : (
          <div className={`strip-row${g.phase === 'reveal' && g.revealTurn === i ? ' turn' : ''}`} key={sv.id}>
            <div className="strip-who">
              <span className="strip-name">{name(i)}</span>
              {g.dealer === i && <span className="dealer">親</span>}
              <Chips n={g.result ? g.result.stacks[i]! : sv.stack} />
            </div>
            {g.phase !== 'placement' && <SeatCards sv={sv} best={g.result?.bestSet[i] ?? g.provisional?.bestSet[i]} />}
            <span className="strip-status">{seatStatus(g, i, sv, odds?.[i]?.current.name)}</span>
          </div>
        ),
      )}
    </section>
  );
}

function SeatCards({ sv, best }: { sv: SeatView; best?: number }) {
  if (!sv.sets) return null;
  return (
    <div className="strip-sets">
      {sv.sets.map((pair, si) => (
        <div className={`strip-set${best === si ? ' best' : ''}`} key={si}>
          {pair.map((k) => (
            <Card key={k} card={sv.cards[k] ?? null} faceUp={sv.cards[k] != null} width={24} />
          ))}
        </div>
      ))}
    </div>
  );
}

function seatStatus(g: GameView, i: number, sv: SeatView, live?: string): string {
  switch (g.phase) {
    case 'placement':
      return sv.arranged ? '配置ずみ' : sv.placed ? '組み分け中' : `めくり ${sv.peekedCount} 枚`;
    case 'boardReveal':
      return '';
    case 'reveal':
      return g.revealTurn === i ? 'めくっています' : (live ?? '');
    case 'result': {
      const r = g.result!;
      const tag = r.winners.includes(i) ? '勝ち ' : '';
      return `${tag}${handName(r.scores[i]!)} ${signed(r.delta[i]!)}`;
    }
    default: {
      const p = g.provisional!;
      const ch = g.challenge;
      const mark = ch?.declarers.includes(i) ? '・挑戦' : ch?.joiners.includes(i) ? '・便乗' : '';
      return `${provisionalRank(g, i)}位 ${handName(p.scores[i]!)}${mark}`;
    }
  }
}

/** 入れ替えの場札（ルーレットの光が回り、止まった札が燃えて入れ替わる）。テーブルの場札の代わり */
export function SwapBoard({ s, g }: { s: RoomView; g: GameView }) {
  const t = useTableless();
  const swap = useSwapAnimation(g, s.gameNo, t.isHost);
  return (
    <div className="swap-board" aria-label="場札">
      <Board g={g} swap={swap} width={52} />
      {swap.intro && <p className="muted small swap-intro">勝負の顔ぶれがそろいました</p>}
    </div>
  );
}

/** 結果の後、親機が次のゲームへ進める */
export function NextGame({ room, s }: { room: Room; s: RoomView }) {
  const t = useTableless();
  if (!t.isHost) return <p className="muted pg-note">{t.hostName} さんが次のゲームへ進めます</p>;
  const last = s.config.maxGames !== null && s.gameNo >= s.config.maxGames;
  return (
    <button className="btn btn-shu btn-wide" onClick={() => room.send({ t: 'nextGame' })}>
      {last ? '最終結果を見る' : '次のゲームへ'}
    </button>
  );
}

/** 最終結果（全員の順位） */
export function FinalList({ s }: { s: RoomView }) {
  const ranked = (s.ranking ?? []).map((id) => s.players.find((p) => p.id === id)!).filter(Boolean);
  return (
    <ol className="final-mini">
      {ranked.map((p, i) => (
        <li key={p.id}>
          <span className={`seal${i === 0 ? ' kin' : ''}`}>{i + 1}位</span>
          <span className="final-mini-name">{p.name}</span>
          <Chips n={p.chips} />
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- ルームを作る

/** スマホでルームを作り、親機として参加する（/host） */
export function HostScreen({ navigate }: { navigate: (path: string, replace?: boolean) => void }) {
  const room = useRoom(null, 'player');
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('unpoker:name') ?? '';
    } catch {
      return '';
    }
  });
  const s = room.state;
  useEffect(() => {
    if (s) navigate(`/play/${s.roomId}`, true);
  }, [s, navigate]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try {
      localStorage.setItem('unpoker:name', n);
    } catch {
      /* noop */
    }
    room.send({ t: 'hostRoom', name: n });
  };
  return (
    <div className="ply felt">
      <form className="join" onSubmit={submit}>
        <h1 className="ply-wordmark">unpoker</h1>
        <p className="muted">このスマホでテーブルを作ります。iPad の代わりに、このスマホでルールを決めて対局を進めます</p>
        <label className="join-label" htmlFor="name">
          テーブルでの呼び名
        </label>
        <input id="name" className="field" maxLength={12} autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} placeholder="例: ゆき" />
        <button className="btn btn-shu btn-wide" type="submit" disabled={!name.trim() || room.status !== 'open'}>
          テーブルを作って参加する
        </button>
        {room.error && <p className="muted small">{room.error.message}</p>}
      </form>
    </div>
  );
}
