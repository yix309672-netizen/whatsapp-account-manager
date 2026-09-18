import { app, ipcMain } from 'electron';
import { join } from 'path';
import { initDatabase, maintenanceCleanup, closeDatabase } from './utils/db';
import { WhatsAppSessionManager } from './services/WhatsAppSessionManager';
import { cleanupStaleChrome, closeAllChrome, startOrphanChromeSweep, stopOrphanChromeSweep } from './services/ChromeLauncher';
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

  // 启动后自动恢复有已保存会话的账号（静默 headless，错峰 12s/个、上限 10 个防卡死）。
  // 这是验证掉线问题的根因修复：以前重启后会话全灭且不恢复，H5 显示成功、 quản端离线。
  handleCommand({ sessionManager }, 'system:auto_restore', { staggerMs: 12000, limit: 10 }).catch((err) => {
    logger.error('Auto-restore failed:', err);
  });

  // 长期运行维护：启动后清理一次，之后每 6 小时一次（导出文件/旧任务/旧缓存）
  try { maintenanceCleanup(); } catch (e) { logger.warn('maintenance initial failed:', e); }
  setInterval(() => { try { maintenanceCleanup(); } catch (e) { logger.warn('maintenance failed:', e); } }, 6 * 3600 * 1000);

  // 周期性孤儿 Chrome 清理：主进程被强杀/崩溃时退出钩子不会执行，
  // detached 的 Chrome 会变成孤儿常驻内存。每 5 分钟扫一次 chrome-profiles，
  // 把"既不在 chromeInstances、也没有被跟踪会话"的整组杀掉（可用 WAAM_SWEEP_INTERVAL_MS=0 关闭）。
  startOrphanChromeSweep((accountId) => sessionManager.isSessionTracked(accountId));

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
          // 疑似被封的不自动重连（避免空转撞墙），等人工 解除
          try { if (m.isCheckerBanned(i)) { logger.warn(`checker #${i} ban-suspect, skip auto-reconnect`); continue; } } catch {}
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

/**
 * 退出清理。
 *
 * ⚠️ 修复说明：
 *  1) Electron **不会 await** before-quit 里的 async 处理器。以前直接 `await shutdownAll()`
 *     时主进程可能先退出，导致 `detached + unref` 的 Chrome 全部变成孤儿进程。
 *     现在用 preventDefault() 拦住退出，清理完再 app.exit()。
 *  2) shutdownAll 只遍历 sessions；chromeInstances 里那些**没有对应 session** 的 Chrome
 *     （启动超时泄漏、未成功 startSession 的新实例）永远关不掉。这里补 closeAllChrome() 兜底。
 *  3) closeDatabase() 之前从未被调用 → WAL 不 checkpoint，单独拷 accounts.db 会丢最近写入。
 *  4) ⚠️ 服务化部署下 systemd 发的是 **SIGTERM**，而 before-quit **不会**因信号触发 ——
 *     实测 `systemctl restart waam` 后 Chrome 仍然残留（27 个）。所以必须同时处理信号。
 */
let quitting = false;

function gracefulShutdown(reason: string): void {
  if (quitting) return;
  quitting = true;
  logger.info(`Graceful shutdown started (${reason})`);

  try { stopWebServer(); } catch (err) { logger.warn('stopWebServer failed:', err); }
  try { cleanupSecurity(); } catch (err) { logger.warn('cleanupSecurity failed:', err); }
  try { stopOrphanChromeSweep(); } catch { /* ignore */ }
  // 先同步杀掉所有已知 Chrome（不依赖 CDP 往返，最可靠）
  try { closeAllChrome(); } catch (err) { logger.warn('closeAllChrome failed:', err); }

  const hardExit = setTimeout(() => {
    logger.warn('Graceful shutdown timed out, forcing exit');
    try { closeDatabase(); } catch { /* ignore */ }
    app.exit(0);
  }, 8000);

  sessionManager.shutdownAll()
    .catch((err) => logger.warn('shutdownAll failed:', err))
    .finally(() => {
      clearTimeout(hardExit);
      // 再兜一次：shutdownAll 可能又新建/遗漏了实例
      try { closeAllChrome(); } catch { /* ignore */ }
      try { closeDatabase(); } catch (err) { logger.warn('closeDatabase failed:', err); }
      app.exit(0);
    });
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  gracefulShutdown('before-quit');
});

// systemd / docker stop / Ctrl-C 都是发信号，不会走 before-quit
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    logger.info(`Received ${sig}`);
    gracefulShutdown(sig);
  });
}
// 进程即将异常退出时也尽量清一次（同步部分至少能杀掉 Chrome）
process.on('exit', () => {
  try { closeAllChrome(); } catch { /* ignore */ }
});
