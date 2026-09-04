import { useState } from 'react';
import { Box, Text, VStack, HStack, Input } from '@chakra-ui/react';

export function LeafPanel(): React.JSX.Element {
  const [prefix, setPrefix] = useState('86');
  const [start, setStart] = useState('13800000000');
  const [count, setCount] = useState('100');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const go = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await (window.api as any).invoke('leaf:gen_task', {
        prefix: prefix.trim(), start: Number(start), count: Number(count),
      });
      setMsg(`搞定：生成 ${r.count} 个号码，筛号任务 ${String(r.taskId).slice(0, 8)} 已建好，去「筛号」页点开始就行`);
    } catch (e: any) { setMsg('失败：' + (e.message || String(e))); }
    finally { setBusy(false); }
  };

  return (
    <VStack align="stretch" spacing="12px">
      <Box>
        <Text fontSize="13px" fontWeight="700">填三个数，点一下就行</Text>
      </Box>
      <HStack spacing="8px" wrap="wrap" align="center">
        <VStack align="start" spacing="2px">
          <Text fontSize="11px" color="#718096">区号（86=大陆，886=台湾，1=美国）</Text>
          <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} width="110px" />
        </VStack>
        <VStack align="start" spacing="2px">
          <Text fontSize="11px" color="#718096">从几开始</Text>
          <Input value={start} onChange={(e) => setStart(e.target.value)} width="170px" />
        </VStack>
        <VStack align="start" spacing="2px">
          <Text fontSize="11px" color="#718096">要几个（最多5000）</Text>
          <Input value={count} onChange={(e) => setCount(e.target.value)} width="110px" type="number" />
        </VStack>
        <button
          onClick={go} disabled={busy}
          style={{ padding: '9px 20px', fontSize: '13px', borderRadius: '10px', background: '#7551FF', color: 'white', fontWeight: 700, marginTop: '18px', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? '生成中…' : '生成并创建筛号任务'}
        </button>
      </HStack>
      {msg && (
        <Box bg={msg.startsWith('搞定') ? '#F0FFF4' : '#FFF5F5'} border="1px solid" borderColor={msg.startsWith('搞定') ? '#C6F6D5' : '#FEB2B2'} borderRadius="8px" p="10px">
          <Text fontSize="12px" color={msg.startsWith('搞定') ? '#276749' : '#C53030'}>{msg}</Text>
        </Box>
      )}
      <Text fontSize="11px" color="#A0AEC0">例子：区号填 86，从 13800000000 开始，要 100 个 → 生成 8613800000000～8613800000099，自动建成筛号任务。</Text>
    </VStack>
  );
}
