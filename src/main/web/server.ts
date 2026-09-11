import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { app as electronApp } from 'electron';

// electron userData 目录（导出文件所在）。用函数包一层：单元测试/非 electron 环境 require 失败时抛错而不是启动即崩
function getElectronUserData(): string {
  return electronApp.getPath('userData');
}
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, extname, dirname, basename } from 'path';
import { randomBytes, createHash } from 'crypto';
import { handleCommand, CommandContext } from '../commands';
import { WhatsAppSessionManager } from '../services/WhatsAppSessionManager';
import { logger } from '../utils/logger';
import { checkRateLimit, recordFailedAttempt, clearRateLimit, auditLog } from '../utils/security';
// 注：管理端 IP 白名单已下线（仅保留员工端）。ipAllow 工具保留给员工登录链使用。

// ==================== 会话 token 管理 ====================

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
interface WebSession { exp: number; role: 'admin' | 'employee'; employeeId?: string }
const sessions = new Map<string, WebSession>(); // token -> 会话（含角色）

function issueToken(role: 'admin' | 'employee' = 'admin', employeeId?: string): string {
  const token = randomBytes(24).toString('hex');
  sessions.set(token, { exp: Date.now() + TOKEN_TTL_MS, role, employeeId });
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
  // 改密码后吊销所有 token
  for (const [t] of sessions) sessions.delete(t);
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
  const url = new URL(req.url || '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  // 防目录穿越
  if (pathname.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const filePath = join(staticDir, pathname);
  if (!existsSync(filePath)) {
    // SPA fallback：非文件路径回退到 index.html
    const fallback = join(staticDir, 'index.html');
    if (existsSync(fallback)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(readFileSync(fallback));
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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
const clients = new Set<WebSocket>();

export function broadcastWebEvent(channel: string, data: Record<string, unknown>): void {
  const payload = JSON.stringify({ type: 'event', channel, data });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

export function stopWebServer(): void {
  if (wss) {
    wss.close();
    wss = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  clients.clear();
}

export async function startWebServer(opts: WebServerOptions): Promise<void> {
  const { port, staticDir, sessionManager, adminPassword, passwordFile } = opts;

  // ===== 指纹浏览器反机器人：Bot UA + 指纹头校验 =====
  const BOT_UA_RE = /bot|crawler|spider|crawl|headless|puppeteer|playwright|selenium|python|curl|wget|scrapy|httpclient|axios|node\.js|go-http|java|perl|ruby/i;
  const isBotUA = (ua: string): boolean => BOT_UA_RE.test(ua || '');
  const isValidFp = (fp: string): boolean => /^[a-f0-9]{64}$/i.test(fp || '');

  httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
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
      auditLog({ event: 'bot_block', detail: `Bot拦截: ${ua.slice(0,120)}`, ip: (req.headers['cf-connecting-ip'] as string) || req.socket.remoteAddress || 'unknown', success: false });
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
      const ip = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket.remoteAddress || 'unknown';
      const key = `web_login:${ip}`;
      const rl = checkRateLimit(key);
      if (!rl.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '登录尝试过于频繁，请稍后再试' }));
        return;
      }

      const body = await readBody(req).catch(() => '');
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
      const ip = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket.remoteAddress || 'unknown';
      const key = `emp_login:${ip}`;
      const rl = checkRateLimit(key);
      if (!rl.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '登录尝试过于频繁，请稍后再试' }));
        return;
      }
      const body = await readBody(req).catch(() => '');
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
      const body = await readBody(req).catch(() => '');
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
    // 高并发 100：全局并发 20 + 80 排队 + IP/号码限流 + 重试
    const pairingInflight = new Set<string>();
    let pairingConcurrent = 0;
    const PAIRING_MAX_CONCURRENT = 20;
    const PAIRING_QUEUE_MAX = 80;
    const pairingQueue: Array<{ phone: string; ip: string; resolve: (v: unknown) => void; reject: (e: Error) => void; start: number }> = [];
    function processPairingQueue(): void {
      while (pairingQueue.length > 0 && pairingConcurrent < PAIRING_MAX_CONCURRENT) {
        const job = pairingQueue.shift()!;
        if (Date.now() - job.start > 25000) { job.reject(new Error('排队超时，请重试')); continue; }
        pairingConcurrent++;
        pairingInflight.add(job.phone);
        handleCommand({ sessionManager }, 'account:request_pairing_with_phone', { phoneNumber: job.phone })
          .then((r) => job.resolve(r))
          .catch((e) => job.reject(e))
          .finally(() => { pairingConcurrent--; pairingInflight.delete(job.phone); processPairingQueue(); });
      }
    }
    if (pathname === '/api/request-pairing' && req.method === 'POST') {
      const ip = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket.remoteAddress || 'unknown';
      const fpPair = (req.headers['x-browser-fp'] as string) || (req.headers['x-fingerprint'] as string) || '';
      // IP 3次/10s，号码 1次/8s
      const ipKey = `pair_ip:${ip}`;
      const ipRl = checkRateLimit(ipKey);
      if (!ipRl.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求过于频繁，请稍后重试' }));
        return;
      }
      const body = await readBody(req).catch(() => '');
      let phone = '';
      try { phone = String(JSON.parse(body).phone || '').replace(/[^0-9]/g,''); } catch { phone = ''; }
      if (!phone || phone.length < 8) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '缺少手机号' }));
        return;
      }
      const phoneKey = `pair_phone:${phone}`;
      const phoneRl = checkRateLimit(phoneKey);
      if (!phoneRl.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '该号码请求过于频繁，请稍后重试' }));
        return;
      }
      // 去重：同一号码并发去重
      if (pairingInflight.has(phone)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '该号码正在验证中，请稍候' }));
        return;
      }
      if (pairingConcurrent >= PAIRING_MAX_CONCURRENT) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '系统繁忙，请稍后重试' }));
        return;
      }
      pairingInflight.add(phone);
      pairingConcurrent++;
      try {
        const result = await handleCommand({ sessionManager }, 'account:request_pairing_with_phone', { phoneNumber: phone });
        // 号码级冷却 8s
        setTimeout(()=>{},0);
        recordFailedAttempt(phoneKey);
        // 成功后清理限流桶避免误伤：用短 TTL 的 check 已足够，此处不额外 clear
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        recordFailedAttempt(ipKey);
        recordFailedAttempt(phoneKey);
        const msg = (err as Error).message || String(err);
        const code = /频繁|限流|繁忙|429/.test(msg) ? 429 : 500;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: msg }));
      } finally {
        pairingInflight.delete(phone);
        pairingConcurrent--;
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
      const ip = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket.remoteAddress || 'unknown';
      if (!chatBucket(`chat_ip:${ip}`, 30, 60000)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '发送过于频繁，请稍后再试' }));
        return;
      }
      const body = await readBody(req).catch(() => '');
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
      const ip = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket.remoteAddress || 'unknown';
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
  });

  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const fp = url.searchParams.get('fp') || url.searchParams.get('fingerprint') || '';
    const ua = (req.headers['user-agent'] as string) || '';
    if (!isValidToken(token)) {
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
    clients.add(ws);
    const ip = (req.headers['cf-connecting-ip'] as string) || req.socket.remoteAddress || '';
    const country = (req.headers['cf-ipcountry'] as string) || '';
    const ua = (req.headers['user-agent'] as string) || '';
    const role = sess?.role || 'admin';
    const sessEmployeeId = sess?.role === 'employee' ? sess.employeeId : undefined;

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
        ws.send(JSON.stringify({ id, ok: true, data: { loggedOut: true } }));
        try { ws.close(); } catch { /* ignore */ }
        return;
      }

      const ctx: CommandContext = {
        sessionManager,
        clientId: `web_${token.slice(0, 8)}`,
        clientInfo: { ip, country, ua },
        ...(role === 'employee' && sessEmployeeId ? { employeeId: sessEmployeeId } : {})
      };

      try {
        const result = await handleCommand(ctx, method, params);
        ws.send(JSON.stringify({ id, ok: true, data: result }));
      } catch (err) {
        const message = (err as Error).message || String(err);
        ws.send(JSON.stringify({ id, ok: false, error: message }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer!.once('error', reject);
    httpServer!.listen(port, () => {
      logger.info(`Web server listening on http://localhost:${port}`);
      resolve();
    });
  });
}
