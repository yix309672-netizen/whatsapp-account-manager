import { useEffect, useState } from 'react';
import { Account } from './types';
import { formatPhone } from './utils/formatPhone';
import w75Bg from './assets/w75-m.webp';

interface EmployeeInfo {
  id: string;
  username: string;
  name: string;
}

const DoraemonFace = ({ size = 64 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
    {/* 蓝色头部 */}
    <circle cx="100" cy="100" r="95" fill="#0093E0" />
    {/* 白色脸蛋 */}
    <ellipse cx="100" cy="115" rx="70" ry="62" fill="#FFFFFF" />
    {/* 左眼白 */}
    <ellipse cx="72" cy="78" rx="24" ry="28" fill="#FFFFFF" stroke="#333" strokeWidth="2" />
    {/* 右眼白 */}
    <ellipse cx="128" cy="78" rx="24" ry="28" fill="#FFFFFF" stroke="#333" strokeWidth="2" />
    {/* 左眼珠 */}
    <circle cx="78" cy="80" r="8" fill="#333" />
    {/* 右眼珠 */}
    <circle cx="122" cy="80" r="8" fill="#333" />
    {/* 红色鼻子 */}
    <circle cx="100" cy="105" r="10" fill="#E60012" />
    {/* 鼻子到嘴巴的线 */}
    <line x1="100" y1="115" x2="100" y2="145" stroke="#333" strokeWidth="2" />
    {/* 嘴巴 */}
    <path d="M65 140 Q100 170 135 140" fill="none" stroke="#333" strokeWidth="3" strokeLinecap="round" />
    {/* 左胡须 */}
    <line x1="25" y1="100" x2="65" y2="110" stroke="#333" strokeWidth="2" />
    <line x1="25" y1="115" x2="65" y2="118" stroke="#333" strokeWidth="2" />
    <line x1="25" y1="130" x2="65" y2="126" stroke="#333" strokeWidth="2" />
    {/* 右胡须 */}
    <line x1="175" y1="100" x2="135" y2="110" stroke="#333" strokeWidth="2" />
    <line x1="175" y1="115" x2="135" y2="118" stroke="#333" strokeWidth="2" />
    <line x1="175" y1="130" x2="135" y2="126" stroke="#333" strokeWidth="2" />
    {/* 红色项圈 */}
    <rect x="55" y="170" width="90" height="12" rx="6" fill="#E60012" />
    {/* 金色铃铛 */}
    <circle cx="100" cy="180" r="10" fill="#FFD700" stroke="#DAA520" strokeWidth="1.5" />
    <line x1="92" y1="180" x2="108" y2="180" stroke="#DAA520" strokeWidth="1.5" />
    <circle cx="100" cy="175" r="2" fill="#DAA520" />
  </svg>
);

const PAGE_SIZE = 10;

function EmployeeApp(): React.JSX.Element {
  const [step, setStep] = useState<'login' | 'list'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [employee, setEmployee] = useState<EmployeeInfo | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [page, setPage] = useState(1);
  // 中转/管理器连接态：online 以中转确认为准（null=确认中）
  const [relay, setRelay] = useState<{ connected: boolean; bound: boolean; online: boolean | null }>({
    connected: false,
    bound: false,
    online: null
  });

  useEffect(() => {
    window.api.app.version().then((v: unknown) => setAppVersion(String(v))).catch(() => {});
    // 用已保存的接入配置连接（主进程启动时已自动连过一次，这里做兜底 + 状态同步）
    window.api.employee
      .getConfig()
      .then((cfg: unknown) => {
        const c = cfg as { serverUrl?: string };
        const url = (c?.serverUrl || '').trim() || 'wss://guanli.whatspph.com/ws';
        return window.api.employee.connect(url);
      })
      .catch(() => {});
    window.api.employee
      .status()
      .then((s: unknown) => setRelay(s as { connected: boolean; bound: boolean; online: boolean | null }))
      .catch(() => {});
    const offs = [
      window.api.on('employee:relay_status', (data: unknown) => {
        setRelay(data as { connected: boolean; bound: boolean; online: boolean | null });
      }),
      window.api.on('account:pairing_code', (data: unknown) => {
        const d = data as { accountId: string; code: string };
        setAccounts((prev) =>
          prev.map((a) => (a.id === d.accountId ? { ...a, status: 'qr_pending' } : a))
        );
      }),
      window.api.on('account:authenticated', (data: unknown) => {
        const d = data as { accountId: string };
        setAccounts((prev) =>
          prev.map((a) => (a.id === d.accountId ? { ...a, status: 'authenticated' } : a))
        );
      }),
      window.api.on('account:ready', (data: unknown) => {
        const d = data as { accountId: string };
        setAccounts((prev) =>
          prev.map((a) => (a.id === d.accountId ? { ...a, status: 'ready' } : a))
        );
      }),
      window.api.on('account:disconnected', (data: unknown) => {
        const d = data as { accountId: string };
        setAccounts((prev) =>
          prev.map((a) => (a.id === d.accountId ? { ...a, status: 'offline' } : a))
        );
      })
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const relayHint =
    relay.online === true
      ? ''
      : relay.online === false
        ? '管理器离线：无法连接管理端，请确认管理器已启动并运行'
        : '正在确认管理器状态…';
  const canLogin = relay.online === true && !busy && !!username && !!password;

  const handleLogin = async (): Promise<void> => {
    setError('');
    if (relay.online !== true) {
      setError('管理器离线，暂不能登录（等连接恢复）');
      return;
    }
    setBusy(true);
    try {
      const result = (await window.api.employee.login(username.trim(), password)) as {
        success: boolean;
        employee: EmployeeInfo;
      };
      setEmployee(result.employee);
      await loadMyAccounts();
      setStep('list');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadMyAccounts = async (): Promise<void> => {
    try {
      const list = (await window.api.employee.listMine()) as Account[];
      setAccounts(list);
      setPage(1);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleLoginAccount = async (account: Account): Promise<void> => {
    setError('');
    setBusyKey(`login-${account.id}`);
    try {
      await window.api.employee.loginAccount(account.id, account.phone || undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey('');
    }
  };

  const handleLogoutAccount = async (account: Account): Promise<void> => {
    setError('');
    setBusyKey(`logout-${account.id}`);
    try {
      await window.api.employee.logoutAccount(account.id);
      setAccounts((prev) =>
        prev.map((a) => (a.id === account.id ? { ...a, status: 'offline' } : a))
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey('');
    }
  };

  return (
    <div className="h-screen flex flex-col relative overflow-hidden">
      {step === 'login' ? (
        <div className="relative flex-1 flex flex-col min-h-0">
          {/* 古风背景 w75-m.webp 微动 */}
          <div
            className="absolute inset-0 bg-cover animate-[w75Pan_22s_ease-in-out_infinite]"
            style={{ backgroundImage: `url(${w75Bg})`, backgroundPosition: 'center top', filter: 'brightness(0.45) saturate(1.08)' }}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/15 to-black/70" />
          {/* 飘落粒子 */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
            <div className="w75-particles" />
          </div>

          <header className="relative z-10 border-b border-amber-500/20 px-6 py-3 flex items-center justify-center bg-black/30 backdrop-blur-sm">
            <span className="text-amber-100 font-bold tracking-[0.2em] text-sm">侠客行 · 员工阁</span>
          </header>
          <main className="relative z-10 flex-1 overflow-y-auto flex items-center justify-center p-6">
            {error && (
              <div className="fixed top-16 left-1/2 -translate-x-1/2 bg-red-500/90 text-white px-4 py-2 rounded-full text-sm shadow-lg z-20 backdrop-blur">
                {error}
              </div>
            )}
            <div className="w-80 rounded-2xl shadow-[0_0_40px_rgba(0,0,0,0.5)] p-8 text-center bg-black/55 backdrop-blur-xl border border-amber-500/20">
              <div className="flex justify-center mb-3">
                <span className="text-2xl">⚔</span>
              </div>
              <h2 className="text-xl font-bold tracking-widest text-amber-100 font-serif">侠客 · 登录</h2>
              <p className="text-xs text-amber-200/60 mt-1 tracking-widest">EMPLOYEE SECURE LOGIN</p>
              <p
                className="text-xs mt-2 tracking-widest"
                style={{ color: relay.online === true ? '#4ade80' : relay.online === false ? '#f87171' : '#fbbf24' }}
              >
                {relay.online === true ? '● 管理器在线' : relay.online === false ? '● 管理器离线' : '● 连接确认中…'}
              </p>
              <div className="flex flex-col gap-3 mt-6">
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="账号"
                  className="w-full px-4 py-2.5 text-sm rounded-lg bg-black/40 border border-amber-500/20 text-amber-50 placeholder:text-amber-200/40 focus:outline-none focus:border-amber-500/50 focus:shadow-[0_0_12px_rgba(217,119,6,0.25)] transition-all"
                />
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  placeholder="密码"
                  className="w-full px-4 py-2.5 text-sm rounded-lg bg-black/40 border border-amber-500/20 text-amber-50 placeholder:text-amber-200/40 focus:outline-none focus:border-amber-500/50 focus:shadow-[0_0_12px_rgba(217,119,6,0.25)] transition-all"
                />
                {relayHint && <p className="text-xs text-amber-200/70 text-center">{relayHint}</p>}
                <button
                  onClick={handleLogin}
                  disabled={!canLogin}
                  className="w-full py-2.5 text-sm font-bold rounded-lg text-black transition-all shadow-md disabled:opacity-40 tracking-[0.2em]"
                  style={{ background: 'linear-gradient(90deg, #d97706, #f59e0b)' }}
                >
                  {busy ? '登录中…' : '剑 指 登 录'}
                </button>
              </div>
            </div>
          </main>
          <style>{`@keyframes w75Pan{0%,100%{transform:scale(1) translateX(0)}25%{transform:scale(1.02) translateX(-0.8%)}50%{transform:scale(1.02) translateX(0.8%)}75%{transform:scale(1.01) translateX(-0.4%)}} .w75-particles{position:absolute;inset:0;overflow:hidden} .w75-particles::before{content:'✦ ❋ 叶 ◈'; position:absolute; left:10%; top:-10%; font-size:10px; color:rgba(251,191,36,0.5); animation: wFall 9s linear infinite} @keyframes wFall{0%{transform:translateY(-10vh)}100%{transform:translateY(110vh)}}`}</style>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 bg-[#0f0f0f] relative">
          <div className="absolute inset-0 opacity-[0.08]" style={{ backgroundImage: `url(${w75Bg})`, backgroundSize: 'cover', backgroundPosition: 'center top', filter: 'blur(2px)' }} />
          <header className="relative z-10 border-b border-amber-500/20 px-4 py-2.5 flex items-center justify-between bg-black/40 backdrop-blur">
            <div className="flex items-center gap-2">
              <span className="text-amber-400 font-bold tracking-widest text-sm">侠客行</span>
              <span className="text-amber-100/60 text-xs">· 我的账号（{accounts.length}）</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-amber-200/40 text-xs">v{appVersion}</span>
              <button onClick={loadMyAccounts} className="px-3 py-1 text-xs rounded-full bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 border border-amber-500/20 transition-colors">刷新</button>
              <button onClick={() => { setEmployee(null); setStep('login'); }} className="px-3 py-1 text-xs rounded-full bg-white/10 text-white hover:bg-white/15 transition-colors border border-white/10">退出</button>
            </div>
          </header>
          <main className="relative z-10 flex-1 overflow-y-auto p-3">
            {error && (
              <div className="fixed top-12 left-1/2 -translate-x-1/2 bg-red-500 text-white px-4 py-1.5 rounded-full text-xs shadow-lg z-10">
                {error}
              </div>
            )}
            {accounts.length === 0 ? (
              <div className="text-center py-20">
                <DoraemonFace size={80} />
                <p className="text-gray-400 mt-4">管理员还没有分配账号给你</p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  {accounts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((account, i) => {
                    const idx = (page - 1) * PAGE_SIZE + i;
                    const isOnline = account.status === 'online' || account.status === 'ready';
                    const phoneDisplay = formatPhone(account.phone || account.name || '');
                    return (
                      <div key={account.id} className="bg-white rounded-xl px-4 py-3 flex items-center gap-3 shadow-sm" style={{ border: '1.5px solid #E3F2FD' }}>
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0" style={{ backgroundColor: '#0093E0' }}>
                          {idx + 1}
                        </div>
                        <div className="w-36 shrink-0 text-sm font-semibold text-gray-900 truncate" title={phoneDisplay}>
                          {phoneDisplay}
                        </div>
                        <div className="flex-1 min-w-0 text-xs text-gray-500 truncate" title={account.remark || ''}>
                          {account.remark || '—'}
                        </div>
                        <span
                          className="shrink-0 text-xs px-2 py-0.5 rounded-full font-medium"
                          style={{
                            backgroundColor: isOnline ? '#E8F5E9' : '#F5F5F5',
                            color: isOnline ? '#2E7D32' : '#9E9E9E'
                          }}
                        >
                          {isOnline ? '在线' : account.status || '离线'}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => handleLoginAccount(account)}
                            disabled={isOnline || busyKey === `login-${account.id}`}
                            className="px-3 py-1 text-xs font-medium rounded-full text-white disabled:opacity-40 transition-colors"
                            style={{ backgroundColor: '#0093E0' }}
                          >
                            {busyKey === `login-${account.id}` ? '…' : '登录'}
                          </button>
                          <button
                            onClick={() => handleLogoutAccount(account)}
                            disabled={!isOnline || busyKey === `logout-${account.id}`}
                            className="px-3 py-1 text-xs font-medium rounded-full bg-gray-200 text-gray-600 hover:bg-gray-300 disabled:opacity-40 transition-colors"
                          >
                            {busyKey === `logout-${account.id}` ? '…' : '退出'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {Math.ceil(accounts.length / PAGE_SIZE) > 1 && (
                  <div className="flex items-center justify-center gap-2 mt-3">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="w-8 h-8 rounded-full text-sm font-medium disabled:opacity-30 transition-colors"
                      style={{ backgroundColor: '#E3F2FD', color: '#0093E0' }}
                    >
                      ‹
                    </button>
                    {Array.from({ length: Math.ceil(accounts.length / PAGE_SIZE) }, (_, i) => i + 1).map((p) => (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        className="w-8 h-8 rounded-full text-xs font-bold transition-colors"
                        style={{
                          backgroundColor: p === page ? '#0093E0' : '#E3F2FD',
                          color: p === page ? '#FFFFFF' : '#0093E0'
                        }}
                      >
                        {p}
                      </button>
                    ))}
                    <button
                      onClick={() => setPage((p) => Math.min(Math.ceil(accounts.length / PAGE_SIZE), p + 1))}
                      disabled={page === Math.ceil(accounts.length / PAGE_SIZE)}
                      className="w-8 h-8 rounded-full text-sm font-medium disabled:opacity-30 transition-colors"
                      style={{ backgroundColor: '#E3F2FD', color: '#0093E0' }}
                    >
                      ›
                    </button>
                  </div>
                )}
              </>
            )}
          </main>
          </div>
      )}
    </div>
  );
}

export default EmployeeApp;
