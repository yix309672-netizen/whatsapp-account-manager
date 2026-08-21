import { AccountStatus } from '../types';

const statusConfig: Record<AccountStatus, { label: string; className: string }> = {
  offline: { label: '离线', className: 'bg-slate-100 text-slate-600' },
  initializing: { label: '初始化中', className: 'bg-amber-50 text-amber-700' },
  qr_pending: { label: '等待配对', className: 'bg-blue-50 text-blue-700' },
  authenticated: { label: '已认证', className: 'bg-emerald-50 text-emerald-700' },
  ready: { label: '就绪', className: 'bg-emerald-50 text-emerald-700' },
  online: { label: '在线', className: 'bg-emerald-100 text-emerald-800' },
  disconnected: { label: '已断开', className: 'bg-red-50 text-red-600' },
  failed: { label: '失败', className: 'bg-red-50 text-red-600' }
};

export function StatusBadge({ status }: { status: AccountStatus }): React.JSX.Element {
  const config = statusConfig[status] || statusConfig.offline;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${config.className}`}>
      {config.label}
    </span>
  );
}