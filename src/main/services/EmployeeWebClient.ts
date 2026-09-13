import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * 员工端直连 Web 管理器的 WS 客户端（不再走 Cloudflare Worker 中转）。
 * - 连接：wss://<管理器域名>/ws?employee=1&fp=<指纹>（员工模式无需预置 token）
 * - 首条命令必须是 employee:login，成功后本连接绑定该员工，后续命令受服务端白名单约束
 * - 管理器离线时连不上 → 无法登录（符合预期）
 */
export class EmployeeWebClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private baseUrl = '';
  private fp: string;
  private clientId: string;
  private pending = new Map<string, PendingCall>();
  private nextId = 1;
  private connected = false;
  private authenticated = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manualClose = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;
  private creds: { username: string; password: string; machineFingerprint: string } | null = null;

  constructor(baseUrl: string, clientId: string, fingerprint: string) {
    super();
    this.clientId = clientId;
    this.fp = fingerprint;
    this.setServer(baseUrl);
  }

  get isConnected(): boolean {
    return this.connected;
  }
  get isBound(): boolean {
    return this.authenticated;
  }
  get id(): string {
    return this.clientId;
  }

  /** 归一化服务器地址：接受 http(s):// 或 ws(s)://，自动补 /ws */
  setServer(baseUrl: string): void {
    let u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) { this.baseUrl = ''; return; }
    u = u.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
    if (!/^wss?:\/\//i.test(u)) u = 'wss://' + u;
    if (!/\/ws$/i.test(u)) u = u + '/ws';
    this.baseUrl = u;
  }

  get serverUrl(): string {
    return this.baseUrl;
  }

  start(): void {
    this.manualClose = false;
    this.connect();
  }

  stop(): void {
    this.manualClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.rejectAllPending(new Error('连接已断开'));
  }

  private connect(): void {
    if (this.manualClose || !this.baseUrl) return;
    const url = `${this.baseUrl}?employee=1&fp=${encodeURIComponent(this.fp)}`;
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      logger.warn('Employee WS connect error:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      this.lastPong = Date.now();
      this.startHeartbeat();
      this.emitStatus();
      // 断线重连后自动重新登录，保持会话
      if (this.creds) {
        this.cmd('employee:login', { ...this.creds }, 30000)
          .then(() => { this.authenticated = true; this.emitStatus(); })
          .catch((e) => logger.warn('Employee auto re-login failed:', (e as Error).message));
      }
    });

    this.ws.on('message', (raw) => this.handleMessage(raw.toString()));

    this.ws.on('close', () => {
      this.connected = false;
      this.authenticated = false;
      this.stopHeartbeat();
      this.rejectAllPending(new Error('管理器连接已断开'));
      this.emitStatus();
      if (!this.manualClose) {
        logger.warn('Employee WS closed, reconnecting...');
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      logger.warn('Employee WS error:', err.message);
    });
  }

  private emitStatus(): void {
    this.emit('status', { connected: this.connected, bound: this.authenticated, online: this.connected });
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
        logger.warn('Employee WS heartbeat timeout (no pong in 40s), forcing reconnect...');
        try { this.ws.terminate(); } catch { /* close 事件会触发重连 */ }
        return;
      }
      this.send({ id: `hb${this.nextId++}`, method: 'ping', params: {} });
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // 事件推送：{ type:'event', channel, data }
    if (msg.type === 'event') {
      this.emit('event', { channel: String(msg.channel), data: msg.data });
      return;
    }
    // 命令响应：{ id, ok, data|error }
    const id = String(msg.id || '');
    if (!id) return;
    const call = this.pending.get(id);
    if (!call) {
      // 心跳响应
      if (id.startsWith('hb')) this.lastPong = Date.now();
      return;
    }
    this.pending.delete(id);
    if (msg.ok) call.resolve(msg.data);
    else call.reject(new Error(String(msg.error || '执行失败')));
    if (id.startsWith('hb')) this.lastPong = Date.now();
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

  private waitForOpen(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (this.connected) { clearInterval(tick); resolve(); return; }
        if (Date.now() - started > timeoutMs) {
          clearInterval(tick);
          reject(new Error('管理器离线：无法连接管理端，请确认管理器已启动并运行'));
        }
      }, 500);
    });
  }

  /** 员工登录：管理器不可达直接报"管理器离线"，不进入登录流程 */
  async login(username: string, password: string, machineFingerprint: string): Promise<unknown> {
    this.creds = { username, password, machineFingerprint };
    if (!this.baseUrl) throw new Error('未配置管理器地址');
    if (!this.connected) {
      if (!this.ws) this.connect();
      await this.waitForOpen(15000);
    }
    const r = await this.cmd('employee:login', { username, password, machineFingerprint }, 30000);
    this.authenticated = true;
    this.emitStatus();
    return r;
  }

  clearToken(): void {
    this.creds = null;
    this.authenticated = false;
  }

  cmd<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('管理器离线：请确认管理器已启动并运行'));
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
      this.send({ id, method, params });
    });
  }
}
