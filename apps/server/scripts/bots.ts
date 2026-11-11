// 開発用: ルームにボットを入れて、残りの席を埋める（ブラウザなし）。自分は実機の iPad やスマホで遊ぶ
//
// 使い方:
//   npm run bots -- <ルームコード> [人数=3] [オプション]
//   npm run bots -- ABC234 3                          … 手元のサーバー（ws://localhost:8080）
//   npm run bots -- ABC234 2 --url https://unpoker.sogawa-yk.com   … 本番
// オプション:
//   --url <URL>     サーバー（http(s)://… か ws(s)://…。既定 ws://localhost:8080）
//   --speed <倍率>  考える時間の倍率（既定 1。0.3 で速く、2 でゆっくり）
//   --consult       判断の前に AI に相談する（前払いクレジットを 2 単位買う）
//   --cautious      チャレンジを宣言・便乗しない（逆に --bold ならいつもする）
//   --names a,b,c   名前（既定 はるか,そうた,みお）
//
// ボットの名前の頭には「🤖」を付ける。Ctrl+C で終わる（席はルームに残る）
import WebSocket from 'ws';
import { arrangeSets, chooseBoardIndex, type GameView, type SpecialKind } from '@unpoker/core';
import type { ClientMsg, RoomView, ServerMsg } from '../src/protocol.ts';

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (k: string) => args.includes(k);
const roomId = (args[0] ?? '').toUpperCase();
const count = Number(args[1] && !args[1].startsWith('--') ? args[1] : 3);
if (!/^[A-Z2-9]{6}$/.test(roomId) || !(count >= 1 && count <= 3)) {
  console.error('使い方: npm run bots -- <ルームコード 6 文字> [人数 1〜3] [--url URL] [--speed 倍率] [--consult] [--cautious|--bold] [--names a,b,c]');
  process.exit(1);
}
const base = (opt('--url') ?? 'ws://localhost:8080').replace(/^http/, 'ws').replace(/\/+$/, '');
const wsUrl = base.endsWith('/ws') ? base : `${base}/ws`;
const speed = Number(opt('--speed') ?? 1);
const consult = flag('--consult');
const style: 'normal' | 'cautious' | 'bold' = flag('--cautious') ? 'cautious' : flag('--bold') ? 'bold' : 'normal';
const names = (opt('--names') ?? 'はるか,そうた,みお').split(',').map((n) => `🤖${n.trim()}`.slice(0, 12));

const think = (min = 700, max = 1600) => (min + Math.random() * (max - min)) * speed;
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
const handIdx = (n: number) => [...Array(n).keys()];

class Bot {
  ws!: WebSocket;
  state: RoomView | null = null;
  token = '';
  timer: ReturnType<typeof setTimeout> | null = null;
  /** 同じ状態に 2 回答えないための印 */
  lastKey = '';
  /** 特殊効果カードを断られたら、その状態ではもう使わない */
  skipSpecial = false;
  constructor(public name: string) {}

  connect() {
    this.ws = new WebSocket(wsUrl);
    this.ws.on('open', () => {
      this.send(this.token ? { t: 'resume', roomId, token: this.token } : { t: 'join', roomId, name: this.name });
      setInterval(() => this.ws.readyState === WebSocket.OPEN && this.ws.send('{"t":"ping"}'), 25_000).unref();
    });
    this.ws.on('message', (raw) => this.onMsg(JSON.parse(raw.toString()) as ServerMsg));
    this.ws.on('close', () => {
      console.log(`${this.name}: 切れたので、つなぎ直します`);
      setTimeout(() => this.connect(), 2000);
    });
    this.ws.on('error', () => {});
  }

