import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCountdown, type Room } from '../net.ts';

/** 残り時間のゲージ。持ち時間のときだけ出す */
export function Gauge({ room }: { room: Room }) {
  const s = room.state;
  const left = useCountdown(s?.deadline ?? null, room.clockOffset, s?.deadlineMs || 1);
  if (s?.paused && s.pausedRemain != null) {
    // テーブルが持ち時間を止めている: 残りの位置で止めて「停止中」と出す
    const frozen = Math.max(0, Math.min(1, s.pausedRemain / (s.deadlineMs || 1)));
    return (
      <div className="gauge paused" role="timer" aria-label={`持ち時間を停止中（残り ${Math.ceil(s.pausedRemain / 1000)} 秒）`}>
        <i style={{ transform: `scaleX(${frozen})` }} />
        <span className="gauge-note">停止中</span>
      </div>
    );
  }
  if (!s?.deadline || !s.deadlineIsTimeout) return <div className="gauge" style={{ visibility: 'hidden' }} />;
  return (
    <div className={`gauge${left < 0.25 ? ' urgent' : ''}`} role="timer" aria-label={`残り ${Math.ceil((left * s.deadlineMs) / 1000)} 秒`}>
      <i style={{ transform: `scaleX(${left})` }} />
    </div>
  );
}

/** 長押しで決定するボタン（誤操作を防ぐ。ux.md 2 章） */
export function HoldButton({
  onDone,
  ms = 500,
  className = 'btn',
  disabled,
  children,
}: {
  onDone: () => void;
  ms?: number;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [p, setP] = useState(0);
  const raf = useRef(0);
  const start = useRef(0);
  const stop = () => {
    cancelAnimationFrame(raf.current);
    setP(0);
  };
  const begin = () => {
    if (disabled) return;
    start.current = performance.now();
    const tick = () => {
      const v = Math.min(1, (performance.now() - start.current) / ms);
      setP(v);
      if (v >= 1) {
        onDone();
        setTimeout(() => setP(0), 150);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return (
    <button
      type="button"
      className={`${className} hold`}
      style={{ ['--hold' as string]: p }}
      disabled={disabled}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onDone()}
    >
      {children}
    </button>
  );
}

export function Toast({ room }: { room: Room }) {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!room.error) return;
    setShown(room.error.message);
    const t = setTimeout(() => setShown(null), 3200);
    return () => clearTimeout(t);
  }, [room.error]);
  return (
    <AnimatePresence>
      {shown && (
        <motion.div className="toast" role="status" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          {shown}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ConnBadge({ room }: { room: Room }) {
  // 裏から戻った直後は、前のゲームの画面が残っているかもしれないので、最新の状態が届くまで隠す
  if (room.stale && room.state)
    return (
      <div className="stale-cover" role="status" aria-live="polite">
        <p>最新の状態を受け取っています…</p>
      </div>
    );
  if (room.status === 'open') return null;
  return <div className="conn">{room.status === 'connecting' ? '接続中…' : '再接続しています…'}</div>;
}

export const Chips = ({ n, className = '' }: { n: number; className?: string }) => <span className={`chips ${className}`}>{n.toLocaleString()}</span>;

export const signed = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());

/**
 * 有料の操作（追加めくり、AI 相談）。金の小判で値段を見せ、押す前に「持ち点がいくつになるか」を見せる。
 * 押し間違えで払わないよう、長押しで確定する
 */
export function PaidButton({
  cost,
  stack,
  onDone,
  disabled,
  note,
  children,
}: {
  cost: number;
  stack: number;
  onDone: () => void;
  disabled?: boolean;
  /** ボタンの下の説明（払えないときは理由） */
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="paid">
      <HoldButton className="btn btn-wide btn-paid" onDone={onDone} disabled={disabled}>
        <span className="paid-label">{children}</span>
        <span className="paid-cost">
          <i className="coin" aria-hidden="true" />−{cost}
        </span>
      </HoldButton>
      {!disabled && (
        <p className="paid-receipt">
          持ち点 <b>{stack.toLocaleString()}</b> → <b>{(stack - cost).toLocaleString()}</b>。料金は次のゲームの持ち越しポットへ
        </p>
      )}
      {note && <p className="paid-note">{note}</p>}
    </div>
  );
}

/** 持ち点。減ったときは、減った分を横に浮かせて見せる（払ったことが目に残るように） */
export function StackChips({ n }: { n: number }) {
  const prev = useRef(n);
  const [drops, setDrops] = useState<{ id: number; v: number }[]>([]);
  useEffect(() => {
    const d = n - prev.current;
    prev.current = n;
    if (d >= 0) return;
    const id = performance.now();
    setDrops((x) => [...x, { id, v: d }]);
    const t = setTimeout(() => setDrops((x) => x.filter((y) => y.id !== id)), 1800);
    return () => clearTimeout(t);
  }, [n]);
  return (
    <span className="stack-chips">
      <Chips n={n} />
      <AnimatePresence>
        {drops.map((d) => (
          <motion.span
            key={d.id}
            className="chip-drop"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: -14 }}
            exit={{ opacity: 0, y: -26 }}
            transition={{ duration: 0.5 }}
          >
            {signed(d.v)}
          </motion.span>
        ))}
      </AnimatePresence>
    </span>
  );
}
