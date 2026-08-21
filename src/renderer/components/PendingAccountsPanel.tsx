import { useCallback, useEffect, useState } from 'react';
import { useAccountStore } from '../store/accountStore';
import { Account } from '../types';
import { formatPhone } from '../utils/formatPhone';

interface Employee {
  id: string;
  username: string;
  name: string;
}

// 已通过验证（有保存的会话）但尚未分配给任何员工管理的账号
function isVerified(a: Account): boolean {
  return !!a.has_session || ['online', 'ready', 'authenticated'].includes(a.status);
}

export function PendingAccountsPanel(): React.JSX.Element {
  const { accounts, loadAccounts } = useAccountStore();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [assignTo, setAssignTo] = useState<Record<string, string>>({});
  const [assignRemark, setAssignRemark] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const refreshEmployees = useCallback(async () => {
    try {
      const list = (await window.api.employees.list()) as Employee[];
      setEmployees(list);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    refreshEmployees();
  }, [refreshEmployees]);

  const pending = accounts.filter((a: Account) => !a.assigned_to && isVerified(a));

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true);
    setError('');
    await Promise.all([loadAccounts(), refreshEmployees()]);
    setRefreshing(false);
  };

  const handleAssign = async (account: Account): Promise<void> => {
    const employeeId = assignTo[account.id];
    if (!employeeId) return;
    setBusy(account.id);
    setError('');
    try {
      await window.api.employees.assign(employeeId, account.id, assignRemark[account.id]?.trim() || undefined);
      setAssignTo((prev) => {
        const next = { ...prev };
        delete next[account.id];
        return next;
      });
      setAssignRemark((prev) => {
        const next = { ...prev };
        delete next[account.id];
        return next;
      });
      await loadAccounts();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">待分配账号</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            已通过验证、但尚未分配给员工管理的账号（{pending.length}）。请及时分配，避免遗漏。
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="px-4 py-1.5 text-sm rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          {refreshing ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      {pending.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center shadow-sm">
          <div className="text-3xl mb-2">🎉</div>
          <p className="text-slate-500">暂无待分配账号，所有已验证账号都已分配给员工</p>
        </div>
      ) : employees.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center shadow-sm">
          <p className="text-slate-500 mb-2">还没有员工账号，请先到「员工管理」创建员工</p>
          <p className="text-sm text-slate-400">创建员工后才能将账号分配下去</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pending.map((account) => (
            <div
              key={account.id}
              className="bg-white rounded-xl border border-amber-200 p-4 flex flex-wrap items-center gap-3 shadow-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900 truncate">{formatPhone(account.phone || account.name || '')}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">待分配</span>
                </div>
                <div className="text-xs text-slate-400 font-mono mt-0.5">ID: {account.id.slice(0, 8)}</div>
              </div>
              <div className="flex flex-col items-stretch gap-2">
                <input
                  value={assignRemark[account.id] || ''}
                  onChange={(e) => setAssignRemark((prev) => ({ ...prev, [account.id]: e.target.value }))}
                  placeholder="备注（选填）"
                  className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg w-56"
                />
                <div className="flex items-center gap-2">
                  <select
                    value={assignTo[account.id] || ''}
                    onChange={(e) => setAssignTo((prev) => ({ ...prev, [account.id]: e.target.value }))}
                    className="flex-1 px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                  >
                    <option value="">选择员工…</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name || emp.username}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleAssign(account)}
                    disabled={!assignTo[account.id] || busy === account.id}
                    className="px-4 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
                  >
                    {busy === account.id ? '分配中…' : '分配'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}