  send(m: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  onMsg(m: ServerMsg) {
    if (m.t === 'welcome') {
      this.token = m.token;
      console.log(`${this.name}: 参加しました`);
    } else if (m.t === 'error') {
      if (m.code === 'room_not_found' || m.code === 'room_full') {
        console.error(`${this.name}: ${m.message}`);
        process.exit(1);
      }
      if (m.code !== 'rule') console.log(`${this.name}: ${m.message}`);
      else {
        // 断られた（使えない場面のカードなど）: 同じ状態でやり直す
        this.skipSpecial = true;
        this.lastKey = '';
        this.act();
      }
    } else if (m.t === 'state') {
      this.state = m.room;
      this.act();
    }
  }

  /** 今の状態で自分がすることを 1 つ選び、少し考えてから送る */
  act() {
    const s = this.state!;
    const key = `${s.serverTime}`;
    if (key === this.lastKey) return;
    if (this.lastKey !== '') this.skipSpecial = false;
    this.lastKey = key;
    if (this.timer) clearTimeout(this.timer);
    const plan = this.decide(s);
    if (!plan) return;
    this.timer = setTimeout(() => this.send(plan.msg), plan.wait);
  }

  decide(s: RoomView): { msg: ClientMsg; wait: number } | null {
    const me = s.you.role === 'player' ? s.you.playerId : '';
    if (s.special?.offer) return { msg: { t: 'specialPick', take: Math.random() < 0.5 }, wait: think() };
    if (s.buying && !s.buying.done.includes(me)) return { msg: { t: 'buy', units: consult ? 2 : pick([0, 0, 1, 2]) }, wait: think(1500, 3000) };
    if (s.betting?.dealerId === me) return { msg: { t: 'bet', amount: pick(s.betting.options) }, wait: think(1500, 3000) };
    const g = s.game;
    if (!g || g.you === null) return null;
    const a = this.gameAction(g);
    return a ? { msg: { t: 'action', action: a.action }, wait: a.wait } : null;
  }

  gameAction(g: GameView): { action: Extract<ClientMsg, { t: 'action' }>['action']; wait: number } | null {
    const you = g.you!;
    const me = g.seats[you]!;
    const all = handIdx(me.cards.length);
    const sp = g.special;
    // 特殊効果カード: 札を渡すときは選ぶ。持っているカードは、使える場面で半分の確率で使う
    if (sp?.passing && sp.passing.myPick === null) return { action: { type: 'pass', index: pick(all.filter((k) => k !== me.boardIndex)) }, wait: think() };
    if (sp?.mine && !this.skipSpecial && Math.random() < 0.3) {
      const k: SpecialKind = sp.mine;
      const idx = all.filter((x) => x !== me.boardIndex);
      // 使えない場面ならサーバーに断られるだけ（次の状態でまた考える）
      if (g.phase === 'placement' || g.phase === 'declare' || g.phase === 'join')
        return { action: { type: 'special', kind: k, index: pick(idx), suit: Math.floor(Math.random() * 4) }, wait: think() };
    }
    switch (g.phase) {
      case 'placement': {
        if (me.peekedCount < 3) return { action: { type: 'peek', index: all.find((k) => !me.known.includes(k))! }, wait: think(500, 1100) };
        if (consult && g.extraPeeks && !me.consulted.includes(me.placed ? 'arrange' : 'place') && (me.credit ?? me.stack) >= g.advicePrice.placement)
          return { action: { type: 'consult' }, wait: think() };
        if (!me.placed) {
          const known = me.known.map((index) => ({ index, card: me.cards[index]! }));
          return { action: { type: 'place', index: chooseBoardIndex(known) }, wait: think(1200, 2500) };
        }
        if (!me.arranged) {
          const known = me.known.filter((k) => k !== me.boardIndex).map((index) => ({ index, card: me.cards[index]! }));
          const unknown = all.filter((k) => k !== me.boardIndex && !me.known.includes(k));
          return { action: { type: 'arrange', sets: arrangeSets(known, unknown) }, wait: think(2000, 4000) };
        }
        return null;
      }
      case 'reveal':
        if (g.revealTurn !== you) return null;
        return { action: { type: 'flip', index: pick(all.filter((k) => k !== me.boardIndex && !me.revealed.includes(k))) }, wait: think(1200, 3000) };
      case 'declare':
        if (!g.provisional?.lasts.includes(you) || me.declareDone) return null;
        if (consult && g.extraPeeks && !me.consulted.includes('declare')) return { action: { type: 'consult' }, wait: think() };
        return { action: { type: 'declare', yes: me.stack > 0 && (style === 'bold' || (style === 'normal' && Math.random() < 0.6)) }, wait: think(2000, 5000) };
      case 'join':
        if (!g.challenge?.optional.includes(you) || me.joinDone) return null;
        if (consult && g.extraPeeks && !me.consulted.includes('join')) return { action: { type: 'consult' }, wait: think() };
        return { action: { type: 'join', yes: style === 'bold' || (style === 'normal' && Math.random() < 0.4) }, wait: think(2000, 5000) };
      case 'swap': {
        const ch = g.challenge!;
        if (ch.roller !== you || ch.roulette === 'stopped') return null;
        return { action: { type: 'roulette', cmd: ch.roulette === 'ready' ? 'start' : 'stop' }, wait: ch.roulette === 'ready' ? think(3500, 5000) : think(2000, 4000) };
      }
      default:
        return null;
    }
  }
}

console.log(`${wsUrl} のルーム ${roomId} に ${count} 人のボットを入れます（考える時間 ×${speed}）`);
for (const n of names.slice(0, count)) new Bot(n).connect();
