// 対局の記録（分析用。architecture.md「追加: 対局の記録」）。本番は OCI NoSQL Database、開発とテストはメモリかファイル
// 記録を書くのに失敗しても、ゲームは止めない（ログに出し、少し待って書き直す）
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Card, GameRecord, MatchConfig, MatchOp } from '@unpoker/core';
import type { NoSqlOptions } from './store.ts';

/** プレイヤー（端末に保存した ID。端末を替えると別人になる） */
export interface PlayerRow {
  deviceId: string;
  name: string;
  lastSeen: number;
}

export interface MatchRow {
  /** ルーム ID と、そのルームで何番目の対局か（例: ABC234-1） */
  matchId: string;
  roomId: string;
  startedAt: number;
  endedAt: number | null;
  config: MatchConfig;
  /** 席順の参加者（ルーム内の ID、端末の ID、名前） */
  players: { id: string; deviceId: string | null; name: string }[];
  /** 乱数の種（操作の番号と合わせて、各操作の乱数が決まる） */
  seed: string;
  rulesVersion: string;
  codeVersion: string;
  /** 終わったときの順位（ルーム内の ID）と持ち点 */
  ranking: string[] | null;
  chips: Record<string, number> | null;
  refund: Record<string, number> | null;
}

export interface GameRow {
  matchId: string;
  gameNo: number;
  startedAt: number;
  endedAt: number | null;
  seatIds: string[];
  dealer: number;
  bet: number;
  carryIn: number;
  /** 配った直後の札（ルールやコードが変わっても、配った札は確実に再現できるように） */
  hands: Card[][];
  initialBoard: Card[];
  /** 伏せたランダムの場札（B-8） */
  hiddenBoard: Card[];
  deck: Card[];
  /** 結果（終わったら入る） */
  result: (Omit<GameRecord, 'gameNo' | 'seatIds'> & { scores: number[]; board: Card[] }) | null;
}

export interface EventRow {
  matchId: string;
  /** 対局の中での通し番号（0 始まり。乱数はこの番号で決まる） */
  eventNo: number;
  at: number;
  /** 操作した人（ルーム内の ID）。テーブル、持ち時間切れ、演出の進行は table / timer */
  actor: string;
  gameNo: number;
  /** 操作の後の局面 */
  phase: string | null;
  op: MatchOp;
}

/** 状態を変えない出来事（AI 相談の説明文など）。分析のために残す */
export interface NoteRow {
  matchId: string;
  eventNo: number;
  at: number;
  kind: 'explanation';
  data: Record<string, unknown>;
}

export interface RecordStore {
  putPlayer(p: PlayerRow): Promise<void>;
  putMatch(m: MatchRow): Promise<void>;
  putGame(g: GameRow): Promise<void>;
  putEvent(e: EventRow): Promise<void>;
  putNote(n: NoteRow): Promise<void>;
}

/** テスト用 */
export class MemoryRecordStore implements RecordStore {
  players = new Map<string, PlayerRow>();
  matches = new Map<string, MatchRow>();
  games = new Map<string, GameRow>();
  events: EventRow[] = [];
  notes: NoteRow[] = [];
  async putPlayer(p: PlayerRow) {
    this.players.set(p.deviceId, structuredClone(p));
  }
  async putMatch(m: MatchRow) {
    this.matches.set(m.matchId, structuredClone(m));
  }
  async putGame(g: GameRow) {
    this.games.set(`${g.matchId}:${g.gameNo}`, structuredClone(g));
  }
  async putEvent(e: EventRow) {
    this.events.push(structuredClone(e));
  }
  async putNote(n: NoteRow) {
    this.notes.push(structuredClone(n));
  }
  /** 対局の操作を番号順に */
  opsOf(matchId: string): MatchOp[] {
    return this.events.filter((e) => e.matchId === matchId).sort((a, b) => a.eventNo - b.eventNo).map((e) => e.op);
  }
}

