import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../utils/db';
import { logger } from '../utils/logger';
// 注意：必须静态导入。动态 require('../web/server') 在打包后相对路径不存在，
// esbuild 会原样保留导致运行时 Cannot find module（被 try/catch 吞掉，Web 推送悄悄失效）
import { broadcastWebEvent } from '../web/server';

// WebCrypto 最小结构类型（node 的 tsconfig 无 DOM lib，不能直接用 Crypto 类型）
type CryptoLike = { subtle?: unknown; getRandomValues?: unknown; randomUUID?: unknown };

// ================== Checker 池 ==================
// 每个 checker = 一个独立 Baileys 会话（独立 auth 目录 + 独立 socket）。
// id 0 沿用老目录 baileys-auth（历史登录态无缝保留），id>0 用 baileys-auth-N。
interface Checker {
  id: number;
  sock: any;
  connectionState: string;
  qrCache: string;
  wantConnection: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  consecutiveFailures: number;
  windowStart: number; // 每 checker 独立小时窗口（风控隔离）
  windowCount: number;
  currentTaskId: string | null;
  lastPairAt: number;
  presenceWaiters: Map<string, (p: { online: boolean; lastSeen: number }) => void>;
}
const checkers = new Map<number, Checker>();
function getChecker(id: number): Checker {
  let c = checkers.get(id);
  if (!c) {
    c = {
      id, sock: null, connectionState: 'close', qrCache: '', wantConnection: false,
      reconnectTimer: null, consecutiveFailures: 0, windowStart: 0, windowCount: 0,
      currentTaskId: null, lastPairAt: 0, presenceWaiters: new Map(),
    };
    checkers.set(id, c);
  }
  return c;
}

// 全局单任务模型：整个池同时只跑一个任务（注册/活跃度），保号优先
let currentTaskId: string | null = null;
let paused = false;
let abortFlag = false;

function broadcast(event: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(event, data));
  try {
    broadcastWebEvent(event, (data || {}) as Record<string, unknown>);
  } catch {}
}

function authDir(id: number): string {
  const d = id === 0
    ? join(app.getPath('userData'), 'baileys-auth')
    : join(app.getPath('userData'), `baileys-auth-${id}`);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

// checker 数量配置（1-10，默认1；加号只需改数 + 逐个扫码登录）
const CHECKER_COUNT_KEY = 'scanner_checker_count';
export function getCheckerCount(): number {
  try {
    const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(CHECKER_COUNT_KEY) as { value: string } | undefined;
    const n = Math.floor(Number(row?.value) || 1);
    return Math.min(Math.max(1, n), 10);
  } catch { return 1; }
}
export function setCheckerCount(n: number): number {
  const v = Math.min(Math.max(1, Math.floor(Number(n) || 1)), 10);
  getDb().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(CHECKER_COUNT_KEY, String(v), String(v));
  logger.info(`[BaileysScanner] checker count set to ${v}`);
  return getCheckerCount();
}
export function listCheckers(): Array<{ id: number; state: string; connected: boolean; taskId: string | null; hasQr: boolean }> {
  const n = getCheckerCount();
  const out: Array<{ id: number; state: string; connected: boolean; taskId: string | null; hasQr: boolean }> = [];
  for (let i = 0; i < n; i++) {
    const c = getChecker(i);
    out.push({ id: c.id, state: c.connectionState, connected: c.connectionState === 'open', taskId: c.currentTaskId, hasQr: !!c.qrCache });
  }
  return out;
}
export function setCheckerWantConnection(id: number, v: boolean): void {
  getChecker(id).wantConnection = v;
}
export function onlineCheckerIds(): number[] {
  const n = getCheckerCount();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = getChecker(i);
    if (c.sock && c.connectionState === 'open') out.push(i);
  }
  return out;
}

function getRandomDelay(min = 1000, max = 3000): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 可中断休眠：每 1s 检查一次 abortFlag，中止/暂停立即响应（批量休眠最长可达 15 分钟，不能干等）
async function sleepInterruptible(ms: number): Promise<'done' | 'aborted'> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (abortFlag) return 'aborted';
    await delay(Math.min(1000, end - Date.now()));
  }
  return abortFlag ? 'aborted' : 'done';
}
// 查询超时保护：WA 偶发不回包，无超时会卡死整个任务
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    delay(ms).then(() => { throw new Error(`${label}超时（${Math.round(ms / 1000)}s）`); }),
  ]) as Promise<T>;
}

// ================== 防风控配置 ==================
// 三档速度（单号间隔，实际每次随机抖动）：
// 隐身 stealth: 8-15s/号（约4-7号/分，最稳，适合主号/大批量）
// 均衡 balanced: 4-8s/号（约9号/分，默认推荐）
// 极速 fast: 2-4s/号（约18号/分，仅小号短期用）
// 多 checker 并行时，总吞吐 ≈ 在线数 × 单号速度（每个号独立计时、独立小时上限）
export type ScanMode = 'stealth' | 'balanced' | 'fast' | 'custom';
export interface ScanCfg {
  mode: ScanMode;
  minMs: number; maxMs: number;       // 单号间隔区间
  batchSize: number;                  // 每批多少号后休眠
  batchRestMinMs: number; batchRestMaxMs: number; // 批量休眠区间
  hourlyCap: number;                  // 每个号每小时上限（0=不限）
  maxConsecErr: number;               // 连续失败熔断阈值
  checkAvatar: boolean;               // 是否检测头像（多一次请求，慢约1倍）
  retryRounds: number;                // 出错号码自动重查轮数（0-3，默认1；只重查报错的，不断点从头来）
  retryCooldownMs: number;            // 重查前冷却（默认60s，可中断）
  presenceGapMs: number;              // 活跃度：每号间隔（默认3s，presence 订阅成本高）
  presenceTimeoutMs: number;          // 活跃度：单号等信号超时（默认10s）
  presenceCacheDays: number;          // 活跃度：缓存天数（0=每次都重查，默认7）
}
export const SCAN_PRESETS: Record<Exclude<ScanMode, 'custom'>, Omit<ScanCfg, 'mode'>> = {
  stealth:  { minMs: 8000, maxMs: 15000, batchSize: 20, batchRestMinMs: 120000, batchRestMaxMs: 240000, hourlyCap: 300,  maxConsecErr: 3, checkAvatar: true, retryRounds: 2, retryCooldownMs: 120000, presenceGapMs: 5000, presenceTimeoutMs: 12000, presenceCacheDays: 7 },
  balanced: { minMs: 4000, maxMs: 8000,  batchSize: 25, batchRestMinMs: 60000,  batchRestMaxMs: 120000, hourlyCap: 800,  maxConsecErr: 5, checkAvatar: true, retryRounds: 1, retryCooldownMs: 60000, presenceGapMs: 3000, presenceTimeoutMs: 10000, presenceCacheDays: 7 },
  fast:     { minMs: 2000, maxMs: 4000,  batchSize: 30, batchRestMinMs: 30000,  batchRestMaxMs: 60000,  hourlyCap: 1500, maxConsecErr: 8, checkAvatar: true, retryRounds: 1, retryCooldownMs: 60000, presenceGapMs: 2000, presenceTimeoutMs: 8000, presenceCacheDays: 7 },
};
export const SCAN_DEFAULTS: ScanCfg = { mode: 'balanced', ...SCAN_PRESETS.balanced };
const SCAN_CFG_KEY = 'scanner_cfg';

