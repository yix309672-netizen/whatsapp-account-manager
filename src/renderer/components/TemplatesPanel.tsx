import { useEffect, useState } from 'react';

interface TemplateDef {
  key: string;
  name: string;
  desc: string;
  preview: {
    bg: string;
    primary: string;
    card: string;
  };
}

const TEMPLATES: TemplateDef[] = [
  {
    key: 'classic',
    name: '经典绿',
    desc: 'WhatsApp 经典绿色风格，清爽直观',
    preview: { bg: '#eafaf5', primary: '#00a884', card: '#ffffff' }
  },
  {
    key: 'modern',
    name: '现代靛蓝',
    desc: '靛蓝色现代风格，简洁商务',
    preview: { bg: '#eef2ff', primary: '#4f46e5', card: '#ffffff' }
  },
  {
    key: 'dark',
    name: '深色模式',
    desc: '深色主题，适合夜间环境',
    preview: { bg: '#111b21', primary: '#25d366', card: '#1f2c33' }
  }
];

export function TemplatesPanel(): React.JSX.Element {
  const [current, setCurrent] = useState<string>('classic');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    window.api.templates
      .get()
      .then((res: unknown) => {
        const r = res as { template?: string };
        if (r?.template) setCurrent(r.template);
      })
      .catch(() => {});
  }, []);

  const apply = async (key: string): Promise<void> => {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await window.api.templates.set(key);
      setCurrent(key);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-slate-800">验证模板管理</h3>
        <p className="text-sm text-slate-500 mt-0.5">
          选择 H5 网页端使用的验证页面模板。核心验证机制不变，仅更换前端视觉元素，保存后即时生效。
        </p>
      </div>

      {error && <div className="text-red-600 text-sm">操作失败：{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {TEMPLATES.map((tpl) => (
          <div
            key={tpl.key}
            className={`rounded-xl border-2 overflow-hidden transition-all ${
              current === tpl.key ? 'border-emerald-500 shadow-lg' : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            {/* 模板预览 */}
            <div
              className="h-36 flex items-center justify-center"
              style={{ background: `linear-gradient(180deg, ${tpl.preview.bg} 0%, ${tpl.preview.bg} 100%)` }}
            >
              <div className="w-32 rounded-lg p-3 shadow-md" style={{ backgroundColor: tpl.preview.card }}>
                <div className="w-6 h-6 rounded-full mx-auto mb-2" style={{ backgroundColor: tpl.preview.primary }} />
                <div className="h-1.5 rounded mb-1.5 bg-slate-200" />
                <div className="h-1.5 rounded mb-1.5 bg-slate-100" />
                <div className="h-1.5 rounded w-2/3 bg-slate-100" />
                <div className="mt-2 h-6 rounded-md" style={{ backgroundColor: tpl.preview.primary }} />
              </div>
            </div>
            <div className="p-4 bg-white">
              <div className="flex items-center justify-between mb-1">
                <h4 className="font-semibold text-slate-800">{tpl.name}</h4>
                {current === tpl.key && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">使用中</span>
                )}
              </div>
              <p className="text-xs text-slate-500 mb-3">{tpl.desc}</p>
              <button
                onClick={() => apply(tpl.key)}
                disabled={saving || current === tpl.key}
                className="w-full py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {current === tpl.key ? '当前模板' : '应用此模板'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {saved && (
        <div className="px-4 py-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">
          模板已保存，网页端下次刷新立即生效。
        </div>
      )}
    </div>
  );
}