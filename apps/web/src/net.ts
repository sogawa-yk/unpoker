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
    if (!asParam()) rememberRoom(roomId, role);
  } catch {
    /* プライベートブラウズなど。再接続はできないが遊べる */
  }
}

/** 最近遊んだルーム（ホーム画面のアイコンから開いたときに、続きへ戻れるように。ルームは 24 時間で消える） */
export interface RecentRoom {
  roomId: string;
  role: Role;
  at: number;
}
const RECENT_KEY = 'unpoker:recent';
const DAY = 24 * 60 * 60 * 1000;

function rememberRoom(roomId: string, role: Role) {
  const list = recentRooms().filter((r) => !(r.roomId === roomId && r.role === role));
  list.unshift({ roomId, role, at: Date.now() });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)));
}

export function recentRooms(): RecentRoom[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as RecentRoom[];
    return list.filter((r) => Date.now() - r.at < DAY && localStorage.getItem(`unpoker:${r.roomId}:${r.role}`) !== null);
  } catch {
    return [];
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
  /** 画面に出ている状態が古いかもしれない（裏から戻って、最新の状態を待っている間） */
  stale: boolean;
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
  const [stale, setStale] = useState(false);
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
    /** 最後にサーバーから何か届いた時刻。ping には必ず pong が返るので、長く途切れたら接続が死んでいる */
    let lastMsgAt = Date.now();
    let hiddenAt: number | null = null;

    /** 今の接続を捨てて、すぐにつなぎ直す（捨てる接続の後始末で、もう 1 本つながないよう先に外す） */
    const reconnectNow = () => {
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      const old = wsRef.current;
      if (old) {
        old.onopen = old.onmessage = old.onclose = null;
        old.close();
      }
      connect();
    };

    const connect = () => {
      setStatus('connecting');
      lastMsgAt = Date.now();
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
        lastMsgAt = Date.now();
        const m = JSON.parse(String(ev.data)) as ServerMsg;
        if (m.t === 'welcome') saveToken(m.roomId, m.role, m.token);
        else if (m.t === 'state') {
          setState(m.room);
          setStale(false);
          setClockOffset(m.room.serverTime - Date.now());
        } else if (m.t === 'error') {
          setError({ message: m.message, code: m.code, at: Date.now() });
          if (m.code === 'bad_token' && roomRef.current) forgetToken(roomRef.current, role);
          if (m.code === 'room_not_found' || m.code === 'bad_token') setStale(false);
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
    // 画面に戻ってきたら、つなぎ直して最新の状態をもらう。
    // iOS は裏に回ると通信を止めるが、戻ったときに接続が「つながっている」ままに見えることがあり、
    // そのままだと次のゲームに進んでも前のゲームの画面が残る。届くまでは古い画面だと示す
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (away < 1500 && wsRef.current?.readyState === WebSocket.OPEN) return;
      if (roomRef.current) setStale(true);
      reconnectNow();
    };
    // 返事が途切れた接続は捨てる（ping は 25 秒ごと。pong が来なければ 35 秒で気づく）
    const watchdog = setInterval(() => {
      if (document.visibilityState === 'visible' && wsRef.current?.readyState === WebSocket.OPEN && Date.now() - lastMsgAt > 35_000) {
        if (roomRef.current) setStale(true);
        reconnectNow();
      }
    }, 5_000);
    document.addEventListener('visibilitychange', onVisible);
    addEventListener('pageshow', onVisible);
    return () => {
      stopped = true;
      clearInterval(pingTimer);
      clearInterval(watchdog);
      clearTimeout(reconnectTimer);
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('pageshow', onVisible);
      const ws = wsRef.current;
      if (ws) ws.onclose = null;
      ws?.close();
    };
  }, [role]);

  return { state, status, error, clockOffset, stale, send };
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
