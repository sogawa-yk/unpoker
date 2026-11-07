// サーバーとの接続。切れたら自動で再接続し、保存しておいたトークンで続きから受け取る
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMsg, RoomView, ServerMsg } from '../../server/src/protocol.ts';

export type { RoomView };

export type Role = 'table' | 'player';
// 同じ端末でテーブルと手札を両方開いても混ざらないよう、役割ごとに保存する
// 開発用: ?as=xxx を付けると、同じブラウザで複数の手札を別人として開ける（/dev の遊び場で使う）
const asParam = () => new URLSearchParams(location.search).get('as');
const key = (roomId: string, role: Role) => `unpoker:${roomId}:${role}${asParam() ? `:${asParam()}` : ''}`;

export function savedToken(roomId: string, role: Role): string | null {
  try {
    return localStorage.getItem(key(roomId, role));
  } catch {
    return null;
  }
}
export function saveToken(roomId: string, role: Role, token: string) {
  try {
    localStorage.setItem(key(roomId, role), token);
  } catch {
    /* プライベートブラウズなど。再接続はできないが遊べる */
  }
}
export function forgetToken(roomId: string, role: Role) {
  try {
    localStorage.removeItem(key(roomId, role));
  } catch {
    /* noop */
  }
}

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export type ConnStatus = 'connecting' | 'open' | 'closed';

export interface Room {
  state: RoomView | null;
  status: ConnStatus;
  error: { message: string; code?: string; at: number } | null;
  /** サーバー時刻 − 端末の時刻（ミリ秒） */
  clockOffset: number;
  send: (msg: ClientMsg) => void;
}

/**
 * roomId があり、そのルームのトークンを持っていれば resume する。
 * onOpen は接続のたびに呼ばれる（トークンがないときの createRoom / join に使う）
 */
export function useRoom(roomId: string | null, role: Role, onOpen?: (send: (m: ClientMsg) => void) => void): Room {
  const [state, setState] = useState<RoomView | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [error, setError] = useState<Room['error']>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const roomRef = useRef(roomId);
  roomRef.current = roomId;

  const send = useCallback((m: ClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      setStatus('connecting');
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setStatus('open');
        const rid = roomRef.current;
        const token = rid ? savedToken(rid, role) : null;
        if (rid && token) ws.send(JSON.stringify({ t: 'resume', roomId: rid, token } satisfies ClientMsg));
        else onOpenRef.current?.((m) => ws.send(JSON.stringify(m)));
        // Cloudflare と LB のアイドルタイムアウトより短い間隔で ping
        pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), 25_000);
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as ServerMsg;
        if (m.t === 'welcome') saveToken(m.roomId, m.role, m.token);
        else if (m.t === 'state') {
          setState(m.room);
          setClockOffset(m.room.serverTime - Date.now());
        } else if (m.t === 'error') {
          setError({ message: m.message, code: m.code, at: Date.now() });
          if (m.code === 'bad_token' && roomRef.current) forgetToken(roomRef.current, role);
        }
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        if (stopped) return;
        setStatus('closed');
        retry++;
        reconnectTimer = setTimeout(connect, Math.min(5000, 300 * 2 ** retry));
      };
    };
    connect();
    // 画面に戻ってきたら、切れていればすぐつなぎ直す（iOS は裏に回ると切れる）
    const onVisible = () => {
      if (document.visibilityState === 'visible' && wsRef.current?.readyState !== WebSocket.OPEN) {
        clearTimeout(reconnectTimer);
        wsRef.current?.close();
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close();
    };
  }, [role]);

  return { state, status, error, clockOffset, send };
}

/** 締め切りまでの残り（0〜1）を毎フレーム更新する */
export function useCountdown(deadline: number | null, clockOffset: number, total: number): number {
  const [left, setLeft] = useState(1);
  useEffect(() => {
    if (deadline === null) return;
    let raf = 0;
    const tick = () => {
      const remain = deadline - (Date.now() + clockOffset);
      setLeft(Math.max(0, Math.min(1, remain / total)));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [deadline, clockOffset, total]);
  return deadline === null ? 1 : left;
}
