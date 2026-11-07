// 開発用の遊び場（/dev）。1 台のブラウザに、テーブル（iPad）と手札（スマホ）を並べて遊ぶ
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './dev.css';

interface SeatCfg {
  name: string;
  bot: boolean;
}

const DEFAULT_SEATS: SeatCfg[] = [
  { name: 'あなた', bot: false },
  { name: 'はるか', bot: true },
  { name: 'そうた', bot: true },
  { name: 'みお', bot: true },
];

const TABLE_W = 1180;
const TABLE_H = 820;
const PHONE_W = 375;
const PHONE_H = 812;

export function DevScreen() {
  const [gen, setGen] = useState(0); // 卓を作り直すたびに増やす
  const [n, setN] = useState<3 | 4>(4);
  const [seats, setSeats] = useState(DEFAULT_SEATS);
  const [roomId, setRoomId] = useState<string | null>(null);
  const active = seats.slice(0, n);
  const tableRef = useRef<HTMLIFrameElement>(null);

  // テーブルの iframe がルームを作ったら、URL からルーム ID を読み取る（同じオリジンなので読める）
  useEffect(() => {
    setRoomId(null);
    const iv = setInterval(() => {
      const path = tableRef.current?.contentWindow?.location.pathname ?? '';
      const m = path.match(/^\/table\/([A-Z2-9]{6})/);
      if (m) {
        setRoomId(m[1]!);
        clearInterval(iv);
      }
    }, 300);
    return () => clearInterval(iv);
  }, [gen]);

  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 画面の分け方: 左にテーブル、右に手札。背の低い画面では手札を 1 段に並べる
  const rows = size.h < 900 ? 1 : 2;
  const phonesCols = Math.ceil(n / rows);
  const phoneScale = Math.min(0.62, (size.h / rows - 34 * rows) / PHONE_H);
  const phonesW = phonesCols * PHONE_W * phoneScale + 12;
  const tableScale = Math.min((size.w - phonesW - 24) / TABLE_W, size.h / TABLE_H);

  const setSeat = (i: number, patch: Partial<SeatCfg>) => setSeats((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="dev">
      <header className="dev-bar">
        <strong>遊び場</strong>
        <span className="dev-room">{roomId ? `テーブル ${roomId}` : 'テーブルを作っています…'}</span>
        <label>
          人数
          <select value={n} onChange={(e) => setN(Number(e.target.value) as 3 | 4)} disabled={!!roomId}>
            <option value={3}>3 人</option>
            <option value={4}>4 人</option>
          </select>
        </label>
        <button className="dev-btn" onClick={() => setGen((g) => g + 1)}>
          卓を作り直す
        </button>
        <span className="dev-hint">人数を変えるときは、卓を作り直してから選びます。開始はテーブルの「対局を始める」から</span>
      </header>
      <div className="dev-area" ref={area}>
        <div className="dev-table" style={{ width: TABLE_W * tableScale, height: TABLE_H * tableScale }}>
          <iframe
            key={`table-${gen}`}
            ref={tableRef}
            title="テーブル"
            src="/table"
            style={{ width: TABLE_W, height: TABLE_H, transform: `scale(${tableScale})` }}
          />
        </div>
        <div className="dev-phones" style={{ gridTemplateColumns: `repeat(${phonesCols}, ${PHONE_W * phoneScale}px)` }}>
          {active.map((seat, i) => (
            <div className="dev-phone" key={i}>
              <div className="dev-phone-bar">
                <input value={seat.name} maxLength={12} disabled={!!roomId} onChange={(e) => setSeat(i, { name: e.target.value })} aria-label={`手札 ${i + 1} の名前`} />
                <label>
                  <input type="checkbox" checked={seat.bot} onChange={(e) => setSeat(i, { bot: e.target.checked })} />
                  ボット
                </label>
              </div>
              <div className="dev-phone-frame" style={{ width: PHONE_W * phoneScale, height: PHONE_H * phoneScale }}>
                {roomId ? (
                  <iframe
                    key={`${gen}-${i}-${seat.bot}`}
                    title={`手札 ${seat.name}`}
                    src={`/play/${roomId}?as=dev${gen}-${i}&name=${encodeURIComponent(seat.name || `P${i + 1}`)}${seat.bot ? '&bot=1' : ''}`}
                    style={{ width: PHONE_W, height: PHONE_H, transform: `scale(${phoneScale})` }}
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
