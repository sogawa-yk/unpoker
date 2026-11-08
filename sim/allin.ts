// オールインの損得のシミュレーション（モンテカルロ）
// 使い方: npx tsx sim/allin.ts [ゲーム数=20000] [人数=4]
//
// 調べること: 持ち点が B に足りずオールインした人（席 0）は、ほかの人より得をしているか。
// 比べ方: 同じ配り方（同じ乱数の種）で、席 0 の持ち点だけを変えて遊ぶ。ほかの人は持ち点が十分。
//   「賭けた額あたりの期待収支」＝ 1 ゲームの収支の平均 ÷ 基本ベット。持ち点が十分な人と同じなら公平
// 遊び方（全員同じ。持ち点では変えない。持ち点が 0 で宣言・便乗できない場合だけ違う）
//   - 配置: 3 枚めくり、strategy.ts の方法で場に出す札と組を決める（追加めくり・AI 相談はしない）
//   - チャレンジ: 最下位は必ず宣言する。2 位・3 位は、1 位との役の段階の差が 1 以内なら乗る
// 持ち越しポットの上限案: 勝者は「自分の基本ベット ÷ B」の割合だけ受け取り、残りは次のゲームへ回す
import { apply, arrangeSets, categoryOf, chooseBoardIndex, newGame, pendingSeats, seededRng, type GameAction, type GameState } from '../packages/core/src/index.ts';

const N = Number(process.argv[2] ?? 20000);
const PLAYERS = Number(process.argv[3] ?? 4);
const B = 100;
const RICH = 2000;

function decide(s: GameState, i: number): GameAction {
  const p = s.seats[i]!;
  switch (s.phase) {
    case 'placement': {
      if (p.peeked.length < 3) return { type: 'peek', seat: i, index: [0, 1, 2, 3, 4, 5, 6].find((k) => !p.peeked.includes(k))! };
      const known = p.peeked.map((index) => ({ index, card: p.hand[index]! }));
      if (p.boardIndex === null) return { type: 'place', seat: i, index: chooseBoardIndex(known) };
      const kept = known.filter((k) => k.index !== p.boardIndex);
      const unknown = [0, 1, 2, 3, 4, 5, 6].filter((k) => k !== p.boardIndex && !p.peeked.includes(k));
      return { type: 'arrange', seat: i, sets: arrangeSets(kept, unknown) };
    }
    case 'reveal':
      return { type: 'flip', seat: i, index: p.sets!.flat().find((k) => !p.revealed.includes(k))! };
    case 'declare':
      return { type: 'declare', seat: i, yes: p.stack > 0 };
    case 'join': {
      const prov = s.provisional!;
      const top = categoryOf(prov.scores[prov.firsts[0]!]!);
      return { type: 'join', seat: i, yes: top - categoryOf(prov.scores[i]!) <= 1 };
    }
    case 'swap':
      return { type: 'roulette', seat: i, cmd: s.challenge!.roulette === 'ready' ? 'start' : 'stop' };
    default:
      throw new Error(`想定外のフェーズ ${s.phase}`);
  }
}

function play(chips: number[], carryIn: number, seed: number): GameState {
  const rng = seededRng(seed);
  let s = newGame({ players: chips.map((c, i) => ({ id: `p${i}`, chips: c })), bet: B, dealer: seed % chips.length, carryIn }, rng);
  while (s.phase !== 'result') {
    const pend = pendingSeats(s);
    s = apply(s, pend.length ? decide(s, pend[0]!) : { type: 'advance' }, rng);
  }
  return s;
}

/** 持ち越しポットに上限を付けた場合の、各席の受け取り（上限で余った分は次のゲームへ回る） */
function cappedCarry(s: GameState): number[] {
  const r = s.result!;
  const each = s.carryIn / r.winners.length;
  return s.seats.map((p, i) => (r.winners.includes(i) ? each * Math.min(1, p.baseBet / B) : 0));
}

interface Acc {
  n: number;
  delta: number;
  deltaCap: number;
  win: number;
  main: number;
  carry: number;
  nut: number;
  fee: number;
  declared: number;
}
const acc = (): Acc => ({ n: 0, delta: 0, deltaCap: 0, win: 0, main: 0, carry: 0, nut: 0, fee: 0, declared: 0 });

const shortStacks = [RICH, 100, 60, 30, 10];
const carries = [0, 100];
console.log(`${PLAYERS} 人、B=${B}、${N} ゲーム。席 0 の持ち点だけを変える（ほかの人は ${RICH}）`);
console.log('値は 1 ゲームあたりの平均。「賭けた額あたり」＝ 収支 ÷ 席 0 の基本ベット\n');
for (const carryIn of carries) {
  console.log(`--- 持ち越しポット ${carryIn} ---`);
  console.log('席0の持ち点 | 基本ベット | 勝率   | 収支(今) | 賭けた額あたり(今) | 収支(上限案) | 賭けた額あたり(上限案) | 内訳: 基本ベット/チャレンジ, 持ち越し, ナッツ, 払った参加費');
  for (const chips0 of shortStacks) {
    const a = acc();
    for (let k = 0; k < N; k++) {
      const chips = [chips0, ...Array(PLAYERS - 1).fill(RICH)];
      const s = play(chips, carryIn, k + 1);
      const r = s.result!;
      const cap = cappedCarry(s);
      const me = s.seats[0]!;
      a.n++;
      a.delta += r.delta[0]!;
      a.deltaCap += r.delta[0]! - r.carryPayout[0]! + cap[0]!;
      a.win += r.winners.includes(0) ? 1 : 0;
      a.main += r.mainPayout[0]! - me.baseBet - me.challengeFee;
      a.carry += r.carryPayout[0]!;
      a.nut += r.nutPayout[0]! - r.nutPaid[0]!;
      a.fee += me.challengeFee;
      a.declared += s.challenge?.declarers.includes(0) ? 1 : 0;
    }
    const base = Math.min(B, chips0);
    const m = (x: number) => x / a.n;
    const f = (x: number, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d);
    console.log(
      [
        String(chips0).padStart(10),
        String(base).padStart(10),
        `${(m(a.win) * 100).toFixed(1)}%`.padStart(6),
        f(m(a.delta)).padStart(8),
        f(m(a.delta) / base, 3).padStart(18),
        f(m(a.deltaCap)).padStart(12),
        f(m(a.deltaCap) / base, 3).padStart(22),
        ` ${f(m(a.main))}, ${f(m(a.carry))}, ${f(m(a.nut))}, ${m(a.fee).toFixed(1)}（宣言 ${(m(a.declared) * 100).toFixed(1)}%）`,
      ].join(' | '),
    );
  }
  console.log('');
}
