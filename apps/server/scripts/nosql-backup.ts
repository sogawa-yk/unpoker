// 本番の NoSQL のテーブルを手元に書き出す・書き戻す（インフラを消す前と、作り直した後に使う）
//
// 書き出す: npm run nosql -- backup  [出力先=.data/backups/<日付>]
// 書き戻す: npm run nosql -- restore <バックアップのディレクトリ>
//
// 認証とコンパートメントは infra/terraform.tfvars（oci_profile、compartment_ocid）から取る。リージョンは大阪
// テーブルは <name>_rooms、<name>_games、<name>_game_events（infra/app.tf）。1 テーブル 1 ファイル（JSON Lines）と、件数を書いた manifest.json
// バックアップにはプレイヤーの名前と端末の ID が入る。公開リポジトリには入れない（.data/ は .gitignore 済み）
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { NoSQLClient, ServiceType } from 'oracle-nosqldb';

const NAME = 'unpoker';
const TABLES = ['rooms', 'games', 'game_events'] as const;

async function tfvars() {
  const text = await readFile(resolve('infra/terraform.tfvars'), 'utf8');
  const get = (k: string) => text.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
  const compartment = get('compartment_ocid');
  if (!compartment) throw new Error('infra/terraform.tfvars に compartment_ocid が無い');
  return { compartment, profile: get('oci_profile') ?? 'DEFAULT' };
}

async function client() {
  const { compartment, profile } = await tfvars();
  return new NoSQLClient({
    serviceType: ServiceType.CLOUD,
    region: 'ap-osaka-1',
    compartment,
    auth: { iam: { configFile: join(homedir(), '.oci', 'config'), profileName: profile } },
  });
}

async function backup(dir: string) {
  const c = await client();
  await mkdir(dir, { recursive: true });
  const manifest: Record<string, number> = {};
  for (const t of TABLES) {
    const table = `${NAME}_${t}`;
    const lines: string[] = [];
    for await (const res of c.queryIterable(`SELECT * FROM ${table}`)) for (const row of res.rows) lines.push(JSON.stringify(row));
    await writeFile(join(dir, `${t}.jsonl`), lines.join('\n') + (lines.length ? '\n' : ''));
    // 件数を数え直して、書き出した件数と合っているか確かめる
    const cnt = (await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n as number;
    if (cnt !== lines.length) console.warn(`${table}: 書き出し ${lines.length} 件、テーブルの件数 ${cnt} 件（書き出し中に増減した可能性）`);
    manifest[t] = lines.length;
    console.log(`${table}: ${lines.length} 件`);
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: NAME, at: new Date().toISOString(), counts: manifest }, null, 2) + '\n');
  c.close();
  console.log(`書き出しました: ${dir}`);
}

async function restore(dir: string) {
  const c = await client();
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { counts: Record<string, number> };
  for (const t of TABLES) {
    const table = `${NAME}_${t}`;
    let n = 0;
    const rl = createInterface({ input: createReadStream(join(dir, `${t}.jsonl`)) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      await c.put(table, JSON.parse(line));
      n++;
    }
    if (n !== manifest.counts[t]) throw new Error(`${table}: manifest は ${manifest.counts[t]} 件、書き戻したのは ${n} 件`);
    console.log(`${table}: ${n} 件を書き戻しました`);
  }
  c.close();
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'backup') await backup(resolve(arg ?? join('.data', 'backups', new Date().toISOString().slice(0, 10))));
else if (cmd === 'restore' && arg) await restore(resolve(arg));
else {
  console.error('使い方: npm run nosql -- backup [出力先] ／ npm run nosql -- restore <バックアップのディレクトリ>');
  process.exit(1);
}
