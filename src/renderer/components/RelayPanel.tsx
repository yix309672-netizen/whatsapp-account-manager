import { useEffect, useState } from 'react';

interface RelayStatus {
  serverUrl: string;
  code: string;
  connected: boolean;
  registered: boolean;
}

export function RelayPanel(): React.JSX.Element | null {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [serverInput, setServerInput] = useState('');

  const refresh = async (): Promise<void> => {
    if (!window.api.relay) return;
    const cfg = (await window.api.relay.getConfig()) as RelayStatus;
    setStatus(cfg);
  };

  useEffect(() => {
    refresh();
    const cleanup = window.api.on('relay:status', () => refresh());
    return cleanup;
  }, []);

  if (!window.api.relay) return null;

  const handleSave = async (): Promise<void> => {
    if (!serverInput.trim()) return;
    await window.api.relay.applyConfig(serverInput.trim());
    setEditing(false);
    refresh();
  };

  const handleRegenerate = async (): Promise<void> => {
    if (!window.confirm('重新生成接入码？旧的接入码将立即失效。')) return;
    await window.api.relay.regenerateCode();
    await window.api.relay.applyConfig();
    refresh();
  };

  if (!status) {
    return (
      <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-2 text-sm text-slate-400">
        加载中转配置…
      </div>
    );
  }

  const online = status.connected && status.registered;

  return (
    <div className="bg-white border-b border-slate-200 px-6 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block w-2.5 h-2.5 rounded-full ${
            online ? 'bg-emerald-500' : status.connected ? 'bg-amber-500' : 'bg-red-500'
          }`}
        />
        <span className="text-sm text-slate-700 font-medium">
          {online ? '已连接中转服务器' : status.connected ? '未注册' : '未连接'}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">接入码</span>
        <code className="text-sm font-mono tracking-[0.2em] bg-slate-100 rounded px-2 py-0.5 text-slate-800">
          {status.code}
        </code>
        <button
          onClick={() => navigator.clipboard?.writeText(status.code)}
          title="复制接入码"
          className="text-xs text-emerald-600 hover:text-emerald-700"
        >
          复制
        </button>
        <button
          onClick={handleRegenerate}
          title="重新生成接入码"
          className="text-xs text-slate-400 hover:text-slate-600"
        >
          重置
        </button>
      </div>

      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-slate-400">服务器</span>
        {editing ? (
          <input
            value={serverInput}
            onChange={(e) => setServerInput(e.target.value)}
            placeholder={status.serverUrl}
            className="text-sm px-2 py-0.5 rounded border border-slate-300 w-56"
          />
        ) : (
          <code className="text-xs text-slate-600 truncate">{status.serverUrl}</code>
        )}
        {editing ? (
          <>
            <button onClick={handleSave} className="text-xs text-emerald-600">
              保存
            </button>
            <button onClick={() => setEditing(false)} className="text-xs text-slate-400">
              取消
            </button>
          </>
        ) : (
          <button onClick={() => { setServerInput(status.serverUrl); setEditing(true); }} className="text-xs text-slate-400 hover:text-slate-600">
            修改
          </button>
        )}
      </div>
    </div>
  );
}