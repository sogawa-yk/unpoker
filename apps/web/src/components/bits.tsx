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
  if (room.status === 'open') return null;
  return <div className="conn">{room.status === 'connecting' ? '接続中…' : '再接続しています…'}</div>;
}

export const Chips = ({ n, className = '' }: { n: number; className?: string }) => <span className={`chips ${className}`}>{n.toLocaleString()}</span>;

export const signed = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
