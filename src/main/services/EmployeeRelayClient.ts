import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * 员工端侧中转客户端：
 * - 像网页一样以 client 身份 bind 到中转服务器（与中央管理器共用同一接入码）
 * - 发送 cmd（employee:login / employee:list_mine 等），由中央管理器执行
 * - 接收定向事件（配对码、状态变化等）
 */
export class EmployeeRelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private code: string;
  private clientId: string;
  private pending = new Map<string, PendingCall>();
  private nextId = 1;
  private connected = false;
  private bound = false;
  private employeeToken = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manualClose = false;
  // 应用层心跳：25s 一次 ping，40s 无 pong 则判定半开并强制重连
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;

  constructor(url: string, code: string, clientId: string) {
    super();
    this.url = url;
    this.code = code;
    this.clientId = clientId;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get isBound(): boolean {
    return this.bound;
  }

  get id(): string {
    return this.clientId;
  }

  setToken(token: string): void {
    this.employeeToken = token;
  }

  clearToken(): void {
    this.employeeToken = '';
  }

  start(): void {
    this.manualClose = false;
    this.connect();
  }

  stop(): void {
    this.manualClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
    this.bound = false;
    this.rejectAllPending(new Error('连接已断开'));
  }

  private connect(): void {
    if (this.manualClose) return;

    const sep = this.url.includes('?') ? '&' : '?';
    const wsUrl = `${this.url}${sep}code=${encodeURIComponent(this.code)}`;
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      logger.warn('Employee relay connect error:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      this.lastPong = Date.now();
      this.startHeartbeat();
      this.send({ type: 'bind', code: this.code, clientId: this.clientId });
    });

    this.ws.on('message', (raw) => this.handleMessage(raw.toString()));

    this.ws.on('close', () => {
      this.connected = false;
      this.bound = false;
      this.stopHeartbeat();
      this.rejectAllPending(new Error('连接已断开'));
      if (!this.manualClose) {
        logger.warn('Employee relay closed, reconnecting...');
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      logger.warn('Employee relay error:', err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.manualClose || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > 40000) {
        logger.warn('Employee relay heartbeat timeout (no pong in 40s), forcing reconnect...');
        try {
          this.ws.terminate();
        } catch {
          // ignore; close 事件会触发重连
        }
        return;
      }
      this.send({ type: 'ping', t: Date.now() });
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'pong': {
        this.lastPong = Date.now();
        break;
      }
      case 'bound': {
        this.bound = !!msg.ok;
        this.emit('bound', { ok: msg.ok, online: msg.online, clientId: msg.clientId });
        if (!msg.ok) logger.warn('Employee relay bind failed:', msg.error);
        break;
      }
      case 'result': {
        const id = String(msg.id);
        const call = this.pending.get(id);
        if (call) {
          this.pending.delete(id);
          if (msg.ok) call.resolve(msg.data);
          else call.reject(new Error(String(msg.error || '执行失败')));
        }
        break;
      }
      case 'event': {
        const channel = String(msg.event);
        this.emit('event', { channel, data: msg.data });
        break;
      }
      case 'manager_status': {
        this.emit('manager_status', { online: msg.online });
        break;
      }
      default:
        break;
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, call] of this.pending) {
      call.reject(err);
      this.pending.delete(id);
    }
  }

  cmd<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.bound) {
        reject(new Error('未连接服务器，请检查接入设置'));
        return;
      }
      const id = `e${this.nextId++}`;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('管理器无响应（30s 超时），可能离线，请稍后重试'));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); (resolve as (vv: unknown) => void)(v); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); }
      });
      const payload: Record<string, unknown> = {
        type: 'cmd',
        id,
        method,
        params,
        clientId: this.clientId
      };
      if (this.employeeToken) {
        payload.employeeToken = this.employeeToken;
      }
      this.send(payload);
    });
  }
}