export function getScanCfg(): ScanCfg {
  try {
    const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(SCAN_CFG_KEY) as { value: string } | undefined;
    if (row?.value) {
      const saved = JSON.parse(row.value) as Partial<ScanCfg>;
      const cfg: ScanCfg = { ...SCAN_DEFAULTS, ...saved };
      // 钳制到安全范围，防止手填离谱值把号搞封
      cfg.minMs = Math.min(Math.max(1500, Math.floor(Number(cfg.minMs) || 0)), 60000);
      cfg.maxMs = Math.min(Math.max(cfg.minMs, Math.floor(Number(cfg.maxMs) || 0)), 120000);
      cfg.batchSize = Math.min(Math.max(5, Math.floor(Number(cfg.batchSize) || 0)), 100);
      cfg.batchRestMinMs = Math.min(Math.max(10000, Math.floor(Number(cfg.batchRestMinMs) || 0)), 600000);
      cfg.batchRestMaxMs = Math.min(Math.max(cfg.batchRestMinMs, Math.floor(Number(cfg.batchRestMaxMs) || 0)), 900000);
      cfg.hourlyCap = Math.min(Math.max(0, Math.floor(Number(cfg.hourlyCap) || 0)), 5000);
      cfg.maxConsecErr = Math.min(Math.max(2, Math.floor(Number(cfg.maxConsecErr) || 0)), 20);
      cfg.checkAvatar = cfg.checkAvatar !== false;
      cfg.retryRounds = Math.min(Math.max(0, Math.floor(Number((cfg as any).retryRounds) || 0)), 3);
      cfg.retryCooldownMs = Math.min(Math.max(30000, Math.floor(Number((cfg as any).retryCooldownMs) || 0)), 600000);
      cfg.presenceGapMs = Math.min(Math.max(1500, Math.floor(Number((cfg as any).presenceGapMs) || 0)), 30000);
      cfg.presenceTimeoutMs = Math.min(Math.max(5000, Math.floor(Number((cfg as any).presenceTimeoutMs) || 0)), 30000);
      cfg.presenceCacheDays = Math.min(Math.max(0, Math.floor(Number((cfg as any).presenceCacheDays) ?? 7)), 30);
      if (!['stealth', 'balanced', 'fast', 'custom'].includes(cfg.mode)) cfg.mode = 'custom';
      return cfg;
    }
  } catch {}
  return { ...SCAN_DEFAULTS };
}

export function setScanCfg(patch: Partial<ScanCfg>): ScanCfg {
  const next: ScanCfg = { ...getScanCfg(), ...patch };
  if (patch.mode && patch.mode !== 'custom' && SCAN_PRESETS[patch.mode as Exclude<ScanMode, 'custom'>]) {
    // 选档位时整套应用档位值（界面输入框会同步更新，所见即所得）
    Object.assign(next, { mode: patch.mode }, SCAN_PRESETS[patch.mode as Exclude<ScanMode, 'custom'>]);
  } else if (patch.mode === undefined && Object.keys(patch).length > 0) {
    next.mode = 'custom';
  }
  getDb().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(SCAN_CFG_KEY, JSON.stringify(next), JSON.stringify(next));
  logger.info('[BaileysScanner] scan cfg saved: ' + JSON.stringify(next));
  return getScanCfg();
}

// ================== 会话启停 ==================

