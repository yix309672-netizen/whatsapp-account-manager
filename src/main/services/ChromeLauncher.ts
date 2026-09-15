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
// 高并发池化：最多 8 个 Chrome 并发启动，超限排队
let launchConcurrent = 0;
const LAUNCH_MAX = 8;
const launchQueue: Array<() => void> = [];
function acquireLaunch(): Promise<void> {
  if (launchConcurrent < LAUNCH_MAX) { launchConcurrent++; return Promise.resolve(); }
  return new Promise((res) => launchQueue.push(res));
}
function releaseLaunch(): void {
  launchConcurrent--;
  const next = launchQueue.shift();
  if (next) { launchConcurrent++; next(); }
}

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

  await acquireLaunch();
  const port = await getFreePort();
  const userDataDir = join(app.getPath('userData'), 'chrome-profiles', accountId);
  const chromePath = findChromeExecutable();

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    // 关掉最后一个标签页时浏览器不退出：配合"连接前先关空白页"，使 wwjs newPage 后只剩 1 个标签页
    '--keep-alive-for-test',
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
  // 无初始 URL，whatsapp-web.js 单建 web.whatsapp.com，避免 about:blank/双 web 残留

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

  let wsEndpoint: string;
  try {
    wsEndpoint = await waitForWebSocketEndpoint(port, 20000);
  } finally {
    releaseLaunch();
  }

  // 连接前先关掉 Chrome 自带的空白页：whatsapp-web.js 随后 newPage()，
  // 这样最终只剩 1 个标签页（其渲染进程随标签关闭一并结束）。
  const closed = await closeAllPageTargets(port).catch(() => 0);
  if (closed > 0) logger.info(`Pre-closed ${closed} blank page(s) for account ${accountId} on port ${port}`);

  return {
    port,
    wsEndpoint,
    userDataDir
  };
}

// 通过 CDP HTTP 接口关掉所有 type=page 的标签（不含 chrome 内部 UI target）
async function closeAllPageTargets(port: number): Promise<number> {
  let n = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) return 0;
    const list = (await res.json()) as Array<{ id: string; type?: string }>;
    for (const t of list) {
      if (t.type !== 'page') continue;
      try {
        await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
        n++;
      } catch { /* 单个失败不影响 */ }
    }
  } catch { /* CDP 不可用时跳过 */ }
  return n;
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
 * 通过 CDP HTTP 接口关闭 about:blank / 新标签页等多余标签，只保留第一个 WhatsApp Web。
 * 背景：whatsapp-web.js 用 browserWSEndpoint 连接时必调 browser.newPage()，
 * 启动时的空白页不可能被复用，只能事后关闭。本函数带重试，失败记 warn（不再静默）。
 * @returns 关闭的标签数（-1 表示 CDP 不可达）
 */
export async function closeBlankTabs(port: number, retries = 3): Promise<number> {
  let closed = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!res.ok) {
        logger.warn(`closeBlankTabs: /json/list HTTP ${res.status} on port ${port} (attempt ${attempt + 1})`);
      } else {
        const pages = (await res.json()) as Array<{ id?: string; url?: string; title?: string; type?: string }>;
        let seenWeb = false;
        let leftover = 0;
        for (const page of pages) {
          if (page.type !== 'page') continue;
          const url = (page.url || '').toLowerCase();
          const title = (page.title || '').toLowerCase();
          const isWeb = url.includes('web.whatsapp.com');
          const isNewTab = url === '' || url === 'about:blank' || url.startsWith('chrome://newtab') || url.startsWith('chrome://') || url.startsWith('devtools://') || title.includes('新标签页') || title.includes('new tab');
          if (isWeb) {
            if (!seenWeb) { seenWeb = true; continue; }
          }
          if (isNewTab || isWeb) {
            if (page.id) {
              try {
                const c = await fetch(`http://127.0.0.1:${port}/json/close/${page.id}`);
                if (c.ok) {
                  closed++;
                  logger.info(`closeBlankTabs: closed "${title || url || 'untitled'}" on port ${port}`);
                } else {
                  leftover++;
                }
              } catch {
                leftover++;
              }
            } else {
              leftover++;
            }
          }
        }
        // WhatsApp 页已就绪且无残留 → 扫干净了；否则重试（WA 页可能还在加载）
        if (seenWeb && leftover === 0) return closed;
      }
    } catch (err) {
      logger.warn(`closeBlankTabs failed on port ${port} (attempt ${attempt + 1}):`, err);
    }
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 1000));
  }
  return closed;
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