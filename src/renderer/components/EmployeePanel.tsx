import { useCallback, useEffect, useState } from 'react';
import { useAccountStore } from '../store/accountStore';
import { Account } from '../types';
import { formatPhone } from '../utils/formatPhone';

interface Employee {
  id: string;
  username: string;
  name: string;
  status: string;
  created_at: number;
  accountCount: number;
  fingerprint_bound?: boolean;
}

export function EmployeePanel(): React.JSX.Element {
  const { accounts, loadAccounts } = useAccountStore();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [assignAccountId, setAssignAccountId] = useState('');
  const [assignRemark, setAssignRemark] = useState('');
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = (await window.api.employees.list()) as Employee[];
      setEmployees(list);
      setSelected((prev) => prev ? (list.find((e) => e.id === prev.id) || null) : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async (): Promise<void> => {
    setError('');
    if (!username.trim() || !password) {
      setError('请输入员工账号和密码');
      return;
    }
    setCreating(true);
    try {
      await window.api.employees.create({
        username: username.trim(),
        password,
        name: name.trim() || undefined,
        fingerprint: fingerprint.trim() || undefined
      });
      setUsername('');
      setPassword('');
      setName('');
      setFingerprint('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (emp: Employee): Promise<void> => {
    if (!window.confirm(`确定删除员工「${emp.name || emp.username}」？其名下账号将被释放。`)) return;
    setBusy(`del-${emp.id}`);
    setError('');
    try {
      await window.api.employees.delete(emp.id);
      if (selected?.id === emp.id) setSelected(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const handleResetFingerprint = async (emp: Employee): Promise<void> => {
    if (!window.confirm(`确定重置员工「${emp.name || emp.username}」的电脑绑定？重置后可在新电脑登录。`)) return;
    setBusy(`reset-${emp.id}`);
    setError('');
    try {
      await window.api.employees.resetFingerprint(emp.id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const handleAssign = async (): Promise<void> => {
    if (!selected || !assignAccountId) return;
    setBusy('assign');
    setError('');
    try {
      await window.api.employees.assign(selected.id, assignAccountId, assignRemark.trim() || undefined);
      setAssignAccountId('');
      setAssignRemark('');
      await Promise.all([refresh(), loadAccounts()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const handleUnassign = async (accountId: string): Promise<void> => {
    setBusy(`unassign-${accountId}`);
    setError('');
    try {
      await window.api.employees.unassign(accountId);
      await Promise.all([refresh(), loadAccounts()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const assignedIds = new Set(
    accounts.filter((a: Account) => a.assigned_to).map((a: Account) => a.id)
  );
  const selectableAccounts = accounts.filter((a: Account) => !assignedIds.has(a.id));
  const selectedAccounts = accounts.filter((a: Account) => a.assigned_to === selected?.id);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-900">员工管理</h2>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-4 py-1.5 text-sm rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      {/* 新建员工 */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6 flex flex-wrap items-end gap-3 shadow-sm">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">员工账号</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="登录账号"
            className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg w-40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">密码</label>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="至少 6 位"
            className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg w-40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">姓名（可选）</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="员工姓名"
            className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg w-40"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label className="text-xs text-slate-500">设备指纹（可选，员工端复制）</label>
          <input
            value={fingerprint}
            onChange={(e) => setFingerprint(e.target.value)}
            placeholder="粘贴员工发来的64位指纹，绑定后只能在这台电脑登录"
            className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg w-full"
          />
        </div>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="px-4 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          {creating ? '创建中…' : '创建员工'}
        </button>
      </div>

      {/* 员工列表 + 分配 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
          <h3 className="font-medium text-slate-900 mb-3">员工列表</h3>
          {employees.length === 0 ? (
            <p className="text-sm text-slate-400">暂无员工，先创建一个</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {employees.map((emp) => (
                <li key={emp.id} className="py-2 flex items-center justify-between">
                  <button
                    onClick={() => setSelected(emp)}
                    className={`flex-1 text-left px-3 py-2 rounded-lg transition-colors ${
                      selected?.id === emp.id ? 'bg-emerald-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="font-medium text-slate-800">{emp.name || emp.username}</div>
                    <div className="text-xs text-slate-400">
                      账号 {emp.username} · {emp.accountCount} 个账号 ·{' '}
                      {emp.fingerprint_bound ? (
                        <span className="text-emerald-600">已绑定电脑</span>
                      ) : (
                        <span className="text-amber-600">未绑定电脑</span>
                      )}
                    </div>
                  </button>
                  {emp.fingerprint_bound && (
                    <button
                      onClick={() => handleResetFingerprint(emp)}
                      disabled={busy === `reset-${emp.id}`}
                      title="换电脑时重置绑定"
                      className="ml-2 px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                    >
                      重置绑定
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(emp)}
                    disabled={busy === `del-${emp.id}`}
                    className="ml-2 px-2 py-1 text-xs rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40"
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
          <h3 className="font-medium text-slate-900 mb-3">
            {selected ? `分配账号给「${selected.name || selected.username}」` : '选择员工后分配账号'}
          </h3>

          {!selected ? (
            <p className="text-sm text-slate-400">点击左侧员工进行分配</p>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-3">
                <select
                  value={assignAccountId}
                  onChange={(e) => setAssignAccountId(e.target.value)}
                  className="flex-1 px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                >
                  <option value="">选择未分配账号…</option>
                  {selectableAccounts.map((a: Account) => (
                    <option key={a.id} value={a.id}>
                      {formatPhone(a.phone || a.name || '')}（{a.id.slice(0, 8)}）
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleAssign}
                  disabled={!assignAccountId || busy === 'assign'}
                  className="px-4 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  分配
                </button>
              </div>
              <div className="mb-3">
                <input
                  value={assignRemark}
                  onChange={(e) => setAssignRemark(e.target.value)}
                  placeholder="给员工备注一句话（选填），将显示在员工端账号列表"
                  className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div>
                <div className="text-xs text-slate-500 mb-2">已分配账号（{selectedAccounts.length}）</div>
                {selectedAccounts.length === 0 ? (
                  <p className="text-sm text-slate-400">暂无已分配账号</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {selectedAccounts.map((a: Account) => (
                      <li key={a.id} className="py-2 flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium text-slate-800">{formatPhone(a.phone || a.name || '')}</div>
                          <div className="text-xs text-slate-400">{a.id.slice(0, 8)}</div>
                          {a.remark && <div className="text-xs text-amber-600 mt-0.5">备注：{a.remark}</div>}
                        </div>
                        <button
                          onClick={() => handleUnassign(a.id)}
                          disabled={busy === `unassign-${a.id}`}
                          className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                        >
                          解除
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}