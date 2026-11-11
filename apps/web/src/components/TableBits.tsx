// テーブルの演出の部品。テーブル（iPad）と、テーブルなしで遊ぶときのスマホで使う
import { motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Card as CardT, GameView } from '@unpoker/core';
import { Card } from './Card.tsx';
import { rouletteSchedule, ROULETTE_SPIN_MS } from '../game.ts';
import type { Room, RoomView } from '../net.ts';
import { noSfx, setSoundOn, sfx as allSfx, soundOn } from '../sound.ts';
import './shared.css';

/** 効果音のオン・オフ（端末ごとに覚える） */
export function SoundButton() {
  const [on, setOn] = useState(soundOn());
  return (
    <button
      type="button"
      className={`pause-btn${on ? '' : ' on'}`}
      aria-pressed={!on}
      onClick={() => {
        setSoundOn(!on);
        setOn(!on);
        if (!on) allSfx.stamp();
      }}
    >
      {on ? '音 あり' : '音 なし'}
    </button>
  );
}

/** テーブルの効果音: 状態の変化に合わせて鳴らす（演出の時間に揃える） */
/** sound が false なら鳴らさない（テーブルなしのとき、親機以外のスマホ） */
export function useTableSounds(s: RoomView, g: GameView, sound = true) {
  const sfx = sound ? allSfx : noSfx;
  const prev = useRef<{ gameNo: number; phase: string; revealed: number; declarers: number; joiners: number } | null>(null);
  useEffect(() => {
    const cur = {
      gameNo: s.gameNo,
      phase: g.phase,
      revealed: g.seats.reduce((a, x) => a + x.revealed.length, 0),
      declarers: g.challenge?.declarers.length ?? 0,
      joiners: g.challenge?.joiners.length ?? 0,
    };
    const p = prev.current;
    prev.current = cur;
    if (!p) return; // 開いた直後（途中から開いた場合）は鳴らさない
    if (p.gameNo !== cur.gameNo) {
      for (let i = 0; i < 5; i++) sfx.flip(i * 0.09); // 配る
      return;
    }
    if (cur.phase !== p.phase) {
      if (cur.phase === 'boardReveal') g.seats.forEach((_, k) => sfx.flip(0.4 + k * 1.1));
      if (cur.phase === 'ranking') g.seats.forEach((_, i) => sfx.stamp(stampDelay(g, i)));
      if (cur.phase === 'result') {
        sfx.win(0.2);
        if (g.result?.nut) sfx.nut(1.1);
      }
    }
    if (cur.revealed > p.revealed) sfx.flip();
    if (cur.declarers > p.declarers) sfx.challenge();
  });
}

export function PauseButton({ room, s }: { room: Room; s: RoomView }) {
  return (
    <button type="button" className={`pause-btn${s.paused ? ' on' : ''}`} aria-pressed={s.paused} onClick={() => room.send({ t: 'pause', paused: !s.paused })}>
      {s.paused ? '▶ 持ち時間を再開' : 'Ⅱ 持ち時間を止める'}
    </button>
  );
}

/** 仮順位は最下位から順に押印し、1 位は最後（ux.md 3 章） */
export function stampDelay(g: GameView, seat: number): number {
  const p = g.provisional!;
  const order = [...p.scores.keys()].sort((a, b) => p.scores[a]! - p.scores[b]!);
  return 0.3 + order.indexOf(seat) * 0.9;
}

export const BOARD_W = 92;

/** under: 札の下に添える表示（チャレンジ中の勝ち筋など） */
export function Board({ g, swap, width = BOARD_W, under }: { g: GameView; swap: SwapAnim; width?: number; under?: (k: number) => ReactNode }) {
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
                  width={width}
                  delay={delay}
                  win={g.phase === 'result'}
                />
              </motion.div>
            ) : (
              <div className="card-slot" style={{ ['--card-w' as string]: `${width}px` }} />
            )}
            {g.phase === 'swap' && swap.highlight === k && <motion.div layoutId="roulette" className="roulette" transition={{ duration: 0.08 }} />}
            {under && <div className="slot-under">{under(k)}</div>}
          </div>
        );
      })}
    </div>
  );
}

export interface SwapAnim {
  /** 勝負の顔ぶれを発表している（ルーレットの前） */
  intro: boolean;
  highlight: number | null;
  burning: boolean;
  done: boolean;
  revealNew: boolean;
}

/** 勝負の顔ぶれを発表する長さ（ミリ秒）。この間は宣言した人が「回す」を押しても、光は発表の後から回り始める */
export const SWAP_INTRO_MS = 2800;

