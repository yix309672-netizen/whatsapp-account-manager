import { app, ipcMain } from 'electron';
import { join } from 'path';
import { initDatabase } from './utils/db';
import { WhatsAppSessionManager } from './services/WhatsAppSessionManager';
import { cleanupStaleChrome } from './services/ChromeLauncher';
import { RelayClient, setRelayInstance } from './services/RelayClient';
import { loadRelaySettings, ensureAccessCode } from './services/relayConfig';
import { logger } from './utils/logger';
import { handleCommand, setRelayRestartCallback } from './commands';
import { initSecurity, cleanupSecurity } from './utils/security';
import { startWebServer, stopWebServer } from './web/server';

// 员工端模式：打包时 employee 构建通过 extraMetadata.name 写入 app 名（含 employee）
// 开发模式：electron . --employee / WAAM_MODE=employee
const isEmployeeMode =
  app.getName().toLowerCase().includes('employee') ||
  app.getName().toLowerCase() === 'kuai-z' ||
  process.argv.includes('--employee') ||
  process.env.WAAM_MODE === 'employee';

if (isEmployeeMode) {
  import('./employee').catch((err) => {
    logger.error('Failed to start employee mode:', err);
    app.quit();
  });
} else {
  initializeManager();
}

let relay: RelayClient | null = null;
const sessionManager = new WhatsAppSessionManager();

function startRelay(): void {
  const settings = loadRelaySettings();
  const code = settings.code || ensureAccessCode();
  if (!settings.serverUrl) return;

  relay = new RelayClient({ url: settings.serverUrl, code }, sessionManager);
  setRelayInstance(relay);
  // 管理端已无桌面窗口，状态通过 Web 广播；如需桌面通知可在此接入 broadcastWebEvent
  relay.on('status', () => {
    // 保留空回调以触发重连逻辑，实际状态由 Web 端通过 relay:status 命令轮询
  });
  relay.start();
}

function restartRelay(): void {
  if (relay) {
    relay.stop();
    relay = null;
    setRelayInstance(null);
  }
  startRelay();
}

async function initializeManager(): Promise<void> {
  await app.whenReady();

  // 单实例锁：防多开（管理端 Web 服务）
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // 桌面渲染兜底：通用命令透传（当前管理端无窗口，仅防回归；Web 走 WS）
  ipcMain.handle('__invoke__', (_e, method: string, params?: Record<string, unknown>) =>
    handleCommand({ sessionManager }, String(method || ''), (params || {}) as Record<string, unknown>)
  );

  // 管理中心已纯 Web 化，不再创建 BrowserWindow/Tray
  cleanupStaleChrome();
  await initDatabase();
  initSecurity();
  setRelayRestartCallback(() => restartRelay());

  startRelay();

  // 始终启动 Web 管理后台（验证 + 管理均为 Web）
  const port = Number(process.env.WAAM_WEB_PORT || 9527);
  // 管理员密码只从环境变量来，不再设仓库可见的默认值（实际鉴权走 admin_users 表）
  const adminPassword = process.env.WAAM_ADMIN_PASSWORD || '';
  const passwordFile = join(app.getPath('userData'), 'web-admin-password.txt');
  const staticDir = join(__dirname, '../renderer');
  try {
    await startWebServer({ port, staticDir, sessionManager, adminPassword, passwordFile });
    logger.info(`Web manager (verification + admin) listening on http://localhost:${port} -> guanli.whatspph.com / www.whatspph.com`);
  } catch (err) {
    logger.error('Failed to start web server:', err);
    app.quit();
    return;
  }

  // 启动后自动恢复所有已保存会话的账号，保持在线（静默，不弹窗）
  // 已停用启动时自动恢复所有账号（避免一次性拉起大量 Chrome 占内存卡死）。
  // 需要的账号请在管理后台手动「登录」。
  // handleCommand({ sessionManager }, 'system:auto_restore', {}).catch((err) => {
  //   logger.error('Auto-restore failed:', err);
  // });

  // Checker 池自动重连：有授权文件的 checker 静默连回（免扫码；失效则出二维码等扫，不阻塞启动）
  setTimeout(() => {
    import('./services/BaileysScanner').then(async (m) => {
      try {
        const { existsSync } = await import('fs');
        const { join } = await import('path');
        const userData = app.getPath('userData');
        const n = m.getCheckerCount();
        for (let i = 0; i < n; i++) {
          const dir = i === 0 ? join(userData, 'baileys-auth') : join(userData, `baileys-auth-${i}`);
          if (!existsSync(join(dir, 'creds.json'))) continue;
          // wantConnection=true：掉线自动重连；若授权失效会出 QR，前端扫一次即可
          m.setCheckerWantConnection(i, true);
          await m.startChecker(i).catch((e: any) => logger.warn(`checker #${i} auto-reconnect failed:`, e?.message || e));
          await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e) {
        logger.warn('checker auto-reconnect init failed:', e);
      }
    }).catch((e) => logger.warn('checker auto-reconnect import failed:', e));
  }, 8000);
}

app.on('window-all-closed', () => {
  // 管理端无窗口，不自动退出；由 before-quit 统一清理
});

app.on('before-quit', async () => {
  stopWebServer();
  cleanupSecurity();
  await sessionManager.shutdownAll();
});
