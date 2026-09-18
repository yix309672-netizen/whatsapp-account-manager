import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { app as electronApp } from 'electron';

// electron userData 目录（导出文件所在）。用函数包一层：单元测试/非 electron 环境 require 失败时抛错而不是启动即崩
function getElectronUserData(): string {
  return electronApp.getPath('userData');
}
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join, extname, dirname, basename } from 'path';
import { randomBytes, createHash } from 'crypto';
import { handleCommand, CommandContext } from '../commands';
import { WhatsAppSessionManager } from '../services/WhatsAppSessionManager';
import { logger } from '../utils/logger';
import { checkRateLimit, recordFailedAttempt, clearRateLimit, auditLog } from '../utils/security';
// 注：管理端 IP 白名单已下线（仅保留员工端）。ipAllow 工具保留给员工登录链使用。

// ==================== 会话 token 管理 ====================

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天（避免长时间不用被强制重新登录）
interface WebSession { exp: number; role: 'admin' | 'employee'; employeeId?: string }
const sessions = new Map<string, WebSession>(); // token -> 会话（含角色）

// 登录态落盘：管理器重启后仍有效，避免"重启一次就要求重新登录"
function sessionsFile(): string {
  return join(getElectronUserData(), 'web-sessions.json');
}
function loadSessions(): void {
  try {
    const f = sessionsFile();
    if (!existsSync(f)) return;
    const arr = JSON.parse(readFileSync(f, 'utf8')) as Array<[string, WebSession]>;
    const now = Date.now();
    for (const [t, s] of arr) if (t && s && typeof s.exp === 'number' && s.exp > now) sessions.set(t, s);
    logger.info(`Loaded ${sessions.size} persisted web session(s)`);
  } catch { /* 忽略损坏文件 */ }
}
function saveSessions(): void {
  try {
    const now = Date.now();
    const arr = [...sessions.entries()].filter(([, s]) => s.exp > now);
    writeFileSync(sessionsFile(), JSON.stringify(arr), 'utf8');
  } catch { /* ignore */ }
}

function issueToken(role: 'admin' | 'employee' = 'admin', employeeId?: string): string {
  const token = randomBytes(24).toString('hex');
  sessions.set(token, { exp: Date.now() + TOKEN_TTL_MS, role, employeeId });
  saveSessions();
  return token;
}

function getSession(token: string | null | undefined): WebSession | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function isValidToken(token: string | null | undefined): boolean {
  return getSession(token) !== null;
}

function isAdminToken(token: string | null | undefined): boolean {
  const s = getSession(token);
  return !!s && s.role === 'admin';
}

function revokeToken(token: string): void {
  sessions.delete(token);
  saveSessions();
}

// ==================== 图形验证码（登录防护） ====================

const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5 分钟
const captchas = new Map<string, { text: string; exp: number }>();
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆 0O1l

function makeCaptcha(): { id: string; text: string } {
  let text = '';
  const buf = randomBytes(4);
  for (let i = 0; i < 4; i++) text += CAPTCHA_CHARS[buf[i] % CAPTCHA_CHARS.length];
  const id = randomBytes(12).toString('hex');
  captchas.set(id, { text, exp: Date.now() + CAPTCHA_TTL_MS });
  if (captchas.size > 500) {
    const oldest = [...captchas.entries()].sort((a, b) => a[1].exp - b[1].exp)[0];
    if (oldest) captchas.delete(oldest[0]);
  }
  return { id, text };
}

function checkCaptcha(id: string, input: string): boolean {
  const rec = captchas.get(String(id || ''));
  captchas.delete(String(id || ''));
  if (!rec || Date.now() > rec.exp) return false;
  return rec.text === String(input || '').trim().toUpperCase();
}

// 聊天专用频率桶（固定窗口计数；登录限流器只记失败，不适用高频正常流量）
const chatBuckets = new Map<string, { count: number; reset: number }>();
function chatBucket(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const e = chatBuckets.get(key);
  if (!e || now >= e.reset) {
    chatBuckets.set(key, { count: 1, reset: now + windowMs });
    if (chatBuckets.size > 5000) {
      for (const [k, v] of chatBuckets) {
        if (v.reset <= now) chatBuckets.delete(k);
        if (chatBuckets.size <= 4000) break;
      }
    }
    return true;
  }
  if (e.count >= max) return false;
  e.count++;
  return true;
}

