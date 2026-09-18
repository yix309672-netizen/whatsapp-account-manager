import { Client, LocalAuth } from 'whatsapp-web.js';
import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { getDb } from '../utils/db';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { relayPushEvent } from './RelayClient';
import { getAccountOwner, getEmployeeClientIdForAccount } from '../commands';
import { closeBlankTabs, closeChromeForAccount, launchChromeForAccount } from './ChromeLauncher';
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
  /**
   * 判断会话底层的 Chrome 是否还活着。
   * puppeteer.connect 模式下，pupBrowser.isConnected() 在 Chrome 进程消失后返回 false;
   * 这一条是"用户关掉浏览器窗口/进程被杀"后能自动恢复的关键，仅看内存里的 status
   * 会一直以为会话是 ready。
   */
  private isClientAlive(client: Client): boolean {
    try {
      const browser = (client as unknown as { pupBrowser?: { isConnected?: () => boolean } }).pupBrowser;
      if (!browser || typeof browser.isConnected !== 'function') return true; // 拿不到就按存活处理，避免误杀
      return browser.isConnected() === true;
    } catch {
      return false;
    }
  }

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
      if (existing.status === 'ready' && this.isClientAlive(existing.client)) return existing.client;
      // 状态是 ready 但底层 Chrome 已经没了（用户关窗口/进程被杀的常见情形）：
      // 必须当作死会话处理，否则会直接返回一个已断开的 client，前端点登录毫无反应。
      if (existing.status === 'ready') {
        logger.warn(`Session for ${accountId} is marked ready but its browser is gone, restarting it`);
      }
      await this.stopSession(accountId);
    }

    // Web 模式强制清除旧认证数据，确保走配对流程（触发手机通知）
    // 注意目录名是 LocalAuth 实际使用的小写 `session-<clientId>`（大写 Session- 在
    // Linux/macOS 上大小写敏感，existsSync 恒为 false，会让"强制重新配对"静默失效）。
    if (_options?.phoneNumber) {
      try {
        const fs = require('fs');
        const authDir = join(this.sessionDataPath, `session-${accountId}`);
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

    // 延时兜底清扫：页面创建有延迟的话，事件时点的清扫可能扑空，5s/15s 后再扫两遍。
    // 句柄记下来，重试换会话时要清掉，否则旧定时器会去关新会话的页面。
    const sweepTimers: Array<ReturnType<typeof setTimeout>> = [];
    for (const ms of [5000, 15000]) {
      sweepTimers.push(setTimeout(() => {
        // 只对"当前仍是这次建立的会话"生效，避免误伤重启后的新会话
        if (this.sessions.get(accountId) !== sessionInfo) return;
        if (!sessionInfo.chromePort) return;
        if (sessionInfo.status === 'disconnected' || sessionInfo.status === 'failed') return;
        closeBlankTabs(sessionInfo.chromePort)
          .then((n) => { if (n > 0) logger.info(`delayed sweep for ${accountId} closed ${n} tab(s) after ${ms}ms`); })
          .catch(() => {});
      }, ms));
    }
    const clearSweepTimers = (): void => { for (const t of sweepTimers) clearTimeout(t); sweepTimers.length = 0; };

    // 初始化重试。
    //
    // ⚠️ 关键坑（已实测确认）：whatsapp-web.js 的 client.destroy() 在 browserWSEndpoint
    // （puppeteer.connect）模式下会执行 CDP 的 Browser.close，**把整个 Chrome 进程杀掉**
    // （实测：logout 后 chrome 进程从 14 个直接归零）。所以重试**不能**复用原来的
    // chromeWsEndpoint —— 那是在连一个已经死掉的端点，必然失败，会把"偶发失败"变成"必然失败"。
    // 正确做法：destroy 之后重新 launchChromeForAccount 拿新的 wsEndpoint/port，再建新 client。
    const MAX_TRY = 3;
    let lastErr: unknown;
    let wsEndpoint = chromeWsEndpoint;
    for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
      try {
        await client.initialize();
        this.setupReconnect(accountId, wsEndpoint, _options);
        return client;
      } catch (err) {
        lastErr = err;
        const msg = (err as Error)?.message || String(err);
        logger.warn(`Session init failed for ${accountId} (attempt ${attempt}/${MAX_TRY}): ${msg}`);
        if (attempt === MAX_TRY) break;
        clearSweepTimers();
        // 1) 销毁半死的 client（这一步会把 Chrome 一起关掉）
        try { await client.destroy(); } catch { /* 已经坏了，忽略 */ }
        // 2) 确保进程真的没了，并清掉 launcher 里的死句柄
        closeChromeForAccount(accountId);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        // 3) 重新拉起一个全新的 Chrome，换成新端点
        try {
          const relaunched = await launchChromeForAccount(accountId, { headless: _options?.headless });
          wsEndpoint = relaunched.wsEndpoint;
          sessionInfo.chromePort = relaunched.port;
        } catch (launchErr) {
          logger.error(`Relaunch Chrome failed for ${accountId} on attempt ${attempt}:`, launchErr);
          lastErr = launchErr;
          break;
        }
        sessionInfo.status = 'initializing';
        client = this.buildClient(accountId, wsEndpoint, _options);
        sessionInfo.client = client;
        this.attachClientHandlers(sessionInfo, sweep);
      }
    }
    clearSweepTimers();
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
      // 触发自动重连（如果存在重连参数）。
      // 注意：这里**不能**把 retryCount 清零——否则"连上就断"的循环会让退避上限
      // （MAX_RECONNECT_RETRIES）永远不成立，变成无限重连。清零只应在重连成功时做。
      if (sessionInfo.reconnectInfo) {
        logger.info(`Session ${accountId} disconnected (${reason}), scheduling auto-reconnect (retry ${sessionInfo.reconnectInfo.retryCount})`);
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