import { app } from 'electron';
import { join } from 'path';
import { accessSync } from 'fs';
import { spawn, execFileSync, SpawnOptions } from 'child_process';
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
  // 单槽覆盖而不是 push：同一个账号反复登录/重连时，旧回调如果不清理会一直累积
  // （长跑 24h 的典型内存泄漏），而且旧回调还会去操作已经废弃的会话。
  exitCallbacks.set(accountId, [cb]);
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

  // Linux：优先常见安装路径（apt 的 google-chrome / chromium），都找不到再靠 PATH
  const linuxPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ];
  for (const p of linuxPaths) {
    try {
      accessSync(p);
      return p;
    } catch {}
  }
  return 'google-chrome';
}

/**
 * Linux 上以 root 运行（systemd 服务、Docker）时 Chrome 拒绝启动沙箱，必须显式加 --no-sandbox。
 * 可用 WAAM_CHROME_NO_SANDBOX=1 强制开启、=0 强制关闭；未设置时按「是否 root」自动判断。
 */
function needChromeNoSandbox(): boolean {
  const env = process.env.WAAM_CHROME_NO_SANDBOX;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  if (process.platform === 'linux') {
    try {
      return typeof process.getuid === 'function' && process.getuid() === 0;
    } catch {
      return false;
    }
  }
  return false;
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
  if (needChromeNoSandbox()) {
    args.push('--no-sandbox');
    args.push('--disable-setuid-sandbox');
    args.push('--disable-dev-shm-usage'); // 容器/小内存服务器上 /dev/shm 太小会崩
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

  // spawn 对"可执行文件不存在"是**异步** emit('error')，没有监听者就是 uncaughtException
  // → Electron 主进程直接崩（表现为"点登录就闪退"）。Chrome 装在非标准路径、
  // 只装了 Edge、或服务器没装 Chrome 时都会踩到。
  chromeProcess.once('error', (err) => {
    logger.error(`Chrome spawn failed for account ${accountId}:`, err);
    if (chromeInstances.get(accountId)?.process === chromeProcess) {
      chromeInstances.delete(accountId);
    }
  });

  logger.info(`Chrome launched for account ${accountId} on port ${port}`);

  let wsEndpoint: string;
  try {
    wsEndpoint = await waitForWebSocketEndpoint(port, 20000);
  } catch (err) {
    // 启动失败必须把已经 spawn 出来的 Chrome 杀掉：
    // 它带 detached + unref，不杀就会变成孤儿进程常驻（而且 map 里的句柄会被下次 launch 覆盖，
    // 从此再也没人管得到它，只能等下次冷启动的 cleanupStaleChrome 兜底）。
    logger.error(`Chrome endpoint wait failed for ${accountId}, killing spawned process:`, err);
    closeChromeForAccount(accountId);
    throw err;
  } finally {
    releaseLaunch();
  }

  // 注意：不可在 wwjs 连接前关闭空白页（会造成 Target.setAutoAttach: Target closed）。
  // 空白页改由 closeBlankTabs 在连接后清扫（qr/code/authenticated/ready + 延时兜底）。
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

/**
 * 杀掉本进程拉起的**所有** Chrome。
 *
 * 退出时必须有这个兜底：`whatsapp-web.js` 的 client.destroy() 在 CDP 已断时不会发
 * Browser.close，而 shutdownAll 又只遍历 sessions —— chromeInstances 里那些没有对应
 * session 的实例（启动超时泄漏、未成功 startSession 的新实例）就永远关不掉。
 * 这些进程是 detached + unref，Electron 退出后仍会活着占内存。
 */
export function closeAllChrome(): void {
  const ids = [...chromeInstances.keys()];
  for (const id of ids) {
    closeChromeForAccount(id);
  }
  if (ids.length > 0) logger.info(`closeAllChrome: killed ${ids.length} Chrome instance(s)`);
}

export function cleanupStaleChrome(): void {
  const profileRoot = join(app.getPath('userData'), 'chrome-profiles');

  // 跨平台：Windows 走 PowerShell/CIM，Linux/macOS 走 /proc + ps（pgrep 不一定装了，用 ps 更保险）
  const script =
    process.platform === 'win32'
      ? [
          'Get-CimInstance Win32_Process -Filter "name=\'chrome.exe\'"',
          `| Where-Object { $_.CommandLine -match [regex]::Escape('${profileRoot}') -and $_.CommandLine -match 'remote-debugging-port' }`,
          '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
        ].join(' ')
      : [
          'ps -eo pid=,args=',
          `| grep -F '${profileRoot}'`,
          "| grep -F 'remote-debugging-port'",
          "| grep -v grep",
          '| awk \'{print $1}\'',
          '| xargs -r kill -9 2>/dev/null',
          '|| true'
        ].join(' ');

  const cmd = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const cmdArgs =
    process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', script]
      : ['-c', script];

  try {
    execFileSync(cmd, cmdArgs, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    logger.info('Cleaned up stale Chrome processes under chrome-profiles');
  } catch (err) {
    logger.warn('Cleanup stale Chrome failed:', err);
  }
  chromeInstances.clear();
}