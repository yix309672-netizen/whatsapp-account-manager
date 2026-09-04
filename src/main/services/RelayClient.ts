import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { getDb } from '../utils/db';
import { handleCommand, CommandContext } from '../commands';
import { WhatsAppSessionManager } from './WhatsAppSessionManager';
import { logger } from '../utils/logger';

export interface RelayConfig {
  url: string;
  code: string;
  autoReconnectMs?: number;
}

/**
 * 管理器侧中转客户端：
 * - 连接中转服务器并用接入码注册
 * - 接收网页发来的 cmd，调用统一 handleCommand 执行
 * - 把账号事件（配对码/状态变化等）推送给绑定网页
 */
export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: RelayConfig;
  private sessionManager: WhatsAppSessionManager;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manualClose = false;
  private connected = false;
  private registered = false;
  // 应用层心跳：25s 一次 ping，40s 无 pong 则判定半开并强制重连
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;

  constructor(config: RelayConfig, sessionManager: WhatsAppSessionManager) {
    super();
    this.config = config;
    this.sessionManager = sessionManager;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get isRegistered(): boolean {
    return this.registered;
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
    this.setConnected(false);
    this.registered = false;
  }

  private connect(): void {
    if (this.manualClose) return;

    const wsUrl = this.buildWsUrl();
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      logger.warn('Relay connect error:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      logger.info(`Relay connected to ${wsUrl}`);
      this.setConnected(true);
      this.lastPong = Date.now();
      this.startHeartbeat();
      this.send({
        type: 'register',
        code: this.config.code
      });
    });

    this.ws.on('message', (raw) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on('close', () => {
      this.registered = false;
      this.setConnected(false);
      this.stopHeartbeat();
      if (!this.manualClose) {
        logger.warn('Relay connection closed, reconnecting...');
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      logger.warn('Relay error:', err.message);
    });
  }

  private buildWsUrl(): string {
    const base = this.config.url;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}code=${encodeURIComponent(this.config.code)}`;
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer) return;
    const delay = this.config.autoReconnectMs ?? 5000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.manualClose || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > 40000) {
        logger.warn('Relay heartbeat timeout (no pong in 40s), forcing reconnect...');
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

  private setConnected(v: boolean): void {
    if (this.connected !== v) {
      this.connected = v;
      this.emit('status', { connected: v, registered: this.registered });
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
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
      case 'registered': {
        const ok = !!msg.ok;
        this.registered = ok;
        if (ok) {
          logger.info(`Relay registered with code ${this.config.code}`);
        } else {
          logger.warn('Relay registration failed:', msg.error);
        }
        this.emit('status', { connected: this.connected, registered: this.registered });
        this.emit('registered', { ok, error: msg.error });
        break;
      }

      case 'cmd': {
        const id = msg.id as string;
        const method = msg.method as string;
        const params = (msg.params || {}) as Record<string, unknown>;
        const clientId = (msg.clientId as string) || '';
        const employeeToken = (msg.employeeToken as string) || '';
        const clientInfo = msg.clientInfo as { ip?: string; country?: string; ua?: string } | undefined;
        this.execute(id, method, params, clientId, employeeToken, clientInfo);
        break;
      }

      default:
        break;
    }
  }

  private async execute(id: string, method: string, params: Record<string, unknown>, clientId = '', employeeToken = '', clientInfo?: { ip?: string; country?: string; ua?: string }): Promise<void> {
    const ctx: CommandContext = { sessionManager: this.sessionManager, clientId, employeeToken: employeeToken || undefined, clientInfo };
    try {
      const result = await handleCommand(ctx, method, params);
      this.send({ type: 'result', id, ok: true, data: result });
    } catch (err) {
      logger.error(`Relay cmd ${method} failed:`, err);
      logger.error(`Relay cmd ${method} stack:`, (err as Error).stack);
      this.send({ type: 'result', id, ok: false, error: (err as Error).message });
    }
  }

  /**
   * 推送事件给网页（配对码、状态变化等）
   * @param target 可选：目标 clientId；不传则广播给所有绑定网页
   */
  pushEvent(event: string, data: Record<string, unknown>, target?: string): void {
    if (target) {
      this.send({ type: 'event', event, data, target });
    } else {
      this.send({ type: 'event', event, data });
    }
  }

  /** 供系统其他模块查询接入码 */
  getCode(): string {
    return this.config.code;
  }

  getUrl(): string {
    return this.config.url;
  }
}

// 全局单例，供主进程各模块推送事件
let relayInstance: RelayClient | null = null;

export function setRelayInstance(relay: RelayClient | null): void {
  relayInstance = relay;
}

export function getRelayInstance(): RelayClient | null {
  return relayInstance;
}

export function relayPushEvent(event: string, data: Record<string, unknown>, target?: string): void {
  relayInstance?.pushEvent(event, data, target);
}