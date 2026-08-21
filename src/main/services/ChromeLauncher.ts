import { app } from 'electron';
import { join } from 'path';
import { accessSync } from 'fs';
import { spawn, SpawnOptions } from 'child_process';
import { getFreePort } from '../utils/port';
import { logger } from '../utils/logger';

interface ChromeInstance {
  process: ReturnType<typeof spawn>;
  port: number;
  userDataDir: string;
  accountId: string;
}

const chromeInstances = new Map<string, ChromeInstance>();

const exitCallbacks = new Map<string, Array<() => void>>();

export function onChromeExit(accountId: string, cb: () => void): void {
  const list = exitCallbacks.get(accountId) || [];
  list.push(cb);
  exitCallbacks.set(accountId, list);
}

function findChromeExecutable(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ];
    for (const p of paths) {
      try {
        accessSync(p);
        return p;
      } catch {}
    }
    return 'chrome';
  }

  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  return 'google-chrome';
}

async function isEndpointAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (res.ok) return true;
  } catch {
    // not alive
  }
  return false;
}

function isProcessAlive(processHandle: ReturnType<typeof spawn>): boolean {
  return processHandle.exitCode === null && processHandle.signalCode === null;
}

export async function launchChromeForAccount(accountId: string, opts?: { headless?: boolean; visible?: boolean }): Promise<{ port: number; wsEndpoint: string; userDataDir: string }> {
  const headless = opts?.headless ?? false;
  const visible = opts?.visible ?? false;
  const existing = chromeInstances.get(accountId);
  if (existing && isProcessAlive(existing.process) && (await isEndpointAlive(existing.port))) {
    logger.info(`Reusing existing Chrome for account ${accountId} on port ${existing.port}`);
    return {
      port: existing.port,
      wsEndpoint: await waitForWebSocketEndpoint(existing.port, 10000),
      userDataDir: existing.userDataDir
    };
  }

  const port = await getFreePort();
  const userDataDir = join(app.getPath('userData'), 'chrome-profiles', accountId);
  const chromePath = findChromeExecutable();

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,ServiceWorkerUpdateOnDemand,WebRtcHideLocalIpsWithMdns',
    '--disable-web-app-updates',
    '--disable-background-networking',
    '--disable-component-update'
  ];
  if (headless) {
    args.push('--headless=new');
    args.push('--hide-scrollbars');
    args.push('--mute-audio');
  }
  args.push('about:blank');

  const options: SpawnOptions = {
    detached: true,
    stdio: 'ignore',
    windowsHide: !visible
  };

  const chromeProcess = spawn(chromePath, args, options);
  chromeProcess.unref();

  chromeProcess.on('exit', () => {
    logger.info(`Chrome exited for account ${accountId} (port ${port})`);
    if (chromeInstances.get(accountId)?.process === chromeProcess) {
      chromeInstances.delete(accountId);
    }
    (exitCallbacks.get(accountId) || []).forEach((cb) => {
      try {
        cb();
      } catch (err) {
        logger.warn(`Chrome exit callback failed for ${accountId}:`, err);
      }
    });
  });

  chromeInstances.set(accountId, { process: chromeProcess, port, userDataDir, accountId });

  logger.info(`Chrome launched for account ${accountId} on port ${port}`);

  const wsEndpoint = await waitForWebSocketEndpoint(port, 20000);

  return {
    port,
    wsEndpoint,
    userDataDir
  };
}

async function waitForWebSocketEndpoint(port: number, timeoutMs: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const data = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
      }
    } catch (err) {
      // Chrome still starting, retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome 调试端点连接超时');
}

/**
 * 通过 CDP HTTP 接口关闭 about:blank 空白标签页（不依赖 puppeteer）。
 * 在 WhatsApp 页面加载完成后由会话管理调用。
 */
export async function closeBlankTabs(port: number): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) return;
    const pages = (await res.json()) as Array<{ id?: string; url?: string; type?: string }>;
    for (const page of pages) {
      if (page.type !== 'page') continue;
      const url = page.url || '';
      if (!url || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('devtools://')) {
        if (page.id) {
          await fetch(`http://127.0.0.1:${port}/json/close/${page.id}`).catch(() => {});
        }
      }
    }
  } catch (err) {
    logger.debug(`closeBlankTabs failed on port ${port}:`, err);
  }
}

export function closeChromeForAccount(accountId: string): void {
  const instance = chromeInstances.get(accountId);
  if (instance) {
    try {
      instance.process.kill();
    } catch (err) {
      logger.warn(`Failed to kill Chrome for ${accountId}:`, err);
    }
    chromeInstances.delete(accountId);
  }
}

export function isChromeRunning(accountId: string): boolean {
  const instance = chromeInstances.get(accountId);
  if (!instance) return false;
  return isProcessAlive(instance.process);
}

export function cleanupStaleChrome(): void {
  const profileRoot = join(app.getPath('userData'), 'chrome-profiles');
  const { execFileSync } = require('child_process');
  const script = [
    'Get-CimInstance Win32_Process -Filter "name=\'chrome.exe\'"',
    `| Where-Object { $_.CommandLine -match [regex]::Escape('${profileRoot}') -and $_.CommandLine -match 'remote-debugging-port' }`,
    '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  ].join(' ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    });
    logger.info('Cleaned up stale Chrome processes under chrome-profiles');
  } catch (err) {
    logger.warn('Cleanup stale Chrome failed:', err);
  }
  chromeInstances.clear();
}