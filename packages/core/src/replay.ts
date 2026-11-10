// 対局の操作（記録の 1 件）と、その操作を状態に当てる関数。architecture.md「追加: 対局の記録」
// サーバーは状態を変えるときに必ず reduceMatch を通し、操作を 1 件ずつ記録する。
// 記録を最初から順に reduceMatch へ当て直すと、同じ対局を 1 手ずつ再現できる（乱数は操作の番号ごとに決まる）。
import type { Rng } from './cards.ts';
import { apply, GameError, type GameAction } from './game.ts';
import { chooseBet, createMatch, settleGame, startGame, type MatchConfig, type MatchState } from './match.ts';

/** ルールの版。遊び方が変わったら上げる（記録にこの版を残し、分析のときに版ごとに分ける） */
export const RULES_VERSION = '2026-11-10.1';

export type MatchOp =
  /** 対局を作る（参加者と設定が決まった時点） */
  | { op: 'create'; config: MatchConfig; players: { id: string; name: string }[] }
  /** 最初のゲームを始める */
  | { op: 'start' }
  /** 持ち回り方式で親がベット額を決める（playerId と amount が null なら時間切れで最低ベット） */
  | { op: 'bet'; playerId: string | null; amount: number | null }
  /** ゲーム中の操作（プレイヤーの操作、時間切れ、演出の進行） */
  | { op: 'game'; action: GameAction }
  /** 結果を持ち点に反映して、次のゲームを始める（規定数に達していれば対局を終える） */
  | { op: 'next' };

export function reduceMatch(m: MatchState | null, op: MatchOp, rng: Rng): MatchState {
  if (op.op === 'create') return createMatch(op.config, op.players);
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
    case 'next': {
      const next = settleGame(m);
      return next.finished ? next : startGame(next, rng);
    }
  }
}

/** 記録した操作を最初から当て直す（rngFor は操作の番号ごとの乱数） */
export function replayMatch(ops: readonly MatchOp[], rngFor: (eventNo: number) => Rng): MatchState {
  let m: MatchState | null = null;
  ops.forEach((op, i) => {
    m = reduceMatch(m, op, rngFor(i));
  });
  if (!m) throw new GameError('記録が空');
  return m;
}
