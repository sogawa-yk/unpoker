// 効果音。音源ファイルは使わず、Web Audio で合成する（外部依存なし・軽い）。
// 和の卓に合わせて、札は紙の擦れ、判子は鈍い打音、チャレンジは太鼓、勝ちは琴の分散和音、ナッツは鈴。
// iOS は利用者の操作の後でないと音が出ないので、最初のタップで AudioContext を起こす。

const PREF_KEY = 'unpoker:sound';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

export function soundOn(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundOn(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* noop */
  }
  if (master) master.gain.value = on ? 0.6 : 0;
}

function audio(): AudioContext | null {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = soundOn() ? 0.6 : 0;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return ctx;
}

/** 最初の操作で音を出せる状態にする（main から 1 回呼ぶ） */
export function installAudioUnlock() {
  const unlock = () => {
    const c = audio();
    if (c && c.state !== 'running') void c.resume();
    if (c?.state === 'running') {
      removeEventListener('pointerdown', unlock);
      removeEventListener('keydown', unlock);
    }
  };
  addEventListener('pointerdown', unlock);
  addEventListener('keydown', unlock);
}

const ready = () => {
  const c = audio();
  if (!c || !master || c.state !== 'running' || master.gain.value === 0) return null;
  return c;
};

/** 帯域を絞ったノイズ（紙の擦れ、風） */
function noise(c: AudioContext, at: number, dur: number, freq: number, q: number, vol: number, sweepTo?: number) {
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(freq, at);
  if (sweepTo) bp.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
  bp.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + Math.min(0.012, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(bp).connect(g).connect(master!);
  src.start(at, Math.random() * 0.5, dur + 0.05);
}

/** 減衰する音程（打音、弦、鈴） */
function tone(c: AudioContext, at: number, freq: number, dur: number, vol: number, type: OscillatorType = 'sine', bendTo?: number) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (bendTo) o.frequency.exponentialRampToValueAtTime(bendTo, at + dur * 0.6);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(master!);
  o.start(at);
  o.stop(at + dur + 0.05);
}

const at = (c: AudioContext, delaySec = 0) => c.currentTime + 0.01 + delaySec;

export const sfx = {
  /** 札をめくる・置く */
  flip(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    noise(c, t, 0.07, 2600, 0.9, 0.35);
    noise(c, t + 0.025, 0.05, 5200, 1.2, 0.12);
  },
  /** 判子（順位、ベットの発表、便乗） */
  stamp(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    tone(c, t, 150, 0.16, 0.7, 'sine', 70);
    noise(c, t, 0.05, 900, 0.7, 0.25);
  },
  /** チャレンジの宣言（太鼓を 2 打） */
  challenge(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    for (const [dt, v] of [
      [0, 0.9],
      [0.22, 1],
    ] as const) {
      tone(c, t + dt, 110, 0.5, v, 'sine', 48);
      noise(c, t + dt, 0.09, 400, 0.6, 0.3);
    }
  },
  /** 太鼓の大きな一打（場札が燃える瞬間） */
  don(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    tone(c, t, 95, 0.9, 1, 'sine', 40);
    tone(c, t, 190, 0.3, 0.25, 'triangle', 90);
    noise(c, t, 0.14, 300, 0.5, 0.4);
  },
  /** 太鼓の連打（ルーレットの間。だんだん速く、強くなる） */
  drumroll(durSec: number, delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t0 = at(c, delaySec);
    let t = 0;
    let gap = 0.26;
    while (t < durSec) {
      const k = t / durSec;
      tone(c, t0 + t, 120 - 20 * k, 0.28, 0.25 + 0.45 * k, 'sine', 55);
      noise(c, t0 + t, 0.05, 500, 0.6, 0.06 + 0.1 * k);
      t += gap;
      gap = Math.max(0.065, gap * 0.93);
    }
  },
  /** 太鼓の軽い一打（ルーレットが回っている間の拍） */
  beat(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    tone(c, t, 105, 0.3, 0.45, 'sine', 55);
    noise(c, t, 0.05, 500, 0.6, 0.1);
  },
  /** 拍子木（新しい札が出たとき） */
  kan(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    for (const dt of [0, 0.16]) {
      tone(c, t + dt, 1900, 0.09, 0.4, 'triangle');
      tone(c, t + dt, 2850, 0.05, 0.15, 'sine');
      noise(c, t + dt, 0.03, 3500, 1.5, 0.3);
    }
  },
  /** 入れ替えのルーレットが 1 つ進む（拍子木） */
  tick(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    tone(c, t, 1250, 0.045, 0.22, 'triangle');
  },
  /** 場札が燃えて入れ替わる */
  swap(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    noise(c, t, 0.75, 300, 0.8, 0.45, 3200);
  },
  /** 勝者が決まる（琴の分散和音: 平調子風の 5 音） */
  win(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    [293.7, 311.1, 392, 440, 466.2, 587.3].forEach((f, i) => {
      tone(c, t + i * 0.09, f, 1.1, 0.28, 'triangle');
      tone(c, t + i * 0.09, f * 2, 0.5, 0.06, 'sine');
    });
  },
  /** ナッツ（鈴） */
  nut(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    for (let i = 0; i < 3; i++) {
      tone(c, t + i * 0.16, 1568, 1.6, 0.18, 'sine');
      tone(c, t + i * 0.16, 2350, 1.0, 0.08, 'sine');
    }
  },
  /** お金を払う（小判が鳴る） */
  coin(delaySec = 0) {
    const c = ready();
    if (!c) return;
    const t = at(c, delaySec);
    tone(c, t, 1976, 0.25, 0.2, 'sine');
    tone(c, t + 0.07, 2637, 0.35, 0.18, 'sine');
  },
};

/** 鳴らさない版（同じ部品を、音を出さない端末で使うとき） */
export const noSfx: typeof sfx = Object.fromEntries(Object.keys(sfx).map((k) => [k, () => {}])) as unknown as typeof sfx;