export async function startChecker(id: number): Promise<{ qr?: string; connected: boolean; state: string; checkerId: number }> {
  const c = getChecker(id);
  if (c.reconnectTimer) { clearTimeout(c.reconnectTimer); c.reconnectTimer = null; }
  if (c.sock && c.connectionState === 'open') return { connected: true, state: 'open', checkerId: id };
  if (c.sock && c.connectionState === 'connecting') {
    // 若已有 QR 直接返回，否则等一会儿（QR 通常 1-5s 到达）
    if (c.qrCache) return { qr: c.qrCache, connected: false, state: 'connecting', checkerId: id };
    for (let i = 0; i < 12; i++) {
      await delay(1000);
      // 用 string 加宽，避免 TS 把 connectionState 收窄为字面量 'connecting' 后误报比较
      const st: string = c.connectionState;
      if (st === 'open') return { connected: true, state: 'open', checkerId: id };
      if (c.qrCache) return { qr: c.qrCache, connected: false, state: 'connecting', checkerId: id };
      if (st === 'close' || !c.sock) break;
    }
    if (c.qrCache) return { qr: c.qrCache, connected: false, state: 'connecting', checkerId: id };
    const st2: string = c.connectionState;
    if (st2 === 'open') return { connected: true, state: 'open', checkerId: id };
    // 掉线了就往下走重建；先清理僵死 socket，避免泄漏
    try { (c.sock as any)?.end?.(undefined); } catch {}
    c.sock = null;
    c.connectionState = 'close';
  }

  try {
    logger.info(`[BaileysScanner] checker ${id} starting...`);
    // Node 18/Electron 28 polyfills: crypto + diagnostics_channel.tracingChannel
    if (!(globalThis as any).crypto) {
      try { (globalThis as any).crypto = (await import('crypto')).webcrypto as unknown as CryptoLike; } catch {}
    }
    if (!(globalThis as any).crypto?.subtle) {
      try { (globalThis as any).crypto = (await import('crypto')).webcrypto as unknown as CryptoLike; } catch {}
    }
    try {
      const dc: any = await import('node:diagnostics_channel');
      if (!dc.tracingChannel) {
        dc.tracingChannel = () => ({ hasSubscribers: false, tracePromise: (fn: any) => fn(), traceSync: (fn: any) => fn(), traceCallback: (fn: any) => fn() });
        logger.info('[BaileysScanner] polyfilled diagnostics_channel.tracingChannel');
      }
      if (!dc.channel) dc.channel = () => ({ hasSubscribers: false, publish: ()=>{}, subscribe: ()=>{}, unsubscribe: ()=>{} });
    } catch {}
    const baileys: any = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.makeWASocket || baileys.default?.makeWASocket || baileys.default;
    const { useMultiFileAuthState, DisconnectReason } = baileys;
    const { state, saveCreds } = await useMultiFileAuthState(authDir(id));

    c.connectionState = 'connecting';
    c.qrCache = '';
    broadcast('scanner:status', { state: 'connecting', checkerId: id });

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: [`WAAM Scanner #${id}`, 'Chrome', '1.0'],
      defaultQueryTimeoutMs: undefined,
    });
    c.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    // presence 信号路由：把 presence.update 按号码分发给等待中的活跃度查询
    sock.ev.on('presence.update', (u: any) => {
      try {
        const pres = (u && u.presences) || {};
        for (const participant of Object.keys(pres)) {
          const digits = String(participant).split('@')[0].replace(/[^0-9]/g, '');
          const fn = c.presenceWaiters.get(digits);
          if (!fn) continue;
          const d = (pres as any)[participant] || {};
          const online = d.lastKnownPresence === 'online' || d.lastKnownPresence === 'available';
          const lastSeen = Number(d.lastSeen) || 0;
          try { fn({ online, lastSeen }); } catch {}
        }
      } catch {}
    });

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        c.qrCache = qr;
        c.consecutiveFailures = 0;
        broadcast('scanner:qr', { qr, checkerId: id });
        broadcast('scanner:status', { state: 'connecting', qr, checkerId: id });
        logger.info(`[BaileysScanner] checker ${id} QR generated len=` + String(qr).length);
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        logger.warn(`[BaileysScanner] checker ${id} connection close code=${code} wantConnection=${c.wantConnection} hasTask=${!!c.currentTaskId}`);
        c.connectionState = 'close';
        c.sock = null;
        c.qrCache = '';
        c.presenceWaiters.forEach((fn) => { try { fn({ online: false, lastSeen: 0 }); } catch {} });
        c.presenceWaiters.clear();
        c.consecutiveFailures++;
        if (loggedOut) {
          c.wantConnection = false;
          broadcast('scanner:status', { state: 'close', code, checkerId: id, error: '已退出登录，请清除授权后重扫' });
          return;
        }
        // 用户期望连接（正在扫码/等配对码）或有任务在跑：自动重连刷新 QR
        if ((c.wantConnection || c.currentTaskId) && !abortFlag && c.consecutiveFailures <= 10) {
          broadcast('scanner:status', { state: 'connecting', code, checkerId: id, retrying: true });
          if (c.reconnectTimer) clearTimeout(c.reconnectTimer);
          c.reconnectTimer = setTimeout(() => {
            c.reconnectTimer = null;
            if ((c.wantConnection || c.currentTaskId) && !abortFlag) {
              startChecker(id).catch((e) => logger.error(`[BaileysScanner] checker ${id} reconnect failed`, e));
            }
          }, 3000);
        } else {
          if (c.consecutiveFailures > 10) {
            broadcast('scanner:status', { state: 'close', code, checkerId: id, error: '重连失败次数过多，已停止，请点 连接/扫码 重试' });
          } else {
            broadcast('scanner:status', { state: 'close', code, checkerId: id });
          }
        }
      } else if (connection === 'open') {
        c.connectionState = 'open';
        c.qrCache = '';
        c.consecutiveFailures = 0;
        broadcast('scanner:status', { state: 'open', checkerId: id });
        logger.info(`[BaileysScanner] checker ${id} connected`);
      } else if (connection === 'connecting') {
        c.connectionState = 'connecting';
        broadcast('scanner:status', { state: 'connecting', checkerId: id });
      }
    });

    // 等 QR 或 open 再返回（QR 通常 1-5s 到达；wsInvoke 30s 超时，留足余量）
    for (let i = 0; i < 12; i++) {
      if (c.connectionState === 'open') return { connected: true, state: 'open', checkerId: id };
      if (c.qrCache) return { qr: c.qrCache, connected: false, state: 'connecting', checkerId: id };
      await delay(1000);
    }
    return { qr: c.qrCache || undefined, connected: c.connectionState === 'open', state: c.connectionState, checkerId: id };
  } catch (e: any) {
    logger.error(`[BaileysScanner] checker ${id} start failed`, e);
    try { (c.sock as any)?.end?.(undefined); } catch {}
    c.sock = null;
    c.connectionState = 'close';
    broadcast('scanner:status', { state: 'close', checkerId: id, error: String(e?.message || e) });
    throw e;
  }
}

// ---- 历史单会话入口（全部映射到 checker 0，保证旧命令/旧前端零改动可用）----
export async function startScanner(): Promise<{ qr?: string; connected: boolean; state: string }> {
  const r = await startChecker(0);
  return { qr: r.qr, connected: r.connected, state: r.state };
}

export function getScannerStatus(): { state: string; qr: string; taskId: string | null; connected: boolean; checkerCount: number; onlineCount: number; checkers: ReturnType<typeof listCheckers> } {
  const c0 = getChecker(0);
  const online = onlineCheckerIds();
  return {
    state: c0.connectionState, qr: c0.qrCache, taskId: currentTaskId, connected: c0.connectionState === 'open',
    checkerCount: getCheckerCount(), onlineCount: online.length, checkers: listCheckers(),
  };
}

export async function stopChecker(id: number, logout = false): Promise<void> {
  const c = getChecker(id);
  c.wantConnection = false;
  if (c.reconnectTimer) { clearTimeout(c.reconnectTimer); c.reconnectTimer = null; }
  c.currentTaskId = null;
  if (c.sock) {
    try {
      if (logout) await c.sock.logout();
      else c.sock.end(undefined);
    } catch {}
    c.sock = null;
  }
  c.connectionState = 'close';
  c.qrCache = '';
  broadcast('scanner:status', { state: 'close', checkerId: id });
}
export async function stopScanner(logout = false): Promise<void> {
  abortFlag = true;
  paused = false;
  currentTaskId = null;
  // 管理端"断开"按钮=断开池内全部 checker（单号模式时只有 #0，行为与以前一致）
  const n = getCheckerCount();
  for (let i = 0; i < n; i++) {
    try { await stopChecker(i, logout); } catch {}
  }
  setTimeout(() => { abortFlag = false; }, 2000);
}