/** 開発用: 種類ごとに JSON Lines で追記する（同じキーの行は後のものが新しい） */
export class FileRecordStore implements RecordStore {
  constructor(private dir: string) {}
  private async put(kind: string, row: unknown) {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, `${kind}.jsonl`), JSON.stringify(row) + '\n');
  }
  putPlayer = (p: PlayerRow) => this.put('players', p);
  putMatch = (m: MatchRow) => this.put('matches', m);
  putGame = (g: GameRow) => this.put('games', g);
  putEvent = (e: EventRow) => this.put('game_events', e);
  putNote = (n: NoteRow) => this.put('notes', n);
}

/**
 * 本番用: OCI NoSQL Database。テーブルは Terraform で作る（TTL なし）
 *   <prefix>_players (deviceId STRING, data JSON, PRIMARY KEY(deviceId))
 *   <prefix>_matches (matchId STRING, data JSON, PRIMARY KEY(matchId))
 *   <prefix>_games (matchId STRING, gameNo INTEGER, data JSON, PRIMARY KEY(SHARD(matchId), gameNo))
 *   <prefix>_game_events (matchId STRING, eventNo INTEGER, data JSON, PRIMARY KEY(SHARD(matchId), eventNo))
 * 説明文などのメモは game_events に eventNo を負の数（-1 から下へ）で入れる
 */
export class NoSqlRecordStore implements RecordStore {
  private client: Promise<import('oracle-nosqldb').NoSQLClient>;
  private noteNo = new Map<string, number>();
  constructor(private opts: NoSqlOptions & { prefix: string }) {
    this.client = import('oracle-nosqldb').then(
      ({ NoSQLClient, ServiceType }) =>
        new NoSQLClient({
          serviceType: ServiceType.CLOUD,
          region: opts.region,
          compartment: opts.compartment,
          auth: {
            iam: opts.auth === 'resource_principal' ? { useResourcePrincipal: true } : { configFile: join(homedir(), '.oci', 'config'), profileName: opts.profile ?? 'DEFAULT' },
          },
        }),
    );
  }
  private async put(table: string, row: Record<string, unknown>) {
    const c = await this.client;
    await c.put(`${this.opts.prefix}_${table}`, row);
  }
  putPlayer = (p: PlayerRow) => this.put('players', { deviceId: p.deviceId, data: p });
  putMatch = (m: MatchRow) => this.put('matches', { matchId: m.matchId, data: m });
  putGame = (g: GameRow) => this.put('games', { matchId: g.matchId, gameNo: g.gameNo, data: g });
  putEvent = (e: EventRow) => this.put('game_events', { matchId: e.matchId, eventNo: e.eventNo, data: e });
  putNote = (n: NoteRow) => {
    const k = (this.noteNo.get(n.matchId) ?? 0) - 1;
    this.noteNo.set(n.matchId, k);
    return this.put('game_events', { matchId: n.matchId, eventNo: k, data: n });
  };
}

/**
 * 記録を順番どおりに書く。失敗したら少し待って書き直す（最大 5 回）。書けなかった記録はログに出す
 */
export class Recorder {
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private store: RecordStore,
    private log?: (msg: string, extra?: Record<string, unknown>) => void,
    private retryMs = 1000,
  ) {}
  private push(kind: string, f: () => Promise<void>) {
    this.queue = this.queue.then(async () => {
      for (let i = 0; ; i++) {
        try {
          return await f();
        } catch (e) {
          if (i >= 4) {
            this.log?.('record failed', { kind, error: String(e) });
            return;
          }
          await new Promise((r) => setTimeout(r, this.retryMs * 2 ** i));
        }
      }
    });
  }
  player = (p: PlayerRow) => this.push('player', () => this.store.putPlayer(p));
  match = (m: MatchRow) => this.push('match', () => this.store.putMatch(structuredClone(m)));
  game = (g: GameRow) => this.push('game', () => this.store.putGame(structuredClone(g)));
  event = (e: EventRow) => this.push('event', () => this.store.putEvent(structuredClone(e)));
  note = (n: NoteRow) => this.push('note', () => this.store.putNote(structuredClone(n)));
  /** 書き終わるのを待つ（テストと終了処理用） */
  flush() {
    return this.queue;
  }
}

export const CODE_VERSION = process.env.APP_VERSION ?? 'dev';