function captchaSvg(text: string): string {
  const w = 120;
  const h = 44;
  let chars = '';
  for (let i = 0; i < text.length; i++) {
    const x = 14 + i * 26;
    const y = 30;
    const rot = (randomBytes(1)[0] % 41) - 20;
    const c = ['#b45309', '#92400e', '#78350f', '#451a03'][randomBytes(1)[0] % 4];
    chars += `<text x="${x}" y="${y}" font-size="26" font-weight="bold" font-family="Georgia,serif" fill="${c}" transform="rotate(${rot} ${x} ${y})">${text[i]}</text>`;
  }
  let noise = '';
  for (let i = 0; i < 5; i++) {
    const x1 = randomBytes(1)[0] % w;
    const y1 = randomBytes(1)[0] % h;
    const x2 = randomBytes(1)[0] % w;
    const y2 = randomBytes(1)[0] % h;
    noise += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#d6a756" stroke-width="1" opacity="0.6"/>`;
  }
  for (let i = 0; i < 24; i++) {
    noise += `<circle cx="${randomBytes(1)[0] % w}" cy="${randomBytes(1)[0] % h}" r="1" fill="#a16207" opacity="0.5"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fef3c7"/>${noise}${chars}</svg>`;
}

// ==================== 管理员账号密码（admin_users 表） ====================

import { getDb } from '../utils/db';

function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(salt + password).digest('hex');
}

function verifyAdmin(username: string, password: string): boolean {
  const row = getDb()
    .prepare('SELECT * FROM admin_users WHERE username = ?')
    .get(String(username || '').trim()) as { salt: string; password_hash: string } | undefined;
  if (!row) return false;
  return hashPassword(String(password || ''), row.salt) === row.password_hash;
}

function changeAdminPassword(username: string, oldPwd: string, newPwd: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(String(username || '').trim()) as
    | { salt: string; password_hash: string }
    | undefined;
  if (!row) return false;
  if (hashPassword(oldPwd, row.salt) !== row.password_hash) return false;
  if (!newPwd || newPwd.length < 6) return false;
  const newSalt = randomBytes(16).toString('hex');
  const newHash = hashPassword(newPwd, newSalt);
  db.prepare('UPDATE admin_users SET salt = ?, password_hash = ? WHERE username = ?').run(newSalt, newHash, String(username).trim());
  // 改密码后吊销所有 token，并且**必须落盘**：loadSessions() 会在下次启动时把
  // web-sessions.json 里的 token 读回内存，不落盘的话旧 token 重启后就会"复活"。
  for (const [t] of sessions) sessions.delete(t);
  saveSessions();
  // 同时断开所有在线连接：已吊销的会话不该继续拥有全权命令能力
  for (const c of [...clients]) {
    try { c.ws.close(); } catch { /* ignore */ }
    clients.delete(c);
  }
  return true;
}

// ==================== 静态文件 ====================

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function sendStatic(req: IncomingMessage, res: ServerResponse, staticDir: string): void {
  // decodeURIComponent 对畸形编码（/%、/%zz、/%E0%A4%A）会抛 URIError；
  // 以前没兜住 → 异常逃出 async handler → 请求永久挂死。这里回 400。
  let url: URL;
  let pathname: string;
  try {
    url = new URL(req.url || '/', 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  // 未知 /api/* 不要回退成 index.html（会让前端拿到 HTML 却按 JSON 解析，报错难排查）
  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
    return;
  }
  // 防目录穿越
  if (pathname.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const filePath = join(staticDir, pathname);
  // existsSync 对目录也返回 true，直接 readFileSync 会抛 EISDIR（以前同样挂死请求）
  let isFile = false;
  try {
    isFile = existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    // SPA fallback：非文件路径回退到 index.html
    const fallback = join(staticDir, 'index.html');
    try {
      if (existsSync(fallback)) {
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache, must-revalidate' });
        res.end(readFileSync(fallback));
        return;
      }
    } catch { /* 落到 404 */ }
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const ext = extname(filePath).toLowerCase();
  // 哈希命名的静态资源可长缓存；HTML 必须每次校验，否则前端更新后用户看不到新版
  const isHtml = ext === '.html';
  const cache = isHtml
    ? 'no-cache, must-revalidate'
    : (/assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
  try {
    const body = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(body);
  } catch (err) {
    logger.warn(`sendStatic failed for ${pathname}:`, err);
    res.writeHead(500);
    res.end('Internal Error');
  }
}

/**
 * 读取请求体。
 *
 * ⚠️ 安全/稳定性修复：以前没有任何上限、超时，也不处理连接中断。
 *  - 声明 `Content-Length: 500000000` 持续发送 → chunks 全量驻留 + Buffer.concat 再复制一份，
 *    峰值约 2 倍体积，可直接把主进程 OOM（连带所有 WhatsApp 会话掉线）；
 *  - 声明长度只发一部分就 RST → Node 只 emit aborted/close，**不 emit end/error**，
 *    Promise 永不 settle，handler 永远 await 挂住；
 *  - 长度不符时会一直占着 socket 到默认 requestTimeout(300s)。
 * 现在：64KB 上限 + 10s 超时 + aborted/close 兜底，超限直接 destroy。
 */
const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 10_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try { req.destroy(); } catch { /* ignore */ }
        reject(new Error('body timeout'));
      });
    }, BODY_TIMEOUT_MS);

    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish(() => {
          try { req.destroy(); } catch { /* ignore */ }
          reject(new Error('body too large'));
        });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', (err) => finish(() => reject(err)));
    // 客户端中断时 Node 不会 emit end/error，必须自己兜住
    req.on('aborted', () => finish(() => reject(new Error('aborted'))));
    req.on('close', () => finish(() => reject(new Error('closed'))));
  });
}

