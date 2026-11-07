import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp } from '../src/app.ts';
import { MemoryStore } from '../src/store.ts';
import type { Explainer } from '../src/explain.ts';
import type { RoomView, ServerMsg } from '../src/protocol.ts';

const FAST = {
  placement: 1500,
  flip: 300,
  declare: 300,
  join: 300,
  boardRevealBase: 10,
  boardRevealPerCard: 5,
  ranking: 10,
  swap: 10,
  bet: 300,
};

type App = Awaited<ReturnType<typeof createApp>>;
const apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function start(store = new MemoryStore(), explainer?: Explainer) {
  const app = await createApp({ store, timing: FAST, explainer });
  apps.push(app);
  await new Promise<void>((r) => app.server.listen(0, r));
  const port = (app.server.address() as AddressInfo).port;
  return { app, url: `ws://127.0.0.1:${port}/ws`, port, store };
}

/** テスト用の端末 */
class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  state: RoomView | null = null;
  token = '';
  playerId = '';
  private waiters: (() => void)[] = [];
  /** 受け取った全状態（情報漏れの検査用） */
  states: RoomView[] = [];
  /** true にすると、自分の番が来ても操作しない（時間切れの確認用） */
  idle = false;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMsg;
      this.msgs.push(m);
      if (m.t === 'welcome') {
        this.token = m.token;
        this.playerId = m.playerId ?? '';
      }
      if (m.t === 'state') {
        this.state = m.room;
        this.states.push(m.room);
      }
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  open() {
    return new Promise<void>((r, j) => {
      this.ws.once('open', () => r());
      this.ws.once('error', j);
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  async until<T>(pred: () => T | undefined | false | null, ms = 8000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() > end) throw new Error(`待ちきれない: ${JSON.stringify(this.msgs.slice(-3))}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  close() {
    this.ws.close();
  }
}

/** 状態を見て、自分の操作があれば 1 つ送る */
function bot(c: Client) {
  const s = c.state;
  const g = s?.game;
  if (!g || g.you === null || c.idle) return;
  const me = g.seats[g.you]!;
  const send = (action: unknown) => c.send({ t: 'action', action });
  switch (g.phase) {
    case 'placement':
      if (me.peekedCount < 3) return send({ type: 'peek', index: [0, 1, 2, 3, 4, 5, 6].find((k) => !me.known.includes(k)) });
      if (!me.placed) return send({ type: 'place', index: me.known[0] });
      if (!me.arranged) {
        const idx = [0, 1, 2, 3, 4, 5, 6].filter((k) => k !== me.boardIndex);
        return send({ type: 'arrange', sets: [[idx[0], idx[1]], [idx[2], idx[3]], [idx[4], idx[5]]] });
      }
      return;
    case 'reveal':
      if (g.revealTurn === g.you) {
        const k = [0, 1, 2, 3, 4, 5, 6].find((i) => i !== me.boardIndex && !me.revealed.includes(i));
        return send({ type: 'flip', index: k });
      }
      return;
    case 'declare':
      if (g.provisional?.lasts.includes(g.you) && !me.declareDone) return send({ type: 'declare', yes: me.stack > 0 });
      return;
    case 'join':
      if (g.challenge?.optional.includes(g.you) && !me.joinDone) return send({ type: 'join', yes: true });
      return;
  }
}

/** 他人の伏せ札がスマホに届いていないか */
function assertNoLeak(c: Client) {
  for (const s of c.states) {
    const g = s.game;
    if (!g || g.you === null) continue;
    const open = ['ranking', 'declare', 'join', 'swap', 'result'].includes(g.phase);
    g.seats.forEach((sv, i) => {
      if (i === g.you || open) return;
      sv.cards.forEach((card, k) => {
        if (card === null) return;
        const allowed = sv.revealed.includes(k) || (g.phase !== 'placement' && k === sv.boardIndex);
        expect(allowed, `席 ${g.you} に席 ${i} の札 ${k} が見えている（${g.phase}）`).toBe(true);
      });
    });
    expect(JSON.stringify(s)).not.toMatch(/"deck"|"token"|tableToken/);
  }
}

async function setupRoom(url: string, names: string[]) {
  const table = new Client(url);
  await table.open();
  table.send({ t: 'createRoom' });
  const roomId = await table.until(() => table.state?.roomId);
  const players: Client[] = [];
  for (const name of names) {
    const c = new Client(url);
    await c.open();
    c.send({ t: 'join', roomId, name });
    await c.until(() => c.playerId);
    players.push(c);
  }
  await table.until(() => table.state!.players.length === names.length && table.state!.players.every((p) => p.connected));
  return { table, players, roomId };
}

async function playUntilResult(table: Client, players: Client[], gameNo: number) {
  await table.until(
    () => {
      players.forEach(bot);
      const s = table.state!;
      return s.status === 'finished' || (s.gameNo === gameNo && s.game?.phase === 'result');
    },
    20000,
  );
}

describe('サーバー', () => {
  it('3 人で 2 ゲーム遊べ、情報が漏れず、持ち点の合計が保たれる', async () => {
    const { url } = await start();
    const { table, players } = await setupRoom(url, ['あ', 'い', 'う']);
    table.send({ t: 'configure', config: { initialChips: 1000, bet: 100, maxGames: 2 } });
    await table.until(() => table.state!.config.maxGames === 2);
    table.send({ t: 'start' });
    await playUntilResult(table, players, 1);
    const r1 = table.state!.game!.result!;
    expect(r1.stacks.reduce((a, b) => a + b, 0)).toBe(3000);
    table.send({ t: 'nextGame' });
    await table.until(() => table.state!.gameNo === 2);
    await playUntilResult(table, players, 2);
    table.send({ t: 'nextGame' });
    await table.until(() => table.state!.status === 'finished');
    const s = table.state!;
    expect(s.ranking).toHaveLength(3);
    expect(s.players.reduce((a, p) => a + p.chips, 0)).toBe(3000);
    expect(s.history).toHaveLength(2);
    players.forEach(assertNoLeak);
  });

  it('切断しても、トークンで再接続すると続きから遊べる', async () => {
    const { url } = await start();
    const { table, players, roomId } = await setupRoom(url, ['A', 'B', 'C', 'D']);
    table.send({ t: 'start' });
    await table.until(() => table.state!.game?.phase === 'placement');
    // 1 人が 1 枚めくってから切断
    const c = players[1]!;
    await c.until(() => c.state?.game);
    c.send({ t: 'action', action: { type: 'peek', index: 4 } });
    await c.until(() => c.state!.game!.seats[c.state!.game!.you!]!.known.includes(4));
    const token = c.token;
    c.close();
    await table.until(() => table.state!.players.filter((p) => p.connected).length === 3);
    const back = new Client(url);
    await back.open();
    back.send({ t: 'resume', roomId, token });
    await back.until(() => back.state?.game);
    const g = back.state!.game!;
    expect(g.seats[g.you!]!.known).toEqual([4]);
    expect(g.seats[g.you!]!.cards[4]).not.toBeNull();
    players[1] = back;
    await playUntilResult(table, players, 1);
    expect(table.state!.game!.result).not.toBeNull();
  });

  it('操作しない人がいても、持ち時間が過ぎれば自動で進む', async () => {
    const { url } = await start();
    const { table, players } = await setupRoom(url, ['x', 'y', 'z']);
    players[2]!.idle = true;
    table.send({ t: 'start' });
    await playUntilResult(table, players, 1);
    expect(table.state!.game!.phase).toBe('result');
  });

  it('テーブルが持ち時間を止めると時間切れにならず、再開すると残り時間から続く', async () => {
    const { url } = await start();
    const { table, players } = await setupRoom(url, ['止', 'め', 'る']);
    players.forEach((p) => (p.idle = true));
    table.send({ t: 'start' });
    await table.until(() => table.state!.game?.phase === 'placement' && table.state!.deadline);
    // プレイヤーは止められない
    players[0]!.send({ t: 'pause', paused: true });
    await players[0]!.until(() => players[0]!.msgs.some((m) => m.t === 'error' && m.message.includes('テーブルだけ')));
    table.send({ t: 'pause', paused: true });
    await table.until(() => table.state!.paused);
    expect(table.state!.deadline).toBeNull();
    expect(table.state!.pausedRemain).toBeGreaterThan(0);
    await players[1]!.until(() => players[1]!.state!.paused);
    // 配置の持ち時間（1.5 秒）を過ぎても配置のまま
    await new Promise((r) => setTimeout(r, 2000));
    expect(table.state!.game!.phase).toBe('placement');
    table.send({ t: 'pause', paused: false });
    await table.until(() => !table.state!.paused && table.state!.deadline);
    expect(table.state!.deadline! - table.state!.serverTime).toBeLessThanOrEqual(1500);
    await table.until(() => table.state!.game!.phase !== 'placement', 4000);
  });

  it('AI 相談: 相談したことは全員に見え、中身は本人だけに届く', async () => {
    const { url } = await start();
    const { table, players } = await setupRoom(url, ['相', '談', '者']);
    players.forEach((p) => (p.idle = true));
    table.send({ t: 'start' });
    const p = players[0]!;
    await p.until(() => p.state!.game?.phase === 'placement');
    const seat = p.state!.game!.you!;
    for (const index of [0, 1, 2]) p.send({ t: 'action', action: { type: 'peek', index } });
    await p.until(() => p.state!.game!.seats[seat]!.peekedCount === 3);
    p.send({ t: 'action', action: { type: 'consult' } });
    await p.until(() => p.state!.game!.seats[seat]!.advice.length === 1);
    expect(p.state!.game!.seats[seat]!.adviceFee).toBe(10);
    await table.until(() => table.state!.game!.seats[seat]!.consulted.length === 1);
    expect(table.state!.game!.seats[seat]!.advice).toEqual([]);
    expect(JSON.stringify(players[1]!.state)).not.toContain('"candidates"');
  });

  it('持ち回りベット: 親だけがベット額を選べ、選ばなければ最低ベットで配る', async () => {
    const { url } = await start();
    const { table, players } = await setupRoom(url, ['親', '子', '孫']);
    players.forEach((p) => (p.idle = true));
    table.send({ t: 'configure', config: { initialChips: 1000, bet: 100, maxGames: 5, betMode: 'rotating', minBet: 100, maxBet: 300, betStep: 100 } });
    await table.until(() => table.state!.config.betMode === 'rotating');
    table.send({ t: 'start' });
    const b = await table.until(() => table.state!.betting);
    expect(table.state!.game).toBeNull();
    expect(b.options).toEqual([100, 200, 300]);
    expect(table.state!.deadlineIsTimeout).toBe(true);
    const dealer = players.find((p) => p.playerId === b.dealerId)!;
    const other = players.find((p) => p.playerId !== b.dealerId)!;
    other.send({ t: 'bet', amount: 200 });
    await other.until(() => other.msgs.some((m) => m.t === 'error' && m.message.includes('親だけ')));
    dealer.send({ t: 'bet', amount: 300 });
    await table.until(() => table.state!.game?.bet === 300);
    expect(table.state!.betting).toBeNull();
  });

  it('持ち回りベット: 親が選ばないまま持ち時間が切れると最低ベット', async () => {
    const { url } = await start();
    const { table, players } = await setupRoom(url, ['甲', '乙', '丙']);
    players.forEach((p) => (p.idle = true));
    table.send({ t: 'configure', config: { initialChips: 1000, bet: 100, maxGames: 5, betMode: 'rotating', minBet: 50, maxBet: null, betStep: 50 } });
    await table.until(() => table.state!.config.betMode === 'rotating');
    table.send({ t: 'start' });
    await table.until(() => table.state!.betting);
    await table.until(() => table.state!.game?.bet === 50, 4000);
  });

  it('AI 相談の説明文: 数字の後に本人だけへ届き、失敗しても数字は残る', async () => {
    const prompts: string[] = [];
    let fail = false;
    const { url } = await start(new MemoryStore(), {
      explain: async (_sys: string, user: string) => {
        prompts.push(user);
        await new Promise((r) => setTimeout(r, 50));
        if (fail) throw new Error('boom');
        return '説明です';
      },
    });
    const { table, players } = await setupRoom(url, ['説', '明', '文']);
    players.forEach((p) => (p.idle = true));
    table.send({ t: 'start' });
    const p = players[0]!;
    await p.until(() => p.state!.game?.phase === 'placement');
    table.send({ t: 'pause', paused: true });
    const seat = p.state!.game!.you!;
    for (const index of [0, 1, 2]) p.send({ t: 'action', action: { type: 'peek', index } });
    await p.until(() => p.state!.game!.seats[seat]!.peekedCount === 3);
    p.send({ t: 'action', action: { type: 'consult' } });
    await p.until(() => p.state!.game!.seats[seat]!.advice[0]?.explanation === '説明です');
    expect(JSON.stringify(players[1]!.state)).not.toContain('説明です');
    expect(JSON.stringify(table.state)).not.toContain('説明です');
    // 説明を頼む文面に、本人が知らない他人の札を入れない
    const others = table.state!.game!.seats.filter((_, i) => i !== seat);
    expect(others.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('自分がめくって中身を知っている札');
    // 失敗したら説明文は null（数字の答えはそのまま）
    fail = true;
    p.send({ t: 'action', action: { type: 'place', index: p.state!.game!.seats[seat]!.known[0]! } });
    await p.until(() => p.state!.game!.seats[seat]!.placed);
    p.send({ t: 'action', action: { type: 'consult' } });
    await p.until(() => p.state!.game!.seats[seat]!.advice[1]?.explaining === false);
    expect(p.state!.game!.seats[seat]!.advice[1]!.explanation).toBeNull();
    expect(p.state!.game!.seats[seat]!.advice[1]!.advice).toBeTruthy();
  });

  it('持ち時間なしのルームでは、操作待ちで時間切れにならず、演出は進む', async () => {
    const { url } = await start();
    const { table, players } = await setupRoom(url, ['待', 'つ', '人']);
    players.forEach((p) => (p.idle = true));
    table.send({ t: 'configure', config: { initialChips: 1000, bet: 100, maxGames: 5, timeLimit: false } });
    await table.until(() => table.state!.config.timeLimit === false);
    table.send({ t: 'start' });
    await table.until(() => table.state!.game?.phase === 'placement');
    expect(table.state!.deadline).toBeNull();
    // 配置の持ち時間（1.5 秒）を過ぎても配置のまま
    await new Promise((r) => setTimeout(r, 2000));
    expect(table.state!.game!.phase).toBe('placement');
    // 全員が操作すれば、演出（場札の公開）は締め切りで進む
    players.forEach((p) => (p.idle = false));
    await table.until(() => {
      players.forEach(bot);
      return table.state!.game!.phase === 'reveal';
    }, 6000);
    expect(table.state!.deadline).toBeNull();
  });

  it('サーバーを再起動しても、保存した状態から続けられる', async () => {
    const store = new MemoryStore();
    const first = await start(store);
    const { table, players, roomId } = await setupRoom(first.url, ['p', 'q', 'r']);
    table.send({ t: 'start' });
    await table.until(() => table.state!.game?.phase === 'placement');
    const tokens = players.map((p) => p.token);
    const tableToken = table.token;
    await first.app.rooms.flushAll();
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    const second = await start(store);
    const t2 = new Client(second.url);
    await t2.open();
    t2.send({ t: 'resume', roomId, token: tableToken });
    await t2.until(() => t2.state?.game?.phase === 'placement');
    const ps = await Promise.all(
      tokens.map(async (token) => {
        const c = new Client(second.url);
        await c.open();
        c.send({ t: 'resume', roomId, token });
        await c.until(() => c.state?.game);
        return c;
      }),
    );
    await playUntilResult(t2, ps, 1);
    expect(t2.state!.game!.result).not.toBeNull();
  });

  it('不正なメッセージや権限のない操作は拒否する', async () => {
    const { url } = await start();
    const { table, players, roomId } = await setupRoom(url, ['一', '二', '三']);
    const p = players[0]!;
    p.send({ t: 'start' });
    await p.until(() => p.msgs.some((m) => m.t === 'error' && m.message.includes('テーブルだけ')));
    p.send({ t: 'nonsense' });
    await p.until(() => p.msgs.some((m) => m.t === 'error' && m.code === 'bad_request'));
    const stranger = new Client(url);
    await stranger.open();
    stranger.send({ t: 'resume', roomId, token: 'x'.repeat(32) });
    await stranger.until(() => stranger.msgs.some((m) => m.t === 'error' && m.code === 'bad_token'));
    table.send({ t: 'start' });
    await table.until(() => table.state!.status === 'playing');
    const late = new Client(url);
    await late.open();
    late.send({ t: 'join', roomId, name: '四' });
    await late.until(() => late.msgs.some((m) => m.t === 'error' && m.message.includes('始まっている')));
  });

  it('/healthz に応答する', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(await res.text()).toBe('ok');
  });
});
