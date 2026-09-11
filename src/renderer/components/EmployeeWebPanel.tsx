import { useEffect, useState } from 'react';
import { Box, Text, Flex, VStack, HStack, Spinner } from '@chakra-ui/react';
import { logoutAdmin } from '../webApi';

type MineRow = { id: string; name?: string; phone?: string; status?: string; has_session?: boolean };

export function EmployeeWebPanel(): React.JSX.Element {
  const [accounts, setAccounts] = useState<MineRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [msg, setMsg] = useState('');
  const [me, setMe] = useState('');

  const inv = (m: string, p: any) => (window.api as any).invoke(m, p);

  const refresh = async () => {
    setLoading(true);
    try {
      const rows = await inv('employee:list_mine', {});
      setAccounts(Array.isArray(rows) ? rows : []);
      try {
        const st = await inv('employee:my_status', {});
        const u = (st && (st.username || st.name)) || '';
        if (u) setMe(String(u));
      } catch {}
    } catch (e: any) {
      setMsg('加载失败：' + (e.message || String(e)));
    } finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);

  const loginAccount = async (id: string) => {
    setBusyId(id); setMsg('');
    try {
      await inv('account:login', { accountId: id });
      setMsg('已发起登录，等待上线…');
      setTimeout(refresh, 4000);
    } catch (e: any) { setMsg('登录失败：' + (e.message || String(e))); }
    finally { setBusyId(''); }
  };
  const logoutAccount = async (id: string) => {
    setBusyId(id); setMsg('');
    try {
      await inv('account:logout', { accountId: id });
      refresh();
    } catch (e: any) { setMsg('退出失败：' + (e.message || String(e))); }
    finally { setBusyId(''); }
  };
  const exit = () => { logoutAdmin(); location.reload(); };

  const online = (a: MineRow) => ['online', 'ready'].includes(String(a.status));

  return (
    <Box minH="100vh" bg="#eef2f6" p="16px">
      <Flex maxW="720px" mx="auto" direction="column" gap="12px">
        <Flex bg="white" borderRadius="16px" p="16px" align="center" justify="space-between" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)">
          <Box>
            <Text fontSize="18px" fontWeight="800" color="#2B3674">我的账号{me ? ` · ${me}` : ''}</Text>
            <Text fontSize="11px" color="#A0AEC0" mt="4px">仅显示分配给你的账号 · 会话跑在管理端</Text>
          </Box>
          <HStack spacing="6px">
            <button onClick={refresh} style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '10px', border: '1px solid #7551FF', color: '#7551FF', background: 'white', fontWeight: 700 }}>
              {loading ? '...' : '刷新'}</button>
            <button onClick={exit} style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '10px', border: '1px solid #E2E8F0', background: 'white', color: '#707EAE' }}>
              退出登录</button>
          </HStack>
        </Flex>
        {msg && <Box bg="#FFFBEA" border="1px solid #F6E05E" borderRadius="10px" p="10px"><Text fontSize="12px" color="#744210">{msg}</Text></Box>}
        {loading && accounts.length === 0 ? (
          <Flex justify="center" py="60px"><Spinner color="#7551FF" /></Flex>
        ) : accounts.length === 0 ? (
          <Box bg="white" borderRadius="16px" p="40px" textAlign="center"><Text fontSize="13px" color="#A0AEC0">暂无分配给你的账号，请联系管理员</Text></Box>
        ) : (
          <VStack align="stretch" spacing="10px">
            {accounts.map((a) => (
              <Flex key={a.id} bg="white" borderRadius="14px" p="14px" align="center" justify="space-between" wrap="wrap" gap="8px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)">
                <Box>
                  <HStack spacing="8px">
                    <Box w="10px" h="10px" borderRadius="full" bg={online(a) ? '#01B574' : '#E53E3E'} />
                    <Text fontSize="14px" fontWeight="700" color="#2D3748">{a.name || a.phone || a.id.slice(0, 8)}</Text>
                  </HStack>
                  <Text fontSize="11px" color="#718096" mt="4px">{a.phone || ''} · {online(a) ? '在线' : String(a.status || '离线')}</Text>
                </Box>
                <HStack spacing="6px">
                  {!online(a) ? (
                    <button onClick={() => loginAccount(a.id)} disabled={busyId === a.id}
                      style={{ padding: '7px 16px', fontSize: '12px', borderRadius: '10px', background: '#7551FF', color: 'white', fontWeight: 700, opacity: busyId === a.id ? 0.6 : 1 }}>
                      {busyId === a.id ? '...' : '登录'}</button>
                  ) : (
                    <button onClick={() => logoutAccount(a.id)} disabled={busyId === a.id}
                      style={{ padding: '7px 16px', fontSize: '12px', borderRadius: '10px', background: 'white', color: '#707EAE', border: '1px solid #E2E8F0', opacity: busyId === a.id ? 0.6 : 1 }}>
                      退出</button>
                  )}
                </HStack>
              </Flex>
            ))}
          </VStack>
        )}
      </Flex>
    </Box>
  );
}
