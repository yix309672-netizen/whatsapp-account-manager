import { app, BrowserWindow, ipcMain, nativeImage, Tray, Menu, shell } from 'electron';
import { join } from 'path';
import { initDatabase } from './utils/db';
import { registerAccountIpc } from './ipc/account';
import { WhatsAppSessionManager } from './services/WhatsAppSessionManager';
import { cleanupStaleChrome } from './services/ChromeLauncher';
import { RelayClient, setRelayInstance } from './services/RelayClient';
import { loadRelaySettings, ensureAccessCode } from './services/relayConfig';
import { logger } from './utils/logger';
import { handleCommand, setRelayRestartCallback } from './commands';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { initSecurity, cleanupSecurity } from './utils/security';

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

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let relay: RelayClient | null = null;
const sessionManager = new WhatsAppSessionManager();

function startRelay(): void {
  const settings = loadRelaySettings();
  const code = settings.code || ensureAccessCode();
  if (!settings.serverUrl) return;

  relay = new RelayClient(
    { url: settings.serverUrl, code },
    sessionManager
  );
  setRelayInstance(relay);
  relay.on('status', () => {
    const data = {
      connected: relay?.isConnected ?? false,
      registered: relay?.isRegistered ?? false
    };
    mainWindow?.webContents.send('relay:status', data);
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 680,
    minHeight: 480,
    title: 'WhatsApp 安全中心',
    icon: join(__dirname, '../../resources/icon.png'),
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
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(__dirname, '../../resources/tray-icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => mainWindow?.show()
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit()
    }
  ]);

  tray.setToolTip('WhatsApp Security Center');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow?.show());
}

function setupAutoUpdater(): void {
  // 无发布渠道，禁用自动更新（避免 electron-updater 读取 app-update.yml 报错）
}

async function initializeManager(): Promise<void> {
  await app.whenReady();

  // 单实例锁：防多开（管理器）
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  cleanupStaleChrome();
  await initDatabase();
  initSecurity();
  setRelayRestartCallback(() => restartRelay());

  registerAccountIpc(ipcMain, sessionManager);

  createWindow();
  createTray();
  setupAutoUpdater();

  startRelay();

  // 启动后自动恢复所有已保存会话的账号，保持在线（静默，不弹窗）
  handleCommand({ sessionManager }, 'system:auto_restore', {}).catch((err) => {
    logger.error('Auto-restore failed:', err);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  cleanupSecurity();
  await sessionManager.shutdownAll();
});