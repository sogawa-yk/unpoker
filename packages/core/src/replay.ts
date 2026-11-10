// 対局の操作（記録の 1 件）と、その操作を状態に当てる関数。architecture.md「追加: 対局の記録」
// サーバーは状態を変えるときに必ず reduceMatch を通し、操作を 1 件ずつ記録する。
// 記録を最初から順に reduceMatch へ当て直すと、同じ対局を 1 手ずつ再現できる（乱数は操作の番号ごとに決まる）。
import type { Rng } from './cards.ts';
import { apply, GameError, type GameAction } from './game.ts';
import { buyCredit, chooseBet, chooseSpecial, createMatch, dealSpecials, settleGame, startGame, waitingBeforeStart, type MatchConfig, type MatchState } from './match.ts';
import type { SpecialKind } from './special.ts';
import type { PlayerStats } from './stats.ts';

/** ルールの版。遊び方が変わったら上げる（記録にこの版を残し、分析のときに版ごとに分ける） */
export const RULES_VERSION = '2026-11-10.3'; // .2: 場札の構成（B-8）と 2 人プレイ ／ .3: 前払いクレジット（B-11）

export type MatchOp =
  /** 対局を作る（参加者と設定が決まった時点） */
  | { op: 'create'; config: MatchConfig; players: { id: string; name: string }[]; held?: Record<string, SpecialKind | null> }
  /** 特殊効果カードを配る（前の対局の成績から） */
  | { op: 'specials'; stats: PlayerStats[] }
  /** 持っているカードと新しいカードのどちらを持つか（playerId が null なら時間切れで、いまのまま） */
  | { op: 'specialPick'; playerId: string | null; take: boolean }
  /** 最初のゲームを始める */
  | { op: 'start' }
  /** 持ち回り方式で親がベット額を決める（playerId と amount が null なら時間切れで最低ベット） */
  | { op: 'bet'; playerId: string | null; amount: number | null }
  /** ゲーム中の操作（プレイヤーの操作、時間切れ、演出の進行） */
  | { op: 'game'; action: GameAction }
  /** 結果を持ち点に反映して、次のゲームを始める（規定数に達していれば対局を終える） */
  | { op: 'next' }
  /** 前払いクレジットを買う（playerId が null なら時間切れで締め切る）。全員が買い終えたら最初のゲームを始める */
  | { op: 'buy'; playerId: string | null; units: number | null };

export function reduceMatch(m: MatchState | null, op: MatchOp, rng: Rng): MatchState {
  if (op.op === 'create') return createMatch(op.config, op.players, op.held ?? {});
  if (!m) throw new GameError('対局がない');
  switch (op.op) {
    case 'start':
      return startGame(m, rng);
    case 'bet':
      return chooseBet(m, op.playerId, op.amount, rng);
    case 'game': {
      if (!m.game) throw new GameError('ゲーム中ではない');
      return { ...m, game: apply(m.game, op.action, rng) };
    }
    case 'buy':
      return maybeStart(buyCredit(m, op.playerId, op.units), rng);
    case 'specials':
      return dealSpecials(m, op.stats, rng);
    case 'specialPick':
      return maybeStart(chooseSpecial(m, op.playerId, op.take), rng);
    case 'next': {
      const next = settleGame(m);
      return next.finished ? next : startGame(next, rng);
    }
  }
}

/** 記録した操作を最初から当て直す（rngFor は操作の番号ごとの乱数） */
/** 最初のゲームの前に待つことがなくなったら、最初のゲームを始める */
function maybeStart(m: MatchState, rng: Rng): MatchState {
  if (waitingBeforeStart(m) || m.game || m.betting || m.finished || m.history.length > 0) return m;
  return startGame(m, rng);
}

export function replayMatch(ops: readonly MatchOp[], rngFor: (eventNo: number) => Rng): MatchState {
  let m: MatchState | null = null;
  ops.forEach((op, i) => {
    m = reduceMatch(m, op, rngFor(i));
  });
  if (!m) throw new GameError('記録が空');
  return m;
}
