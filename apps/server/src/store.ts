// ルームの永続化。本番は OCI NoSQL Database（インフラ構築時に実装）、開発とテストはメモリかファイル
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RoomData } from './room.ts';

export interface RoomStore {
  save(room: RoomData): Promise<void>;
  loadAll(): Promise<RoomData[]>;
  delete(id: string): Promise<void>;
}

export class MemoryStore implements RoomStore {
  rooms = new Map<string, string>();
  async save(room: RoomData) {
    this.rooms.set(room.id, JSON.stringify(room));
  }
  async loadAll() {
    return [...this.rooms.values()].map((s) => JSON.parse(s) as RoomData);
  }
  async delete(id: string) {
    this.rooms.delete(id);
  }
}

/** 開発用: 1 ルーム 1 ファイルで保存する（サーバーを再起動しても続きから遊べる） */
export class FileStore implements RoomStore {
  constructor(private dir: string) {}
  async save(room: RoomData) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${room.id}.json`), JSON.stringify(room));
  }
  async loadAll() {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'));
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(this.dir, f), 'utf8')) as RoomData));
  }
  async delete(id: string) {
    await rm(join(this.dir, `${id}.json`), { force: true });
  }
}

export interface NoSqlOptions {
  table: string;
  region: string;
  compartment: string;
  /** resource_principal（Container Instances 上）か config（手元。~/.oci/config のプロファイル） */
  auth: 'resource_principal' | 'config';
  profile?: string;
}

/**
 * 本番用: OCI NoSQL Database。テーブルは Terraform で作る
 *   CREATE TABLE rooms (id STRING, updatedAt LONG, data STRING, PRIMARY KEY(id)) USING TTL 1 DAYS
 * TTL で 24 時間後に自動で消える（ROOM_TTL_MS と同じ）
 */
export class NoSqlStore implements RoomStore {
  private client: Promise<import('oracle-nosqldb').NoSQLClient>;
  constructor(private opts: NoSqlOptions) {
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
  async save(room: RoomData) {
    const c = await this.client;
    await c.put(this.opts.table, { id: room.id, updatedAt: room.updatedAt, data: JSON.stringify(room) });
  }
  async loadAll() {
    const c = await this.client;
    const out: RoomData[] = [];
    for await (const res of c.queryIterable(`SELECT data FROM ${this.opts.table}`)) {
      for (const row of res.rows) out.push(JSON.parse(String((row as { data: string }).data)) as RoomData);
    }
    return out;
  }
  async delete(id: string) {
    const c = await this.client;
    await c.delete(this.opts.table, { id });
  }
}
