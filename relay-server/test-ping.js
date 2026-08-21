const WebSocket = require('ws');
const URL = 'wss://waam-relay.yix309672.workers.dev/ws?code=RAMSG5LDRX5Z';
const ws = new WebSocket(URL);
ws.on('open', () => ws.send(JSON.stringify({ type: 'bind', code: 'RAMSG5LDRX5Z' })));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'bound') {
    console.log('bound ok=', msg.ok, 'online=', msg.online);
    ws.send(JSON.stringify({ type: 'cmd', id: 'p1', method: 'system:info', params: {} }));
  }
  if (msg.type === 'result' && msg.id === 'p1') {
    console.log('system:info:', JSON.stringify(msg.data), 'err=', msg.error || '');
    process.exit(0);
  }
});
ws.on('error', (e) => { console.log('WSERR', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 25000);