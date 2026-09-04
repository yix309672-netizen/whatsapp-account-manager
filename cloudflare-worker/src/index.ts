// WAAM WebSocket 中转服务器（Cloudflare Worker + Durable Object）
//
// 协议（与 relay-server/server.js 保持一致）：
// - 管理器连接:  wss://xxx.workers.dev/ws?code=<接入码>
//   打开后发送 { type: 'register', code } 注册为 manager
// - 网页连接:    wss://xxx.workers.dev/ws?code=<接入码>
//   打开后发送 { type: 'bind', code } 绑定为 client
// - 网页 -> 管理器: { type: 'cmd', id, method, params }
// - 管理器 -> 网页: { type: 'result', id, ok, data|error }
// - 管理器 -> 网页: { type: 'event', event, data }

interface Env {
  ROOM: DurableObjectNamespace;
}

interface RoomConnection {
  ws: WebSocket;
  role: 'manager' | 'client';
  id: string;
  clientId?: string;
  ip?: string;
  country?: string;
  ua?: string;
}

// 每个接入码对应一个 Durable Object 实例（Room），使用 WebSocket Hibernation API
export class Room {
  private connections = new Map<string, RoomConnection>();
  private managerId: string | null = null;
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = (url.searchParams.get('code') || '').toUpperCase();

    if (!code) {
      return new Response(JSON.stringify({ ok: false, error: '缺少 code 参数' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return new Response(
        JSON.stringify({ ok: true, name: 'waam-relay', room: code, online: this.managerId !== null }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const connId = crypto.randomUUID();

    server.accept();

    const ip = request.headers.get('CF-Connecting-IP') || '';
    const country = request.headers.get('cf-ipcountry') || '';
    const ua = request.headers.get('User-Agent') || '';

    this.connections.set(connId, { ws: server, role: 'client', id: connId, ip, country, ua });

    server.addEventListener('message', (event) => {
      this.onMessage(connId, event.data as string);
    });
    server.addEventListener('close', () => {
      this.onClose(connId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // 消息/关闭处理在 addEventListener 中完成（非 Hibernation 模式）

  private findConnId(ws: WebSocket): string | null {
    for (const [id, conn] of this.connections) {
      if (conn.ws === ws) return id;
    }
    return null;
  }

  private onMessage(connId: string, raw: string | ArrayBuffer): void {
    const conn = this.connections.get(connId);
    if (!conn) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    switch (msg.type) {
      // 应用层心跳：防止 NAT/边缘静默丢弃导致半开连接（管理端以为在线、中转已忘掉）
      case 'ping': {
        this.send(connId, { type: 'pong', t: typeof msg.t === 'number' ? msg.t : null });
        break;
      }
      case 'pong': {
        break;
      }
      case 'register': {
        // 管理器注册：同一房间只保留一个 manager，新的替换旧的
        if (this.managerId && this.managerId !== connId) {
          const old = this.connections.get(this.managerId);
          if (old) {
            this.connections.delete(this.managerId);
            try {
              old.ws.close();
            } catch {
              // ignore
            }
          }
        }
        conn.role = 'manager';
        this.managerId = connId;
        this.send(connId, { type: 'registered', ok: true, code: msg.code });
        this.broadcastToClients({ type: 'manager_status', online: true });
        break;
      }

      case 'bind': {
        conn.role = 'client';
        // 客户端可携带唯一 clientId 用于事件定向投递
        if (typeof msg.clientId === 'string' && msg.clientId) {
          conn.clientId = msg.clientId;
        } else if (!conn.clientId) {
          conn.clientId = connId;
        }
        this.send(connId, {
          type: 'bound',
          ok: true,
          code: msg.code,
          online: !!this.managerId,
          clientId: conn.clientId
        });
        break;
      }

      case 'cmd': {
        // 网页 -> 管理器
        if (!this.managerId) {
          this.send(connId, { type: 'result', id: msg.id, ok: false, error: '管理器离线' });
          return;
        }
        this.send(this.managerId, {
          type: 'cmd',
          id: msg.id,
          method: msg.method,
          params: msg.params || {},
          clientId: conn.clientId || conn.id,
          clientInfo: { ip: conn.ip, country: conn.country, ua: conn.ua },
          ...(typeof msg.employeeToken === 'string' && msg.employeeToken
            ? { employeeToken: msg.employeeToken }
            : {})
        });
        break;
      }

      case 'result':
      case 'event': {
        // 管理器 -> 网页；带 target 时只发给目标 clientId，否则广播
        if (conn.role === 'manager') {
          const target = typeof msg.target === 'string' ? msg.target : null;
          if (target) {
            this.sendToClientId(target, msg);
          } else {
            this.broadcastToClients(msg);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  private onClose(connId: string): void {
    this.connections.delete(connId);
    if (this.managerId === connId) {
      this.managerId = null;
      this.broadcastToClients({ type: 'manager_status', online: false });
    }
  }

  private send(connId: string, obj: Record<string, unknown>): void {
    const conn = this.connections.get(connId);
    if (!conn) return;
    try {
      conn.ws.send(JSON.stringify(obj));
    } catch {
      // socket closed
    }
  }

  private sendToClientId(clientId: string, obj: Record<string, unknown>): void {
    for (const [id, conn] of this.connections) {
      if (conn.role === 'client' && conn.clientId === clientId) {
        this.send(id, obj);
      }
    }
  }

  private broadcastToClients(obj: Record<string, unknown>): void {
    for (const [id, conn] of this.connections) {
      if (conn.role === 'client') {
        this.send(id, obj);
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const code = (url.searchParams.get('code') || '').toUpperCase();

    if (!code) {
      return new Response(
        JSON.stringify({ ok: false, error: '缺少 code 参数，用法: /ws?code=<接入码>' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const id = env.ROOM.idFromName(code);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  }
};