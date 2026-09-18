import { Client, LocalAuth } from 'whatsapp-web.js';
import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { getDb } from '../utils/db';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { relayPushEvent } from './RelayClient';
import { getAccountOwner, getEmployeeClientIdForAccount } from '../commands';
import { closeBlankTabs } from './ChromeLauncher';
// 注意：必须静态导入。动态 require('../web/server') 在打包后相对路径不存在，
// esbuild 会原样保留导致运行时 Cannot find module（被 try/catch 吞掉，Web 推送悄悄失效）
import { broadcastWebEvent } from '../web/server';

interface SessionInfo {
  client: Client;
  accountId: string;
  status: 'initializing' | 'qr_pending' | 'authenticated' | 'ready' | 'disconnected' | 'failed';
  qrCode?: string;
  pairingCode?: string;
  chromePort?: number;
  /** 自动重连参数 */
  reconnectInfo?: {
    chromeWsEndpoint: string;
    options?: StartSessionOptions;
    retryCount: number;
    timer?: ReturnType<typeof setTimeout>;
  };
}

export interface StartSessionOptions {
  phoneNumber?: string;
  headless?: boolean;
  chromePort?: number;
}

const MAX_RECONNECT_RETRIES = 5;
const RECONNECT_BASE_DELAY_MS = 3000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

