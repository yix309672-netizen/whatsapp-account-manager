const WebSocket = require('ws');
const URL = 'wss://waam-relay.yix309672.workers.dev/ws?code=RAMSG5LDRX5Z';
const ws = new WebSocket(URL);
ws.on('open', () => ws.send(JSON.stringify({ type: 'bind', code: 'RAMSG5LDRX5Z' })));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'bound') ws.send(JSON.stringify({ type: 'cmd', id: 'l1', method: 'account:list', params: {} }));
  if (msg.type === 'result' && msg.id === 'l1') {
    console.log('count:', (msg.data||[]).length);
    for (const a of (msg.data||[])) console.log(`${a.status} | has_session=${a.has_session} | ${a.name}`);
    process.exit(0);
  }
});
ws.on('error', (e) => { console.log('WSERR', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 25000);