/** 统一的请求体读取 + 错误响应：超限 413，其余 400 */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  try {
    return await readBody(req);
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg === 'body too large') {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '请求体过大' }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '请求体读取失败' }));
    }
    return null;
  }
}

// ==================== 可信 IP 解析 ====================
/**
 * 取客户端 IP。
 *
 * ⚠️ 安全修复：以前无条件采信 `cf-connecting-ip` / `x-forwarded-for`。
 * 服务监听 0.0.0.0 时，攻击者直连端口并自带这两个头，就能让**所有按 IP 分桶的限流**
 * 与**员工 IP 白名单**失效（每次换一个值 = 无限次尝试）。
 * 现在只有对端确实是本机/内网反代（Nginx、cloudflared 等）时才采信转发头，
 * 否则一律使用 TCP 对端地址。
 */
function isTrustedProxy(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const a = remoteAddress.replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  return false;
}

function getClientIp(req: IncomingMessage): string {
  const remote = req.socket?.remoteAddress || '';
  if (isTrustedProxy(remote)) {
    const cf = req.headers['cf-connecting-ip'] as string | undefined;
    if (cf) return cf.trim();
    const xff = req.headers['x-forwarded-for'] as string | undefined;
    if (xff) return (xff.split(',')[0] || '').trim();
  }
  return remote || 'unknown';
}

// ==================== 公开配对接口的全局闸门 ====================
// ⚠️ 安全/稳定性修复：这些状态以前声明在 HTTP 请求回调**内部**，等于每个请求各自
// 重置一份（pairingConcurrent 每次都是 0、inflight 每次都是空），于是注释里宣称的
// "全局并发 + 排队 + 同号去重"全部不存在 —— 公开接口可被并发刷出大量 headless Chrome
// （每个数百 MB）把管理器压垮。现在提升到模块作用域，真正全局生效。
const PAIRING_MAX_CONCURRENT = 3;   // headless Chrome 很重，3 个并发足够
const PAIRING_QUEUE_MAX = 20;
const pairingInflight = new Set<string>();
let pairingConcurrent = 0;
const pairingQueue: Array<{ phone: string; resolve: (v: unknown) => void; reject: (e: Error) => void; start: number }> = [];

function processPairingQueue(sessionManager: WhatsAppSessionManager): void {
  while (pairingQueue.length > 0 && pairingConcurrent < PAIRING_MAX_CONCURRENT) {
    const job = pairingQueue.shift()!;
    if (Date.now() - job.start > 25000) {
      job.reject(new Error('排队超时，请重试'));
      continue;
    }
    pairingConcurrent++;
    pairingInflight.add(job.phone);
    handleCommand({ sessionManager }, 'account:request_pairing_with_phone', { phoneNumber: job.phone })
      .then((r) => job.resolve(r))
      .catch((e) => job.reject(e))
      .finally(() => {
        pairingConcurrent--;
        pairingInflight.delete(job.phone);
        processPairingQueue(sessionManager);
      });
  }
}

