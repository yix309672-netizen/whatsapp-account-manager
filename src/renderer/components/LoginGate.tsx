import { useEffect, useState } from 'react';
import { loginAdmin, loginEmployee, fetchCaptcha, logoutAdmin } from '../webApi';
import w171Bg from '../assets/w171-m.webp';

export function LoginGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean>(false);
  const [role, setRole] = useState<'admin' | 'employee'>('admin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [captchaSvg, setCaptchaSvg] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [captchaError, setCaptchaError] = useState('');

  const loadCaptcha = async (): Promise<void> => {
    setCaptchaError('');
    try {
      const c = await fetchCaptcha();
      setCaptchaId(c.id);
      setCaptchaSvg(c.svg);
    } catch (err) {
      // 以前这里静默吞异常：验证码区永远显示"加载中"，用户完全不知道发生了什么
      // （最常见原因：浏览器禁用本地存储 / 网络或隧道不可达）
      setCaptchaId('');
      setCaptchaSvg('');
      setCaptchaError((err as Error).message || '验证码加载失败');
    }
  };

  useEffect(() => {
    // 每次进入强制登录：清旧 token
    logoutAdmin();
    setAuthed(false);
    loadCaptcha();
  }, []);

  const handleLogin = async (): Promise<void> => {
    setError('');
    if (!username.trim() || !password.trim()) {
      setError('请输入账号和密码');
      return;
    }
    if (!captcha.trim()) {
      setError('请输入验证码');
      return;
    }
    setLoading(true);
    try {
      if (role === 'employee') {
        await loginEmployee(username.trim(), password.trim(), captchaId, captcha.trim());
      } else {
        await loginAdmin(username.trim(), password.trim(), captchaId, captcha.trim());
      }
      setAuthed(true);
    } catch (err) {
      setError((err as Error).message || '登录失败');
      // 验证码一次性，失败就换一张
      setCaptcha('');
      loadCaptcha();
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
      <div className="relative min-h-screen flex items-center justify-center md:justify-start px-4 md:pl-[8%] overflow-hidden">
        {/* 古风背景 - 仅背景缓慢平移，登录框本身静止 */}
        <div
          className="absolute inset-0 bg-cover animate-[wuxiaPan_20s_ease-in-out_infinite]"
          style={{
            backgroundImage: `url(${w171Bg})`,
            backgroundPosition: 'center top',
            filter: 'brightness(0.42) saturate(1.05)',
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/20 to-black/75" />

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
              <div className="flex justify-center gap-2 mt-4">
                {(['admin', 'employee'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => { setRole(r); setError(''); }}
                    className={`px-4 py-1.5 rounded-lg text-xs tracking-widest transition-all ${role === r ? 'bg-amber-500 text-black font-bold' : 'bg-black/40 text-amber-200/60 border border-amber-500/25'}`}
                  >
                    {r === 'admin' ? '管理员' : '员工'}
                  </button>
                ))}
              </div>
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

              <div>
                <label className="text-xs text-amber-200/70 tracking-widest mb-1.5 block">验 证 码 · CAPTCHA</label>
                <div className="flex gap-2">
                  <input
                    value={captcha}
                    onChange={(e) => setCaptcha(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                    placeholder="请输入验证码"
                    maxLength={8}
                    className="flex-1 min-w-0 px-4 py-3 rounded-lg bg-black/40 border border-amber-500/25 text-amber-50 text-sm tracking-[0.3em] focus:outline-none focus:border-amber-500 focus:shadow-[0_0_12px_rgba(217,119,6,0.3)] transition-all"
                  />
                  <button
                    type="button"
                    onClick={loadCaptcha}
                    title="换一张"
                    className="shrink-0 rounded-lg overflow-hidden border border-amber-500/25 bg-[#fef3c7] h-[46px] w-[110px]"
                  >
                    {captchaSvg ? (
                      <img src={`data:image/svg+xml;utf8,${encodeURIComponent(captchaSvg)}`} alt="验证码" className="h-full w-full object-cover" />
                    ) : captchaError ? (
                      <span className="text-xs text-red-700 px-1 leading-tight">加载失败<br />点此重试</span>
                    ) : (
                      <span className="text-xs text-amber-700">加载中…</span>
                    )}
                  </button>
                </div>
                {captchaError ? (
                  <p className="text-xs text-red-400 mt-1">
                    {captchaError}
                    <button type="button" onClick={loadCaptcha} className="ml-2 underline text-amber-300">重新加载</button>
                  </p>
                ) : null}
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
          @keyframes wuxiaPan {
            0%, 100% { transform: scale(1) translateX(0); }
            25% { transform: scale(1.02) translateX(-0.8%); }
            50% { transform: scale(1.02) translateX(0.8%); }
            75% { transform: scale(1.01) translateX(-0.4%); }
          }
        `}</style>
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
