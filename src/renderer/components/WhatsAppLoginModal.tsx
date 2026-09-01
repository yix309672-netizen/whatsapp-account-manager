import { useEffect, useMemo, useState } from 'react';
import { useAccountStore } from '../store/accountStore';
import { COUNTRY_CODES } from '../data/countryCodes';
import 'flag-icons/css/flag-icons.min.css';

interface WhatsAppLoginModalProps {
  accountId: string;
  accountName: string;
  onClose: () => void;
}

type Step = 'verify' | 'phone' | 'pairing' | 'success';

export function WhatsAppLoginModal({ accountId, accountName, onClose }: WhatsAppLoginModalProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('verify');
  const [verifying, setVerifying] = useState(false);
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState(COUNTRY_CODES[0]);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [copied, setCopied] = useState(false);

  const pairingCode = useAccountStore((s) => s.pairingCodes[accountId]);
  const accountStatus = useAccountStore((s) => s.accounts.find((a) => a.id === accountId)?.status);

  const filteredCountries = useMemo(() => {
    const q = countrySearch.toLowerCase();
    return COUNTRY_CODES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.includes(q)
    );
  }, [countrySearch]);

  useEffect(() => {
    if (pairingCode) setStep('pairing');
  }, [pairingCode]);

  useEffect(() => {
    if (accountStatus === 'online' || accountStatus === 'ready') {
      setStep('success');
      const t = setTimeout(onClose, 2500);
      return () => clearTimeout(t);
    }
  }, [accountStatus, onClose]);

  const handleVerify = (): void => {
    setVerifying(true);
    setTimeout(() => {
      setVerifying(false);
      setStep('phone');
    }, 1500);
  };

  const handleRequestPairing = async (): Promise<void> => {
    setError('');
    setRequesting(true);
    try {
      const fullNumber = phone.replace(/[^0-9]/g, '');
      const cc = country.code.replace('+', '');
      const fullPhone = cc + fullNumber;
      await window.api.accounts.login(accountId);
      await window.api.accounts.requestPairing(accountId, fullPhone);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRequesting(false);
    }
  };

  const backdrops = 'fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4';

  return (
    <div className={backdrops} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mech-panel w-full max-w-md overflow-hidden animate-[fadeIn_.2s_ease]">
        <div className="px-8 pt-6 pb-2 flex items-center justify-between">
          <span className="mech-tag" style={{ color: '#ffb000' }}>WAAM · PAIRING</span>
          <button onClick={onClose} className="mech-btn" style={{ padding: '2px 10px', fontSize: '11px' }}>✕</button>
        </div>

        {step === 'verify' && (
          <div className="p-8 flex flex-col items-center text-center pt-2">
            <div className="w-20 h-20 mech-panel flex items-center justify-center mb-6">
              <span className="text-4xl text-[#ffb000]">⌾</span>
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">验证 {accountName}</h2>
            <p className="text-sm text-[#5a6270] mb-8">
              在开始之前，请先完成安全验证
            </p>
            <button
              onClick={handleVerify}
              disabled={verifying}
              className="mech-btn primary relative w-48 py-3 font-medium text-sm"
            >
              {verifying ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  验证中…
                </span>
              ) : (
                '点击进行验证'
              )}
            </button>
          </div>
        )}

        {step === 'phone' && (
          <div className="p-8 pt-2">
            <h2 className="text-xl font-semibold text-white mb-1">使用电话号码登录</h2>
            <p className="text-sm text-[#5a6270] mb-6">
              我们会向你的 WhatsApp 发送安全关联请求，请输入你的手机号码
            </p>

            <div className="space-y-4">
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCountryPicker(true)}
                  className="mech-btn flex items-center gap-1.5 px-3 py-2.5 text-sm shrink-0"
                >
                  <span className={`fi fi-${country.iso} text-lg leading-none rounded-[2px]`} />
                  <span className="font-medium">{country.code}</span>
                </button>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, '').slice(0, 15))}
                  onKeyDown={(e) => e.key === 'Enter' && phone.length >= 5 && handleRequestPairing()}
                  placeholder="手机号码"
                  autoFocus
                  className="flex-1 px-3 py-2.5 text-sm text-white bg-[#0d0f12] border border-[rgba(255,176,0,0.2)] focus:border-[#ffb000] focus:shadow-[0_0_10px_rgba(255,176,0,0.3)] outline-none transition-all"
                />
              </div>

              <button
                onClick={handleRequestPairing}
                disabled={phone.length < 5 || requesting}
                className="mech-btn primary w-full py-3 font-medium text-sm"
              >
                {requesting ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    正在发起验证请求，请勿退出…
                  </span>
                ) : (
                  '继续'
                )}
              </button>

              <p className="text-xs text-[#5a6270] text-center leading-relaxed">
                点击“继续”即表示你同意我们的
                <span className="text-[#ffb000] cursor-pointer">服务条款</span>和
                <span className="text-[#ffb000] cursor-pointer">隐私政策</span>
              </p>

              {error && <p className="text-xs text-red-400 text-center">{error}</p>}
            </div>
          </div>
        )}

        {step === 'pairing' && (
          <div className="p-8 pt-2 text-center">
            <h2 className="text-xl font-semibold text-white mb-2">关联设备</h2>
            <p className="text-sm text-[#5a6270] mb-6 leading-relaxed">
              手机 WhatsApp 会弹出<b className="text-white">「关联设备」通知</b>，<br />
              点击通知即可进入关联设备页面
            </p>
            <div className="mech-panel py-4 px-3 mb-4 mech-glow-green">
              <span className="text-2xl font-mono font-bold tracking-[0.3em] text-[#39ff14]">
                {pairingCode.replace(/(.{4})/g, '$1 ').trim()}
              </span>
            </div>
            <div className="space-y-3 mb-4">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(pairingCode.replace(/\s/g, '')).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="mech-btn green w-full py-3 font-medium text-sm"
              >
                {copied ? '已复制' : '点击复制验证码'}
              </button>
              <button
                onClick={() => {
                  const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
                  if (isMobile) {
                    window.location.href = 'whatsapp://app';
                  } else {
                    window.open('https://web.whatsapp.com', '_blank');
                  }
                }}
                className="mech-btn primary w-full py-3 font-medium text-sm"
              >
                打开 WhatsApp
              </button>
            </div>
            <p className="text-xs text-[#5a6270]">
              未收到通知？可手动进入：设置 → 已关联设备 → 关联设备<br />
              配对码约 3 分钟有效，过期后将自动刷新
            </p>
            <div className="mt-6 flex items-center justify-center gap-2 text-sm text-[#5a6270]">
              <svg className="animate-spin w-4 h-4 text-[#ffb000]" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              等待手机确认中…
            </div>
          </div>
        )}

        {step === 'success' && (
          <div className="p-8 pt-2 text-center">
            <div className="w-16 h-16 mech-panel mech-glow-green flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-[#39ff14]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">登录成功</h2>
            <p className="text-sm text-[#5a6270]">
              登录信息已保存到账户管理器，可随时一键登录
            </p>
          </div>
        )}
      </div>

      {showCountryPicker && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4" onClick={() => setShowCountryPicker(false)}>
          <div className="mech-panel w-full max-w-sm overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-[rgba(255,176,0,0.1)]">
              <h3 className="font-semibold text-white mb-3">选择国家/地区</h3>
              <input
                value={countrySearch}
                onChange={(e) => setCountrySearch(e.target.value)}
                placeholder="搜索国家或区号"
                autoFocus
                className="w-full px-3 py-2 text-sm text-white bg-[#0d0f12] border border-[rgba(255,176,0,0.2)] focus:border-[#ffb000] outline-none transition-all"
              />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {filteredCountries.map((c) => (
                <button
                  key={c.code}
                  onClick={() => { setCountry(c); setShowCountryPicker(false); setCountrySearch(''); }}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#1a1e24] text-left transition-colors"
                >
                  <span className={`fi fi-${c.iso} text-xl leading-none rounded-[2px]`} />
                  <span className="flex-1 text-sm text-white">{c.name}</span>
                  <span className="text-sm text-[#5a6270]">{c.code}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