export function clearCheckerAuth(id: number): void {
  try { rmSync(authDir(id), { recursive: true, force: true }); } catch {}
  mkdirSync(authDir(id), { recursive: true });
}
export function clearScannerAuth(): void {
  clearCheckerAuth(0);
}

// ================== 注册筛查 ==================

// 单号查询（注册+可选头像），供分片循环与补查共用
async function checkOne(c: Checker, raw: string, cfg: ScanCfg): Promise<{ exists: boolean; hasAvatar: boolean; avatarUrl: string; jid: string }> {
  const jid = `${raw}@s.whatsapp.net`;
  if (!c.sock || c.connectionState !== 'open') throw new Error(`checker #${c.id} 未连接`);
  const res = await withTimeout(c.sock.onWhatsApp(jid), 20000, '查询号码');
  const r = Array.isArray(res) ? res[0] : res;
  let exists = false;
  let hasAvatar = false;
  let avatarUrl = '';
  if (r && r.exists) {
    exists = true;
    if (cfg.checkAvatar) {
      try {
        avatarUrl = (await withTimeout(c.sock.profilePictureUrl(r.jid || jid, 'image'), 15000, '头像查询')) || '';
        if (avatarUrl) hasAvatar = true;
      } catch { hasAvatar = false; }
    }
  }
  return { exists, hasAvatar, avatarUrl, jid: (r && (r as any).jid) || jid };
}

function pauseTask(taskId: string, reason?: string): void {
  paused = true;
  getDb().prepare("UPDATE scanner_tasks SET status='paused' WHERE id=?").run(taskId);
  broadcast('scanner:task', { id: taskId, status: 'paused', reason });
  if (reason) logger.warn(`[BaileysScanner] task ${taskId} auto-paused: ${reason}`);
}

async function readTaskProgress(taskId: string): Promise<{ done: number; total: number; valid: number; invalid: number }> {
  const t = getDb().prepare('SELECT done, total, valid_count, invalid_count FROM scanner_tasks WHERE id=?').get(taskId) as any;
  return { done: t?.done || 0, total: t?.total || 0, valid: t?.valid_count || 0, invalid: t?.invalid_count || 0 };
}

// 单个 checker 的注册分片循环（含本分片出错补查）
async function runRegisterShard(checkerId: number, taskId: string, phones: string[], cfg: ScanCfg): Promise<void> {
  const c = getChecker(checkerId);
  const db = getDb();
  const retryQueue: Array<{ raw: string; rid: string }> = [];
  let shardDone = 0;

  const processOne = async (raw: string): Promise<{ ok: boolean; err?: string }> => {
    let r: { exists: boolean; hasAvatar: boolean; avatarUrl: string; jid: string };
    try {
      r = await checkOne(c, raw, cfg);
    } catch (e: any) {
      return { ok: false, err: String(e?.message || e).slice(0, 200) };
    }
    const rid = uuidv4();
    db.prepare(`INSERT INTO scanner_results (id, task_id, phone, jid, exists_flag, has_avatar, avatar_url, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(rid, taskId, raw, r.jid, r.exists ? 1 : 0, r.hasAvatar ? 1 : 0, r.avatarUrl, '', Math.floor(Date.now() / 1000));
    db.prepare(`UPDATE scanner_tasks SET done=done+1, valid_count=valid_count+?, invalid_count=invalid_count+? WHERE id=?`)
      .run(r.exists ? 1 : 0, r.exists ? 0 : 1, taskId);
    return { ok: true };
  };

  for (let i = 0; i < phones.length; i++) {
    if (abortFlag) { pauseTask(taskId); return; }
    while (paused) {
      await delay(1000);
      if (abortFlag) return;
    }
    // 小时上限（每 checker 独立窗口）：到点自动熔断暂停整个任务，需手动继续（保护通道号）
    if (cfg.hourlyCap > 0) {
      const nowH = Date.now();
      if (!c.windowStart || nowH - c.windowStart >= 3600000) { c.windowStart = nowH; c.windowCount = 0; }
      if (c.windowCount >= cfg.hourlyCap) {
        pauseTask(taskId, `checker #${checkerId} 触发小时上限（${cfg.hourlyCap}/时），已自动暂停，冷却后点 开始 继续（断点保留）`);
        return;
      }
    }
    const raw = phones[i];
    const res = await processOne(raw);
    c.windowCount++;
    if (!res.ok) {
      // 失败记一行（供补查），计数照常 +1（done 含失败，避免 resume 死循环）
      const rid = uuidv4();
      db.prepare(`INSERT INTO scanner_results (id, task_id, phone, jid, exists_flag, has_avatar, avatar_url, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(rid, taskId, raw, `${raw}@s.whatsapp.net`, 0, 0, '', res.err || '', Math.floor(Date.now() / 1000));
      db.prepare(`UPDATE scanner_tasks SET done=done+1, invalid_count=invalid_count+1 WHERE id=?`).run(taskId);
      retryQueue.push({ raw, rid });
      // 连续失败熔断：大概率被限流/掉线，自动暂停保号（断点保留）
      const recentErrs = db.prepare(`SELECT COUNT(*) c FROM scanner_results WHERE task_id=? AND error<>'' AND created_at>?`).get(taskId, Math.floor(Date.now() / 1000) - 600) as any;
      if ((recentErrs?.c || 0) >= cfg.maxConsecErr) {
        pauseTask(taskId, `checker #${checkerId} 10分钟内失败 ${recentErrs.c} 次（${(res.err || '').slice(0, 60)}），已熔断暂停，冷却后点 开始 继续（断点保留）`);
        return;
      }
      if ((await sleepInterruptible(5000)) === 'aborted') { pauseTask(taskId); return; }
    }
    shardDone++;
    const p = await readTaskProgress(taskId);
    // 取本号结果用于展示
    const row = db.prepare(`SELECT exists_flag, has_avatar FROM scanner_results WHERE task_id=? AND phone=? ORDER BY created_at DESC LIMIT 1`).get(taskId, raw) as any;
    broadcast('scanner:progress', { taskId, done: p.done, total: p.total, valid: p.valid, invalid: p.invalid, phone: raw, exists: !!row?.exists_flag, hasAvatar: !!row?.has_avatar, checkerId });

    // 防风控间隔：单号随机抖动 + 整批休眠（按本分片计数）
    if (shardDone < phones.length) {
      if (shardDone % cfg.batchSize === 0) {
        const rest = getRandomDelay(cfg.batchRestMinMs, cfg.batchRestMaxMs);
        broadcast('scanner:progress', { taskId, done: p.done, total: p.total, valid: p.valid, invalid: p.invalid, phone: raw, exists: !!row?.exists_flag, hasAvatar: !!row?.has_avatar, checkerId, resting: Math.round(rest / 1000) });
        logger.info(`[BaileysScanner] task ${taskId} checker #${checkerId} batch rest ${Math.round(rest / 1000)}s after ${shardDone}/${phones.length}`);
        if ((await sleepInterruptible(rest)) === 'aborted') { pauseTask(taskId); return; }
      } else {
        if ((await sleepInterruptible(getRandomDelay(cfg.minMs, cfg.maxMs))) === 'aborted') { pauseTask(taskId); return; }
      }
    }
  }

  // 本分片出错自动补查：冷却后只重查报错号码（按 rid 直接 UPDATE）
  for (let round = 1; round <= cfg.retryRounds && retryQueue.length > 0; round++) {
    if (abortFlag) { pauseTask(taskId); return; }
    const p0 = await readTaskProgress(taskId);
    broadcast('scanner:progress', { taskId, done: p0.done, total: p0.total, valid: p0.valid, invalid: p0.invalid, phone: '', exists: false, hasAvatar: false, checkerId, resting: Math.round(cfg.retryCooldownMs / 1000), retryRound: round });
    logger.info(`[BaileysScanner] task ${taskId} checker #${checkerId} retry round ${round}: ${retryQueue.length} error numbers after ${Math.round(cfg.retryCooldownMs / 1000)}s cooldown`);
    if ((await sleepInterruptible(cfg.retryCooldownMs)) === 'aborted') { pauseTask(taskId); return; }
    if (cfg.hourlyCap > 0 && c.windowCount >= cfg.hourlyCap) {
      pauseTask(taskId, `checker #${checkerId} 补查前触发小时上限（${cfg.hourlyCap}/时），已自动暂停，冷却后点 开始 继续（断点保留）`);
      return;
    }
    const batch = retryQueue.splice(0, retryQueue.length);
    for (const item of batch) {
      if (abortFlag) { pauseTask(taskId); return; }
      while (paused) {
        await delay(1000);
        if (abortFlag) return;
      }
      c.windowCount++;
      try {
        const r = await checkOne(c, item.raw, cfg);
        const old = db.prepare('SELECT exists_flag FROM scanner_results WHERE id=?').get(item.rid) as any;
        db.prepare('UPDATE scanner_results SET exists_flag=?, has_avatar=?, avatar_url=?, error=?, jid=? WHERE id=?')
          .run(r.exists ? 1 : 0, r.hasAvatar ? 1 : 0, r.avatarUrl, '', r.jid, item.rid);
        if (r.exists && !old?.exists_flag) {
          db.prepare('UPDATE scanner_tasks SET valid_count=valid_count+1, invalid_count=invalid_count-1 WHERE id=?').run(taskId);
        }
        const p = await readTaskProgress(taskId);
        broadcast('scanner:progress', { taskId, done: p.done, total: p.total, valid: p.valid, invalid: p.invalid, phone: item.raw, exists: r.exists, hasAvatar: r.hasAvatar, checkerId, retryRound: round });
      } catch (e: any) {
        const msg = String(e?.message || e).slice(0, 200);
        db.prepare('UPDATE scanner_results SET error=? WHERE id=?').run(msg, item.rid);
        if (round >= cfg.retryRounds) {
          logger.warn(`[BaileysScanner] task ${taskId} checker #${checkerId} retry exhausted for ${item.raw}: ${msg.slice(0, 60)}`);
        } else {
          retryQueue.push(item);
        }
      }
      if ((await sleepInterruptible(getRandomDelay(cfg.minMs, cfg.maxMs))) === 'aborted') { pauseTask(taskId); return; }
    }
  }
}

