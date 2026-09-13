import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } from 'electron';
import { join } from 'path';
import { EmployeeWebClient } from './services/EmployeeWebClient';
import { WhatsAppSessionManager } from './services/WhatsAppSessionManager';
import { launchChromeForAccount, closeChromeForAccount, isChromeRunning, onChromeExit, cleanupStaleChrome } from './services/ChromeLauncher';
import { generateStableMachineFingerprint } from './services/fingerprint';
import { initDatabase } from './utils/db';
import { saveRelaySettings, loadRelaySettings } from './services/relayConfig';
import { logger } from './utils/logger';
import { initSecurity, cleanupSecurity } from './utils/security';

// 员工端使用独立数据目录，避免与中央管理器共用账号数据库（严格隔离）
app.setPath('userData', join(app.getPath('appData'), 'whatsapp-employee-client'));

// 员工端机器指纹（防拷贝：绑定安装电脑，换机需管理员重置）
const machineFingerprint = generateStableMachineFingerprint();

// 单实例锁：防多开
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let relay: EmployeeWebClient | null = null;
// 直连管理器：连上=管理器在线；连不上=离线（无法登录）
let managerOnline: boolean | null = null;
const sessionManager = new WhatsAppSessionManager();
// 员工端默认管理器地址（可被设置覆盖）
const DEFAULT_MANAGER_URL = 'wss://guanli.whatspph.com/ws';

