import { useEffect, useState, useRef } from 'react';
import { Box, Text, Flex, VStack, HStack, Input, Textarea, Spinner } from '@chakra-ui/react';

type TaskRow = { id:string; name:string; kind?:string; channel?:string; total:number; done:number; valid_count:number; invalid_count:number; status:string; created_at:number };
type CheckerRow = { id:number; state:string; connected:boolean; taskId:string|null; hasQr:boolean; banSuspect?:boolean; banReason?:string };

export function ScannerPanel(): React.JSX.Element {
  const [status, setStatus] = useState<any>({ state:'close', connected:false });
  const [qr, setQr] = useState('');
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [phonesText, setPhonesText] = useState('8613800000000\n8613900000000\n886912345678');
  const [taskName, setTaskName] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const [progress, setProgress] = useState<any>(null);
  const [qrImg, setQrImg] = useState('');
  const [pairPhone, setPairPhone] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [pairCd, setPairCd] = useState(0);
  const [pairErr, setPairErr] = useState('');
  const [cfg, setCfg] = useState<any>({ mode:'balanced', minMs:4000, maxMs:8000, batchSize:25, batchRestMinMs:60000, batchRestMaxMs:120000, hourlyCap:800, maxConsecErr:5, checkAvatar:true, checkStatusMsg:true, presenceGapMs:3000, presenceTimeoutMs:10000, presenceCacheDays:7 });
  const [kw, setKw] = useState('');
  const [checkers, setCheckers] = useState<CheckerRow[]>([]);
  const [checkerCount, setCheckerCount] = useState(1);
  const [qrMap, setQrMap] = useState<Record<number,string>>({});
  const [qrImgMap, setQrImgMap] = useState<Record<number,string>>({});
  const [checkerBusy, setCheckerBusy] = useState<Record<number,boolean>>({});
  const [pairChecker, setPairChecker] = useState(0);
  const [newKind, setNewKind] = useState<'register'|'presence'>('register');
  const [channelSel, setChannelSel] = useState('pool');
  const [webAccounts, setWebAccounts] = useState<any[]>([]);
  const [presenceFilter, setPresenceFilter] = useState<'all'|'signal'|'online'|'recent'|'hidden'|'unregistered'|'error'>('all');
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgMsg, setCfgMsg] = useState('');
  const [taskMsg, setTaskMsg] = useState('');
  const [resultFilter, setResultFilter] = useState<'all' | 'valid' | 'invalid'>('all');
  const qrRef = useRef<HTMLCanvasElement>(null);

  const refresh = async () => {
    try {
      const s = await (window.api as any).invoke('scanner:status', {});
      setStatus(s); if (s?.qr) setQr(s.qr);
      if (Array.isArray(s?.checkers)) setCheckers(s.checkers as CheckerRow[]);
      if (typeof s?.checkerCount === 'number') setCheckerCount(s.checkerCount);
      const ts = await (window.api as any).invoke('scanner:list_tasks', {});
      setTasks(ts as TaskRow[]);
      try {
        const accs = await (window.api as any).accounts.list();
        setWebAccounts(((accs as any[]) || []).filter(a=>['ready','authenticated','online'].includes(String(a.status))));
      } catch {}
    } catch {}
  };

  const qrToImg = async (q:string):Promise<string> => {
    try {
      const QR = await import('qrcode');
      return await (QR as any).toDataURL(q, { width: 200, margin: 1 });
    } catch { return ''; }
  };

  const connectChecker = async (id:number) => {
    setCheckerBusy(b=>({...b,[id]:true}));
    try {
      const r = await (window.api as any).invoke('checker:connect', { id });
      if (r?.qr) {
        setQrMap(m=>({...m,[id]:r.qr}));
        setQrImgMap(m=>({...m,[id]:''}));
        qrToImg(r.qr).then(img=>{ if(img) setQrImgMap(m=>({...m,[id]:img})); });
      }
      if (r?.connected) { setQrMap(m=>{ const n={...m}; delete n[id]; return n; }); }
      await refresh();
      if (!r?.qr && !r?.connected) {
        // 没立即拿到 QR 就等推送（scanner:qr 事件会进 qrMap）；兜底轮询最多 15s
        for (let i=0;i<15;i++) {
          await new Promise(res=>setTimeout(res,1000));
          const c = await (window.api as any).invoke('checker:list', {});
          const row = (c?.checkers||[]).find((x:any)=>x.id===id);
          if (row?.connected) { setQrMap(m=>{ const n={...m}; delete n[id]; return n; }); break; }
          if (row?.hasQr) break;
        }
        await refresh();
      }
    } catch(e:any){ alert(`checker #${id} 连接失败: `+(e.message||String(e))); }
    finally { setCheckerBusy(b=>({...b,[id]:false})); }
  };
  const disconnectChecker = async (id:number, logout=false) => {
    try { await (window.api as any).invoke('checker:disconnect', { id, logout }); } catch(e:any){ alert(e.message||String(e)); }
    setQrMap(m=>{ const n={...m}; delete n[id]; return n; });
    refresh();
  };
  const clearCheckerAuth = async (id:number) => {
    if(!confirm(`清除 checker #${id} 登录态，需重扫。确定？`)) return;
    try { await (window.api as any).invoke('checker:clear_auth', { id }); } catch(e:any){ alert(e.message||String(e)); }
    refresh();
  };
  const unbanChecker = async (id:number) => {
    if(!confirm(`解除 checker #${id} 的封号标记并恢复参与任务？（仅确认号正常/申诉通过后点）`)) return;
    try { await (window.api as any).invoke('checker:unban', { id }); } catch(e:any){ alert(e.message||String(e)); }
    refresh();
  };
  const saveCheckerCount = async (n:number) => {
    try {
      const r = await (window.api as any).invoke('checker:set_count', { count:n });
      if (typeof r?.checkerCount === 'number') setCheckerCount(r.checkerCount);
      if (Array.isArray(r?.checkers)) setCheckers(r.checkers as CheckerRow[]);
    } catch(e:any){ alert(e.message||String(e)); }
  };

  const loadCfg = async () => {
    try {
      const r = await (window.api as any).invoke('scanner:get_config', {});
      if (r?.config) setCfg(r.config);
    } catch {}
  };

  // 手改任何数值/开关即视为自定义档，避免保存时被档位值覆盖
  const upd = (patch: any) => setCfg((c:any)=>({ ...c, ...patch, mode:'custom' }));

  const saveCfg = async (patch: any) => {
    setCfgSaving(true); setCfgMsg('');
    try {
      const r = await (window.api as any).invoke('scanner:set_config', { config: patch });
      if (r?.config) setCfg(r.config);
      setCfgMsg('已保存，下个任务生效');
      setTimeout(()=> setCfgMsg(''), 2500);
    } catch (e:any) { setCfgMsg('保存失败: ' + (e.message||String(e))); }
    finally { setCfgSaving(false); }
  };

  // QR 转二维码图片
  useEffect(() => {
    if (!qr) { setQrImg(''); return; }
    let cancelled = false;
    (async () => {
      try {
        const QR = await import('qrcode');
        const url = await (QR as any).toDataURL(qr, { width: 220, margin: 1 });
        if (!cancelled) setQrImg(url);
      } catch { setQrImg(''); }
    })();
    return () => { cancelled = true; };
  }, [qr]);

  useEffect(() => {
    refresh(); loadCfg();
    const offs = [
      (window.api as any).on('scanner:qr', (d:any)=> {
        if (d?.checkerId > 0) {
          setQrMap(m=>({...m,[d.checkerId]:d.qr}));
          qrToImg(d.qr).then(img=>{ if(img) setQrImgMap(m=>({...m,[d.checkerId]:img})); });
        } else setQr(d.qr);
        refresh();
      }),
      (window.api as any).on('scanner:status', (d:any)=> {
        if (d?.checkerId > 0) {
          if (d.state==='open') setQrMap(m=>{ const n={...m}; delete n[d.checkerId]; return n; });
          refresh();
          return;
        }
        setStatus((p:any)=>({...p, ...d, connected: d.state==='open'}));
        if (d.qr) setQr(d.qr);
        if (d.state==='open') setQr('');
      }),
      (window.api as any).on('scanner:progress', (d:any)=> { setProgress(d); refresh(); }),
      (window.api as any).on('scanner:task', (d:any)=> { if(d?.reason) setTaskMsg(d.reason); else if(d?.status==='running') setTaskMsg(''); refresh(); }),
      (window.api as any).on('presence:progress', (d:any)=> { setProgress(d); refresh(); }),
      (window.api as any).on('presence:task', (d:any)=> { if(d?.status==='running') setTaskMsg(''); refresh(); }),
    ];
    const iv = setInterval(refresh, 4000);
    return () => { offs.forEach((o:any)=>o()); clearInterval(iv); };
  }, []);

  const connect = async () => {
    setBusy(true); setQr(''); setQrImg('');
    try{
      const r= await (window.api as any).invoke('scanner:connect',{});
      if(r?.qr) setQr(r.qr);
      if(r?.error) alert('连接失败: ' + r.error);
      await refresh();
      // 若未立即拿到 QR，等待事件推送（最多 15s）
      if(!r?.qr && !r?.connected){
        for(let i=0;i<15;i++){ await new Promise(res=>setTimeout(res,1000)); const s= await (window.api as any).invoke('scanner:status',{}); if(s?.qr){ setQr(s.qr); break;} if(s?.connected) break; }
      }
    } catch(e:any){ alert('连接失败: '+(e.message||String(e))); }
    finally{ setBusy(false);}
  };
  const disconnect = async (logout=false)=>{ try { await (window.api as any).invoke('scanner:disconnect',{logout}); } catch(e:any){ alert(e.message||String(e)); } setQr(''); refresh(); };
  const clearAuth = async()=>{ if(!confirm('清除 Baileys 登录态，需重扫二维码。确定？')) return; try { await (window.api as any).invoke('scanner:clear_auth',{}); } catch(e:any){ alert(e.message||String(e)); } setQr(''); refresh(); };

  const onlineCount = (status as any)?.onlineCount ?? (status.connected ? 1 : 0);
  const createTask = async()=>{
    if(!phonesText.trim()) return alert('请填入号码');
    setBusy(true);
    try{
      const method = newKind==='presence' ? 'presence:create_task' : 'scanner:create_task';
      const params:any = { text: phonesText, name: taskName || undefined };
      if (newKind==='register' && channelSel.startsWith('web:')) params.channel = channelSel;
      const r = await (window.api as any).invoke(method, params);
      setPhonesText(''); setTaskName('');
      await refresh();
      alert(`${newKind==='presence' ? '活跃度' : '筛号'}任务已创建 ${r.taskId.slice(0,8)} 共 ${phonesText.split(/[\r\n,;\s]+/).filter(Boolean).length} 条`);
    } catch(e:any){ alert(e.message);} finally{ setBusy(false);}
  };

  const startTask = async(id:string)=>{
    const t = tasks.find(x=>x.id===id);
    const isWeb = !!t?.channel && t.channel.startsWith('web:');
    if (!isWeb && !onlineCount) { alert('没有在线通道号：请先在上方给至少一个 checker 扫码/配对码登录，显示在线再点开始'); return; }
    try { await (window.api as any).invoke('scanner:start',{taskId:id}); } catch(e:any){ alert(e.message||String(e)); } refresh();
  };
  const viewTask = async(id:string)=>{ try { const r= await (window.api as any).invoke('scanner:get_task',{taskId:id}); setSelected(r); setResultFilter('all'); setPresenceFilter('all'); } catch(e:any){ alert(e.message||String(e)); } };
  const doExport = async(id:string, onlyValid:boolean)=>{ try { const r= await (window.api as any).invoke('scanner:export',{taskId:id, onlyValid}); alert(`已导出${onlyValid ? '有效 ' : ''}${r.count} 条\n${r.filePath}`); } catch(e:any){ alert(e.message||String(e)); } };
  const delTask = async(id:string)=>{ if(!confirm('删除任务及结果？')) return; try { await (window.api as any).invoke('scanner:delete',{taskId:id}); } catch(e:any){ alert(e.message||String(e)); } refresh(); };
  const ctlTask = async(action:'pause'|'resume'|'abort', label:string)=>{
    try { await (window.api as any).invoke(`scanner:${action}`,{}); } catch(e:any){ alert(`${label}失败：`+(e.message||String(e))); } refresh();
  };

  return (
    <VStack align="stretch" spacing="16px">
      <Box bg="white" border="1px solid #E2E8F0" borderRadius="12px" p="12px">
        <Flex justify="space-between" align="center" wrap="wrap" gap="8px">
          <Text fontSize="12px" fontWeight="700" color="#2D3748">🛡 防风控（下个任务生效，当前约 {Number((cfg.minMs/1000).toFixed(1))}~{Number((cfg.maxMs/1000).toFixed(1))} 秒/号{cfg.mode==='custom' ? ' · 自定义' : ''}）</Text>
          <HStack spacing="6px">
            {([['stealth','隐身'],['balanced','均衡'],['fast','极速']] as const).map(([k,label])=>(
              <button key={k} onClick={()=>saveCfg({ mode:k })} disabled={cfgSaving}
                style={{padding:'5px 12px', fontSize:'11px', borderRadius:'8px', fontWeight:700,
                  background: cfg.mode===k ? '#7551FF' : 'white', color: cfg.mode===k ? 'white' : '#4A5568',
                  border:'1px solid '+(cfg.mode===k ? '#7551FF' : '#E2E8F0')}}>{label}</button>
            ))}
          </HStack>
        </Flex>
        <Text fontSize="10px" color="#718096" mt="4px">隐身 8~15s/号·最稳（主号/大批量）｜均衡 4~8s/号·推荐｜极速 2~4s/号·仅小号短期用。熔断/小时上限触发会自动暂停，需手动继续。</Text>
        <Flex mt="8px" gap="8px" wrap="wrap" align="center">
          <HStack spacing="4px"><Text fontSize="11px" color="#4A5568">间隔</Text>
            <Input value={Math.round(cfg.minMs/1000)} onChange={(e)=>upd({minMs:Number(e.target.value)*1000})} size="xs" width="52px" type="number" />
            <Text fontSize="11px">~</Text>
            <Input value={Math.round(cfg.maxMs/1000)} onChange={(e)=>upd({maxMs:Number(e.target.value)*1000})} size="xs" width="52px" type="number" />
            <Text fontSize="11px" color="#718096">秒/号</Text></HStack>
          <HStack spacing="4px"><Text fontSize="11px" color="#4A5568">每</Text>
            <Input value={cfg.batchSize} onChange={(e)=>upd({batchSize:Number(e.target.value)})} size="xs" width="52px" type="number" />
            <Text fontSize="11px" color="#4A5568">号休</Text>
            <Input value={Math.round(cfg.batchRestMinMs/1000)} onChange={(e)=>upd({batchRestMinMs:Number(e.target.value)*1000})} size="xs" width="56px" type="number" />
            <Text fontSize="11px">~</Text>
            <Input value={Math.round(cfg.batchRestMaxMs/1000)} onChange={(e)=>upd({batchRestMaxMs:Number(e.target.value)*1000})} size="xs" width="56px" type="number" />
            <Text fontSize="11px" color="#718096">秒</Text></HStack>
          <HStack spacing="4px"><Text fontSize="11px" color="#4A5568">小时上限</Text>
            <Input value={cfg.hourlyCap} onChange={(e)=>upd({hourlyCap:Number(e.target.value)})} size="xs" width="64px" type="number" />
            <Text fontSize="11px" color="#718096">号（0=不限）</Text></HStack>
          <HStack spacing="4px"><Text fontSize="11px" color="#4A5568">连错熔断</Text>
            <Input value={cfg.maxConsecErr} onChange={(e)=>upd({maxConsecErr:Number(e.target.value)})} size="xs" width="52px" type="number" />
            <Text fontSize="11px" color="#718096">次</Text></HStack>
          <HStack spacing="4px"><Text fontSize="11px" color="#4A5568">失败重查</Text>
            <Input value={cfg.retryRounds ?? 1} onChange={(e)=>upd({retryRounds:Number(e.target.value)})} size="xs" width="52px" type="number" />
            <Text fontSize="11px" color="#718096">轮/间隔</Text>
            <Input value={Math.round((cfg.retryCooldownMs ?? 60000)/1000)} onChange={(e)=>upd({retryCooldownMs:Number(e.target.value)*1000})} size="xs" width="56px" type="number" />
            <Text fontSize="11px" color="#718096">秒</Text></HStack>
          <HStack spacing="4px">
            <input type="checkbox" checked={cfg.checkAvatar !== false} onChange={(e)=>upd({checkAvatar:e.target.checked})} />
            <Text fontSize="11px" color="#4A5568">检测头像（慢约1倍；关=更快更稳）</Text></HStack>
          <HStack spacing="4px">
            <input type="checkbox" checked={cfg.checkStatusMsg !== false} onChange={(e)=>upd({checkStatusMsg:e.target.checked})} />
            <Text fontSize="11px" color="#4A5568">读个性签名（对方关隐私则为空）</Text></HStack>
          <HStack spacing="4px"><Text fontSize="11px" color="#4A5568">活跃间隔</Text>
            <Input value={Math.round((cfg.presenceGapMs ?? 3000)/1000)} onChange={(e)=>upd({presenceGapMs:Number(e.target.value)*1000})} size="xs" width="52px" type="number" />
            <Text fontSize="11px" color="#718096">秒/号</Text></HStack>
          <HStack spacing="4px"><Text fontSize="11px" color="#4A5568">活跃超时</Text>
            <Input value={Math.round((cfg.presenceTimeoutMs ?? 10000)/1000)} onChange={(e)=>upd({presenceTimeoutMs:Number(e.target.value)*1000})} size="xs" width="52px" type="number" />
            <Text fontSize="11px" color="#718096">秒</Text></HStack>
          <HStack spacing="4px"><Text fontSize="11px" color="#4A5568">活跃缓存</Text>
            <Input value={cfg.presenceCacheDays ?? 7} onChange={(e)=>upd({presenceCacheDays:Number(e.target.value)})} size="xs" width="52px" type="number" />
            <Text fontSize="11px" color="#718096">天（0=每次重查）</Text></HStack>
          <button onClick={()=>saveCfg(cfg)} disabled={cfgSaving}
            style={{padding:'6px 14px', fontSize:'11px', borderRadius:'8px', background:'#01B574', color:'white', fontWeight:700}}>
            {cfgSaving ? '保存中…' : '保存风控设置'}</button>
          {cfgMsg && <Text fontSize="11px" color={cfgMsg.startsWith('保存失败') ? '#E53E3E' : '#01B574'}>{cfgMsg}</Text>}
        </Flex>
      </Box>

      <Box bg="white" border="1px solid #E2E8F0" borderRadius="12px" p="12px">
        <Flex justify="space-between" align="center" wrap="wrap" gap="8px">
          <Text fontSize="12px" fontWeight="700" color="#2D3748">🔌 Checker 池（{onlineCount}/{checkerCount} 在线 · 注册筛查与活跃度按在线数分片并行）</Text>
          <HStack spacing="4px">
            <Text fontSize="11px" color="#4A5568">数量</Text>
            <select value={checkerCount} onChange={(e)=>saveCheckerCount(Number(e.target.value))}
              style={{fontSize:'11px', border:'1px solid #E2E8F0', borderRadius:'6px', padding:'4px 6px'}}>
              {[1,2,3,4,5,6,7,8,9,10].map(n=><option key={n} value={n}>{n} 个</option>)}
            </select>
          </HStack>
        </Flex>
        <Text fontSize="10px" color="#718096" mt="4px">#0 沿用老登录态（无缝保留）；#1 起每个号独立扫码（独立 auth 目录）。加号只需改数量后逐个扫码。</Text>
        <Flex mt="8px" gap="8px" wrap="wrap">
          {checkers.map(c=>(
            <Box key={c.id} minW="200px" flex="1" bg="#F8FAFC" border="1px solid #E2E8F0" borderRadius="10px" p="10px">
              <HStack spacing="6px">
                <Box w="8px" h="8px" borderRadius="full" bg={c.banSuspect ? '#9B2C2C' : c.connected ? '#01B574' : c.state==='connecting' ? '#FFB547' : '#E53E3E'} />
                <Text fontSize="12px" fontWeight="700">#{c.id}</Text>
                <Text fontSize="11px" color={c.banSuspect ? '#C53030' : '#718096'}>{c.banSuspect ? '疑似被封（已隔离）' : c.connected ? '在线' : c.state==='connecting' ? '连接中' : '离线'}{c.taskId ? ` · 跑 ${c.taskId.slice(0,6)}` : ''}</Text>
              </HStack>
              {c.banSuspect && (
                <Box mt="6px" bg="#FFF5F5" border="1px solid #FEB2B2" borderRadius="6px" p="6px">
                  <Text fontSize="10px" color="#C53030">🚫 {c.banReason || '疑似被封'}（不参与任务、不自动重连）</Text>
                  <button onClick={()=>unbanChecker(c.id)} style={{marginTop:'6px', padding:'4px 10px', fontSize:'11px', borderRadius:'6px', background:'#C53030', color:'white', fontWeight:700}}>解除标记</button>
                </Box>
              )}
              {qrMap[c.id] ? (
                <Box mt="8px" bg="white" p="6px" borderRadius="8px" textAlign="center">
                  {qrImgMap[c.id] ? <img src={qrImgMap[c.id]} alt={`QR-${c.id}`} style={{width:200, height:200, margin:'0 auto', display:'block', border:'1px solid #E2E8F0', borderRadius:8}} /> : <Spinner size="sm" color="#7551FF" />}
                  <Text fontSize="10px" color="#A0AEC0" mt="4px">用 #{c.id} 号手机扫码（过期自动刷新）</Text>
                </Box>
              ) : null}
              <HStack mt="8px" spacing="6px" flexWrap="wrap">
                <button onClick={()=>connectChecker(c.id)} disabled={checkerBusy[c.id] || c.connected}
                  style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', background: c.connected ? '#E2E8F0' : '#7551FF', color: c.connected ? '#718096' : 'white', fontWeight:700}}>
                  {checkerBusy[c.id] ? '...' : '连接/扫码'}</button>
                <button onClick={()=>disconnectChecker(c.id,false)} style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #E2E8F0', background:'white'}}>断开</button>
                <button onClick={()=>clearCheckerAuth(c.id)} style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #FEB2B2', background:'white', color:'#E53E3E'}}>清除授权</button>
              </HStack>
            </Box>
          ))}
        </Flex>
      </Box>

      <Flex gap="16px" wrap="wrap">
        <Box flex="1" minW="260px" bg="#F8FAFC" borderRadius="12px" p="14px" border="1px solid #E2E8F0">
          <Text fontWeight="700" fontSize="13px">通道号状态（#0）</Text>
          <HStack mt="8px" spacing="8px">
            <Box w="8px" h="8px" borderRadius="full" bg={status.connected ? '#01B574' : status.state==='connecting' ? '#FFB547' : '#E53E3E'} />
            <Text fontSize="12px" fontWeight="600">{status.connected ? '已连接可筛号' : status.state==='connecting' ? '连接中…' : '未连接'}</Text>
            <Text fontSize="11px" color="#718096">{status.state}</Text>
          </HStack>
          {qr ? (
            <Box mt="10px" bg="white" p="8px" borderRadius="8px" textAlign="center">
              <Text fontSize="11px" color="#4A5568" mb="6px">用通道号手机 WhatsApp 扫码登录（15-45秒内有效，过期自动刷新）</Text>
              {qrImg ? <img src={qrImg} alt="QR" style={{width:220, height:220, margin:'0 auto', display:'block', border:'1px solid #E2E8F0', borderRadius:8}} /> : <Spinner size="sm" color="#7551FF" />}
              <Box fontSize="10px" wordBreak="break-all" bg="#F7FAFC" p="6px" borderRadius="6px" maxH="60px" overflowY="auto" mt="6px" color="#718096">{qr.slice(0,120)}...</Box>
              <Text fontSize="10px" color="#A0AEC0" mt="4px">二维码过期会自动刷新，无需重复点击按钮</Text>
            </Box>
          ) : (status as any)?.retrying ? (
            <Box mt="10px" bg="white" p="8px" borderRadius="8px" textAlign="center">
              <Spinner size="sm" color="#FFB547" />
              <Text fontSize="11px" color="#4A5568" mt="4px">通道重连中，二维码马上回来…</Text>
            </Box>
          ) : (
            <Box mt="8px">
              <Text fontSize="11px" color="#A0AEC0">未登录时点“连接/扫码”生成二维码；已登录下次免扫码。</Text>
              {(status as any)?.error && <Text fontSize="11px" color="#E53E3E" mt="4px">{(status as any).error}</Text>}
            </Box>
          )}
          <HStack mt="10px" spacing="6px" flexWrap="wrap">
            <button onClick={connect} disabled={busy || status.connected} style={{padding:'6px 10px', fontSize:'11px', borderRadius:'8px', background: status.connected ? '#E2E8F0' : '#7551FF', color: status.connected ? '#718096' : 'white', fontWeight:700}}>{busy ? '...' : '连接/扫码'}</button>
            <button onClick={()=>disconnect(false)} style={{padding:'6px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #E2E8F0', background:'white'}}>断开</button>
            <button onClick={()=>disconnect(true)} style={{padding:'6px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #FED7AA', background:'#FFF7ED', color:'#C2410C'}}>退出登录</button>
            <button onClick={clearAuth} style={{padding:'6px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #FEB2B2', background:'white', color:'#E53E3E'}}>清除授权</button>
          </HStack>
          {/* 配对码（官方 Web 同链路，扫码失败时用） */}
          <Box mt="12px" bg="white" border="1px dashed #E2E8F0" borderRadius="8px" p="8px">
            <Flex justify="space-between" align="center">
              <Text fontSize="11px" fontWeight="700" color="#4A5568">扫码失败？用配对码</Text>
              <HStack spacing="4px">
                <Text fontSize="10px" color="#718096">checker</Text>
                <select value={pairChecker} onChange={(e)=>setPairChecker(Number(e.target.value))}
                  style={{fontSize:'10px', border:'1px solid #E2E8F0', borderRadius:'6px', padding:'2px 4px'}}>
                  {checkers.map(c=><option key={c.id} value={c.id}>#{c.id}</option>)}
                </select>
              </HStack>
            </Flex>
            <Text fontSize="10px" color="#718096" mt="2px">填通道号本机号码（8-15位纯数字带区号，如 8613800…；不用加 +，00开头请去掉，开头勿带0）→ 获取 → 等二维码出现后再点获取 → 手机 已关联设备 → 用电话号码关联 输入8位。</Text>
            <HStack mt="6px" spacing="6px">
              <Input value={pairPhone} onChange={(e)=>{ setPairPhone(e.target.value); setPairErr(''); }} placeholder="通道号 8613xxxxxxxx" size="xs" fontSize="11px" />
              <button
                onClick={async()=>{
                  if(!pairPhone.trim()) { setPairErr('请填通道号本机号码'); return; }
                  if(pairCd>0) return;
                  setBusy(true); setPairErr('');
                  try{
                    const r= pairChecker===0
                      ? await (window.api as any).invoke('scanner:pairing_code',{phone: pairPhone.trim()})
                      : await (window.api as any).invoke('checker:pairing_code',{id: pairChecker, phone: pairPhone.trim()});
                    const c = String(r.code||'').toUpperCase();
                    setPairCode(c);
                    setPairCd(30);
                    const iv=setInterval(()=> setPairCd(v=>{ if(v<=1){clearInterval(iv); return 0;} return v-1;}),1000);
                  }catch(e:any){ setPairErr(e.message||String(e)); }
                  finally{ setBusy(false);}
                }}
                disabled={busy || pairCd>0}
                style={{padding:'6px 10px', fontSize:'11px', borderRadius:'6px', background: pairCd>0 ? '#E2E8F0' : '#01B574', color: pairCd>0 ? '#718096' : 'white', fontWeight:700, whiteSpace:'nowrap'}}
              >{pairCd>0 ? `${pairCd}s` : '获取配对码'}</button>
            </HStack>
            {pairErr && <Text fontSize="11px" color="#E53E3E" mt="6px">{pairErr}</Text>}
            {pairCode && (
              <Box mt="6px" bg="#F0FFF4" border="1px solid #C6F6D5" borderRadius="6px" p="8px" textAlign="center">
                <Text fontSize="22px" fontWeight="800" letterSpacing="0.25em" color="#276749" fontFamily="monospace">{pairCode.includes('-') ? pairCode : `${pairCode.slice(0,4)}-${pairCode.slice(4)}`}</Text>
                <HStack justify="center" mt="4px" spacing="6px">
                  <button onClick={()=>{ navigator.clipboard.writeText(pairCode.replace(/-/g,'')); alert('已复制'); }} style={{padding:'4px 8px', fontSize:'10px', borderRadius:'4px', background:'white', border:'1px solid #C6F6D5'}}>复制</button>
                  <Text fontSize="10px" color="#68D391">3分钟内有效，1次/30s，官方限流勿连点</Text>
                </HStack>
              </Box>
            )}
          </Box>
          {progress && <Text fontSize="11px" color="#2B6CB0" mt="8px">▶ {progress.retryRound ? `第${progress.retryRound}轮补查 ` : ''}{progress.phone} {progress.status ? ({online:'在线',recent:'近期活跃',hidden:'无信号',unregistered:'未开通',error:'异常'} as any)[progress.status] || progress.status : (progress.exists ? '已开通' : '未开通')} {progress.hasAvatar ? '有头像' : ''}{progress.checkerId === -1 ? ' [账号直查]' : (progress.checkerId !== undefined && progress.checkerId !== null ? ` [#${progress.checkerId}]` : '')} — {progress.done}/{progress.total}{progress.resting ? `（休眠 ${progress.resting}s…）` : ''}</Text>}
        </Box>

        <Box flex="1.2" minW="320px" bg="white" border="1px solid #E2E8F0" borderRadius="12px" p="14px">
          <Flex justify="space-between" align="center">
            <Text fontWeight="700" fontSize="13px">新建任务</Text>
            <HStack spacing="4px">
              {([['register','注册筛查'],['presence','活跃度']] as const).map(([k,label])=>(
                <button key={k} onClick={()=>setNewKind(k)}
                  style={{padding:'4px 10px', fontSize:'11px', borderRadius:'6px', fontWeight:700,
                    background: newKind===k ? '#7551FF' : 'white', color: newKind===k ? 'white' : '#4A5568',
                    border:'1px solid '+(newKind===k ? '#7551FF' : '#E2E8F0')}}>{label}</button>
              ))}
            </HStack>
          </Flex>
          <Text fontSize="11px" color="#718096" mt="2px">每行一个号码，须带国际区号无加号（例 86138xxxx / 886912xxxx）。{newKind==='presence' ? '活跃度：单任务最多2000条（建议≤500），逐个等信号约3~10秒/号，多 checker 并行。' : '也支持逗号/空格分隔，或粘贴 txt/csv 内容。'}</Text>
          {newKind==='register' && (
            <HStack mt="8px" spacing="6px">
              <Text fontSize="11px" color="#4A5568">通道</Text>
              <select value={channelSel} onChange={(e)=>setChannelSel(e.target.value)}
                style={{fontSize:'11px', border:'1px solid #E2E8F0', borderRadius:'6px', padding:'4px 6px', maxWidth:'100%'}}>
                <option value="pool">🔌 Checker 池{onlineCount ? `（${onlineCount}在线）` : '（离线需扫码）'}</option>
                {webAccounts.map(a=><option key={a.id} value={'web:'+a.id}>🖥️ {a.name || a.phone || a.id.slice(0,8)}（免扫码直查）</option>)}
              </select>
            </HStack>
          )}
          {newKind==='register' && webAccounts.length===0 && (
            <Text fontSize="10px" color="#A0AEC0" mt="4px">管理器暂无已登录账号：账号管理里登录后，这里可免扫码直查。</Text>
          )}
          <Input value={taskName} onChange={(e)=>setTaskName(e.target.value)} placeholder="任务名（可选）" size="sm" mt="8px" />
          <Textarea value={phonesText} onChange={(e)=>setPhonesText(e.target.value)} placeholder="8613800138000..." rows={6} mt="8px" fontSize="12px" />
          <HStack mt="8px" justify="space-between">
            <Text fontSize="11px" color="#A0AEC0">{phonesText.split(/[\r\n,;\s]+/).filter(Boolean).length} 条待创建 · 最多{newKind==='presence' ? 2000 : 5000}</Text>
            <button onClick={createTask} disabled={busy} style={{padding:'7px 14px', fontSize:'12px', borderRadius:'8px', background:'#01B574', color:'white', fontWeight:700}}>{busy ? '创建中…' : '创建任务'}</button>
          </HStack>
          <HStack mt="8px" spacing="6px">
            <button onClick={()=>ctlTask('pause','暂停')} style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #E2E8F0', background:'white'}}>暂停</button>
            <button onClick={()=>ctlTask('resume','继续')} style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #E2E8F0', background:'white'}}>继续</button>
            <button onClick={()=>ctlTask('abort','中止')} style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #FED7AA', background:'white', color:'#C2410C'}}>中止</button>
          </HStack>
        </Box>
      </Flex>

      <Box>
        <Flex justify="space-between" align="center" mb="8px">
          <Text fontWeight="700" fontSize="13px">任务列表</Text>
          <button onClick={refresh} style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #7551FF', color:'#7551FF', background:'white'}}>刷新</button>
        </Flex>
        {taskMsg && <Box bg="#FFF5F5" border="1px solid #FEB2B2" borderRadius="8px" p="8px" mb="8px"><Text fontSize="11px" color="#C53030">⛔ {taskMsg}</Text></Box>}
        {tasks.length===0 ? <Text fontSize="12px" color="#A0AEC0" textAlign="center" py="20px">暂无任务</Text> : (
          <VStack align="stretch" spacing="8px">
            {tasks.map(t=>(
              <Flex key={t.id} bg="white" border="1px solid #E2E8F0" borderRadius="10px" p="10px" align="center" justify="space-between" wrap="wrap" gap="8px">
                <Box>
                  <Text fontSize="12px" fontWeight="700">{(t.kind||'register')==='presence' ? '🟢' : '🔵'} {t.name} <Text as="span" fontWeight="400" color="#718096">· {t.id.slice(0,8)}</Text>{t.channel && t.channel.startsWith('web:') && <Text as="span" fontSize="10px" color="#2B6CB0"> · 🖥️账号直查</Text>}</Text>
                  <Text fontSize="11px" color="#718096">{new Date(t.created_at*1000).toLocaleString()} · {t.done}/{t.total} · <Text as="span" color="#01B574">{(t.kind||'register')==='presence' ? `有信号${t.valid_count}` : `有效${t.valid_count}`}</Text> / {(t.kind||'register')==='presence' ? `无信号${t.invalid_count}` : `无效${t.invalid_count}`} · <Text as="span" color={t.status==='completed' ? '#01B574' : t.status==='running' ? '#3182CE' : '#718096'}>{t.status}</Text></Text>
                  <Box w="160px" h="4px" bg="#E2E8F0" borderRadius="full" mt="4px" overflow="hidden"><Box h="100%" bg="#7551FF" style={{width: `${t.total ? Math.round(t.done/t.total*100) : 0}%`}} /></Box>
                </Box>
                <HStack spacing="6px" flexWrap="wrap">
                  <button onClick={()=>startTask(t.id)} disabled={t.status==='running'} style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', background: t.status==='running' ? '#E2E8F0' : '#7551FF', color:'white'}}>开始</button>
                  <button onClick={()=>viewTask(t.id)} style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #E2E8F0', background:'white'}}>查看</button>
                  <button onClick={()=>doExport(t.id, false)} style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #01B574', color:'#01B574', background:'white'}}>导出CSV</button>
                  <button onClick={()=>delTask(t.id)} style={{padding:'5px 10px', fontSize:'11px', borderRadius:'8px', border:'1px solid #FEB2B2', color:'#E53E3E', background:'white'}}>删除</button>
                </HStack>
              </Flex>
            ))}
          </VStack>
        )}
      </Box>

      {selected && (selected.kind==='presence' ? (
        <Box bg="white" border="1px solid #E2E8F0" borderRadius="12px" p="14px">
          <Flex justify="space-between" align="center" wrap="wrap" gap="8px">
            <Text fontWeight="700" fontSize="13px">🟢 活跃度结果 · {selected.task.id.slice(0,8)} {selected.task.name}</Text>
            <HStack spacing="6px" flexWrap="wrap">
              {([['all','全部'],['signal','有信号'],['online','在线'],['recent','近期活跃'],['hidden','无信号'],['unregistered','未开通'],['error','异常']] as const).map(([k,label])=>(
                <button key={k} onClick={()=>setPresenceFilter(k)}
                  style={{padding:'4px 10px', fontSize:'11px', borderRadius:'6px',
                    background: presenceFilter===k ? '#01B574' : 'white', color: presenceFilter===k ? 'white' : '#4A5568',
                    border:'1px solid '+(presenceFilter===k ? '#01B574' : '#E2E8F0')}}>{label}</button>
              ))}
              <button onClick={()=>doExport(selected.task.id, ['signal','online','recent'].includes(presenceFilter))} style={{padding:'4px 10px', fontSize:'11px', borderRadius:'6px', border:'1px solid #01B574', color:'#01B574', background:'white'}}>导出当前筛选</button>
              <button onClick={()=>setSelected(null)} style={{padding:'4px 8px', fontSize:'11px', borderRadius:'6px', border:'1px solid #E2E8F0'}}>关闭</button>
            </HStack>
          </Flex>
          <Text fontSize="10px" color="#718096" mt="4px">无信号 ≠ 不活跃（对方关了"最后在线"隐私就看不到）。checker 列 -1 表示命中缓存未实际查询。</Text>
          <Box maxH="300px" overflowY="auto" mt="8px" fontSize="11px">
            <table style={{width:'100%', borderCollapse:'collapse'}}>
              <thead><tr style={{background:'#F7FAFC'}}><th style={{padding:'6px', textAlign:'left'}}>号码</th><th>状态</th><th>最后在线</th><th>checker</th><th>错误</th></tr></thead>
              <tbody>
                {selected.results.filter((r:any)=>{
                  if (presenceFilter==='all') return true;
                  if (presenceFilter==='signal') return r.status==='online'||r.status==='recent';
                  return r.status===presenceFilter;
                }).map((r:any,i:number)=>(
                  <tr key={i} style={{borderTop:'1px solid #EDF2F7'}}><td style={{padding:'6px'}}>{r.phone}</td>
                    <td style={{textAlign:'center', fontWeight:700, color: r.status==='online' ? '#01B574' : r.status==='recent' ? '#2B6CB0' : r.status==='unregistered' ? '#A0AEC0' : r.status==='error' ? '#E53E3E' : '#718096'}}>
                      {r.status==='online' ? '在线' : r.status==='recent' ? '近期活跃' : r.status==='hidden' ? '无信号' : r.status==='unregistered' ? '未开通' : '异常'}</td>
                    <td style={{textAlign:'center', fontSize:'10px'}}>{r.last_seen ? new Date(r.last_seen*1000).toLocaleString() : '-'}</td>
                    <td style={{textAlign:'center'}}>{r.checker_id ?? ''}</td>
                    <td style={{fontSize:'10px', color:'#718096'}}>{r.error || ''}</td></tr>
                ))}
              </tbody>
            </table>
          </Box>
        </Box>
      ) : (
        <Box bg="white" border="1px solid #E2E8F0" borderRadius="12px" p="14px">
          <Flex justify="space-between" align="center" wrap="wrap" gap="8px">
            <Text fontWeight="700" fontSize="13px">🔵 结果 · {selected.task.id.slice(0,8)} {selected.task.name}</Text>
            <HStack spacing="6px">
              {([['all','全部'],['valid','有效'],['invalid','无效']] as const).map(([k,label])=>(
                <button key={k} onClick={()=>setResultFilter(k)}
                  style={{padding:'4px 10px', fontSize:'11px', borderRadius:'6px',
                    background: resultFilter===k ? '#7551FF' : 'white', color: resultFilter===k ? 'white' : '#4A5568',
                    border:'1px solid '+(resultFilter===k ? '#7551FF' : '#E2E8F0')}}>{label}</button>
              ))}
              <button onClick={()=>doExport(selected.task.id, resultFilter==='valid')} style={{padding:'4px 10px', fontSize:'11px', borderRadius:'6px', border:'1px solid #01B574', color:'#01B574', background:'white'}}>导出当前筛选</button>
              <button onClick={()=>setSelected(null)} style={{padding:'4px 8px', fontSize:'11px', borderRadius:'6px', border:'1px solid #E2E8F0'}}>关闭</button>
            </HStack>
          </Flex>
          <HStack mt="8px" spacing="6px">
            <Text fontSize="11px" color="#718096">关键词</Text>
            <Input value={kw} onChange={(e)=>setKw(e.target.value)} placeholder="搜号码/签名/昵称" size="xs" width="220px" />
            {kw && <button onClick={()=>setKw('')} style={{padding:'4px 8px', fontSize:'11px', borderRadius:'6px', border:'1px solid #E2E8F0'}}>清空</button>}
          </HStack>
          <Box maxH="300px" overflowY="auto" mt="8px" fontSize="11px">
            <table style={{width:'100%', borderCollapse:'collapse'}}>
              <thead><tr style={{background:'#F7FAFC'}}><th style={{padding:'6px', textAlign:'left'}}>号码</th><th>开通</th><th>头像</th><th style={{textAlign:'left'}}>签名</th><th style={{textAlign:'left'}}>昵称</th><th>错误</th></tr></thead>
              <tbody>
                {selected.results.filter((r:any)=>{
                  if (!(resultFilter==='all' ? true : resultFilter==='valid' ? r.exists_flag : !r.exists_flag)) return false;
                  if (!kw.trim()) return true;
                  const k = kw.trim().toLowerCase();
                  return String(r.phone||'').includes(k) || String(r.status_msg||'').toLowerCase().includes(k) || String(r.pushname||'').toLowerCase().includes(k);
                }).map((r:any,i:number)=>(
                  <tr key={i} style={{borderTop:'1px solid #EDF2F7'}}><td style={{padding:'6px'}}>{r.phone}</td><td style={{textAlign:'center'}}>{r.exists_flag ? '是' : '否'}</td><td style={{textAlign:'center'}}>{r.has_avatar ? '是' : '否'}</td><td style={{fontSize:'10px', maxWidth:'180px', overflow:'hidden', textOverflow:'ellipsis'}}>{r.status_msg || ''}</td><td style={{fontSize:'10px', maxWidth:'120px', overflow:'hidden', textOverflow:'ellipsis'}}>{r.pushname || ''}</td><td style={{fontSize:'10px', color:'#718096'}}>{r.error || (r.avatar_url ? '有头像' : '')}</td></tr>
                ))}
              </tbody>
            </table>
          </Box>
        </Box>
      ))}
    </VStack>
  );
}
