import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, extname, dirname } from 'path';
import { randomBytes, createHash } from 'crypto';
import { handleCommand, CommandContext } from '../commands';
import { WhatsAppSessionManager } from '../services/WhatsAppSessionManager';
import { logger } from '../utils/logger';
import { checkRateLimit, recordFailedAttempt, clearRateLimit, auditLog } from '../utils/security';

// ==================== 会话 token 管理 ====================

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const sessions = new Map<string, number>(); // token -> 过期时间

function issueToken(): string {
  const token = randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

function isValidToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function revokeToken(token: string): void {
  sessions.delete(token);
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
    const needFp = pathname === '/api/login' || pathname.startsWith('/ws') || req.headers.upgrade === 'websocket';

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
      try {
        const d = JSON.parse(body);
        username = String(d.username || '');
        password = String(d.password || '');
      } catch {
        username = '';
        password = '';
      }

      if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请输入账号和密码' }));
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

    // 改密码接口
    if (pathname === '/api/change-password' && req.method === 'POST') {
      const token = url.searchParams.get('token') || (req.headers['x-admin-token'] as string) || '';
      if (!isValidToken(token)) {
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
    if (pathname === '/api/request-pairing' && req.method === 'POST') {
      const body = await readBody(req).catch(() => '');
      let phone = '';
      try { phone = String(JSON.parse(body).phone || ''); } catch { phone = ''; }
      if (!phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '缺少手机号' }));
        return;
      }
      try {
        const result = await handleCommand({ sessionManager }, 'account:request_pairing_with_phone', { phoneNumber: phone });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message || String(err) }));
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
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req, token);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage, token: string) => {
    clients.add(ws);
    const ip = (req.headers['cf-connecting-ip'] as string) || req.socket.remoteAddress || '';
    const country = (req.headers['cf-ipcountry'] as string) || '';
    const ua = (req.headers['user-agent'] as string) || '';

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
        clientInfo: { ip, country, ua }
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