export async function runScanTask(taskId: string): Promise<void> {
  const db = getDb();
  const task = db.prepare('SELECT * FROM scanner_tasks WHERE id = ?').get(taskId) as any;
  if (!task) throw new Error('任务不存在');
  const online = onlineCheckerIds();
  if (online.length === 0) throw new Error('没有在线通道号，请先扫码/配对码登录至少一个 checker');

  // 单任务模型：池子同时只跑一个任务（多 checker 是分片加速，不是双任务并发）
  if (currentTaskId && currentTaskId !== taskId) {
    throw new Error('已有筛号任务在跑，请先暂停/中止它再开始新任务');
  }
  currentTaskId = taskId;
  abortFlag = false;
  paused = false;
  online.forEach((id) => { getChecker(id).currentTaskId = taskId; });
  db.prepare("UPDATE scanner_tasks SET status='running' WHERE id=?").run(taskId);
  broadcast('scanner:task', { id: taskId, status: 'running', checkers: online });
  try {
    const numbers: string[] = JSON.parse(task.phones_json as string);
    // resume：跳过已有结果的号码（断点保留，分片天然支持）
    const existing = new Set((db.prepare('SELECT phone FROM scanner_results WHERE task_id=?').all(taskId) as any[]).map((r) => String(r.phone)));
    const queue = numbers.map((p) => String(p).replace(/[^0-9]/g, '')).filter((p) => p && !existing.has(p));
    const cfg = getScanCfg();
    logger.info(`[BaileysScanner] task ${taskId} start kind=register with ${online.length} checkers, ${queue.length} pending (total ${numbers.length}) cfg ${cfg.mode} ${cfg.minMs}-${cfg.maxMs}ms`);
    // 轮询分片：号码均匀摊到在线 checker
    const shards: string[][] = online.map(() => []);
    queue.forEach((p, i) => { shards[i % shards.length].push(p); });
    await Promise.all(shards.map((phones, k) => runRegisterShard(online[k], taskId, phones, cfg)));
    // 收尾判定：abort 优先（覆盖"暂停中被中止"的竞态，此时分片直接返回、状态仍是 running，
    // 若不处理会被误判为 completed）；否则 running 才算正常跑完
    if (abortFlag) {
      pauseTask(taskId, '任务已中止（断点保留，可点 开始 继续）');
    } else {
      const st = (db.prepare('SELECT status FROM scanner_tasks WHERE id=?').get(taskId) as any)?.status;
      if (st === 'running') {
        db.prepare("UPDATE scanner_tasks SET status='completed', finished_at=? WHERE id=?").run(Math.floor(Date.now() / 1000), taskId);
        broadcast('scanner:task', { id: taskId, status: 'completed' });
      }
    }
  } finally {
    if (currentTaskId === taskId) currentTaskId = null;
    online.forEach((id) => { const cc = getChecker(id); if (cc.currentTaskId === taskId) cc.currentTaskId = null; });
  }
}

