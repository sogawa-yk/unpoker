// 端末とサーバーの間のメッセージ（JSON）。受け取るメッセージは zod で形を検査する
import { z } from 'zod';
import type { GameView, MatchConfig, GameRecord } from '@unpoker/core';

const pair = z.tuple([z.number().int(), z.number().int()]);

export const GameActionMsg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('peek'), index: z.number().int() }),
  z.object({ type: z.literal('place'), index: z.number().int() }),
  z.object({ type: z.literal('arrange'), sets: z.array(pair).length(3) }),
  z.object({ type: z.literal('flip'), index: z.number().int() }),
  z.object({ type: z.literal('declare'), yes: z.boolean() }),
  z.object({ type: z.literal('join'), yes: z.boolean() }),
]);
export type GameActionMsg = z.infer<typeof GameActionMsg>;

export const ConfigMsg = z.object({
  initialChips: z.number().int(),
  bet: z.number().int(),
  maxGames: z.number().int().nullable(),
});

const roomId = z.string().regex(/^[A-Z2-9]{6}$/);
const token = z.string().min(20).max(100);

export const ClientMsg = z.discriminatedUnion('t', [
  /** テーブル（iPad）がルームを作る */
  z.object({ t: z.literal('createRoom') }),
  /** スマホがルームに参加する */
  z.object({ t: z.literal('join'), roomId, name: z.string().trim().min(1).max(12) }),
  /** 再接続（テーブルもスマホも） */
  z.object({ t: z.literal('resume'), roomId, token }),
  /** ルーム設定の変更（テーブル、待機中のみ） */
  z.object({ t: z.literal('configure'), config: ConfigMsg }),
  /** 待機中の参加者を外す（テーブル、待機中のみ） */
  z.object({ t: z.literal('kick'), playerId: z.string() }),
  /** 対局開始（テーブル） */
  z.object({ t: z.literal('start') }),
  /** 結果確認の後、次のゲームへ（テーブル） */
  z.object({ t: z.literal('nextGame') }),
  /** 持ち時間を止める・再開する（テーブル、対局中） */
  z.object({ t: z.literal('pause'), paused: z.boolean() }),
  /** ゲーム中の操作（スマホ） */
  z.object({ t: z.literal('action'), action: GameActionMsg }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface PlayerView {
  id: string;
  name: string;
  connected: boolean;
  chips: number;
  /** 今のゲームでの席番号（参加していなければ null） */
  seat: number | null;
}

export interface RoomView {
  roomId: string;
  status: RoomStatus;
  config: MatchConfig;
  players: PlayerView[];
  tableConnected: boolean;
  you: { role: 'table' } | { role: 'player'; playerId: string };
  gameNo: number;
  dealerId: string | null;
  history: GameRecord[];
  ranking: string[] | null;
  game: GameView | null;
  /** 今のフェーズの締め切り（サーバー時刻のミリ秒）。演出の終わりの時刻か、持ち時間の終わり */
  deadline: number | null;
  /** 締め切りまでの長さ（ミリ秒） */
  deadlineMs: number;
  /** 締め切りが持ち時間（操作待ち）なら true、演出の待ち時間なら false */
  deadlineIsTimeout: boolean;
  /** テーブルが持ち時間を止めている */
  paused: boolean;
  /** 止めている間の操作待ちの残り（ミリ秒）。操作待ちでなければ null */
  pausedRemain: number | null;
  serverTime: number;
}

export type ServerMsg =
  | { t: 'welcome'; roomId: string; token: string; role: 'table' | 'player'; playerId?: string }
  | { t: 'state'; seq: number; room: RoomView }
  | { t: 'error'; message: string; code?: 'room_not_found' | 'bad_token' | 'room_full' | 'bad_request' | 'rule' | 'rate_limited' }
  | { t: 'pong'; serverTime: number };