/** 把一次配对请求放进全局队列，返回其结果 */
function enqueuePairing(phone: string, sessionManager: WhatsAppSessionManager): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pairingQueue.push({ phone, resolve, reject, start: Date.now() });
    processPairingQueue(sessionManager);
  });
}

// ==================== Web 服务器 ====================

export interface WebServerOptions {
  port: number;
  staticDir: string;
  sessionManager: WhatsAppSessionManager;
  adminPassword: string;
  passwordFile: string;
}

let httpServer: Server | null = null;
let wss: WebSocketServer | null = null;

/**
 * 已订阅事件的 WebSocket 连接。
 *
 * ⚠️ 安全修复：以前这里是 `Set<WebSocket>`，并且在 upgrade 后**无条件** add ——
 * 而 `/ws?employee=1` 是免 token 放行的，于是任何人只要连上来（不发任何命令）
 * 就能收到所有账号的 account:qr / account:pairing_code / account:ready 广播。
 * 二维码/配对码本身就是可用来接管 WhatsApp 会话的凭据，等于零凭据泄露。
 * 现在改为：只有**已鉴权**的连接才登记，并且记录角色与归属，员工只能收到自己账号的事件。
 */
interface SubscribedClient {
  ws: WebSocket;
  role: 'admin' | 'employee';
  employeeId?: string;
  token: string;
}
const clients = new Set<SubscribedClient>();

function sendToClient(c: SubscribedClient, payload: string): void {
  if (c.ws.readyState === WebSocket.OPEN) {
    try { c.ws.send(payload); } catch { /* 连接已坏，交给 close 事件清理 */ }
  }
}

/** 账号是否属于该员工（用于事件定向投递） */
function accountBelongsToEmployee(accountId: string, employeeId: string): boolean {
  try {
    const row = getDb()
      .prepare('SELECT assigned_to FROM accounts WHERE id = ?')
      .get(accountId) as { assigned_to: string | null } | undefined;
    return !!row && row.assigned_to === employeeId;
  } catch {
    return false;
  }
}

export function broadcastWebEvent(channel: string, data: Record<string, unknown>): void {
  const payload = JSON.stringify({ type: 'event', channel, data });
  const accountId = typeof data?.accountId === 'string' ? data.accountId : '';
  for (const c of clients) {
    // 管理员看全部；员工只能看分配给自己的账号事件，避免越权拿到别人的二维码
    if (c.role !== 'admin') {
      if (!accountId || !c.employeeId) continue;
      if (!accountBelongsToEmployee(accountId, c.employeeId)) continue;
    }
    sendToClient(c, payload);
  }
}

/** 吊销某个员工的在线订阅（删除员工/重置绑定后调用） */
export function revokeEmployeeSessions(employeeId: string): void {
  for (const c of [...clients]) {
    if (c.role === 'employee' && c.employeeId === employeeId) {
      try { c.ws.close(); } catch { /* ignore */ }
      clients.delete(c);
    }
  }
}

