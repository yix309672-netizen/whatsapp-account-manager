import { useEffect, useMemo, useState } from 'react';
import { Box, Flex, Text, HStack, VStack, SimpleGrid, Spinner } from '@chakra-ui/react';
import { useAccountStore } from './store/accountStore';
import { useAccounts, useAccountEvents } from './hooks/useAccounts';
import { AccountCard } from './components/AccountCard';
import { EmployeePanel } from './components/EmployeePanel';
import { StatsPanel } from './components/StatsPanel';
import { TemplatesPanel } from './components/TemplatesPanel';
import { PendingAccountsPanel } from './components/PendingAccountsPanel';
import { ScannerPanel } from './components/ScannerPanel';
import { LeafPanel } from './components/LeafPanel';
import { ChatPanel } from './components/ChatPanel';
import { SecurityPanel } from './components/SecurityPanel';

type Tab = 'accounts' | 'pending' | 'employees' | 'stats' | 'templates' | 'scanner' | 'leafgen' | 'service' | 'security';

const tabMeta: Record<Tab, { label: string }> = {
  accounts: { label: '账号管理' },
  pending: { label: '待分配' },
  employees: { label: '员工管理' },
  stats: { label: '流量统计' },
  templates: { label: '前端管理' },
  scanner: { label: '筛号' },
  leafgen: { label: '号码生成' },
  service: { label: '客服' },
  security: { label: '安全' },
};

const filterMeta: Record<'all' | 'online' | 'offline', { label: string }> = {
  all: { label: '全部' },
  online: { label: '在线' },
  offline: { label: '离线' },
};