export class WhatsAppSessionManager {
  private sessions = new Map<string, SessionInfo>();
  private sessionDataPath: string;
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.sessionDataPath = join(app.getPath('userData'), 'whatsapp-sessions');
    this.startHealthCheck();
  }

  /**
   * 构造 whatsapp-web.js 客户端。
   * 抽成方法是为了支持"初始化失败后换一个全新 client 重试"——
   * 失败的 client 内部 page 已半死，复用同一个实例重试往往还是失败。
   */
  private buildClient(accountId: string, chromeWsEndpoint: string, options?: StartSessionOptions): Client {
    const headless = options?.headless ?? false;
    return new Client({
      authStrategy: new LocalAuth({
        clientId: accountId,
        dataPath: this.sessionDataPath
      }),
      puppeteer: {
        browserWSEndpoint: chromeWsEndpoint,
        headless
      },
      deviceName: 'WhatsApp账号安全中心',
      browserName: 'Chrome',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      pairWithPhoneNumber: options?.phoneNumber
        ? {
            phoneNumber: options.phoneNumber,
            showNotification: true,
            intervalMs: 180000
          }
        : undefined
    });
  }

  async startSession(accountId: string, chromeWsEndpoint: string, _options?: StartSessionOptions): Promise<Client> {
    if (this.sessions.has(accountId)) {
      const existing = this.sessions.get(accountId)!;
      if (existing.status === 'ready') return existing.client;
      await this.stopSession(accountId);
    }

    // Web 模式强制清除旧认证数据，确保走配对流程（触发手机通知）
    if (_options?.phoneNumber) {
      try {
        const fs = require('fs');
        const authDir = join(this.sessionDataPath, `Session-${accountId}`);
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
          logger.info(`Cleared old auth data for ${accountId} to force pairing flow`);
        }
      } catch (err) {
        logger.debug(`Failed to clear auth data for ${accountId}:`, err);
      }
    }

    let client = this.buildClient(accountId, chromeWsEndpoint, _options);

    const sessionInfo: SessionInfo = {
      client,
      accountId,
      status: 'initializing',
      chromePort: _options?.chromePort
    };
    this.sessions.set(accountId, sessionInfo);

    // 清扫多余标签（about:blank/新标签页/重复 web 页），只留一个 WhatsApp。
    // wwebjs 用 browserWSEndpoint 时必 newPage()，空白页不可能被复用，只能事后关。
    const sweep = async (reason: string): Promise<void> => {
      if (!sessionInfo.chromePort) {
        logger.warn(`sweepBlankTabs skipped for ${accountId}: no chromePort (${reason})`);
        return;
      }
      const n = await closeBlankTabs(sessionInfo.chromePort).catch(() => -1);
      if (n === 0) logger.info(`sweepBlankTabs for ${accountId}: already clean (${reason})`);
    };

    this.attachClientHandlers(sessionInfo, sweep);

    // 延时兜底清扫：页面创建有延迟的话，事件时点的清扫可能扑空，5s/15s 后再扫两遍
    for (const ms of [5000, 15000]) {
      setTimeout(() => {
        const s = this.sessions.get(accountId);
        if (!s || !s.chromePort) return;
        if (s.status === 'disconnected' || s.status === 'failed') return;
        closeBlankTabs(s.chromePort)
          .then((n) => { if (n > 0) logger.info(`delayed sweep for ${accountId} closed ${n} tab(s) after ${ms}ms`); })
          .catch(() => {});
      }, ms);
    }

    // 初始化重试：实测第一次并发拉起 6 个账号时，偶发 wwebjs 内部竞态
    // （Cannot read properties of null (reading 'info')）导致该账号登录失败。
    // 失败的 client 内部 page 已半死，所以重试要换一个全新 client —— 实测这件事很关键。
    const MAX_TRY = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
      try {
        await client.initialize();
        this.setupReconnect(accountId, chromeWsEndpoint, _options);
        return client;
      } catch (err) {
        lastErr = err;
        const msg = (err as Error)?.message || String(err);
        logger.warn(`Session init failed for ${accountId} (attempt ${attempt}/${MAX_TRY}): ${msg}`);
        if (attempt === MAX_TRY) break;
        // 销毁半死的 client，换新实例重来
        try { await client.destroy(); } catch { /* 已经坏了，忽略 */ }
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        sessionInfo.status = 'initializing';
        client = this.buildClient(accountId, chromeWsEndpoint, _options);
        sessionInfo.client = client;
        this.attachClientHandlers(sessionInfo, sweep);
      }
    }
    sessionInfo.status = 'failed';
    logger.error(`Session init failed for ${accountId} after ${MAX_TRY} attempts:`, lastErr);
    throw lastErr;
  }

  /** 绑定 whatsapp-web.js 事件（重试换 client 后需要重新绑定） */
  private attachClientHandlers(
    sessionInfo: SessionInfo,
    sweep: (reason: string) => Promise<void>
  ): void {
    const { client, accountId } = sessionInfo;

    client.on('qr', async (qr) => {
      sessionInfo.status = 'qr_pending';
      sessionInfo.qrCode = qr;
      this.emitAccountEvent('account:qr', { accountId, qr });
      await sweep('qr');
    });

    client.on('code', async (code) => {
      sessionInfo.status = 'qr_pending';
      sessionInfo.pairingCode = code;
      this.emitAccountEvent('account:pairing_code', { accountId, code });
      await sweep('pairing-code');
    });

    client.on('authenticated', async () => {
      sessionInfo.status = 'authenticated';
      this.emitAccountEvent('account:authenticated', { accountId });
      await sweep('authenticated');
    });

    client.on('ready', async () => {
      sessionInfo.status = 'ready';
      this.updateAccountStatus(accountId, 'online');
      this.emitAccountEvent('account:ready', { accountId });
      await sweep('ready');
    });

    client.on('disconnected', (reason) => {
      sessionInfo.status = 'disconnected';
      this.updateAccountStatus(accountId, 'offline');
      this.emitAccountEvent('account:disconnected', { accountId, reason });
      // 触发自动重连（如果存在重连参数）
      if (sessionInfo.reconnectInfo) {
        logger.info(`Session ${accountId} disconnected (${reason}), scheduling auto-reconnect`);
        sessionInfo.reconnectInfo.retryCount = 0;
        this.triggerReconnect(accountId);
      }
    });

    client.on('auth_failure', (msg) => {
      sessionInfo.status = 'failed';
      this.updateAccountStatus(accountId, 'offline');
      this.emitAccountEvent('account:auth_failure', { accountId, message: msg });
    });
  }

  async stopSession(accountId: string): Promise<void> {
    this.clearReconnect(accountId);
    const session = this.sessions.get(accountId);
    if (session) {
      try {
        await session.client.destroy();
      } catch (err) {
        logger.warn(`Error destroying session ${accountId}:`, err);
      }
      this.sessions.delete(accountId);
    }
  }

  async shutdownAll(): Promise<void> {
    this.destroy();
    for (const [accountId] of this.sessions) {
      await this.stopSession(accountId);
    }
  }

  getSession(accountId: string): Client | undefined {
    return this.sessions.get(accountId)?.client;
  }

  hasActiveSession(accountId: string): boolean {
    const s = this.sessions.get(accountId);
    return !!s && (s.status === 'ready' || s.status === 'authenticated');
  }

  getStatus(accountId: string): SessionInfo['status'] | undefined {
    return this.sessions.get(accountId)?.status;
  }

  /**
   * Chrome 浏览器被用户关闭时调用：强制将会话标记为断开，并通知界面恢复登录按钮
   */
  markDisconnected(accountId: string): void {
    const s = this.sessions.get(accountId);
    if (!s) return;
    s.status = 'disconnected';
    this.updateAccountStatus(accountId, 'offline');
    this.emitAccountEvent('account:disconnected', { accountId, reason: 'browser_closed' });
  }

  /**
   * 返回最近一次生成的配对码；若无配对码但会话未认证，返回 null 表示应重新请求
   */
  getLatestPairingCode(accountId: string): string | null {
    return this.sessions.get(accountId)?.pairingCode ?? null;
  }

  /**
   * 手动保存配对码（用于 requestPairingCode 直接返回码时同步到会话状态）
   */
  setPairingCode(accountId: string, code: string): void {
    const s = this.sessions.get(accountId);
    if (s) {
      s.pairingCode = code;
    }
  }

  /**
   * 轮询等待配对码生成（用于等 initialize 内部的自动请求完成），超时返回 null
   */
  async waitForPairingCode(accountId: string, timeoutMs = 25000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const code = this.getLatestPairingCode(accountId);
      if (code) return code;
      const s = this.sessions.get(accountId);
      if (!s) return null;
      // 已认证或已就绪，说明配对已完成，无需再等待
      if (s.status === 'authenticated' || s.status === 'ready') return null;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  private updateAccountStatus(accountId: string, status: string): void {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const updates: string[] = ['status = ?', 'updated_time = ?'];
    const params: (string | number)[] = [status, now];
    
    if (status === 'online') {
      const row = db.prepare('SELECT login_time FROM accounts WHERE id = ?').get(accountId) as { login_time: number | null } | undefined;
      if (row && !row.login_time) {
        updates.push('login_time = ?');
        params.push(now);
      }
    }
    
    params.push(accountId);
    db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  // ====== 自动重连 + 健康检测 ======

  /**
   * 定期检查所有活跃会话的健康状态，检测到异常时触发自动重连
   */
  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      for (const [accountId, info] of this.sessions) {
        if (info.status !== 'ready' && info.status !== 'authenticated') continue;
        // 检查 client 是否仍然有效（WhatsApp Web 内部状态）
        try {
          const info2 = info as unknown as Record<string, unknown>;
          // whatsapp-web.js Client 有 info.page 属性，如果页面已关闭则需要重连
          const client = info.client as unknown as Record<string, unknown>;
          const page = client.page as Record<string, unknown> | undefined;
          if (page && typeof page.isClosed === 'function' && page.isClosed()) {
            logger.warn(`Health check: session ${accountId} page is closed, triggering reconnect`);
            this.triggerReconnect(accountId);
          }
        } catch {
          // 检查失败视为不健康，触发重连
          logger.warn(`Health check failed for ${accountId}, triggering reconnect`);
          this.triggerReconnect(accountId);
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * 触发自动重连（带指数退避）
   */
  private triggerReconnect(accountId: string): void {
    const session = this.sessions.get(accountId);
    if (!session?.reconnectInfo) return;
    const ri = session.reconnectInfo;
    if (ri.retryCount >= MAX_RECONNECT_RETRIES) {
      logger.warn(`Reconnect: ${accountId} exceeded max retries (${MAX_RECONNECT_RETRIES}), giving up`);
      session.status = 'failed';
      this.updateAccountStatus(accountId, 'offline');
      this.emitAccountEvent('account:disconnected', { accountId, reason: 'reconnect_failed' });
      return;
    }

    // 取消已有的重连定时器
    if (ri.timer) clearTimeout(ri.timer);

    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, ri.retryCount);
    ri.retryCount++;
    logger.info(`Reconnect: ${accountId} will retry in ${delay}ms (attempt ${ri.retryCount}/${MAX_RECONNECT_RETRIES})`);

    ri.timer = setTimeout(async () => {
      try {
        // 先停掉旧会话
        try { await session.client.destroy(); } catch {}
        // 重新启动
        await this.startSession(accountId, ri.chromeWsEndpoint, ri.options);
        logger.info(`Reconnect: ${accountId} succeeded`);
      } catch (err) {
        logger.error(`Reconnect: ${accountId} failed:`, err);
        this.triggerReconnect(accountId);
      }
    }, delay);
  }

  /**
   * 在 startSession 成功连接后，设置自动重连参数
   */
  private setupReconnect(accountId: string, chromeWsEndpoint: string, options?: StartSessionOptions): void {
    const session = this.sessions.get(accountId);
    if (!session) return;
    session.reconnectInfo = {
      chromeWsEndpoint,
      options,
      retryCount: 0
    };
  }

  /**
   * 停止会话时清除重连参数
   */
  private clearReconnect(accountId: string): void {
    const session = this.sessions.get(accountId);
    if (session?.reconnectInfo?.timer) {
      clearTimeout(session.reconnectInfo.timer);
    }
    if (session) {
      session.reconnectInfo = undefined;
    }
  }

  /**
   * 销毁时清理健康检测定时器
   */
  destroy(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  private emitAccountEvent(channel: string, data: Record<string, unknown>): void {
    // 桌面端窗口始终收到事件
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(channel, data);
    });
    // Web 管理后台广播
    try {
      broadcastWebEvent(channel, data);
    } catch { /* web 未启动时忽略 */ }
    // 中转端：只推送给创建该账号的网页客户端或拥有该账号的员工端，避免广播给所有绑定者
    const accountId = data.accountId as string | undefined;
    const owner = accountId ? getAccountOwner(accountId) : undefined;
    const target = owner || (accountId ? getEmployeeClientIdForAccount(accountId) : undefined);
    relayPushEvent(channel, data, target || undefined);
  }
}