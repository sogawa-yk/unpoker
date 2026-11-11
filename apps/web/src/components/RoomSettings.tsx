// ルームの設定（待機中）。テーブル（iPad）と、テーブルなしで遊ぶときの親機（スマホ）で使う
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { DEFAULT_CONFIG } from '@unpoker/core';
import type { Room, RoomView } from '../net.ts';
import './shared.css';

/** 参加用の QR コード（SVG の文字列） */
export function useJoinQr(roomId: string): string {
  const joinUrl = `${location.origin}/play/${roomId}`;
  const [qr, setQr] = useState('');
  useEffect(() => {
    void QRCode.toString(joinUrl, { type: 'svg', margin: 0, color: { dark: '#221d19', light: '#f2ecdc' } }).then(setQr);
  }, [joinUrl]);
  return qr;
}

/** ルール設定と、対局を始めるボタン */
export function RuleSettings({ room, s }: { room: Room; s: RoomView }) {
  // 古いルームの設定には持ち回りの項目が無いので、既定値で補う
  const c = { ...DEFAULT_CONFIG, ...s.config };
  const set = (patch: Partial<typeof c>) => room.send({ t: 'configure', config: { ...c, ...patch } });
  const rotating = c.betMode === 'rotating';
  const n = s.players.length;
  return (
    <>
    <div className="settings">
      <Stepper label="最初の持ち点" value={c.initialChips} step={100} big={1000} min={500} max={10000} onChange={(v) => set({ initialChips: v })} />
      <Segmented
        label="ベット方式"
        value={c.betMode ?? 'fixed'}
        options={[
          ['fixed', '固定'],
          ['rotating', '持ち回り'],
        ]}
        onChange={(v) => set({ betMode: v })}
      />
      {!rotating ? (
        <Stepper label="ベット額" value={c.bet} step={10} big={100} min={10} max={1000} onChange={(v) => set({ bet: v })} />
      ) : (
        <>
          <Stepper
            label="最低ベット"
            value={c.minBet!}
            step={10}
            big={100}
            min={10}
            max={1000}
            onChange={(v) => set({ minBet: v, maxBet: c.maxBet !== null && c.maxBet! < v ? v : c.maxBet })}
          />
          <Stepper
            label="最高ベット"
            value={c.maxBet ?? 1010}
            step={10}
            big={100}
            min={c.minBet!}
            max={1010}
            format={(v) => (v > 1000 ? '上限なし' : v.toLocaleString())}
            onChange={(v) => set({ maxBet: v > 1000 ? null : v })}
          />
          <Segmented
            label="刻み幅"
            value={String(c.betStep)}
            options={[
              ['10', '10'],
              ['50', '50'],
              ['100', '100'],
            ]}
            onChange={(v) => set({ betStep: Number(v) })}
          />
        </>
      )}
      <Segmented
        label="持ち時間"
        value={c.timeLimit === false ? 'off' : 'on'}
        options={[
          ['on', 'あり'],
          ['off', 'なし'],
        ]}
        onChange={(v) => set({ timeLimit: v === 'on' })}
      />
      <Stepper
        label="ゲーム数"
        value={c.maxGames ?? 10}
        step={1}
        big={5}
        min={1}
        max={50}
        format={(v) => `${v} ゲーム`}
        onChange={(v) => set({ maxGames: v })}
      />
      <Segmented
        label="前払い"
        value={c.prepaid === false ? 'off' : 'on'}
        options={[
          ['on', 'あり'],
          ['off', 'なし'],
        ]}
        onChange={(v) => set({ prepaid: v === 'on' })}
      />
      <Segmented
        label="特殊カード"
        value={c.specialCards ? 'on' : 'off'}
        options={[
          ['off', 'なし'],
          ['on', 'あり'],
        ]}
        onChange={(v) => set({ specialCards: v === 'on' })}
      />
      <Segmented
        label="残り 2 人"
        value={c.headsUp ? 'on' : 'off'}
        options={[
          ['off', '終える'],
          ['on', '続ける'],
        ]}
        onChange={(v) => set({ headsUp: v === 'on' })}
      />
    </div>
    <button className="btn btn-shu btn-wide start" disabled={n < 2} onClick={() => room.send({ t: 'start' })}>
      {n < 2 ? `あと ${2 - n} 人で始められます` : `${n} 人で対局を始める`}
    </button>
    {(rotating || c.timeLimit === false || n >= 3) && (
      <p className="lobby-hint small">
        {[
          n >= 3 && (c.headsUp ? 'ヘッズアップ: 残り 2 人になっても、どちらかの持ち点が 0 になるか規定のゲーム数まで続けます' : '残り 2 人になったら、その時点の持ち点で順位を決めて終えます'),
          rotating && `持ち回り: 親がゲームごとにスマホでベット額を決めます${c.timeLimit === false ? '' : '（30 秒で最低ベット）'}`,
          c.timeLimit === false && '持ち時間なし: 時間切れで進めず、全員の操作を待ちます',
        ]
          .filter(Boolean)
          .join('。')}
      </p>
    )}
    </>
  );
}

export function Segmented<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="stepper" role="radiogroup" aria-label={props.label}>
      <span className="st-label">{props.label}</span>
      <div className="seg">
        {props.options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={props.value === v} className={`seg-btn${props.value === v ? ' on' : ''}`} onClick={() => props.onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Stepper(props: {
  label: string;
  value: number;
  step: number;
  big: number;
  min: number;
  max: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { label, value, step, big, min, max, format = (v) => v.toLocaleString(), onChange } = props;
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="stepper">
      <span className="st-label">{label}</span>
      <button className="st-btn" aria-label={`${label}を ${big} 減らす`} onClick={() => onChange(clamp(value - big))}>
        «
      </button>
      <button className="st-btn" aria-label={`${label}を ${step} 減らす`} onClick={() => onChange(clamp(value - step))}>
        −
      </button>
      <span className="st-value">{format(value)}</span>
      <button className="st-btn" aria-label={`${label}を ${step} 増やす`} onClick={() => onChange(clamp(value + step))}>
        ＋
      </button>
      <button className="st-btn" aria-label={`${label}を ${big} 増やす`} onClick={() => onChange(clamp(value + big))}>
        »
      </button>
    </div>
  );
}