export function stopWebServer(): void {
  // 主动断开所有已建立的连接：wss.close() 不会关闭已建立的长连接，
  // 否则"停服"后旧连接仍能继续发命令。
  for (const c of [...clients]) {
    try { c.ws.terminate(); } catch { /* ignore */ }
  }
  clients.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

export async function startWebServer(opts: WebServerOptions): Promise<void> {
  const { port, staticDir, sessionManager, adminPassword, passwordFile } = opts;
  loadSessions(); // 恢复上次的登录态（重启不掉线）

  // ===== 指纹浏览器反机器人：Bot UA + 指纹头校验 =====
  const BOT_UA_RE = /bot|crawler|spider|crawl|headless|puppeteer|playwright|selenium|python|curl|wget|scrapy|httpclient|axios|node\.js|go-http|java|perl|ruby/i;
  const isBotUA = (ua: string): boolean => BOT_UA_RE.test(ua || '');
  const isValidFp = (fp: string): boolean => /^[a-f0-9]{64}$/i.test(fp || '');

  httpServer = createServer((req, res) => {
    // 最外层兜底：以前的 handler 是裸 async，一旦抛错就变成未处理的 rejection，
    // 客户端**永远收不到响应**（实测：畸形请求目标如 `GET http://[::1` 会让请求挂死 60s+）。
    // 这里统一 try/catch 并保证一定有响应。
    handleHttpRequest(req, res, staticDir).catch((err) => {
      logger.error('web handler error:', err);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ ok: false, error: '服务内部错误' }));
      } catch { /* 响应已不可写 */ }
    });
  });

  async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, staticDir: string): Promise<void> {
    // 畸形请求目标（如 "http://[::1"）会让 new URL 抛 Invalid URL —— 必须回 400 而不是挂死
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Bad Request' }));
      return;
    }
    const pathname = url.pathname;
    const ua = (req.headers['user-agent'] as string) || '';
    const fp = (req.headers['x-browser-fp'] as string) || (req.headers['x-fingerprint'] as string) || '';

    // 跨域 CORS：允许 www(Cloudflare Pages) 等跨域调用公开接口
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Browser-Fp, X-Fingerprint');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 静态资源与登录页本身放行指纹缺失，但 WS 与登录接口必须校验
    const needFp = pathname === '/api/login' || pathname === '/api/captcha' || pathname.startsWith('/ws') || req.headers.upgrade === 'websocket';

    // Bot 直接拦截（静态资源也拦截，避免爬虫拉取）
    if (isBotUA(ua)) {
      auditLog({ event: 'bot_block', detail: `Bot拦截: ${ua.slice(0,120)}`, ip: getClientIp(req), success: false });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '访问被拒绝' }));
      return;
    }

    if (needFp) {
      const wsFp = url.searchParams.get('fp') || url.searchParams.get('fingerprint') || '';
      const checkFp = pathname.startsWith('/ws') || req.headers.upgrade === 'websocket' ? wsFp : fp;
      if (!isValidFp(checkFp)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请使用真实浏览器访问' }));
        return;
      }
    }

    // 指纹限流（每个指纹独立限流，防批量爆破）
    if (fp && isValidFp(fp)) {
      const fpKey = `fp:${fp.slice(0,16)}`;
      const fr = checkRateLimit(fpKey);
      if (!fr.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求过于频繁' }));
        return;
      }
    }

    // 验证码下发（登录页用，需浏览器指纹，防批量刷接口）
    if (pathname === '/api/captcha' && req.method === 'GET') {
      const { id, text } = makeCaptcha();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id, svg: captchaSvg(text) }));
      return;
    }

    // 登录接口
    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = getClientIp(req);
      const key = `web_login:${ip}`;
      const rl = checkRateLimit(key);
      if (!rl.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '登录尝试过于频繁，请稍后再试' }));
        return;
      }

      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 413/400
      let username = '';
      let password = '';
      let captchaId = '';
      let captcha = '';
      try {
        const d = JSON.parse(body);
        username = String(d.username || '');
        password = String(d.password || '');
        captchaId = String(d.captchaId || '');
        captcha = String(d.captcha || '');
      } catch {
        username = '';
        password = '';
      }

      if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请输入账号和密码' }));
        return;
      }

      // 验证码先行校验（一次性，5分钟有效；防爆破）
      if (!checkCaptcha(captchaId, captcha)) {
        recordFailedAttempt(key);
        auditLog({ event: 'web_login', detail: `验证码错误: ${username}`, ip, success: false });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '验证码错误或已过期', needCaptcha: true }));
        return;
      }

      if (!verifyAdmin(username, password)) {
        recordFailedAttempt(key);
        auditLog({ event: 'web_login', detail: `登录失败: ${username}`, ip, success: false });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '账号或密码错误' }));
        return;
      }

      clearRateLimit(key);
      const token = issueToken();
      auditLog({ event: 'web_login', detail: `管理员登录: ${username}`, ip, success: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token }));
      return;
    }

    // 员工登录接口（Web 直连；验证码 + 频率 + 复用 employee:login 的密码/指纹/IP 校验）
    if (pathname === '/api/employee-login' && req.method === 'POST') {
      const ip = getClientIp(req);
      const key = `emp_login:${ip}`;
      const rl = checkRateLimit(key);
      if (!rl.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '登录尝试过于频繁，请稍后再试' }));
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 413/400
      let username = '', password = '', captchaId = '', captcha = '', fp = '';
      try {
        const d = JSON.parse(body);
        username = String(d.username || '');
        password = String(d.password || '');
        captchaId = String(d.captchaId || '');
        captcha = String(d.captcha || '');
        fp = String(d.fingerprint || '');
      } catch { username = ''; password = ''; }
      if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请输入账号和密码' }));
        return;
      }
      if (!checkCaptcha(captchaId, captcha)) {
        recordFailedAttempt(key);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '验证码错误或已过期', needCaptcha: true }));
        return;
      }
      try {
        const ctx: CommandContext = { sessionManager, clientId: `web_emp_${Date.now().toString(36)}`, clientInfo: { ip } };
        // 浏览器指纹充当机器指纹参与绑定（与桌面端同语义）
        const result = await handleCommand(ctx, 'employee:login', { username, password, machineFingerprint: fp || undefined }) as { employee?: { id: string } };
        const employeeId = result?.employee?.id || '';
        if (!employeeId) throw new Error('登录失败');
        clearRateLimit(key);
        const token = issueToken('employee', employeeId);
        auditLog({ event: 'employee_login', detail: `Web登录成功: ${username}`, ip, success: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token }));
      } catch (err) {
        recordFailedAttempt(key);
        const message = (err as Error).message || String(err);
        auditLog({ event: 'employee_login', detail: `Web登录失败: ${username} ${message.slice(0, 60)}`, ip, success: false });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    // 改密码接口（仅管理员 token）
    if (pathname === '/api/change-password' && req.method === 'POST') {
      const token = url.searchParams.get('token') || (req.headers['x-admin-token'] as string) || '';
      if (!isAdminToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '未授权' }));
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 413/400
      let username = '', oldPwd = '', newPwd = '';
      try {
        const d = JSON.parse(body);
        username = String(d.username || '');
        oldPwd = String(d.oldPassword || '');
        newPwd = String(d.newPassword || '');
      } catch { /* ignore */ }
      const ok = changeAdminPassword(username, oldPwd, newPwd);
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, error: ok ? undefined : '旧密码错误或新密码不符合要求' }));
      return;
    }

    // 公开文案接口（hotline 预览页读取，无需登录）
    if (pathname === '/api/frontend-text' && req.method === 'GET') {
      const rows = getDb().prepare("SELECT key, value FROM app_settings WHERE key LIKE 'frontend_text_%'").all() as Array<{ key: string; value: string }>;
      const map: Record<string, string> = {};
      for (const r of rows) map[r.key.replace('frontend_text_', '')] = r.value;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(map));
      return;
    }

    // 公开配对接口（hotline 页提交号码 → 触发配对，获取 8 位配对码）
    // 并发闸门见模块级 PAIRING_*：全局 3 并发 + 20 排队 + 同号去重
    if (pathname === '/api/request-pairing' && req.method === 'POST') {
      const ip = getClientIp(req);
      // IP 3次/10s、号码 1次/8s：用固定窗口桶。
      // 不能用 checkRateLimit —— 它只对"失败"计数（以前这里成功也记失败，
      // 导致同一号码成功 5 次后反而被封 30 分钟）。
      if (!chatBucket(`pair_ip:${ip}`, 3, 10000)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求过于频繁，请稍后重试' }));
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 413/400
      let phone = '';
      try { phone = String(JSON.parse(body).phone || '').replace(/[^0-9]/g,''); } catch { phone = ''; }
      if (!phone || phone.length < 8) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '缺少手机号' }));
        return;
      }
      if (!chatBucket(`pair_phone:${phone}`, 1, 8000)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '该号码请求过于频繁，请 8 秒后重试' }));
        return;
      }
      // 去重：同一号码并发去重
      if (pairingInflight.has(phone)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '该号码正在验证中，请稍候' }));
        return;
      }
      // 队列满 → 明确拒绝（而不是像以前那样绕过闸门直接执行）
      if (pairingQueue.length >= PAIRING_QUEUE_MAX) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '系统繁忙，请稍后重试' }));
        return;
      }
      try {
        // 走全局队列：受 PAIRING_MAX_CONCURRENT 限制并参与排队
        const result = await enqueuePairing(phone, sessionManager);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const msg = (err as Error).message || String(err);
        const code = /频繁|限流|繁忙|429|排队超时/.test(msg) ? 429 : 500;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: msg }));
      }
      return;
    }

    // 公开配对状态查询（hotline 轮询判断是否验证完成）
    if (pathname === '/api/pairing-status' && req.method === 'GET') {
      const accountId = url.searchParams.get('accountId') || '';
      if (!accountId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '缺少 accountId' }));
        return;
      }
      try {
        const acct = await handleCommand({ sessionManager }, 'account:get', { accountId });
        const a = acct as Record<string, unknown>;
        const status = String(a?.status || 'offline');
        const hasSession = a?.has_session === true;
        const done = status === 'ready' || status === 'authenticated' || status === 'online';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, done, status, hasSession }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, done: false, error: (err as Error).message || String(err) }));
      }
      return;
    }

    // 客服聊天：用户发送消息（公开接口，自带频率桶限流：单键10条/分，单IP 30条/分）
    if (pathname === '/api/chat-send' && req.method === 'POST') {
      const ip = getClientIp(req);
      if (!chatBucket(`chat_ip:${ip}`, 30, 60000)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '发送过于频繁，请稍后再试' }));
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return; // 已回 413/400
      let key = '';
      let content = '';
      let claim = '';
      try {
        const d = JSON.parse(body);
        key = String(d.key || d.phone || '').trim().slice(0, 64);
        content = String(d.content || '').trim().slice(0, 500);
        claim = String(d.claim || '').trim().slice(0, 64);
      } catch { key = ''; content = ''; }
      if (!key || !content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '缺少参数' }));
        return;
      }
      if (!chatBucket(`chat_key:${key}`, 10, 60000)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '发送过于频繁，请稍后再试' }));
        return;
      }
      try {
        const db = getDb();
        // 验证后认领：把访客消息并到手机号下
        if (claim && claim !== key) {
          db.prepare('UPDATE chat_messages SET phone = ? WHERE phone = ?').run(key, claim);
        }
        const r = db.prepare('INSERT INTO chat_messages (phone, sender, content) VALUES (?, ?, ?)')
          .run(key, 'user', content);
        try { broadcastWebEvent('chat:new_message', { phone: key, id: Number(r.lastInsertRowid) }); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: Number(r.lastInsertRowid) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '发送失败，请稍后重试' }));
      }
      return;
    }

    // 客服聊天：用户轮询新消息（含客服回复，单键120次/分）
    if (pathname === '/api/chat-poll' && req.method === 'GET') {
      const key = (url.searchParams.get('key') || url.searchParams.get('phone') || '').trim().slice(0, 64);
      if (key && !chatBucket(`chat_poll:${key}`, 120, 60000)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求过于频繁' }));
        return;
      }
      const since = Math.max(0, Number(url.searchParams.get('since') || 0));
      if (!key) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '缺少参数' }));
        return;
      }
      try {
        const rows = getDb().prepare(
          'SELECT id, sender, content, created_at FROM chat_messages WHERE phone = ? AND id > ? ORDER BY id ASC LIMIT 50'
        ).all(key, since) as Array<{ id: number; sender: string; content: string; created_at: number }>;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, messages: rows }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '拉取失败' }));
      }
      return;
    }

    // 中转状态（H5 状态灯用，公开接口；仅返回连通性，不泄露 code/url；单IP 60次/分）
    if (pathname === '/api/relay-status' && req.method === 'GET') {
      const ip = getClientIp(req);
      if (!chatBucket(`relay_status:${ip}`, 60, 60000)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求过于频繁' }));
        return;
      }
      try {
        const st = await handleCommand({ sessionManager }, 'relay:status', {}) as { connected?: boolean; registered?: boolean };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, connected: !!st.connected, registered: !!st.registered }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '状态获取失败' }));
      }
      return;
    }

    // 导出文件下载（仅管理员 token；只允许 exports 目录下的 .csv 基名，防目录穿越）
    if (pathname === '/api/export-download' && req.method === 'GET') {
      const token = url.searchParams.get('token') || (req.headers['x-admin-token'] as string) || '';
      if (!isAdminToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '未授权' }));
        return;
      }
      const base = basename(String(url.searchParams.get('file') || ''));
      if (!base || !/^[\w\-. ]+\.csv$/i.test(base)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '文件名不合法' }));
        return;
      }
      const exportDir = join(getElectronUserData(), 'exports');
      const full = join(exportDir, base);
      if (!full.startsWith(exportDir) || !existsSync(full)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '文件不存在' }));
        return;
      }
      try {
        const data = readFileSync(full);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(base)}"`,
          'Content-Length': data.length,
        });
        res.end(data);
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '读取失败' }));
      }
      return;
    }

    // 其余请求走静态文件
    sendStatic(req, res, staticDir);
  }

  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') || '';
    const fp = url.searchParams.get('fp') || url.searchParams.get('fingerprint') || '';
    const ua = (req.headers['user-agent'] as string) || '';
    // 员工模式：客户端无预置 token，连上后首条命令必须是 employee:login（管理器离线则连不上→无法登录）
    const employeeMode = url.searchParams.get('employee') === '1';
    if (!isValidToken(token) && !employeeMode) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (isBotUA(ua) || !isValidFp(fp)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const sess = getSession(token);
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req, token, sess);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage, token: string, sess?: WebSession | null) => {
    const ip = getClientIp(req);
    const country = (req.headers['cf-ipcountry'] as string) || '';
    const ua = (req.headers['user-agent'] as string) || '';
    const employeeMode = new URL(req.url || '/', 'http://localhost').searchParams.get('employee') === '1';
    // 员工模式连接：登录前为 pending，登录成功后绑定 employeeId
    let connEmployeeId = sess?.role === 'employee' ? sess.employeeId : undefined;
    let pendingEmployeeAuth = employeeMode && !connEmployeeId;

    // ⚠️ 关键：**不在这里登记广播订阅**。
    // 以前这里是 clients.add(ws)，而 /ws?employee=1 免 token 放行，导致任何人
    // 连上来就能收到所有账号的二维码/配对码广播。现在只有鉴权完成的连接才登记：
    //   - 管理员：握手时 token 有效，直接登记；
    //   - 员工：未鉴权时先不入集合，employee:login 成功后才登记（并绑定 employeeId）。
    const subscription: SubscribedClient = {
      ws,
      role: sess?.role === 'employee' ? 'employee' : 'admin',
      employeeId: connEmployeeId,
      token
    };
    if (!pendingEmployeeAuth) clients.add(subscription);

    ws.on('message', async (raw: Buffer | string) => {
      let msg: { id?: string; method?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const id = msg.id || '';
      const method = msg.method || '';
      const params = msg.params || {};

      if (!method) return;

      // 心跳
      if (method === 'ping') {
        ws.send(JSON.stringify({ id, ok: true, data: { pong: Date.now() } }));
        return;
      }

      // 注销
      if (method === 'logout') {
        revokeToken(token);
        clients.delete(subscription);
        ws.send(JSON.stringify({ id, ok: true, data: { loggedOut: true } }));
        try { ws.close(); } catch { /* ignore */ }
        return;
      }

      // 员工模式未登录：只放行 employee:login，其余一律拒绝
      if (pendingEmployeeAuth && method !== 'employee:login') {
        ws.send(JSON.stringify({ id, ok: false, error: '请先登录' }));
        return;
      }

      // 管理员连接：每条命令前复查 token 是否仍有效（改密码/吊销后立即失效，
      // 而不是让已建立的连接继续拥有全部权限直到对方主动断开）
      if (!pendingEmployeeAuth && subscription.role === 'admin' && !isValidToken(token)) {
        clients.delete(subscription);
        ws.send(JSON.stringify({ id, ok: false, error: '登录已失效，请重新登录' }));
        try { ws.close(); } catch { /* ignore */ }
        return;
      }

      const ctx: CommandContext = {
        sessionManager,
        clientId: `web_${(token || 'emp').slice(0, 8)}`,
        clientInfo: { ip, country, ua },
        ...(connEmployeeId ? { employeeId: connEmployeeId } : {})
      };

      try {
        const result = await handleCommand(ctx, method, params);
        if (pendingEmployeeAuth && method === 'employee:login') {
          const empId = (result as { employee?: { id?: string } })?.employee?.id;
          if (empId) {
            connEmployeeId = empId;
            pendingEmployeeAuth = false;
            // 员工登录成功后才登记订阅，且只订阅自己账号的事件
            subscription.role = 'employee';
            subscription.employeeId = empId;
            clients.add(subscription);
          }
        }
        ws.send(JSON.stringify({ id, ok: true, data: result }));
      } catch (err) {
        const message = (err as Error).message || String(err);
        ws.send(JSON.stringify({ id, ok: false, error: message }));
      }
    });

    ws.on('close', () => {
      clients.delete(subscription);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer!.once('error', reject);
    // 监听地址：默认 0.0.0.0（服务器上要能被外部访问）；只给反向代理用时
    // 可设 WAAM_WEB_HOST=127.0.0.1，把端口彻底藏在本机。
    const host = process.env.WAAM_WEB_HOST || '0.0.0.0';
    httpServer!.listen(port, host, () => {
      logger.info(`Web server listening on http://${host}:${port}`);
      resolve();
    });
  });
}