// Web 通道任务：用管理器里已登录的 whatsapp-web.js 账号直查（免扫码免配对）。
// 结果写同一张 scanner_results 表，查看/导出/删除与池任务完全通用。
export async function runWebTask(taskId: string, getClient: () => any): Promise<void> {
  const db = getDb();
  const task = db.prepare('SELECT * FROM scanner_tasks WHERE id = ?').get(taskId) as any;
  if (!task) throw new Error('任务不存在');
  if (currentTaskId && currentTaskId !== taskId) {
    throw new Error('已有任务在跑，请先暂停/中止它再开始新任务');
  }
  const client = getClient();
  if (!client) throw new Error('通道账号未登录：请先在 账号管理 登录该账号');
  currentTaskId = taskId;
  abortFlag = false;
  paused = false;
  db.prepare("UPDATE scanner_tasks SET status='running' WHERE id=?").run(taskId);
  broadcast('scanner:task', { id: taskId, status: 'running', channel: 'web' });
  try {
    const numbers: string[] = JSON.parse(task.phones_json as string);
    const existing = new Set((db.prepare('SELECT phone FROM scanner_results WHERE task_id=?').all(taskId) as any[]).map((r) => String(r.phone)));
    const queue = numbers.map((p) => String(p).replace(/[^0-9]/g, '')).filter((p) => p && !existing.has(p));
    const cfg = getScanCfg();
    logger.info(`[BaileysScanner] task ${taskId} start kind=register channel=web, ${queue.length} pending (total ${numbers.length})`);
    for (let i = 0; i < queue.length; i++) {
      if (abortFlag) { pauseTask(taskId); return; }
      while (paused) {
        await delay(1000);
        if (abortFlag) return;
      }
      const raw = queue[i];
      const jid = `${raw}@c.us`;
      let exists = false;
      let hasAvatar = false;
      let avatarUrl = '';
      let error = '';
      let outJid = jid;
      try {
        if (typeof client.isRegisteredUser === 'function') {
          exists = await withTimeout(client.isRegisteredUser(jid), 20000, '查询号码');
        } else if (typeof client.getNumberId === 'function') {
          const num = await withTimeout(client.getNumberId(jid), 20000, '查询号码');
          exists = !!num;
          if (num) outJid = (num as any)._serialized || (num as any).user || jid;
        } else {
          throw new Error('当前通道 Client 不支持 isRegisteredUser/getNumberId');
        }
        if (exists && cfg.checkAvatar) {
          try {
            const contact: any = await withTimeout(client.getContactById(outJid), 15000, '取联系人');
            avatarUrl = (await withTimeout(contact.getProfilePicUrl(), 15000, '头像查询')) || '';
            if (avatarUrl) hasAvatar = true;
          } catch { hasAvatar = false; }
        }
      } catch (e: any) {
        error = String(e?.message || e).slice(0, 200);
      }
      const rid = uuidv4();
      db.prepare(`INSERT INTO scanner_results (id, task_id, phone, jid, exists_flag, has_avatar, avatar_url, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(rid, taskId, raw, outJid, exists ? 1 : 0, hasAvatar ? 1 : 0, avatarUrl, error, Math.floor(Date.now() / 1000));
      db.prepare(`UPDATE scanner_tasks SET done=done+1, valid_count=valid_count+?, invalid_count=invalid_count+? WHERE id=?`)
        .run(exists ? 1 : 0, exists ? 0 : 1, taskId);
      const p = await readTaskProgress(taskId);
      broadcast('scanner:progress', { taskId, done: p.done, total: p.total, valid: p.valid, invalid: p.invalid, phone: raw, exists, hasAvatar, checkerId: -1 });
      // Web 通道固定约 1s/号（官方客户端，激进会被限流）
      if (i + 1 < queue.length) {
        if ((await sleepInterruptible(1000)) === 'aborted') { pauseTask(taskId); return; }
      }
    }
    if (abortFlag) {
      pauseTask(taskId, '任务已中止（断点保留，可点 开始 继续）');
    } else {
      const st = (db.prepare('SELECT status FROM scanner_tasks WHERE id=?').get(taskId) as any)?.status;
      if (st === 'running') {
        db.prepare("UPDATE scanner_tasks SET status='completed', finished_at=? WHERE id=?").run(Math.floor(Date.now() / 1000), taskId);
        broadcast('scanner:task', { id: taskId, status: 'completed' });
      }
    }
  } finally {
    if (currentTaskId === taskId) currentTaskId = null;
  }
}

export function isScanRunning(): boolean { return currentTaskId !== null; }
export function pauseScan(): void { paused = true; broadcast('scanner:task', { id: currentTaskId, status: 'paused' }); }
export function resumeScan(): void { paused = false; broadcast('scanner:task', { id: currentTaskId, status: 'running' }); }
export function abortScan(): void { abortFlag = true; }

// ================== 活跃度（presence） ==================
// 结果只有三种：online（此刻在线）/ recent（有最后在线时间）/ hidden（对方关隐私或超时无信号）。
// hidden ≠ 不活跃，这是协议限制，任何工具都一样。unregistered=未开通，error=查询异常。

function waitPresence(c: Checker, digits: string, timeoutMs: number): Promise<{ online: boolean; lastSeen: number }> {
  return new Promise((resolve) => {
    const to = setTimeout(() => {
      c.presenceWaiters.delete(digits);
      resolve({ online: false, lastSeen: 0 });
    }, timeoutMs);
    c.presenceWaiters.set(digits, (p) => {
      clearTimeout(to);
      c.presenceWaiters.delete(digits);
      resolve(p);
    });
    try {
      c.sock.presenceSubscribe(`${digits}@s.whatsapp.net`);
    } catch {
      clearTimeout(to);
      c.presenceWaiters.delete(digits);
      resolve({ online: false, lastSeen: 0 });
    }
  });
}

async function checkPresenceOne(c: Checker, raw: string, cfg: ScanCfg): Promise<{ status: string; lastSeen: number; jid: string }> {
  const jid = `${raw}@s.whatsapp.net`;
  if (!c.sock || c.connectionState !== 'open') throw new Error(`checker #${c.id} 未连接`);
  const res = await withTimeout(c.sock.onWhatsApp(jid), 20000, '查询号码');
  const r = Array.isArray(res) ? res[0] : res;
  if (!r || !r.exists) return { status: 'unregistered', lastSeen: 0, jid };
  const targetJid = (r as any).jid || jid;
  const p = await waitPresence(c, raw, cfg.presenceTimeoutMs);
  if (p.online) return { status: 'online', lastSeen: 0, jid: targetJid };
  if (p.lastSeen > 0) return { status: 'recent', lastSeen: p.lastSeen, jid: targetJid };
  return { status: 'hidden', lastSeen: 0, jid: targetJid };
}

async function runPresenceShard(checkerId: number, taskId: string, phones: string[], cfg: ScanCfg): Promise<void> {
  const c = getChecker(checkerId);
  const db = getDb();
  let shardDone = 0;
  for (let i = 0; i < phones.length; i++) {
    if (abortFlag) { pauseTask(taskId); return; }
    while (paused) {
      await delay(1000);
      if (abortFlag) return;
    }
    if (cfg.hourlyCap > 0) {
      const nowH = Date.now();
      if (!c.windowStart || nowH - c.windowStart >= 3600000) { c.windowStart = nowH; c.windowCount = 0; }
      if (c.windowCount >= cfg.hourlyCap) {
        pauseTask(taskId, `checker #${checkerId} 触发小时上限（${cfg.hourlyCap}/时），已自动暂停，冷却后点 开始 继续（断点保留）`);
        return;
      }
    }
    const raw = phones[i];
    let status = 'hidden';
    let lastSeen = 0;
    let jid = `${raw}@s.whatsapp.net`;
    let error = '';
    try {
      const r = await checkPresenceOne(c, raw, cfg);
      status = r.status; lastSeen = r.lastSeen; jid = r.jid;
    } catch (e: any) {
      error = String(e?.message || e).slice(0, 200);
      status = 'error';
    }
    c.windowCount++;
    const rid = uuidv4();
    const nowSec = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO presence_results (id, task_id, phone, jid, status, last_seen, checker_id, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(rid, taskId, raw, jid, status, lastSeen || null, checkerId, error, nowSec);
    if (!error) {
      db.prepare('INSERT INTO presence_cache (phone, status, last_seen, checked_at) VALUES (?,?,?,?) ON CONFLICT(phone) DO UPDATE SET status=?, last_seen=?, checked_at=?')
        .run(raw, status, lastSeen || null, nowSec, status, lastSeen || null, nowSec);
    }
    // 进度计数语义（活跃度任务）：valid=有信号(online+recent)，invalid=无信号/未开通/异常
    const hasSignal = status === 'online' || status === 'recent';
    db.prepare(`UPDATE scanner_tasks SET done=done+1, valid_count=valid_count+?, invalid_count=invalid_count+? WHERE id=?`)
      .run(hasSignal ? 1 : 0, hasSignal ? 0 : 1, taskId);
    shardDone++;
    const p = await readTaskProgress(taskId);
    broadcast('presence:progress', { taskId, done: p.done, total: p.total, valid: p.valid, invalid: p.invalid, phone: raw, status, checkerId });

    if (shardDone < phones.length) {
      if (shardDone % cfg.batchSize === 0) {
        const rest = getRandomDelay(cfg.batchRestMinMs, cfg.batchRestMaxMs);
        broadcast('presence:progress', { taskId, done: p.done, total: p.total, valid: p.valid, invalid: p.invalid, phone: raw, status, checkerId, resting: Math.round(rest / 1000) });
        logger.info(`[BaileysScanner] presence task ${taskId} checker #${checkerId} batch rest ${Math.round(rest / 1000)}s after ${shardDone}/${phones.length}`);
        if ((await sleepInterruptible(rest)) === 'aborted') { pauseTask(taskId); return; }
      } else {
        if ((await sleepInterruptible(getRandomDelay(cfg.presenceGapMs, Math.max(cfg.presenceGapMs, cfg.presenceGapMs + 2000)))) === 'aborted') { pauseTask(taskId); return; }
      }
    }
  }
}

export async function runPresenceTask(taskId: string): Promise<void> {
  const db = getDb();
  const task = db.prepare('SELECT * FROM scanner_tasks WHERE id = ?').get(taskId) as any;
  if (!task) throw new Error('任务不存在');
  const online = onlineCheckerIds();
  if (online.length === 0) throw new Error('没有在线通道号，请先扫码/配对码登录至少一个 checker');
  if (currentTaskId && currentTaskId !== taskId) {
    throw new Error('已有任务在跑，请先暂停/中止它再开始新任务');
  }
  currentTaskId = taskId;
  abortFlag = false;
  paused = false;
  online.forEach((id) => { getChecker(id).currentTaskId = taskId; });
  db.prepare("UPDATE scanner_tasks SET status='running' WHERE id=?").run(taskId);
  broadcast('presence:task', { id: taskId, status: 'running', checkers: online });
  try {
    const numbers: string[] = JSON.parse(task.phones_json as string);
    const cfg = getScanCfg();
    // resume：跳过已有结果
    const existing = new Set((db.prepare('SELECT phone FROM presence_results WHERE task_id=?').all(taskId) as any[]).map((r) => String(r.phone)));
    let queue = numbers.map((p) => String(p).replace(/[^0-9]/g, '')).filter((p) => p && !existing.has(p));
    // 缓存预填：N 天内查过的直接复用，不消耗配额
    const nowSec = Math.floor(Date.now() / 1000);
    if (cfg.presenceCacheDays > 0) {
      const fresh: string[] = [];
      for (const raw of queue) {
        const hit = db.prepare('SELECT status, last_seen, checked_at FROM presence_cache WHERE phone=?').get(raw) as any;
        if (hit && nowSec - hit.checked_at < cfg.presenceCacheDays * 86400) {
          db.prepare(`INSERT INTO presence_results (id, task_id, phone, jid, status, last_seen, checker_id, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(uuidv4(), taskId, raw, `${raw}@s.whatsapp.net`, hit.status, hit.last_seen, -1, '', nowSec);
          const hasSignal = hit.status === 'online' || hit.status === 'recent';
          db.prepare(`UPDATE scanner_tasks SET done=done+1, valid_count=valid_count+?, invalid_count=invalid_count+? WHERE id=?`)
            .run(hasSignal ? 1 : 0, hasSignal ? 0 : 1, taskId);
        } else {
          fresh.push(raw);
        }
      }
      if (fresh.length < queue.length) {
        logger.info(`[BaileysScanner] presence task ${taskId} cache hit ${queue.length - fresh.length}/${queue.length}`);
      }
      queue = fresh;
    }
    logger.info(`[BaileysScanner] task ${taskId} start kind=presence with ${online.length} checkers, ${queue.length} pending`);
    const shards: string[][] = online.map(() => []);
    queue.forEach((p, i) => { shards[i % shards.length].push(p); });
    await Promise.all(shards.map((phones, k) => runPresenceShard(online[k], taskId, phones, cfg)));
    if (abortFlag) {
      pauseTask(taskId, '任务已中止（断点保留，可点 开始 继续）');
      broadcast('presence:task', { id: taskId, status: 'paused' });
    } else {
      const st = (db.prepare('SELECT status FROM scanner_tasks WHERE id=?').get(taskId) as any)?.status;
      if (st === 'running') {
        db.prepare("UPDATE scanner_tasks SET status='completed', finished_at=? WHERE id=?").run(nowSec, taskId);
        broadcast('presence:task', { id: taskId, status: 'completed' });
      } else {
        broadcast('presence:task', { id: taskId, status: st });
      }
    }
  } finally {
    if (currentTaskId === taskId) currentTaskId = null;
    online.forEach((id) => { const cc = getChecker(id); if (cc.currentTaskId === taskId) cc.currentTaskId = null; });
  }
}

// ================== 配对码 ==================

function normalizePairPhone(phone: string): string {
  // 号码归一化：去空格/+/横线；00 国际前缀转为无前缀；单个 0 开头大概率缺区号
  let clean = String(phone).replace(/[^0-9]/g, '');
  if (clean.startsWith('00')) clean = clean.slice(2);
  if (clean.length < 8 || clean.length > 15) {
    throw new Error(`号码格式不对（${clean || '空'}）：需 8-15 位纯数字并带国家区号，如 86138…/8869…（不用加 +，00 开头请去掉）`);
  }
  if (/^0/.test(clean)) {
    throw new Error(`号码格式不对（${clean}）：开头有 0，请去掉 0 并加上国家区号，如 86138…`);
  }
  return clean;
}

export async function requestCheckerPairingCode(id: number, phone: string): Promise<string> {
  const c = getChecker(id);
  const clean = normalizePairPhone(phone);
  const now = Date.now();
  if (now - c.lastPairAt < 30000) {
    const wait = Math.ceil((30000 - (now - c.lastPairAt)) / 1000);
    throw new Error(`请等待 ${wait}s 后再试（WA 限流，频繁请求会封通道）`);
  }
  if (c.connectionState === 'open' && c.sock) {
    throw new Error(`checker #${id} 已登录，无需配对码（直接建筛号任务即可）`);
  }
  if (!c.sock || c.connectionState === 'close') {
    await startChecker(id);
  }
  // 关键：必须等 Noise 握手完成（以收到 QR 或 open 为准）再发 pairing，
  // 否则提前发送会报 Connection Closed，还会把本次握手搞挂。实测 QR 约 1-5s 到达。
  let ready = false;
  for (let i = 0; i < 30; i++) {
    if (!c.sock || c.connectionState === 'close') break;
    if (c.qrCache || c.connectionState === 'open') { ready = true; break; }
    await delay(500);
  }
  if (!ready || !c.sock || c.connectionState === 'close') {
    throw new Error(`checker #${id} 未就绪（WA 未连上）：请先点 连接/扫码，等二维码出现后再获码`);
  }
  const tryOnce = async (): Promise<string> => {
    const code: string = await (c.sock as any).requestPairingCode(clean);
    return code;
  };
  try {
    let code: string;
    try {
      code = await tryOnce();
    } catch (e: any) {
      if (/Connection Closed/i.test(String(e?.message || e))) {
        logger.warn(`[BaileysScanner] checker ${id} pairingCode Connection Closed, retry after 2s`);
        await delay(2000);
        // 确保仍在 connecting
        if (c.connectionState === 'close') await startChecker(id);
        await delay(1500);
        code = await tryOnce();
      } else throw e;
    }
    c.lastPairAt = Date.now();
    const display = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pretty = display.length === 8 ? `${display.slice(0, 4)}-${display.slice(4)}` : code;
    logger.info(`[BaileysScanner] checker ${id} pairing code for ${clean}: ${pretty} (raw=${code})`);
    broadcast('scanner:pairing_code', { phone: clean, code: pretty, checkerId: id });
    return pretty;
  } catch (e: any) {
    const msg = String(e?.message || e);
    logger.error(`[BaileysScanner] checker ${id} pairingCode failed for ${clean}: ${msg}`);
    if (/Too many|rate|429|try again/i.test(msg)) throw new Error('WA 限流：pairingCode 请求过于频繁，请 1-2 分钟后再试');
    if (/Connection Closed|Terminated|not connected|not open|closed/i.test(msg)) throw new Error('通道刚断开重连中：请等二维码重新出现后再获码（约 3-5s）');
    throw new Error(`获取配对码失败：${msg.slice(0, 160)}`);
  }
}
export async function requestPairingCode(phone: string): Promise<string> {
  return requestCheckerPairingCode(0, phone);
}

// helpers for commands
export function createTask(phones: string[], name?: string, kind: string = 'register', channel: string = 'pool'): string {
  const id = uuidv4();
  const cleaned = phones.map((p) => String(p).replace(/[^0-9]/g, '')).filter((p) => p.length >= 8 && p.length <= 16);
  if (cleaned.length === 0) throw new Error('无有效号码（需8-16位数字，含国际区号）');
  const k = kind === 'presence' ? 'presence' : 'register';
  const cap = k === 'presence' ? 2000 : 5000;
  if (cleaned.length > cap) throw new Error(`单次最多${cap}条，请分批${k === 'presence' ? '（活跃度查询慢，建议≤500）' : ''}`);
  const ch = channel && channel.startsWith('web:') ? channel.slice(0, 64) : 'pool';
  getDb().prepare(`INSERT INTO scanner_tasks (id, name, kind, channel, phones_json, total, done, valid_count, invalid_count, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name || `${k === 'presence' ? '活跃度' : '筛选'}-${new Date().toISOString().slice(0, 10)}`, k, ch, JSON.stringify(cleaned), cleaned.length, 0, 0, 0, 'pending', Math.floor(Date.now() / 1000));
  return id;
}
export function createPresenceTask(phones: string[], name?: string): string {
  return createTask(phones, name, 'presence');
}
