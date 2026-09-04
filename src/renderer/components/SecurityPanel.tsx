import { useEffect, useState } from 'react';
import { Box, Text, Flex, HStack, Textarea, Spinner } from '@chakra-ui/react';

type Scope = 'admin' | 'employee';

function AllowCard({ scope, title, desc }: { scope: Scope; title: string; desc: string }): React.JSX.Element {
  const [text, setText] = useState('');
  const [source, setSource] = useState('db');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const r = await (window.api as any).invoke('security:ip_allowlist', { scope });
      setText(((r?.list as string[]) || []).join('\n'));
      setSource(String(r?.source || 'db'));
      setMsg('');
    } catch (e: any) { setMsg('读取失败: ' + (e.message || String(e))); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      const list = text.split(/[\r\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
      const r = await (window.api as any).invoke('security:ip_allowlist_set', { scope, list });
      setText(((r?.list as string[]) || []).join('\n'));
      setMsg(`已保存 ${((r?.list as string[]) || []).length} 条（空=不限制）`);
      setTimeout(() => setMsg(''), 2500);
    } catch (e: any) { setMsg('保存失败: ' + (e.message || String(e))); }
    finally { setSaving(false); }
  };

  return (
    <Box flex="1" minW="260px" bg="#F8FAFC" border="1px solid #E2E8F0" borderRadius="12px" p="14px">
      <Text fontWeight="700" fontSize="13px">{title}</Text>
      <Text fontSize="11px" color="#718096" mt="2px">{desc}</Text>
      {source === 'env' && <Text fontSize="11px" color="#B7791F" mt="4px">⚠ 当前由环境变量接管，此处只读（改环境变量后重启生效）。</Text>}
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} mt="8px" fontSize="12px"
        placeholder={'每行一个，例如：\n203.0.113.8\n198.51.100.0/24'} />
      <HStack mt="8px" justify="space-between">
        <Text fontSize="11px" color="#A0AEC0">空=不限制 · 本机回环永远放行</Text>
        <button onClick={save} disabled={saving || source === 'env'}
          style={{ padding: '6px 14px', fontSize: '11px', borderRadius: '8px', background: '#7551FF', color: 'white', fontWeight: 700, opacity: saving || source === 'env' ? 0.5 : 1 }}>
          {saving ? '保存中…' : '保存'}</button>
      </HStack>
      {msg && <Text fontSize="11px" color={msg.startsWith('保存失败') || msg.startsWith('读取失败') ? '#E53E3E' : '#01B574'} mt="6px">{msg}</Text>}
    </Box>
  );
}

export function SecurityPanel(): React.JSX.Element {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const loadLogs = async () => {
    setLoading(true);
    try {
      const r = await (window.api as any).invoke('security:audit_logs', { limit: 100 });
      setLogs(Array.isArray(r) ? r : []);
    } catch { setLogs([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { loadLogs(); }, []);

  return (
    <Box>
      <Text fontWeight="700" fontSize="13px" mb="8px">登录 IP 白名单</Text>
      <Flex gap="16px" wrap="wrap">
        <AllowCard scope="admin" title="管理端（guanli）" desc="卡登录 / 验证码 / 改密码 / WS。验证 H5 公开接口不受影响。" />
        <AllowCard scope="employee" title="员工端" desc="卡员工账号登录（中转/直连均按真实 IP 判定）。" />
      </Flex>
      <Flex justify="space-between" align="center" mt="16px" mb="8px">
        <Text fontWeight="700" fontSize="13px">审计日志（近100条，含 IP 拦截记录）</Text>
        <button onClick={loadLogs} style={{ padding: '5px 10px', fontSize: '11px', borderRadius: '8px', border: '1px solid #7551FF', color: '#7551FF', background: 'white' }}>
          {loading ? '...' : '刷新'}</button>
      </Flex>
      {loading ? <Spinner size="sm" color="#7551FF" /> : logs.length === 0 ? (
        <Text fontSize="12px" color="#A0AEC0">暂无记录</Text>
      ) : (
        <Box maxH="320px" overflowY="auto" fontSize="11px" border="1px solid #EDF2F7" borderRadius="8px">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: '#F7FAFC' }}>
              <th style={{ padding: '6px', textAlign: 'left' }}>时间</th><th style={{ textAlign: 'left' }}>事件</th>
              <th style={{ textAlign: 'left' }}>详情</th><th>IP</th><th>结果</th>
            </tr></thead>
            <tbody>
              {logs.map((l: any, i: number) => (
                <tr key={i} style={{ borderTop: '1px solid #EDF2F7' }}>
                  <td style={{ padding: '6px', whiteSpace: 'nowrap' }}>{l.timestamp ? new Date(Number(l.timestamp) > 1e12 ? Number(l.timestamp) : Number(l.timestamp) * 1000).toLocaleString() : '-'}</td>
                  <td>{l.event}</td>
                  <td style={{ maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.detail}</td>
                  <td style={{ textAlign: 'center' }}>{l.ip}</td>
                  <td style={{ textAlign: 'center', color: l.success ? '#01B574' : '#E53E3E' }}>{l.success ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      )}
    </Box>
  );
}
