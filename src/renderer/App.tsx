import { useEffect, useMemo, useState } from 'react';
import { useAccountStore } from './store/accountStore';
import { useAccounts, useAccountEvents } from './hooks/useAccounts';
import { AccountCard } from './components/AccountCard';
import { StatusBadge } from './components/StatusBadge';
import { EmployeePanel } from './components/EmployeePanel';
import { StatsPanel } from './components/StatsPanel';
import { TemplatesPanel } from './components/TemplatesPanel';
import { PendingAccountsPanel } from './components/PendingAccountsPanel';
import { AccountStatus } from './types';

type Tab = 'accounts' | 'pending' | 'employees' | 'stats' | 'templates';

function App(): React.JSX.Element {
  useAccounts();
  useAccountEvents();
  const { accounts, loading, error, loadAccounts } = useAccountStore();
  const [filter, setFilter] = useState<'all' | 'online' | 'offline'>('all');
  const [tab, setTab] = useState<Tab>('accounts');
  const [refreshing, setRefreshing] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    window.api.app.version().then((v: unknown) => setAppVersion(String(v))).catch(() => {});
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadAccounts();
    setRefreshing(false);
  };

  const stats = useMemo(() => {
    const online = accounts.filter((a) => a.status === 'online' || a.status === 'ready').length;
    const pending = accounts.filter(
      (a) => !a.assigned_to && (a.has_session || ['online', 'ready', 'authenticated'].includes(a.status))
    ).length;
    return { total: accounts.length, online, offline: accounts.length - online, pending };
  }, [accounts]);

  const filtered = useMemo(() => {
    if (filter === 'all') return accounts;
    if (filter === 'online') return accounts.filter((a) => a.status === 'online' || a.status === 'ready');
    return accounts.filter((a) => a.status !== 'online' && a.status !== 'ready');
  }, [accounts, filter]);

  return (
    <div className="h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">WhatsApp 安全中心</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            共 {stats.total} 个账号 · {stats.online} 在线 · {stats.offline} 离线 ·{' '}
            {stats.pending > 0 ? (
              <span className="text-amber-600 font-medium">{stats.pending} 个待分配</span>
            ) : (
              '0 个待分配'
            )}{' '}
            · v{appVersion}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-slate-300 overflow-hidden">
            {(['accounts', 'pending', 'employees', 'stats', 'templates'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-1.5 text-sm transition-colors ${
                  tab === t
                    ? 'bg-emerald-600 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {t === 'accounts'
                  ? '账号管理'
                  : t === 'pending'
                    ? `待分配${stats.pending > 0 ? ` (${stats.pending})` : ''}`
                    : t === 'employees'
                      ? '员工管理'
                      : t === 'stats'
                        ? '流量统计'
                        : '前端管理'}
              </button>
            ))}
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className={`px-4 py-1.5 text-sm rounded-lg border border-slate-300 transition-colors flex items-center gap-1.5 ${
              refreshing
                ? 'bg-slate-100 text-slate-400 cursor-wait'
                : 'bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            <svg
              className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          <div className="flex rounded-lg border border-slate-300 overflow-hidden">
            {(['all', 'online', 'offline'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-1.5 text-sm transition-colors ${
                  filter === f
                    ? 'bg-emerald-600 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {f === 'all' ? '全部' : f === 'online' ? '在线' : '离线'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-4">
        {tab === 'pending' ? (
          <PendingAccountsPanel />
        ) : tab === 'employees' ? (
          <EmployeePanel />
        ) : tab === 'stats' ? (
          <StatsPanel />
        ) : tab === 'templates' ? (
          <TemplatesPanel />
        ) : loading ? (
          <div className="text-center text-slate-400 py-20">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-slate-400 py-20">
            {error ? `加载失败：${error}` : '暂无账号'}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((account, index) => (
              <AccountCard key={account.id} account={account} index={index} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;