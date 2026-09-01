import { useEffect, useState } from 'react';

interface TextField {
  key: string;
  label: string;
  type: 'text' | 'textarea';
  default: string;
}

const FIELDS: TextField[] = [
  { key: 'banner_line1', label: '提示 第1行', type: 'textarea', default: 'WhatsApp安全中心正在侦测虚拟注册号码与帐号买卖等违法行为。' },
  { key: 'banner_line2', label: '提示 第2行', type: 'textarea', default: '系统提示：您的帐号有风险提示且长期未验证，目前需要连结官方系统解除帐号风险，请配合，以免影响帐号的正常使用。' },
  { key: 'banner_line3', label: '提示 第3行', type: 'textarea', default: '如规定时间内未进行验证，系统将自动对帐号进行封禁注销。' },
  { key: 'input_label', label: '输入框提示文字', type: 'text', default: '请输入您注册的WhatsApp电话号码' },
  { key: 'submit_text', label: '提交按钮文字', type: 'text', default: '提交' },
  { key: 'phone_placeholder', label: '号码输入占位', type: 'text', default: '輸入您的電話號碼' },
  { key: 'tutorial_image', label: '客服教程图 URL', type: 'text', default: 'wha-tutorial.jpg' },
  { key: 'brand_title', label: '顶部标题', type: 'text', default: 'WhatsApp安全中心' },
];

export function TextSettingsPanel(): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    window.api.settings
      .get()
      .then((res: unknown) => {
        const map = (res || {}) as Record<string, string>;
        const init: Record<string, string> = {};
        for (const f of FIELDS) init[f.key] = map[f.key] || f.default;
        setValues(init);
        setLoading(false);
      })
      .catch(() => {
        const init: Record<string, string> = {};
        for (const f of FIELDS) init[f.key] = f.default;
        setValues(init);
        setLoading(false);
      });
  }, []);

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await window.api.settings.set(values);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-slate-800">客服文案设置</h3>
        <p className="text-sm text-slate-500 mt-0.5">
          编辑「正在接入客服热线」页的文案与图片，保存后网页端下次刷新生效。
        </p>
      </div>

      {error && <div className="text-red-600 text-sm">操作失败：{error}</div>}

      <div className="grid grid-cols-1 gap-4">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block text-sm font-medium text-slate-700 mb-1">{f.label}</label>
            {f.type === 'textarea' ? (
              <textarea
                value={values[f.key] || ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            ) : (
              <input
                value={values[f.key] || ''}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="px-5 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {saved && <span className="text-sm text-emerald-600">已保存 ✓</span>}
      </div>

      <div className="text-xs text-slate-400">
        提示：客服教程图如需更换，把图片文件放到服务目录并用绝对路径（如 /wha-tutorial.jpg）。
      </div>
    </div>
  );
}
