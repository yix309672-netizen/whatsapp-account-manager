const http = require('http');
const { WebSocketServer } = require('ws');
const { randomBytes } = require('crypto');

const PORT = Number(process.env.PORT || 8890);
const HOST = process.env.HOST || '0.0.0.0';

// 每个接入码对应一台管理器。网页绑定到接入码后，指令转发给管理器。
// rooms: code -> { manager: ws|null, clients: Set<ws> }
const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { manager: null, clients: new Set() };
    rooms.set(code, room);
  }
  return room;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcastToClients(room, obj) {
  for (const client of room.clients) {
    send(client, obj);
  }
}

function heartbeat() {
  this.isAlive = true;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, name: 'waam-relay', online: rooms.size }));
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  ws.room = null;
  ws.role = null;

  // 注入客户端来源信息（本地联调时无真实 IP/地区，可为空或取 X-Forwarded-For）
  ws.clientInfo = {
    ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket.remoteAddress || '',
    country: (req.headers['cf-ipcountry'] || '').toString() || '',
    ua: (req.headers['user-agent'] || '').toString() || ''
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', error: 'invalid json' });
    }

    switch (msg.type) {
      case 'register': {
        // 管理器注册
        if (!msg.code || typeof msg.code !== 'string' || msg.code.length < 6) {
          return send(ws, { type: 'registered', ok: false, error: 'code 格式无效' });
        }
        if (ws.room) ws.room.manager = null;
        const room = getRoom(msg.code);
        room.manager = ws;
        ws.room = room;
        ws.role = 'manager';
        send(ws, { type: 'registered', ok: true, code: msg.code });
        broadcastToClients(room, { type: 'manager_status', online: true });
        break;
      }

      case 'bind': {
        // 网页绑定管理器
        if (!msg.code || typeof msg.code !== 'string') {
          return send(ws, { type: 'bound', ok: false, error: '缺少 code' });
        }
        const room = getRoom(msg.code);
        room.clients.add(ws);
        ws.room = room;
        ws.role = 'client';
        if (typeof msg.clientId === 'string' && msg.clientId) {
          ws.clientId = msg.clientId;
        } else {
          ws.clientId = ws.clientId || `${ws._socket.remotePort}`;
        }
        send(ws, {
          type: 'bound',
          ok: true,
          code: msg.code,
          online: !!room.manager,
          clientId: ws.clientId
        });
        break;
      }

      case 'cmd': {
        // 网页 -> 管理器
        if (ws.role !== 'client' || !ws.room) {
          return send(ws, { type: 'result', id: msg.id, ok: false, error: '未绑定' });
        }
        const { manager } = ws.room;
        if (!manager) {
          return send(ws, { type: 'result', id: msg.id, ok: false, error: '管理器离线' });
        }
        send(manager, {
          type: 'cmd',
          id: msg.id,
          method: msg.method,
          params: msg.params || {},
          clientId: ws.clientId,
          clientInfo: ws.clientInfo,
          ...(typeof msg.employeeToken === 'string' && msg.employeeToken
            ? { employeeToken: msg.employeeToken }
            : {})
        });
        break;
      }

      case 'result':
      case 'event': {
        // 管理器 -> 网页；带 target 时只发给目标 clientId，否则广播
        if (ws.role === 'manager' && ws.room) {
          const target = typeof msg.target === 'string' ? msg.target : null;
          if (target) {
            for (const client of ws.room.clients) {
              if (client.clientId === target) send(client, msg);
            }
          } else {
            broadcastToClients(ws.room, msg);
          }
        }
        break;
      }

      case 'ping':
        send(ws, { type: 'pong', t: Date.now() });
        break;

      default:
        send(ws, { type: 'error', error: 'unknown type: ' + msg.type });
    }
  });

  ws.on('close', () => {
    if (ws.room) {
      if (ws.role === 'manager') {
        ws.room.manager = null;
        broadcastToClients(ws.room, { type: 'manager_status', online: false });
      } else {
        ws.room.clients.delete(ws);
      }
    }
  });

  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`[waam-relay] listening on ws://${HOST}:${PORT}/ws (pid ${process.pid})`);
});

process.on('SIGINT', () => {
  console.log('[waam-relay] shutting down');
  process.exit(0);
});