/**
 * 入れ替えの演出（山場 2）。ルーレットは、チャレンジを宣言した人がスマホで回して止める
 *   顔ぶれの発表（挑戦・受けて立つ・便乗を順に押印）
 *   → 回すのを待つ → 回っている間は光が一定の速さで回り続ける（拍子木と太鼓の拍）
 *   → ストップで、今の位置からだんだん遅くなって入れ替える札で止まる（太鼓の連打）
 *   → 太鼓の一打で札が燃えて消える → 拍子木で新しい札をめくる
 * どの札を入れ替えるかは、ストップを押したときにサーバーがランダムに決める（押す時機で結果は変わらない）
 */
/** チャレンジ宣言の発表（「挑戦」の印）の長さ。便乗の受付が始まったときに出す */
export const CHALLENGE_BANNER_MS = 2600;

/**
 * チャレンジ宣言の発表を出しているか。便乗の受付が始まった最初だけ、CHALLENGE_BANNER_MS の間 true。
 * 便乗がすぐ締め切られて場面が変わっても、発表は最後まで出す（途中で消えなくなる不具合の修正）
 */
export function useChallengeBanner(g: GameView, gameNo: number): boolean {
  const [shown, setShown] = useState(false);
  const seen = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (g.phase !== 'join' || !g.challenge || seen.current === gameNo) return;
    seen.current = gameNo;
    setShown(true);
    timer.current = setTimeout(() => setShown(false), CHALLENGE_BANNER_MS);
  }, [g.phase, gameNo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return shown;
}

export function useSwapAnimation(g: GameView, gameNo: number, sound = true): SwapAnim {
  const sfx = sound ? allSfx : noSfx;
  const ch = g.challenge;
  const target = ch?.swap?.index ?? null;
  const roulette = ch ? (ch.roulette ?? (ch.swap ? 'stopped' : 'ready')) : null;
  const idle: SwapAnim = { intro: false, highlight: null, burning: false, done: false, revealNew: false };
  const [st, setSt] = useState<SwapAnim>(idle);
  const pos = useRef(-1); // 今光っている位置
  const introFor = useRef<number | null>(null);
  const finishFor = useRef<number | null>(null);
  // チャレンジ宣言の発表が出ている間は、顔ぶれの発表を待たせる（重ならないように）
  const banner = useChallengeBanner(g, gameNo);

  // 顔ぶれの発表: 入れ替えの場面に入った最初だけ
  useEffect(() => {
    if (g.phase !== 'swap' || roulette === 'stopped' || introFor.current === gameNo || banner) return;
    introFor.current = gameNo;
    pos.current = -1;
    setSt({ ...idle, intro: true });
    const t = setTimeout(() => setSt((p) => ({ ...p, intro: false })), SWAP_INTRO_MS);
    return () => clearTimeout(t);
  }, [g.phase, gameNo, roulette, banner]); // eslint-disable-line react-hooks/exhaustive-deps

  // 回っている間: 一定の速さで回り続ける
  useEffect(() => {
    if (g.phase !== 'swap' || roulette !== 'spinning' || st.intro) return;
    const iv = setInterval(() => {
      pos.current = (pos.current + 1) % 5;
      const p = pos.current;
      setSt((s) => ({ ...s, highlight: p }));
      sfx.tick();
      if (p === 0) sfx.beat();
    }, ROULETTE_SPIN_MS);
    return () => clearInterval(iv);
  }, [g.phase, roulette, st.intro]);

  // 止めたら: 今の位置から減速して target で止まり、燃えて、新しい札をめくる
  useEffect(() => {
    if (target === null) {
      if (g.phase !== 'swap') setSt(idle);
      return;
    }
    if (g.phase !== 'swap') {
      // 途中から開いた場合や結果の画面は、入れ替え後の状態で見せる
      if (finishFor.current !== gameNo) setSt({ ...idle, done: true, revealNew: true });
      return;
    }
    if (st.intro || finishFor.current === gameNo) return;
    finishFor.current = gameNo;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, f: () => void) => timers.push(setTimeout(f, ms));
    const ticks = rouletteSchedule(target, 5, 2, pos.current, ROULETTE_SPIN_MS);
    const end = ticks[ticks.length - 1]!.at;
    sfx.drumroll(end / 1000);
    for (const tk of ticks)
      at(tk.at, () => {
        pos.current = tk.index;
        setSt((p) => ({ ...p, highlight: tk.index }));
        sfx.tick();
      });
    at(end + 500, () => {
      setSt((p) => ({ ...p, burning: true }));
      sfx.don();
      sfx.swap(0.05);
    });
    at(end + 1250, () => setSt({ ...idle, done: true }));
    at(end + 1450, () => {
      setSt((p) => ({ ...p, revealNew: true }));
      sfx.flip();
      sfx.kan(0.15);
    });
    return () => {
      timers.forEach(clearTimeout);
      finishFor.current = null; // 途中で外れたら、次に描くときにやり直す
    };
  }, [target, g.phase, gameNo, st.intro]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}