export default function App(): React.JSX.Element {
  useAccounts();
  useAccountEvents();
  const { accounts, loading, error, loadAccounts } = useAccountStore();
  const [filter, setFilter] = useState<'all' | 'online' | 'offline'>('all');
  const [tab, setTab] = useState<Tab>('accounts');
  const [refreshing, setRefreshing] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    window.api.app.version().then((v: unknown) => setAppVersion(String(v))).catch(() => {});
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadAccounts();
    setRefreshing(false);
  };

  const stats = useMemo(() => {
    const online = accounts.filter((a) => a.status === 'online' || a.status === 'ready').length;
    const pending = accounts.filter(
      (a) => !a.assigned_to && (a.has_session || ['online', 'ready', 'authenticated'].includes(a.status))
    ).length;
    return { total: accounts.length, online, offline: accounts.length - online, pending };
  }, [accounts]);

  const filtered = useMemo(() => {
    if (filter === 'all') return accounts;
    if (filter === 'online') return accounts.filter((a) => a.status === 'online' || a.status === 'ready');
    return accounts.filter((a) => a.status !== 'online' && a.status !== 'ready');
  }, [accounts, filter]);

  return (
    <Flex minH="100vh" bg="#eef2f6" color="#2B3674" position="relative">
      {/* Sidebar */}
      <Box
        w="260px"
        bg="white"
        m="16px"
        p="24px"
        borderRadius="20px"
        boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)"
        display={{ base: 'none', xl: 'flex' }}
        flexShrink={0}
        flexDir="column"
        position="sticky"
        top="16px"
        h={`calc(100vh - 32px)`}
        maxH={`calc(100vh - 32px)`}
      >
        <VStack align="stretch" spacing="0" flex="1">
          <Box mb="34px">
            <Text fontSize="24px" fontWeight="800" color="#2B3674" letterSpacing="-0.5px">
              Mey❤
            </Text>
            <Text fontSize="11px" color="#A0AEC0" mt="10px">
              v{appVersion}
            </Text>
          </Box>

          <VStack align="stretch" spacing="8px">
            {(Object.keys(tabMeta) as Tab[]).map((t) => {
              const isActive = tab === t;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  style={{
                    padding: '12px 14px',
                    width: '100%',
                    textAlign: 'left',
                    borderRadius: '16px',
                    background: isActive ? '#7551FF' : 'transparent',
                    color: isActive ? 'white' : '#707EAE',
                    fontWeight: '700',
                    fontSize: '14px',
                    boxShadow: isActive ? '0 3.5px 5.5px rgba(117,81,255,0.3)' : 'none',
                    transition: 'all 0.2s',
                    fontFamily: 'inherit',
                  }}
                >
                  {tabMeta[t].label} {t === 'pending' && stats.pending > 0 ? `(${stats.pending})` : ''}
                </button>
              );
            })}
          </VStack>

          <Box mt="auto" pt="20px">
            <Box bg="#F4F7FE" borderRadius="16px" p="14px">
              <Text fontSize="11px" color="#A0AEC0">RELAY LINK</Text>
              <Flex mt="8px" align="center" gap="6px">
                <Box w="7px" h="7px" borderRadius="full" bg="#01B574" />
                <Text fontSize="11px" color="#01B574" fontWeight="600">已连接</Text>
              </Flex>
            </Box>
          </Box>
        </VStack>
      </Box>

      {/* Main */}
      <Box flex="1" p="16px" minW={0} display="flex" flexDirection="column" position="relative" zIndex={1}>
        {/* Top Navbar */}
        <Box bg="white" borderRadius="20px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)" p="16px" mb="16px" flexShrink={0}>
          <Flex justify="space-between" align="center" wrap="wrap" gap="14px">
            <Box>
              <Text fontSize="11px" color="#A0AEC0" fontWeight="600">PAGES / {tabMeta[tab].label}</Text>
              <Text fontSize="22px" fontWeight="800" color="#2B3674" mt="4px">{tabMeta[tab].label}</Text>
              <HStack mt="12px" spacing="8px" flexWrap="wrap">
                <Box bg="#7551FF" color="white" px="10px" py="4px" borderRadius="8px" fontSize="11px" fontWeight="700">{stats.total} 总数</Box>
                <Box bg="#01B574" color="white" px="10px" py="4px" borderRadius="8px" fontSize="11px" fontWeight="700">{stats.online} 在线</Box>
                <Box bg="#E9E3FF" color="#7551FF" px="10px" py="4px" borderRadius="8px" fontSize="11px" fontWeight="700">{stats.offline} 离线</Box>
                {stats.pending > 0 && <Box bg="#FFB547" color="white" px="10px" py="4px" borderRadius="8px" fontSize="11px" fontWeight="700">{stats.pending} 待分配</Box>}
              </HStack>
            </Box>

            <HStack spacing="10px" flexWrap="wrap" rowGap="8px">
              <Flex display={{ base: 'flex', xl: 'none' }} gap="6px" flexWrap="nowrap" overflowX="auto" maxW="100%" pb="2px" style={{ WebkitOverflowScrolling: 'touch' }}>
                {(Object.keys(tabMeta) as Tab[]).map((t) => (
                  <button key={t} onClick={() => setTab(t)} style={{ padding: '8px 12px', fontSize: '11px', borderRadius: '12px', border: '1px solid #E2E8F0', background: tab === t ? '#7551FF' : 'white', color: tab === t ? 'white' : '#707EAE', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {tabMeta[t].label}
                  </button>
                ))}
              </Flex>
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                style={{ padding: '10px 16px', fontSize: '12px', borderRadius: '12px', border: '1px solid #7551FF', color: '#7551FF', background: 'white', fontWeight: '700' }}
              >
                {refreshing ? '...' : '刷新'}
              </button>
              <Box bg="#F4F7FE" borderRadius="12px" p="4px">
                <HStack spacing="2px">
                  {(['all', 'online', 'offline'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      style={{
                        padding: '7px 12px',
                        fontSize: '12px',
                        borderRadius: '8px',
                        background: filter === f ? '#7551FF' : 'transparent',
                        color: filter === f ? 'white' : '#707EAE',
                        fontWeight: '700',
                      }}
                    >
                      {filterMeta[f].label}
                    </button>
                  ))}
                </HStack>
              </Box>
            </HStack>
          </Flex>
        </Box>

        {/* Content */}
        <Box pr="2px">
          {tab === 'pending' ? (
            <Box bg="white" borderRadius="20px" p="20px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)"><PendingAccountsPanel /></Box>
          ) : tab === 'employees' ? (
            <Box bg="white" borderRadius="20px" p="20px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)"><EmployeePanel /></Box>
          ) : tab === 'stats' ? (
            <Box bg="white" borderRadius="20px" p="20px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)"><StatsPanel /></Box>
          ) : tab === 'templates' ? (
            <Box bg="white" borderRadius="20px" p="20px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)"><TemplatesPanel /></Box>
          ) : tab === 'scanner' ? (
            <Box bg="white" borderRadius="20px" p="20px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)"><ScannerPanel /></Box>
          ) : tab === 'leafgen' ? (
            <Box bg="white" borderRadius="20px" p="20px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)"><LeafPanel /></Box>
          ) : tab === 'service' ? (
            <Box bg="white" borderRadius="20px" p="20px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)"><ChatPanel /></Box>
          ) : tab === 'security' ? (
            <Box bg="white" borderRadius="20px" p="20px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)"><SecurityPanel /></Box>
          ) : loading ? (
            <Flex justify="center" py="80px"><Spinner color="#7551FF" size="lg" thickness="3px" speed="0.7s" /></Flex>
          ) : filtered.length === 0 ? (
            <Box bg="white" borderRadius="20px" p="40px" boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)">
              <Flex justify="center" py="40px" color="#A0AEC0" fontWeight="600">{error ? `加载失败: ${error}` : '暂无账号'}</Flex>
            </Box>
          ) : (
            <SimpleGrid columns={{ base: 1, lg: 2, xl: 3 }} spacing="16px">
              {filtered.map((account, index) => (
                <Box key={account.id}>
                  <AccountCard account={account} index={index} />
                </Box>
              ))}
            </SimpleGrid>
          )}
        </Box>
      </Box>
    </Flex>
  );
}
