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
  // 旧的 relay worker 地址一律废弃，强制走 Web 管理器
  const saved = (serverUrl || '').trim();
  const url = (!saved || /waam-relay|workers\.dev/i.test(saved)) ? DEFAULT_MANAGER_URL : saved;
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
    if (!relay) throw new Error('管理器离线');
    // 会话跑在管理器上，状态以管理器为准（关闭客户端不影响账号在线）
    return (await relay.cmd('employee:list_mine', {})) as Array<Record<string, unknown>>;
  });

  // 以下会话操作在员工本机执行（WhatsApp 会话跑在员工电脑上）

  // 账号会话统一跑在管理器上：关闭客户端不影响账号在线
  ipcMain.handle('employee:login_account', async (_e, accountId: string, phoneNumber?: string) => {
    if (!relay) throw new Error('管理器离线');
    await relay.cmd('account:login', { accountId, phoneNumber });
    return { success: true };
  });

  ipcMain.handle('employee:logout_account', async (_e, accountId: string) => {
    if (!relay) throw new Error('管理器离线');
    await relay.cmd('account:logout', { accountId });
    return { success: true };
  });

  // 同步数据：由管理器在其会话上执行（拉手机端历史记录）
  ipcMain.handle('employee:sync_data', async (_e, accountId: string) => {
    if (!relay) throw new Error('管理器离线');
    return (await relay.cmd('account:sync', { accountId })) as { chats: number; requested: number };
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