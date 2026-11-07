// AI 相談の説明文（生成 AI）。数字は core の計算で出し、生成 AI はその根拠を言葉にするだけ（architecture.md）。
// 説明文に使うのは、相談した本人が見えている情報と、計算した数字だけ（rules.md B-6）
import { handName, type AdviceRecord, type Card, type ChallengeAdvice, type GameState, type PlacementAdvice } from '@unpoker/core';

export interface Explainer {
  /** 説明文を返す。失敗したら null（数字の答えはそのまま使える） */
  explain(system: string, user: string): Promise<string | null>;
}

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const cardName = (c: Card) => `${SUITS[c & 3]}${RANKS[c >> 2]}`;
const cards = (cs: Card[]) => cs.map(cardName).join(' ');
const pct = (p: number) => `${Math.round(p * 100)}%`;

export const SYSTEM_PROMPT = [
  'あなたはカードゲーム「unpoker」の相談役です。',
  'ルール: 各自 7 枚の札から 1 枚を場に出し、残り 6 枚を 2 枚ずつ 3 組にする。場札 5 枚と自分の 1 組（2 枚）で作るポーカーの役のうち、一番強い組で勝負する。',
  '仮順位の最下位はチャレンジを宣言でき、宣言すると場札 1 枚がランダムに入れ替わって、1 位と勝負し直す。2 位・3 位は参加費を払って乗れる。',
  '数字はもう画面に出ています。数字を言い直すのではなく、「なぜそうなるのか」を、遊んでいる人にわかる言葉で日本語 2 文以内・90 字程度で説明してください。',
  '理由の例: どの札と場札で何の役（ペア、フラッシュ、ストレートなど）を狙えるか、誰のどの役に負けているか、どんな札が入れ替われば逆転できるか、追加でめくると何が分かるか。',
  '確率や点数などの数字は新しく作らないこと。役名は与えられたものと矛盾させないこと。命令口調にせず、勝てるかは運次第であることを前提にすること。',
  '前置きや見出しは書かず、説明文だけを返すこと。',
].join('\n');

/** 見えている札の特徴（同じ数字、同じマーク、続き番号）。役の根拠は生成 AI に考えさせず、ここで数えて渡す */
export function cardFacts(cs: Card[]): string {
  const byRank = new Map<number, Card[]>();
  const bySuit = new Map<number, Card[]>();
  for (const c of cs) {
    byRank.set(c >> 2, [...(byRank.get(c >> 2) ?? []), c]);
    bySuit.set(c & 3, [...(bySuit.get(c & 3) ?? []), c]);
  }
  const facts: string[] = [];
  for (const [, xs] of [...byRank].sort((a, b) => b[0] - a[0])) if (xs.length >= 2) facts.push(`同じ数字が ${xs.length} 枚（${cards(xs)}）`);
  for (const [, xs] of bySuit) if (xs.length >= 3) facts.push(`同じマークが ${xs.length} 枚（${cards(xs)}）`);
  // 続き番号（A は 1 としても数える）
  const ranks = new Set(cs.map((c) => c >> 2));
  if (ranks.has(12)) ranks.add(-1);
  const sorted = [...ranks].sort((a, b) => a - b);
  let best: number[] = [];
  let run: number[] = [];
  for (const r of sorted) {
    run = run.length && r === run[run.length - 1]! + 1 ? [...run, r] : [r];
    if (run.length > best.length) best = run;
  }
  if (best.length >= 3) facts.push(`続き番号が ${best.length} つ（${best.map((r) => RANKS[(r + 13) % 13]).join('-')}）`);
  return facts.length ? facts.join('、') : '目立つ組み合わせはない';
}

