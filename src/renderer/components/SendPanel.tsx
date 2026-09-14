import { useEffect, useState } from 'react';
import { Box, Text, Flex, VStack, HStack, Input, Textarea } from '@chakra-ui/react';

type Tpl = { name: string; text: string };

export function SendPanel(): React.JSX.Element {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [checkers, setCheckers] = useState<any[]>([]);
  const [accountId, setAccountId] = useState('');
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [tplIdx, setTplIdx] = useState(0);
  const [tplName, setTplName] = useState('');
  const [tplText, setTplText] = useState('');
  const [targets, setTargets] = useState('');
  const [verified, setVerified] = useState<any[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [preview, setPreview] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendLog, setSendLog] = useState<string[]>([]);

  const [ctaChecker, setCtaChecker] = useState(0);
  const [ctaTo, setCtaTo] = useState('');
  const [ctaBody, setCtaBody] = useState('*Hello!* Check out our latest update below.');
  const [ctaBtn, setCtaBtn] = useState('Visit Website');
  const [ctaUrl, setCtaUrl] = useState('https://www.whatspph.com/');
  const [ctaFooter, setCtaFooter] = useState('');
  const [ctaImg, setCtaImg] = useState('');
  const [ctaBusy, setCtaBusy] = useState(false);
  const [ctaMsg, setCtaMsg] = useState('');

  const inv = (m: string, p: any) => (window.api as any).invoke(m, p);

  const refresh = async () => {
    try {
      const accs = await (window.api as any).accounts.list();
      const on = ((accs as any[]) || []).filter((a) => ['ready', 'authenticated', 'online'].includes(String(a.status)));
      setAccounts(on);
      if (!accountId && on[0]) setAccountId(on[0].id);
    } catch {}
    try {
      const c = await inv('checker:list', {});
      const list = (c?.checkers || []).filter((x: any) => x.connected);
      setCheckers(list);
      if (list[0] && !list.some((x: any) => x.id === ctaChecker)) setCtaChecker(list[0].id);
    } catch {}
    try {
      // 已验证号码池：账号管理里所有带手机号的账号
      const all = await (window.api as any).accounts.list();
      setVerified(((all as any[]) || []).filter((a) => a.phone && String(a.phone).replace(/[^0-9]/g, '').length >= 8));
    } catch {}
    try {
      const t = await inv('send:templates_get', {});
      if (Array.isArray(t?.templates) && t.templates.length) {
        setTpls(t.templates);
        setTplIdx(0); setTplName(t.templates[0].name); setTplText(t.templates[0].text);
      }
    } catch {}
  };
  useEffect(() => { refresh(); }, []);

  const pickTpl = (i: number) => {
    setTplIdx(i);
    if (tpls[i]) { setTplName(tpls[i].name); setTplText(tpls[i].text); }
  };
  const saveTpls = async (next: Tpl[]) => {
    const r = await inv('send:templates_set', { templates: next });
    if (Array.isArray(r?.templates)) {
      setTpls(r.templates);
      const i = Math.min(tplIdx, r.templates.length - 1);
      setTplIdx(i); setTplName(r.templates[i].name); setTplText(r.templates[i].text);
    }
  };
  const addTpl = async () => {
    if (!tplText.trim()) return alert('模板内容不能为空');
    await saveTpls([...tpls, { name: tplName.trim() || `模板${tpls.length + 1}`, text: tplText }]).catch((e: any) => alert(e.message || String(e)));
  };
  const updateTpl = async () => {
    if (!tpls[tplIdx]) return alert('先选一条模板');
    if (!tplText.trim()) return alert('模板内容不能为空');
    const next = tpls.map((t, i) => (i === tplIdx ? { name: tplName.trim() || t.name, text: tplText } : t));
    await saveTpls(next).catch((e: any) => alert(e.message || String(e)));
  };
  const delTpl = async () => {
    if (!tpls[tplIdx]) return;
    if (!confirm(`删除模板「${tpls[tplIdx].name}」？`)) return;
    const next = tpls.filter((_, i) => i !== tplIdx);
    if (!next.length) return alert('至少保留一条：改完内容点“新增”会替换');
    await saveTpls(next).catch((e: any) => alert(e.message || String(e)));
  };

  const doSend = async () => {
    const nums = targets.split(/[\r\n,;\s]+/).map((s) => s.replace(/[^0-9]/g, '')).filter((s) => s.length >= 8 && s.length <= 16);
    if (!accountId) return alert('请选择发送账号（需已登录）');
    if (!tplText.trim()) return alert('发送内容不能为空');
    if (!nums.length) return alert('请填对方号码（每行一个，带区号）');
    if (!confirm(`用账号发 ${nums.length} 条？内容前50字：${tplText.trim().slice(0, 50)}`)) return;
    setSending(true); setSendLog([]);
    const lines: string[] = [];
    for (const n of nums) {
      try {
        const r = await inv('send:quick', { accountId, to: n, text: tplText.trim(), preview });
        lines.push(`✓ ${n} (${String(r.messageId || '').slice(-12)})`);
      } catch (e: any) {
        lines.push(`✗ ${n} ${e.message || String(e)}`);
      }
      setSendLog([...lines]);
    }
    setSending(false);
    refresh();
  };

  const doCta = async () => {
    if (!ctaTo.replace(/[^0-9]/g, '')) return alert('请填接收测试的号码（你自己的号）');
    setCtaBusy(true); setCtaMsg('');
    try {
      const r = await inv('send:cta_test', {
        checkerId: ctaChecker, to: ctaTo.trim(),
        body: ctaBody, buttonText: ctaBtn, buttonUrl: ctaUrl,
        footer: ctaFooter, imageUrl: ctaImg,
      });
      setCtaMsg(`已发出（${(r.messageIds || []).length} 条），去手机看渲染效果。按钮没出来=被客户端降级。`);
    } catch (e: any) { setCtaMsg('发送失败：' + (e.message || String(e))); }
    finally { setCtaBusy(false); }
  };

  return (
    <VStack align="stretch" spacing="16px">
      <Box bg="white" border="1px solid #E2E8F0" borderRadius="12px" p="14px">
        <Text fontWeight="700" fontSize="13px">快捷发送（英文预设 + 链接卡片，一点即发）</Text>
        <Text fontSize="11px" color="#718096" mt="2px">文本里的完整 URL 对方一点即跳；卡片由对方客户端按落地页 OG 标签生成。单账号 30 条/分限流。</Text>
        <Flex gap="12px" wrap="wrap" mt="10px">
          <Box flex="1" minW="240px">
            <Text fontSize="11px" color="#4A5568" mb="4px">发送账号（已登录）</Text>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
              style={{ width: '100%', fontSize: '12px', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '7px 8px' }}>
              {accounts.length === 0 && <option value="">暂无在线账号，去账号管理登录</option>}
              {accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name || a.phone || a.id.slice(0, 8)}（{a.status}）</option>)}
            </select>
            <Text fontSize="11px" color="#4A5568" mt="8px" mb="4px">模板</Text>
            <HStack spacing="4px" flexWrap="wrap">
              {tpls.map((t, i) => (
                <button key={i} onClick={() => pickTpl(i)}
                  style={{ padding: '4px 10px', fontSize: '11px', borderRadius: '6px', fontWeight: 700,
                    background: tplIdx === i ? '#7551FF' : 'white', color: tplIdx === i ? 'white' : '#4A5568',
                    border: '1px solid ' + (tplIdx === i ? '#7551FF' : '#E2E8F0') }}>{t.name}</button>
              ))}
            </HStack>
            <Input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="模板名" size="sm" mt="8px" />
            <Textarea value={tplText} onChange={(e) => setTplText(e.target.value)} rows={5} mt="8px" fontSize="12px" placeholder="英文内容，链接写全 https://…" />
            <HStack mt="8px" spacing="6px" flexWrap="wrap">
              <button onClick={addTpl} style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: '1px solid #01B574', color: '#01B574', background: 'white' }}>新增模板</button>
              <button onClick={updateTpl} style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: '1px solid #E2E8F0', background: 'white' }}>保存修改</button>
              <button onClick={delTpl} style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: '1px solid #FEB2B2', color: '#E53E3E', background: 'white' }}>删除</button>
              <HStack spacing="4px">
                <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
                <Text fontSize="11px" color="#4A5568">链接卡片</Text>
              </HStack>
            </HStack>
          </Box>
          <Box flex="1" minW="240px">
            <Flex justify="space-between" align="center" mb="4px">
              <Text fontSize="11px" color="#4A5568">对方号码（每行一个，带区号）</Text>
              <HStack spacing="6px">
                <button onClick={() => setShowPicker((v) => !v)}
                  style={{ padding: '3px 10px', fontSize: '11px', borderRadius: '8px', border: '1px solid #7551FF', color: '#7551FF', background: 'white', fontWeight: 700 }}>
                  从账号管理选择（{verified.length}）
                </button>
                {targets && <button onClick={() => setTargets('')} style={{ padding: '3px 8px', fontSize: '11px', borderRadius: '8px', border: '1px solid #E2E8F0', background: 'white' }}>清空</button>}
              </HStack>
            </Flex>
            {showPicker && (
              <Box mb="8px" maxH="180px" overflowY="auto" bg="#F8FAFC" border="1px solid #E2E8F0" borderRadius="8px" p="8px">
                {verified.length === 0 ? <Text fontSize="11px" color="#A0AEC0">账号管理里暂无已验证号码</Text> : verified.map((a) => {
                  const digits = String(a.phone).replace(/[^0-9]/g, '');
                  const checked = targets.split(/[\r\n,;\s]+/).includes(digits);
                  return (
                    <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', padding: '3px 0', cursor: 'pointer' }}>
                      <input type="checkbox" checked={checked} onChange={(e) => {
                        const cur = targets.split(/[\r\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
                        const next = e.target.checked ? [...new Set([...cur, digits])] : cur.filter((x) => x !== digits);
                        setTargets(next.join('\n'));
                      }} />
                      <span style={{ fontFamily: 'monospace' }}>+{digits}</span>
                      <span style={{ color: '#A0AEC0' }}>{a.name || ''}</span>
                    </label>
                  );
                })}
              </Box>
            )}
            <Textarea value={targets} onChange={(e) => setTargets(e.target.value)} rows={8} fontSize="12px" placeholder={'8613800000000\n886912345678'} />
            <button onClick={doSend} disabled={sending}
              style={{ marginTop: '8px', padding: '8px 16px', fontSize: '12px', borderRadius: '8px', background: '#7551FF', color: 'white', fontWeight: 700, opacity: sending ? 0.6 : 1 }}>
              {sending ? '发送中…' : '立即发送'}</button>
            {sendLog.length > 0 && (
              <Box mt="8px" maxH="160px" overflowY="auto" bg="#F7FAFC" borderRadius="8px" p="8px" fontSize="11px">
                {sendLog.map((l, i) => <Text key={i}>{l}</Text>)}
              </Box>
            )}
          </Box>
        </Flex>
      </Box>

      <Box bg="white" border="1px solid #E2E8F0" borderRadius="12px" p="14px">
        <Text fontWeight="700" fontSize="13px">CTA 跳转按钮测试（checker 发 interactive，手机看渲染）</Text>
        <Text fontSize="11px" color="#718096" mt="2px">先发图片+正文，再发跳转按钮。按钮能不能出来看对方客户端给不给面子——发完去自己手机上看，<Text as="span" fontWeight="700">填你自己的号测</Text>。</Text>
        <Flex gap="12px" wrap="wrap" mt="10px">
          <Box flex="1" minW="240px">
            <Text fontSize="11px" color="#4A5568" mb="4px">发送 checker（在线）</Text>
            <select value={ctaChecker} onChange={(e) => setCtaChecker(Number(e.target.value))}
              style={{ width: '100%', fontSize: '12px', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '7px 8px' }}>
              {checkers.length === 0 && <option value={0}>暂无在线 checker</option>}
              {checkers.map((c: any) => <option key={c.id} value={c.id}>#{c.id} 在线</option>)}
            </select>
            <Text fontSize="11px" color="#4A5568" mt="8px" mb="4px">接收测试号（你自己的号）</Text>
            <Input value={ctaTo} onChange={(e) => setCtaTo(e.target.value)} placeholder="如 8613800000000" size="sm" />
            <Text fontSize="11px" color="#4A5568" mt="8px" mb="4px">正文（*星号* = 加粗）</Text>
            <Textarea value={ctaBody} onChange={(e) => setCtaBody(e.target.value)} rows={4} fontSize="12px" />
          </Box>
          <Box flex="1" minW="240px">
            <Text fontSize="11px" color="#4A5568" mb="4px">按钮文字（≤30字）</Text>
            <Input value={ctaBtn} onChange={(e) => setCtaBtn(e.target.value)} size="sm" />
            <Text fontSize="11px" color="#4A5568" mt="8px" mb="4px">跳转域名（http(s) 完整）</Text>
            <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} size="sm" />
            <Text fontSize="11px" color="#4A5568" mt="8px" mb="4px">底部小字（可选）</Text>
            <Input value={ctaFooter} onChange={(e) => setCtaFooter(e.target.value)} size="sm" />
            <Text fontSize="11px" color="#4A5568" mt="8px" mb="4px">配图 URL（可选，不填只发按钮体）</Text>
            <Input value={ctaImg} onChange={(e) => setCtaImg(e.target.value)} size="sm" placeholder="https://…/shield.png" />
            <button onClick={doCta} disabled={ctaBusy}
              style={{ marginTop: '10px', padding: '8px 16px', fontSize: '12px', borderRadius: '8px', background: '#01B574', color: 'white', fontWeight: 700, opacity: ctaBusy ? 0.6 : 1 }}>
              {ctaBusy ? '发送中…' : '发送测试'}</button>
            {ctaMsg && <Text fontSize="11px" color={ctaMsg.startsWith('发送失败') ? '#E53E3E' : '#01B574'} mt="6px">{ctaMsg}</Text>}
          </Box>
        </Flex>
      </Box>
    </VStack>
  );
}
