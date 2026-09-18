import { useState } from 'react';
import { Box, Flex, Text, HStack, VStack, Badge, IconButton } from '@chakra-ui/react';
import { useAccountStore } from '../store/accountStore';
import { Account } from '../types';
import { formatPhone } from '../utils/formatPhone';

interface AccountCardProps {
  account: Account;
  index: number;
}

const statusColor: Record<string, { bg: string; color: string; label: string }> = {
  online: { bg: '#01B574', color: 'white', label: '在线' },
  ready: { bg: '#01B574', color: 'white', label: '在线' },
  offline: { bg: '#E2E8F0', color: '#707EAE', label: '离线' },
  qr_pending: { bg: '#FFB547', color: 'white', label: '等待扫码' },
  failed: { bg: '#FEB2B2', color: '#C53030', label: '失败' },
  authenticated: { bg: '#01B574', color: 'white', label: '已认证' },
};

export function AccountCard({ account, index }: AccountCardProps): React.JSX.Element {
  const { removeAccount, loadAccounts } = useAccountStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isOnline = account.status === 'online' || account.status === 'ready';
  const phoneDisplay = formatPhone(account.phone || account.name || '');
  const st = statusColor[account.status] || { bg: '#E2E8F0', color: '#707EAE', label: account.status };

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      bg="white"
      borderRadius="20px"
      border="1px solid"
      borderColor="#E2E8F0"
      boxShadow="0 3.5px 5.5px rgba(0,0,0,0.04)"
      p="18px"
      h="168px"
      display="flex"
      flexDirection="column"
      justifyContent="space-between"
      _hover={{ transform: 'translateY(-2px)', boxShadow: '0 10px 20px rgba(0,0,0,0.06)' }}
      transition="all 0.2s"
    >
      {/* Top */}
      <Flex justify="space-between" align="flex-start" gap="12px">
        <VStack align="start" spacing="8px" flex="1" minW={0}>
          <HStack spacing="8px">
            <Text fontSize="11px" fontWeight="700" color="#A0AEC0">ID {index + 1}</Text>
            <Badge bg={st.bg} color={st.color} px="8px" py="3px" borderRadius="8px" fontSize="10px" fontWeight="700">{st.label}</Badge>
          </HStack>
          <Text
            fontSize="16px"
            fontWeight="800"
            color="#2B3674"
            noOfLines={1}
            title={phoneDisplay}
            fontFamily="monospace"
          >
            {phoneDisplay}
          </Text>
          <Text fontSize="11px" color="#A0AEC0" noOfLines={1} title={account.remark || ''}>
            {account.remark || '— 无备注 —'}
          </Text>
          <Text fontSize="10px" color="#A0AEC0">
            验证：{account.created_at ? new Date(account.created_at * 1000).toLocaleString() : '—'}
            {account.assigned_to ? ` · 已分配` : ''}
          </Text>
        </VStack>
        <Text fontSize="9px" color="#CBD5E0" fontWeight="700" letterSpacing="1px" flexShrink={0}>
          CH:{index + 1} · {isOnline ? 'ACTIVE' : 'IDLE'}
        </Text>
      </Flex>

      <Box borderTop="1px solid" borderColor="#F1F4F9" />

      {/* Actions */}
      <Box>
        {error && (
          <Text fontSize="11px" color="#E53E3E" noOfLines={1} mb="8px" title={error}>
            ⚠ {error}
          </Text>
        )}
        <HStack spacing="8px" justify="stretch">
          <button
            onClick={() => run(() => window.api.accounts.login(account.id))}
            disabled={isOnline || busy}
            style={{
              flex: 1, padding: '9px 0', fontSize: '12px', fontWeight: '700', borderRadius: '12px',
              background: isOnline ? '#E2E8F0' : '#7551FF', color: isOnline ? '#707EAE' : 'white',
              border: '1px solid transparent', cursor: isOnline || busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            登录
          </button>
          <button
            onClick={() => run(() => window.api.accounts.logout(account.id))}
            disabled={!isOnline || busy}
            style={{
              flex: 1, padding: '9px 0', fontSize: '12px', fontWeight: '700', borderRadius: '12px',
              background: 'white', color: '#707EAE', border: '1px solid #E2E8F0',
              cursor: !isOnline || busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            退出
          </button>
          {account.assigned_to && (
            <button
              onClick={async () => {
                if (!window.confirm(`把「${phoneDisplay}」收回管理器？（员工将不再看到该账号）`)) return;
                setBusy(true); setError('');
                try {
                  await window.api.employees.unassign(account.id);
                  await loadAccounts();
                } catch (e: unknown) {
                  setError((e as Error).message || String(e));
                } finally { setBusy(false); }
              }}
              disabled={busy}
              style={{
                flex: 1, padding: '9px 0', fontSize: '12px', fontWeight: '700', borderRadius: '12px',
                background: '#FFFBEA', color: '#B7791F', border: '1px solid #F6E05E',
                cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
              }}
            >
              收回
            </button>
          )}
          <button
            onClick={() => {
              if (window.confirm(`确定删除账号「${phoneDisplay}」？此操作不可恢复。`)) {
                // 必须走 run() 包一层：直接 removeAccount() 不 await 也不 catch，
                // 删除失败时用户看不到任何反馈，还会留下未处理的 promise rejection。
                void run(() => removeAccount(account.id));
              }
            }}
            style={{
              flex: 1, padding: '9px 0', fontSize: '12px', fontWeight: '700', borderRadius: '12px',
              background: 'white', color: '#E53E3E', border: '1px solid #FEB2B2', cursor: 'pointer',
            }}
          >
            删除
          </button>
        </HStack>
      </Box>
    </Box>
  );
}
