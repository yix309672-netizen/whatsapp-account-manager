import { useState } from 'react';
import { useAccountStore } from '../store/accountStore';
import { Account } from '../types';
import { StatusBadge } from './StatusBadge';
import { WhatsAppLoginModal } from './WhatsAppLoginModal';
import { formatPhone } from '../utils/formatPhone';

interface AccountCardProps {
  account: Account;
  index: number;
}

export function AccountCard({ account, index }: AccountCardProps): React.JSX.Element {
  const { removeAccount } = useAccountStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showLoginModal, setShowLoginModal] = useState(false);

  const isOnline = account.status === 'online' || account.status === 'ready';
  const canOneClick = !!account.has_session;
  const phoneDisplay = formatPhone(account.phone || account.name || '');

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-3 flex items-center gap-4 shadow-sm">
      <div className="w-12 shrink-0 text-sm font-medium text-slate-400">ID {index + 1}</div>
      <div className="w-48 shrink-0 text-sm font-semibold text-slate-900 truncate" title={phoneDisplay}>
        {phoneDisplay}
      </div>
      <div className="flex-1 min-w-0 text-sm text-slate-500 truncate" title={account.remark || ''}>
        {account.remark || '—'}
      </div>
      <StatusBadge status={account.status} />

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => (canOneClick ? run(() => window.api.accounts.login(account.id)) : setShowLoginModal(true))}
          disabled={isOnline || busy}
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          {busy ? '处理中…' : '登录'}
        </button>
        <button
          onClick={() => run(() => window.api.accounts.logout(account.id))}
          disabled={!isOnline || busy}
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300 disabled:opacity-40"
        >
          {busy ? '处理中…' : '退出'}
        </button>
        <button
          onClick={() => {
            if (window.confirm(`确定删除账号「${phoneDisplay}」？此操作不可恢复。`)) {
              removeAccount(account.id);
            }
          }}
          title="删除账号"
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-white border border-red-200 text-red-600 hover:bg-red-50"
        >
          删除
        </button>
      </div>

      {showLoginModal && (
        <WhatsAppLoginModal
          accountId={account.id}
          accountName={phoneDisplay}
          onClose={() => setShowLoginModal(false)}
        />
      )}
    </div>
  );
}