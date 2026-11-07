import { motion, useReducedMotion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';
import { rankOf, suitOf, type Card as CardT } from '@unpoker/core';

const RANK_LABEL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT = ['♠', '♥', '♦', '♣'];

export const rankLabel = (c: CardT) => RANK_LABEL[rankOf(c)]!;
export const suitLabel = (c: CardT) => SUIT[suitOf(c)]!;
export const isRed = (c: CardT) => suitOf(c) === 1 || suitOf(c) === 2;
export const cardName = (c: CardT) => `${suitLabel(c)}${rankLabel(c)}`;

export interface CardProps {
  card: CardT | null;
  /** 表向きにするか（card が null なら常に裏） */
  faceUp: boolean;
  width?: number;
  /** 自分だけが中身を知っている伏せ札 */
  secret?: boolean;
  /** 持ち主も中身を知らない伏せ札 */
  unknown?: boolean;
  selected?: boolean;
  dim?: boolean;
  win?: boolean;
  /** めくる演出の遅れ（秒） */
  delay?: number;
  onClick?: () => void;
  style?: CSSProperties;
  label?: string;
  children?: ReactNode;
}

export function Card({ card, faceUp, width, secret, unknown, selected, dim, win, delay = 0, onClick, style, label, children }: CardProps) {
  const reduce = useReducedMotion();
  const up = faceUp && card !== null;
  const cls = ['card', secret && 'secret', unknown && !up && 'unknown', selected && 'selected', dim && 'dim', win && 'win']
    .filter(Boolean)
    .join(' ');
  const aria = label ?? (up ? cardName(card!) : unknown ? '中身のわからない伏せ札' : '伏せ札');
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={cls}
      style={{ ...(width ? ({ '--card-w': `${width}px` } as CSSProperties) : {}), ...(onClick ? { border: 0, padding: 0, background: 'none' } : {}), ...style }}
      onClick={onClick}
      aria-label={aria}
      type={onClick ? 'button' : undefined}
    >
      <motion.div
        className="card-inner"
        initial={false}
        animate={{ rotateY: up ? 180 : 0, y: selected ? -10 : 0 }}
        transition={reduce ? { duration: 0 } : { rotateY: { duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }, y: { type: 'spring', stiffness: 400, damping: 26 } }}
      >
        <div className="card-back" />
        {card !== null && (
          <div className={`card-face${isRed(card) ? ' red' : ''}`}>
            <span className="card-index">
              {rankLabel(card)}
              <small>{suitLabel(card)}</small>
            </span>
            <span className="card-pip">{suitLabel(card)}</span>
            <span className="card-index flip">
              {rankLabel(card)}
              <small>{suitLabel(card)}</small>
            </span>
          </div>
        )}
      </motion.div>
      {children}
    </Tag>
  );
}