/** 相談の記録から、説明文を頼む文面を作る。本人に見えている情報だけを入れる */
export function buildPrompt(s: GameState, seat: number, rec: AdviceRecord, names: string[]): string {
  const p = s.seats[seat]!;
  const a = rec.advice;
  if ('sets' in a) {
    const pa = a as PlacementAdvice;
    const known = p.peeked.map((k) => p.hand[k]!);
    const setText = pa.sets
      .map(([x, y]) => [x, y].map((k) => (p.peeked.includes(k) ? cardName(p.hand[k]!) : '中身を知らない札')).join(' と '))
      .join(' ／ ');
    const lines = [
      `場面: 配置フェーズ（${pa.topic === 'place' ? '場に出す札を選ぶ' : '組み方を決める'}）。${s.seats.length} 人で対戦。`,
      `初期の場札: ${cards(s.initialBoard)}`,
      `自分がめくって中身を知っている札: ${cards(known)}`,
      ...(pa.topic === 'place' ? pa.candidates.map((c) => c.index) : [pa.boardIndex]).map((bi) => {
        const b = p.hand[bi]!;
        const kept = p.peeked.filter((k) => k !== bi).map((k) => p.hand[k]!);
        return `${cardName(b)} を場に出す場合: 場（${cards([...s.initialBoard, b])}）と手元に残る札（${cards(kept)}）を合わせた特徴は「${cardFacts([...s.initialBoard, b, ...kept])}」。場だけの特徴は「${cardFacts([...s.initialBoard, b])}」（場の札は相手も使える）`;
      }),
      '役の理由は、上の「特徴」に書かれた組み合わせだけを根拠にすること。特徴にない役やペアを書かないこと。',
      pa.topic === 'place'
        ? `AI のおすすめ: ${cardName(p.hand[pa.boardIndex]!)} を場に出す。1 位になる見込み ${pct(pa.win)}。ほかの札を出した場合: ${pa.candidates
            .slice(1)
            .map((c) => `${cardName(p.hand[c.index]!)} ${pct(c.win)}`)
            .join('、')}`
        : `場に出した札: ${cardName(p.hand[pa.boardIndex]!)}。この組み方で 1 位になる見込み ${pct(pa.win)}`,
      `おすすめの組み方: ${setText}`,
      pa.peekWin !== null ? `1 枚追加でめくった場合の見込み: ${pct(pa.peekWin)}（料金 ${s.peekPrice} 点）` : '',
      '相手の札はわからないので、相手は札を適当に組むと仮定した推定。',
    ];
    return lines.filter(Boolean).join('\n');
  }
  const ca = a as ChallengeAdvice;
  const prov = s.provisional!;
  const others = (xs: number[]) => (xs.length ? `${xs.map((i) => names[i]).join('・')} が乗る` : '誰も乗らない');
  const lines = [
    `場面: チャレンジの${ca.topic === 'declare' ? '宣言（自分は仮順位の最下位）' : '便乗（自分は 2 位か 3 位）'}。ベット ${s.bet} 点、参加費 ${s.bet} 点。`,
    `場札: ${cards(s.board)}`,
    ...s.seats.map((q, i) => {
      const best = prov.bestSet[i]!;
      const pair = q.sets![best]!.map((k) => q.hand[k]!);
      return `${i === seat ? '自分' : names[i]}: 仮 ${1 + prov.scores.filter((x) => x > prov.scores[i]!).length} 位、${handName(prov.scores[i]!)}（最強の組 ${cards(pair)}）`;
    }),
    `${ca.topic === 'declare' ? 'チャレンジする' : '乗る'}: 勝率 ${pct(ca.yes.win)}、期待収支 ${Math.round(ca.yes.ev) || 0} 点（予想: ${others(ca.yes.predicted)}）`,
    `見送る: 期待収支 ${Math.round(ca.no.ev) || 0} 点`,
    `AI のおすすめ: ${ca.recommend ? (ca.topic === 'declare' ? 'チャレンジする' : '乗る') : '見送る'}`,
    '入れ替わる札の全パターンから計算した値。役名は上に書いたものだけを使うこと。',
  ];
  return lines.join('\n');
}

export interface OciExplainerOptions {
  region: string;
  compartment: string;
  model: string;
  auth: 'resource_principal' | 'config';
  profile?: string;
  /** 待つ上限（ミリ秒）。過ぎたら説明文なし */
  timeoutMs?: number;
}

/** OCI Generative AI（オンデマンド）で説明文を作る */
export class OciExplainer implements Explainer {
  private client: Promise<{ chat: (system: string, user: string) => Promise<string | null> }>;
  constructor(private opts: OciExplainerOptions) {
    this.client = (async () => {
      const common = await import('oci-common');
      const genai = await import('oci-generativeaiinference');
      const provider =
        opts.auth === 'resource_principal'
          ? await common.ResourcePrincipalAuthenticationDetailsProvider.builder()
          : new common.ConfigFileAuthenticationDetailsProvider(undefined, opts.profile ?? 'DEFAULT');
      const client = new genai.GenerativeAiInferenceClient({ authenticationDetailsProvider: provider });
      client.region = common.Region.fromRegionId(opts.region);
      return {
        chat: async (system: string, user: string) => {
          const res = await client.chat({
            chatDetails: {
              compartmentId: opts.compartment,
              servingMode: { servingType: 'ON_DEMAND', modelId: opts.model } as never,
              chatRequest: {
                apiFormat: 'GENERIC',
                messages: [
                  { role: 'SYSTEM', content: [{ type: 'TEXT', text: system }] },
                  { role: 'USER', content: [{ type: 'TEXT', text: user }] },
                ],
                maxCompletionTokens: 300,
              } as never,
            },
          });
          // ストリーミングを頼んでいないので、応答は ChatResponse（chatResult を持つ）
          const resp = (res as { chatResult?: { chatResponse?: unknown } } | null)?.chatResult?.chatResponse as
            | { choices?: { message?: { content?: { text?: string }[] } }[] }
            | undefined;
          const text = resp?.choices?.[0]?.message?.content?.map((c) => c.text ?? '').join('').trim();
          return text || null;
        },
      };
    })();
  }

  async explain(system: string, user: string): Promise<string | null> {
    const c = await this.client;
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), this.opts.timeoutMs ?? 12_000));
    return Promise.race([c.chat(system, user), timeout]);
  }
}
