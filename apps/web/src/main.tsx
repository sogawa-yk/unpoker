import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Card } from './components/Card.tsx';
import { DevScreen } from './screens/Dev.tsx';
import { PlayScreen } from './screens/Play.tsx';
import { TableScreen } from './screens/Table.tsx';
import './styles.css';

// 画面は 3 つだけなので、ルーターは使わず URL を見て切り替える
//   /                 … はじめの画面
//   /table[/ROOMID]   … テーブル（iPad）
//   /play/ROOMID      … 手札（スマホ）
//   /dev              … 開発用の遊び場（手元の環境だけ）
function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const navigate = useCallback((p: string, replace = false) => {
    if (replace) history.replaceState(null, '', p);
    else history.pushState(null, '', p);
    setPath(p);
  }, []);

  const table = path.match(/^\/table(?:\/([A-Z2-9]{6}))?\/?$/);
  if (table) return <TableScreen key={table[1] ?? 'new'} roomId={table[1] ?? null} navigate={navigate} />;
  const play = path.match(/^\/play\/([A-Za-z2-9]{6})\/?$/);
  if (play) return <PlayScreen roomId={play[1]!.toUpperCase()} />;
  // 開発用の遊び場は、手元の環境（localhost と LAN）でだけ開く
  if (path === '/dev' && /^(localhost|127\.0\.0\.1|192\.168\.|10\.)/.test(location.hostname)) return <DevScreen />;
  return <Home navigate={navigate} />;
}

function Home({ navigate }: { navigate: (p: string) => void }) {
  const [code, setCode] = useState('');
  const ok = /^[A-Za-z2-9]{6}$/.test(code);
  return (
    <main className="home felt">
      <div className="home-cards" aria-hidden>
        <Card card={48} faceUp width={84} style={{ transform: 'rotate(-8deg) translateY(6px)' }} />
        <Card card={null} faceUp={false} width={84} />
        <Card card={45} faceUp width={84} style={{ transform: 'rotate(8deg) translateY(6px)' }} />
      </div>
      <h1 className="home-title">unpoker</h1>
      <p className="home-lead">iPad をテーブルに、スマホを手札に。3〜4 人で遊ぶ、運試しのポーカー</p>
      <div className="home-actions">
        <button className="btn btn-shu" onClick={() => navigate('/table')}>
          この端末をテーブルにする
        </button>
        <form
          className="home-join"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) navigate(`/play/${code.toUpperCase()}`);
          }}
        >
          <input className="field" aria-label="テーブルのコード" placeholder="テーブルのコード" value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" />
          <button className="btn" type="submit" disabled={!ok}>
            参加する
          </button>
        </form>
        <p className="muted home-note">スマホからは、テーブルに出る QR コードを読み取るのがかんたんです</p>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
