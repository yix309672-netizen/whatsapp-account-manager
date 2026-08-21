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

  const backdrops = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4';

  return (
    <div className={backdrops} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-[fadeIn_.2s_ease]">
        <div className="h-1.5 bg-gradient-to-r from-[#00a884] via-[#25d366] to-[#00a884]" />

        {step === 'verify' && (
          <div className="p-8 flex flex-col items-center text-center">
            <div className="w-20 h-20 rounded-full bg-[#00a884]/10 flex items-center justify-center mb-6">
              <svg viewBox="0 0 24 24" className="w-10 h-10 text-[#00a884]" fill="currentColor">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.297-.497.1-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">验证 {accountName}</h2>
            <p className="text-sm text-slate-500 mb-8">
              在开始之前，请先完成安全验证
            </p>
            <button
              onClick={handleVerify}
              disabled={verifying}
              className="relative w-48 py-3 rounded-lg bg-[#00a884] text-white font-medium text-sm hover:bg-[#00a884]/90 disabled:opacity-70 transition-all overflow-hidden"
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
          <div className="p-8">
            <h2 className="text-xl font-semibold text-slate-900 mb-1">使用电话号码登录</h2>
            <p className="text-sm text-slate-500 mb-6">
              我们会向你的 WhatsApp 发送安全关联请求，请输入你的手机号码
            </p>

            <div className="space-y-4">
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCountryPicker(true)}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-slate-300 text-sm bg-white hover:bg-slate-50 shrink-0"
                >
                  <span className={`fi fi-${country.iso} text-lg leading-none rounded-[2px]`} />
                  <span className="text-slate-700 font-medium">{country.code}</span>
                </button>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, '').slice(0, 15))}
                  onKeyDown={(e) => e.key === 'Enter' && phone.length >= 5 && handleRequestPairing()}
                  placeholder="手机号码"
                  autoFocus
                  className="flex-1 px-3 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]"
                />
              </div>

              <button
                onClick={handleRequestPairing}
                disabled={phone.length < 5 || requesting}
                className="w-full py-3 rounded-lg bg-[#00a884] text-white font-medium text-sm hover:bg-[#00a884]/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
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

              <p className="text-xs text-slate-400 text-center leading-relaxed">
                点击“继续”即表示你同意我们的
                <span className="text-[#00a884] cursor-pointer">服务条款</span>和
                <span className="text-[#00a884] cursor-pointer">隐私政策</span>
              </p>

              {error && <p className="text-xs text-red-600 text-center">{error}</p>}
            </div>
          </div>
        )}

        {step === 'pairing' && (
          <div className="p-8 text-center">
            <h2 className="text-xl font-semibold text-slate-900 mb-2">关联设备</h2>
            <p className="text-sm text-slate-500 mb-6 leading-relaxed">
              手机 WhatsApp 会弹出<b className="text-slate-700">「关联设备」通知</b>，<br />
              点击通知即可进入关联设备页面
            </p>
            <div className="bg-slate-50 rounded-xl py-4 px-3 mb-2">
              <span className="text-2xl font-mono font-bold tracking-[0.3em] text-slate-900">
                {pairingCode.replace(/(.{4})/g, '$1 ').trim()}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              未收到通知？可手动进入：设置 → 已关联设备 → 关联设备<br />
              配对码约 3 分钟有效，过期后将自动刷新
            </p>
            <div className="mt-6 flex items-center justify-center gap-2 text-sm text-slate-500">
              <svg className="animate-spin w-4 h-4 text-[#00a884]" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              等待手机确认中…
            </div>
          </div>
        )}

        {step === 'success' && (
          <div className="p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">登录成功</h2>
            <p className="text-sm text-slate-500">
              登录信息已保存到账户管理器，可随时一键登录
            </p>
          </div>
        )}
      </div>

      {showCountryPicker && (
        <div className="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-[60] p-4" onClick={() => setShowCountryPicker(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-slate-100">
              <h3 className="font-semibold text-slate-900 mb-3">选择国家/地区</h3>
              <input
                value={countrySearch}
                onChange={(e) => setCountrySearch(e.target.value)}
                placeholder="搜索国家或区号"
                autoFocus
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]"
              />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {filteredCountries.map((c) => (
                <button
                  key={c.code}
                  onClick={() => { setCountry(c); setShowCountryPicker(false); setCountrySearch(''); }}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 text-left"
                >
                  <span className={`fi fi-${c.iso} text-xl leading-none rounded-[2px]`} />
                  <span className="flex-1 text-sm text-slate-800">{c.name}</span>
                  <span className="text-sm text-slate-400">{c.code}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}