import { useEffect, useState } from 'react';
import { loginAdmin, getToken, logoutAdmin } from '../webApi';

export function LoginGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean>(!!getToken());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (getToken()) setAuthed(true);
  }, []);

  const handleLogin = async (): Promise<void> => {
    setError('');
    if (!username.trim() || !password.trim()) {
      setError('请输入账号和密码');
      return;
    }
    setLoading(true);
    try {
      await loginAdmin(username.trim(), password.trim());
      setAuthed(true);
    } catch (err) {
      setError((err as Error).message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = (): void => {
    logoutAdmin();
    setAuthed(false);
    setUsername('');
    setPassword('');
  };

  if (!authed) {
    return (
      <div className="relative min-h-screen flex items-center justify-center px-4 overflow-hidden">
        {/* 动态古风侠义动漫背景 */}
        <div
          className="absolute inset-0 bg-cover bg-center animate-[saijiFade_18s_ease-in-out_infinite]"
          style={{
            backgroundImage:
              "url('https://images.unsplash.com/photo-1547981609-4b6bfe67ca0b?q=80&w=2000&auto=format&fit=crop')",
            filter: 'brightness(0.35)',
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/80" />

        {/* 飘落古风粒子 */}
        <div className="absolute inset-0 pointer-events-none" id="wuxia-particles" />

        <div className="relative z-10 w-full max-w-md">
          <div className="rounded-2xl border border-amber-500/30 bg-black/55 backdrop-blur-xl p-8 shadow-[0_0_40px_rgba(217,119,6,0.3)]">
            <div className="text-center mb-8">
              <div className="flex items-center justify-center gap-2 mb-4">
                <span className="h-px w-10 bg-gradient-to-r from-transparent to-amber-500/70" />
                <span className="text-3xl">⚔</span>
                <span className="h-px w-10 bg-gradient-to-l from-transparent to-amber-500/70" />
              </div>
              <h1 className="text-2xl font-bold tracking-widest text-amber-100 font-serif">江湖 · 安全阁</h1>
              <p className="text-xs text-amber-200/60 mt-2 tracking-[0.3em]">WHATSAPP SECURE CONSOLE</p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-amber-200/70 tracking-widest mb-1.5 block">账 号 · USER</label>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  placeholder="请输入账号"
                  autoFocus
                  className="w-full px-4 py-3 rounded-lg bg-black/40 border border-amber-500/25 text-amber-50 text-sm focus:outline-none focus:border-amber-500 focus:shadow-[0_0_12px_rgba(217,119,6,0.3)] transition-all"
                />
              </div>
              <div>
                <label className="text-xs text-amber-200/70 tracking-widest mb-1.5 block">密 码 · PASS</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  placeholder="请输入密码"
                  className="w-full px-4 py-3 rounded-lg bg-black/40 border border-amber-500/25 text-amber-50 text-sm focus:outline-none focus:border-amber-500 focus:shadow-[0_0_12px_rgba(217,119,6,0.3)] transition-all"
                />
              </div>

              {error && <p className="text-xs text-red-400 text-center">⚠ {error}</p>}

              <button
                onClick={handleLogin}
                disabled={loading}
                className="w-full py-3 rounded-lg bg-gradient-to-r from-amber-700 to-amber-500 text-black font-bold tracking-[0.3em] text-sm hover:from-amber-600 hover:to-amber-400 disabled:opacity-60 transition-all shadow-[0_0_20px_rgba(217,119,6,0.4)]"
              >
                {loading ? '登 录 中 …' : '剑 指 登 录'}
              </button>
            </div>
          </div>
          <p className="text-center text-[10px] text-amber-200/30 tracking-widest mt-4">江湖路远 · 且行且珍惜</p>
        </div>

        <style>{`
          @keyframes saijiFade {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.06); }
          }
          #wuxia-particles span {
            position: absolute;
            top: -10vh;
            color: rgba(217,119,6,0.7);
            animation-name: fall;
            animation-timing-function: linear;
            animation-iteration-count: infinite;
          }
          @keyframes fall {
            0% { transform: translateY(0) rotate(0deg); opacity: 0; }
            10% { opacity: 0.9; }
            100% { transform: translateY(120vh) rotate(360deg); opacity: 0.2; }
          }
        `}</style>
        <WuxiaParticles />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#eef2f6]">
      <div className="sticky top-0 z-20 flex items-center justify-end px-6 py-2 border-b border-[#E2E8F0] bg-white">
        <span className="mr-3 text-xs text-gray-400">SYS.AUTH</span>
        <button
          onClick={handleLogout}
          style={{ padding: '6px 14px', fontSize: '11px', borderRadius: '10px', border: '1px solid #E2E8F0', background: 'white', color: '#707EAE', cursor: 'pointer' }}
        >
          退出登录
        </button>
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// 古风飘落粒子（樱花/落叶/剑气）
function WuxiaParticles(): React.JSX.Element {
  const particles = Array.from({ length: 14 }, (_, i) => ({
    left: Math.random() * 100,
    delay: Math.random() * 6,
    dur: 6 + Math.random() * 8,
    size: 6 + Math.random() * 10,
    glyph: ['✦', '❋', '☯', '✧', '葉', '◈', '❖'][i % 7],
  }));
  return (
    <>{particles.map((p, i) => (
      <span
        key={i}
        style={{
          left: `${p.left}%`,
          fontSize: `${p.size}px`,
          animationDuration: `${p.dur}s`,
          animationDelay: `${p.delay}s`,
        }}
      >
        {p.glyph}
      </span>
    ))}</>
  );
}
