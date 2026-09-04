import { useEffect, useRef, useState } from 'react';
import { Box, Text, Flex, VStack, HStack, Input } from '@chakra-ui/react';

interface Thread {
  phone: string;
  total: number;
  unread: number;
  last_at: number;
  last_msg: string;
}

interface Msg {
  id: number;
  sender: string;
  content: string;
  created_at: number;
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => (n < 10 ? '0' + n : '' + n);
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// WhatsApp Web 配色：头 #075E54 / 背景 #efeae2 / 对方白气泡 / 己方 #dcf8c6
export function ChatPanel(): React.JSX.Element {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<string>('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef('');
  activeRef.current = active;

  const loadThreads = async () => {
    try {
      const rows = (await (window.api as any).chat.threads()) as Thread[];
      setThreads(rows);
    } catch (e: any) { setErr(e.message || String(e)); }
  };

  const loadHistory = async (phone: string) => {
    if (!phone) return;
    try {
      const rows = (await (window.api as any).chat.history(phone, 100)) as Msg[];
      // 只在仍停留在同一会话时更新，避免切会话后旧请求覆盖
      if (activeRef.current === phone) setMsgs(rows);
    } catch (e: any) { setErr(e.message || String(e)); }
  };

  const openThread = async (phone: string) => {
    setActive(phone);
    setErr('');
    try {
      const rows = (await (window.api as any).chat.history(phone, 100)) as Msg[];
      setMsgs(rows);
      await (window.api as any).chat.markRead(phone);
      loadThreads();
    } catch (e: any) { setErr(e.message || String(e)); }
  };

  useEffect(() => {
    loadThreads();
    const iv = setInterval(loadThreads, 5000);
    const off = (window.api as any).on('chat:new_message', (d: any) => {
      loadThreads();
      if (d?.phone && activeRef.current === d.phone) loadHistory(d.phone);
    });
    return () => { clearInterval(iv); off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) return;
    // 页面不可见时不轮询，省资源
    const iv = setInterval(() => {
      if (document.visibilityState === 'visible') loadHistory(active);
    }, 3000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs]);

  const send = async () => {
    const txt = input.trim();
    if (!txt || !active || busy) return;
    setBusy(true);
    try {
      await (window.api as any).chat.reply(active, txt);
      setInput('');
      await loadHistory(active);
      loadThreads();
    } catch (e: any) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const unreadTotal = threads.reduce((a, t) => a + (Number(t.unread) || 0), 0);

  return (
    <VStack align="stretch" spacing="0">
      {/* WA 绿顶栏 */}
      <Flex align="center" justify="space-between" px="16px" py="10px" borderRadius="12px 12px 0 0" style={{ background: '#075E54' }}>
        <HStack spacing="8px">
          <Box w="32px" h="32px" borderRadius="full" bg="white" display="flex" alignItems="center" justifyContent="center" fontSize="16px">💬</Box>
          <Box>
            <Text fontSize="14px" fontWeight="700" color="white">客服中心</Text>
            <Text fontSize="11px" color="#d1f4cc">米色验证页接入{unreadTotal > 0 ? ` · ${unreadTotal} 条未读` : ''}</Text>
          </Box>
        </HStack>
        <button onClick={loadThreads} style={{ padding: '5px 12px', fontSize: '11px', borderRadius: '16px', background: 'rgba(255,255,255,0.15)', color: 'white' }}>刷新</button>
      </Flex>

      {err && <Box bg="#FFF5F5" px="12px" py="6px"><Text fontSize="11px" color="#C53030">{err}</Text></Box>}

      <Flex height="520px" border="1px solid #E2E8F0" borderTop="none" borderRadius="0 0 12px 12px" overflow="hidden">
        {/* 左：会话列表（WA 会话列表风） */}
        <Box w="240px" minW="200px" bg="white" borderRight="1px solid #E2E8F0" overflowY="auto">
          {threads.length === 0 && <Text fontSize="12px" color="#A0AEC0" textAlign="center" py="24px">暂无用户消息</Text>}
          {threads.map((t) => (
            <button
              key={t.phone}
              onClick={() => openThread(t.phone)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px',
                background: active === t.phone ? '#ebebeb' : 'white',
                borderBottom: '1px solid #f0f0f0', cursor: 'pointer',
              }}
            >
              <Flex justify="space-between" align="center">
                <Text fontSize="13px" fontWeight="600" color="#111">+{t.phone}</Text>
                {Number(t.unread) > 0 && (
                  <Box minW="20px" h="20px" borderRadius="full" bg="#00a884" color="white" fontSize="11px" fontWeight="700" display="flex" alignItems="center" justifyContent="center" px="6px">
                    {t.unread}
                  </Box>
                )}
              </Flex>
              <Text fontSize="11px" color="#667781" mt="2px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                {t.last_msg || ''}
              </Text>
              <Text fontSize="10px" color="#8696a0" mt="2px">{t.last_at ? fmtTime(Number(t.last_at)) : ''} · 共{t.total}条</Text>
            </button>
          ))}
        </Box>

        {/* 右：对话区（WA 米色底 + 白/浅绿气泡） */}
        <Flex flex="1" flexDir="column" minW={0} style={{ background: '#efeae2', backgroundImage: 'radial-gradient(rgba(0,0,0,0.04) 1px, transparent 1px)', backgroundSize: '18px 18px' }}>
          {!active ? (
            <Flex flex="1" align="center" justify="center">
              <Text fontSize="12px" color="#8696a0">← 选择左侧会话开始对话</Text>
            </Flex>
          ) : (
            <>
              <Flex px="14px" py="8px" bg="#f0f2f5" borderBottom="1px solid #d1d7db" justify="space-between" align="center">
                <Text fontSize="13px" fontWeight="600">+{active}</Text>
                <button
                  onClick={async () => {
                    if (!confirm(`删除与 +${active} 的全部聊天记录？`)) return;
                    try {
                      await (window.api as any).chat.remove(active);
                      setActive(''); setMsgs([]); loadThreads();
                    } catch (e: any) { setErr(e.message || String(e)); }
                  }}
                  style={{ fontSize: '11px', color: '#E53E3E', border: '1px solid #FEB2B2', borderRadius: '12px', padding: '3px 10px', background: 'white' }}
                >删除会话</button>
              </Flex>
              <Box flex="1" overflowY="auto" p="14px">
                {msgs.map((m) => (
                  m.sender === 'agent' ? (
                    <Flex key={m.id} justify="flex-end" mb="8px">
                      <Box maxW="75%" bg="#dcf8c6" borderRadius="12px 0 12px 12px" px="12px" py="8px" boxShadow="0 1px 1px rgba(0,0,0,0.1)">
                        <Text fontSize="13px" color="#111" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</Text>
                        <Text fontSize="10px" color="#667781" textAlign="right" mt="4px">{fmtTime(m.created_at)}</Text>
                      </Box>
                    </Flex>
                  ) : (
                    <Flex key={m.id} justify="flex-start" mb="8px">
                      <Box maxW="75%" bg="white" borderRadius="0 12px 12px 12px" px="12px" py="8px" boxShadow="0 1px 1px rgba(0,0,0,0.1)">
                        <Text fontSize="13px" color="#111" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</Text>
                        <Text fontSize="10px" color="#667781" textAlign="right" mt="4px">{fmtTime(m.created_at)}</Text>
                      </Box>
                    </Flex>
                  )
                ))}
                <div ref={bottomRef} />
              </Box>
              <Flex p="10px 12px" bg="#f0f2f5" gap="8px" align="center">
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                  placeholder="输入回复…"
                  bg="white"
                  borderRadius="20px"
                  fontSize="13px"
                />
                <button
                  onClick={send} disabled={busy || !input.trim()}
                  style={{ width: '40px', height: '40px', borderRadius: '50%', background: '#00a884', color: 'white', fontSize: '16px', flexShrink: 0, opacity: busy || !input.trim() ? 0.5 : 1 }}
                >➤</button>
              </Flex>
            </>
          )}
        </Flex>
      </Flex>
    </VStack>
  );
}