// 员工端自己的持久 clientId
function getClientId(): string {
  try {
    const p = join(app.getPath('userData'), 'employee-client-id.txt');
    const { existsSync, readFileSync, writeFileSync } = require('fs');
    if (existsSync(p)) {
      const v = readFileSync(p, 'utf-8').trim();
      if (v) return v;
    }
    const id = `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    writeFileSync(p, id, 'utf-8');
    return id;
  } catch {
    return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function pushStatus(): void {
  managerOnline = !!relay?.isConnected;
  win?.webContents.send('employee:relay_status', {
    connected: !!relay?.isConnected,
    bound: !!relay?.isBound,
    online: managerOnline
  });
}

function startRelay(serverUrl: string): void {
  if (relay) {
    relay.stop();
    relay = null;
  }
  const url = (serverUrl || '').trim() || DEFAULT_MANAGER_URL;
  relay = new EmployeeWebClient(url, getClientId(), machineFingerprint);
  relay.on('status', () => pushStatus());
  relay.on('event', (ev) => {
    const d = ev as { channel: string; data: unknown };
    win?.webContents.send(d.channel, d.data);
  });
  relay.start();
  setTimeout(pushStatus, 1500);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 680,
    minHeight: 480,
    title: '员工端 - WhatsApp 账号',
    icon: join(__dirname, '../../resources/employee-icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false,
    resizable: true
  });
  Menu.setApplicationMenu(null);

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173?mode=employee');
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { mode: 'employee' } });
  }

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/employee-tray.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  const menu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => win?.show() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
  tray.setToolTip('员工端');
  tray.setContextMenu(menu);
  tray.on('double-click', () => win?.show());
}

function registerEmployeeIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('employee:connect', (_e, serverUrl?: string) => {
    const url = ((serverUrl as string) || '').trim() || DEFAULT_MANAGER_URL;
    saveRelaySettings({ serverUrl: url, code: '' });
    startRelay(url);
    return { success: true, serverUrl: url };
  });

  ipcMain.handle('employee:get_config', () => {
    return loadRelaySettings();
  });

  ipcMain.handle('employee:status', () => {
    // 直连管理器：连上=在线，连不上=离线（离线时无法登录）
    return {
      connected: !!relay?.isConnected,
      bound: !!relay?.isBound,
      online: relay ? !!relay.isConnected : null
    };
  });

  ipcMain.handle('employee:login', async (_e, username: string, password: string) => {
    if (!relay) throw new Error('管理器离线：请确认管理器已启动并运行');
    // 直连管理器登录：管理器不可达时 login 内会抛"管理器离线"
    const result = (await relay.login(username, password, machineFingerprint)) as {
      success: boolean;
      employee: unknown;
    };
    pushStatus();
    return result;
  });

  ipcMain.handle('employee:list_mine', async () => {
    if (!relay) throw new Error('未连接服务器');
    const list = (await relay.cmd('employee:list_mine', {})) as Array<Record<string, unknown>>;
    // 状态以员工本机会话为准：本机未登录的显示离线，可一键登录；Chrome 已关闭也视为离线
    return list.map((a) => {
      const id = a.id as string;
      const running = isChromeRunning(id);
      const st = running ? sessionManager.getStatus(id) : 'offline';
      return { ...a, status: st || 'offline' };
    });
  });

  // 以下会话操作在员工本机执行（WhatsApp 会话跑在员工电脑上）

  ipcMain.handle('employee:login_account', async (_e, accountId: string, phoneNumber?: string) => {
    // 1) 从中央端拉取该账号已保存的 WhatsApp 会话，写入本地 Chrome profile（免扫码登录）
    const { rmSync, mkdirSync, writeFileSync } = require('fs');
    const profileRoot = join(app.getPath('userData'), 'chrome-profiles', accountId);
    try {
      const sess = (await relay?.cmd('employee:get_session', { accountId })) as
        | { files?: Array<{ rel: string; data: string }> }
        | undefined;
      // 先清空旧 profile：上次写入损坏/不完整文件会导致 Chrome 崩溃（TargetCloseError）
      if (sess?.files?.length) {
        try {
          rmSync(profileRoot, { recursive: true, force: true });
        } catch {}
        const defaultDir = join(profileRoot, 'Default');
        for (const f of sess.files) {
          const target = join(defaultDir, ...f.rel.split('/'));
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(target, Buffer.from(f.data, 'base64'));
        }
        logger.info(`Restored WhatsApp session files for ${accountId}: ${sess.files.length} files`);
      }
    } catch (err) {
      logger.warn('Failed to fetch session files (will scan QR if needed):', err);
    }

    // 2) 打开可见浏览器窗口并启动会话（本地已有会话则免登录）
    const { port, wsEndpoint } = await launchChromeForAccount(accountId, { visible: true });
    await sessionManager.startSession(accountId, wsEndpoint, {
      phoneNumber: phoneNumber as string | undefined,
      chromePort: port
    });

    // 员工不小心关闭浏览器窗口时，强制把会话标记为断开，界面恢复「一键登录」按钮
    onChromeExit(accountId, () => {
      sessionManager.markDisconnected(accountId);
      win?.webContents.send('account:disconnected', { accountId, reason: 'browser_closed' });
    });

    return { success: true };
  });

  ipcMain.handle('employee:logout_account', async (_e, accountId: string) => {
    await sessionManager.stopSession(accountId);
    closeChromeForAccount(accountId);
    return { success: true };
  });

  ipcMain.handle('employee:pairing_code', async (_e, accountId: string, phoneNumber: string) => {
    const cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (cleanPhone.length < 8) throw new Error('手机号格式错误');

    const existing = await sessionManager.waitForPairingCode(accountId, 25000);
    if (existing) return { success: true, code: existing, reused: true };
    const client = sessionManager.getSession(accountId);
    if (!client) throw new Error('会话未启动，请先一键登录');
    try {
      const code = await client.requestPairingCode(cleanPhone);
      if (code) sessionManager.setPairingCode(accountId, code);
      return { success: true, code, reused: false };
    } catch (err) {
      const msg = String((err as Error).message || err);
      if (/rate[-_]?overlimit|Too many attempt|429/i.test(msg) || /^[a-z]:?\s*[a-z]*$/i.test(msg.trim())) {
        throw new Error('WhatsApp 暂时限制了该号码的配对码请求。请等待 15~30 分钟后再试，或换一个号码。');
      }
      throw err;
    }
  });

  ipcMain.handle('employee:my_status', async () => {
    if (!relay) throw new Error('未连接服务器');
    const remote = (await relay.cmd('employee:my_status', {})) as Array<{ accountId: string }>;
    // 用本机会话状态覆盖
    return remote.map((r) => ({ accountId: r.accountId, status: sessionManager.getStatus(r.accountId) || 'offline' }));
  });
}

async function initializeEmployee(): Promise<void> {
  await app.whenReady();
  if (!gotLock) {
    app.quit();
    return;
  }
  await initDatabase();
  initSecurity();
  cleanupStaleChrome();
  registerEmployeeIpc();
  createWindow();
  createTray();

  // 启动时连管理器（用已保存地址，没存过就用默认域名）
  try {
    const cfg = loadRelaySettings();
    startRelay(cfg.serverUrl || DEFAULT_MANAGER_URL);
  } catch (err) {
    logger.warn('Employee auto-connect failed:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  cleanupSecurity();
  if (relay) relay.stop();
  await sessionManager.shutdownAll();
});

initializeEmployee().catch((err) => {
  logger.error('Employee app init failed:', err);
  app.quit();
});