import { getDb } from '../utils/db';
import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { existsSync, readdirSync, rmSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { generateDeviceFingerprint, verifyFingerprint } from '../services/fingerprint';
import { WhatsAppSessionManager } from '../services/WhatsAppSessionManager';
import { launchChromeForAccount, closeChromeForAccount } from '../services/ChromeLauncher';
import { hashPassword, verifyPassword, createEmployeeToken, resolveEmployeeToken } from '../services/employeeAuth';
import { loadRelaySettings, saveRelaySettings, ensureAccessCode, regenerateAccessCode } from '../services/relayConfig';
import { getRelayInstance } from '../services/RelayClient';
import { logger } from '../utils/logger';
import { parseUa } from '../utils/ua';
import { checkRateLimit, recordFailedAttempt, clearRateLimit, auditLog, sanitizeSql, isValidUsername, getAuditLogs } from '../utils/security';
import { parseAllowList, isValidAllowEntry } from '../utils/ipAllow';

export interface CommandContext {
  sessionManager: WhatsAppSessionManager;
  clientId?: string;
  employeeToken?: string;
  /** 网页客户端握手来源信息（由中转服务器注入） */
  clientInfo?: { ip?: string; country?: string; ua?: string };
}

// 记录账号归属的网页 clientId，用于事件定向投递（配对码只发给发起验证的客户端）
const accountOwners = new Map<string, string>();

// 发送专用频率桶（固定窗口；与登录限流器隔离，正常发送流量适用）
const sendBuckets = new Map<string, { count: number; reset: number }>();
function sendBucket(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const e = sendBuckets.get(key);
  if (!e || now >= e.reset) {
    sendBuckets.set(key, { count: 1, reset: now + windowMs });
    if (sendBuckets.size > 2000) {
      for (const [k, v] of sendBuckets) {
        if (v.reset <= now) sendBuckets.delete(k);
        if (sendBuckets.size <= 1500) break;
      }
    }
    return true;
  }
  if (e.count >= max) return false;
  e.count++;
  return true;
}

// 记录员工绑定的 clientId，用于员工端事件定向投递
const employeeClients = new Map<string, string>();

// 中转重启回调：由 index.ts 在初始化时注入（桌面/Web 模式均可用）
let relayRestartCallback: (() => void) | null = null;

export function setRelayRestartCallback(cb: (() => void) | null): void {
  relayRestartCallback = cb;
}

export function getAccountOwner(accountId: string): string | undefined {
  return accountOwners.get(accountId);
}

export function getEmployeeClientId(employeeId: string): string | undefined {
  return employeeClients.get(employeeId);
}

// 根据账号归属的员工，返回该员工端绑定的 clientId（用于事件定向投递）
export function getEmployeeClientIdForAccount(accountId: string): string | undefined {
  const row = getDb().prepare('SELECT assigned_to FROM accounts WHERE id = ?').get(accountId) as { assigned_to: string | null } | undefined;
  if (!row?.assigned_to) return undefined;
  return employeeClients.get(row.assigned_to);
}

// 校验员工 token，返回 employeeId；无效则抛错
function requireEmployee(ctx: CommandContext): string {
  if (!ctx.employeeToken) throw new Error('未登录员工账号');
  const employeeId = resolveEmployeeToken(ctx.employeeToken);
  if (!employeeId) throw new Error('登录已过期，请重新登录');
  return employeeId;
}

function hasSavedSession(accountId: string): boolean {
  const profileRoot = join(app.getPath('userData'), 'chrome-profiles', accountId);
  const defaultDir = join(profileRoot, 'Default');
  if (!existsSync(defaultDir)) return false;

  // 会话数据保存在 Chrome profile 的 Local Storage leveldb（WhatsApp Web 登录后写入）
  const lsDir = join(defaultDir, 'Local Storage', 'leveldb');
  return !!existsSync(lsDir) && readdirSync(lsDir).some((f) => f.startsWith('CURRENT') || f.endsWith('.log') || f.endsWith('.ldb'));
}

function toPublicAccount(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    has_session: hasSavedSession(row.id as string)
  };
}

// ====== 模板发布状态（异步发布，后台执行，前端轮询） ======
interface PublishState {
  running: boolean;
  target: string;
  startedAt: number;
  lastOk: boolean | null;
  lastError: string;
  lastTime: number;
  output: string;
}
let publishState: PublishState = { running: false, target: '', startedAt: 0, lastOk: null, lastError: '', lastTime: 0, output: '' };

// 打包后 __dirname=dist/main → 项目根；dev 下 __dirname=src/main/commands → 项目根；
// 都用 app.getAppPath() 兜底（打包后指向 resources/app，dist 场景不走这里）。
function resolveProjectRoot(): string {
  const { dirname } = require('path') as typeof import('path');
  const candidates = [join(__dirname, '..', '..'), join(__dirname, '..', '..', '..')];
  for (const c of candidates) {
    try {
      if (existsSync(join(c, 'package.json'))) return c;
    } catch {}
  }
  try {
    const base = app.getAppPath();
    if (existsSync(join(base, 'package.json'))) return base;
  } catch {}
  void dirname;
  return candidates[0];
}

function runPublishInBackground(root: string, srcDir: string, target: string): void {
  const { spawn } = require('child_process') as typeof import('child_process');
  const { mkdirSync, cpSync, rmSync, existsSync: exists } = require('fs') as typeof import('fs');
  const tmpRoot = join(
    process.env.TEMP || process.env.TMP || require('os').tmpdir(),
    `waam-deploy-${Date.now()}`
  );
  const onDone = (ok: boolean, msg: string, output: string): void => {
    publishState = { running: false, target, startedAt: publishState.startedAt, lastOk: ok, lastError: ok ? '' : msg.slice(0, 300), lastTime: Date.now(), output: output.slice(-2000) };
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    auditLog({ event: 'template_publish', detail: ok ? `发布模板 ${target} 成功` : `发布失败 ${target}: ${msg.slice(0, 120)}`, success: ok });
    logger.info(`[template:publish] ${target} ${ok ? 'OK' : 'FAIL: ' + msg.slice(0, 200)}`);
  };
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  try {
    mkdirSync(tmpRoot, { recursive: true });
    cpSync(join(root, srcDir), join(tmpRoot, srcDir), { recursive: true });
  } catch (err) {
    onDone(false, '拷贝模板目录失败：' + String((err as Error).message || err), '');
    return;
  }
  // npx 定位：本机固定路径优先，否则走 PATH（spawn+shell 解析）
  // 两套模板各发各的项目，互不覆盖：hotline→waam-web（www 验证 H5），classic→waam-classic
  const projectName = target === 'hotline' ? 'waam-web' : 'waam-classic';
  const fixedNpx = 'C:\\nvm4w\\nodejs\\npx.cmd';
  const npxCmd = exists(fixedNpx) ? `"${fixedNpx}"` : 'npx';
  const child = spawn(`${npxCmd} wrangler pages deploy ${srcDir} --project-name ${projectName} --branch main`, {
    cwd: tmpRoot,
    shell: true,
    timeout: 300000,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  child.on('error', (err: Error) => onDone(false, '启动 wrangler 失败：' + String(err.message || err), stdout + stderr));
  child.on('close', (code: number | null) => {
    const msg = (stderr || stdout).slice(0, 600);
    if (code === 0) onDone(true, '', stdout);
    else onDone(false, `wrangler 退出码 ${code}：${msg}`, stdout + stderr);
  });
}

/**
 * 统一的业务命令入口。IPC 与 WS 中转均调用此函数。
 * method 为 snake_case 的命令名，与 IPC 保持一致。
 */
export async function handleCommand(ctx: CommandContext, method: string, params: Record<string, unknown>): Promise<unknown> {
  const db = getDb();

  switch (method) {
    case 'account:list': {
      const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
      // 用实时会话状态覆盖 DB 里可能残留的旧状态
      return rows.map((row) => {
        const live = ctx.sessionManager.getStatus(row.id as string);
        const pub = toPublicAccount(row);
        if (live && live !== 'initializing') {
          pub.status = live === 'ready' ? 'online' : 'offline';
        }
        return pub;
      });
    }

    case 'account:create': {
      const id = uuidv4();
      const machineFingerprint = generateDeviceFingerprint();
      const name = (params?.name as string) || `账号-${id.slice(0, 8)}`;
      const now = Math.floor(Date.now() / 1000);

      db.prepare(
        `INSERT INTO accounts (id, device_id, machine_fingerprint, name, status, created_at)
         VALUES (?, ?, ?, ?, 'offline', ?)`
      ).run(id, machineFingerprint, machineFingerprint, name, now);

      db.prepare('INSERT INTO login_logs (account_id, action, detail) VALUES (?, ?, ?)')
        .run(id, 'create', '账号创建');

      // 记录创建者归属，用于事件定向投递
      if (ctx.clientId) {
        accountOwners.set(id, ctx.clientId);
      }

      const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown>;
      return toPublicAccount(row);
    }

    case 'account:get': {
      const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(params.accountId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('账号不存在');
      return toPublicAccount(row);
    }

    case 'account:has_session': {
      return { hasSession: hasSavedSession(params.accountId as string) };
    }

    case 'account:update': {
      const allowed = ['name', 'phone'];
      const updates: string[] = [];
      const values: Array<string | number> = [];

      for (const key of allowed) {
        if (params[key] !== undefined) {
          updates.push(`${key} = ?`);
          values.push(String(params[key]));
        }
      }
      if (updates.length === 0) return { success: false, message: '无有效字段' };

      updates.push('updated_time = ?');
      values.push(Math.floor(Date.now() / 1000));
      values.push(params.accountId as string);

      db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      return { success: true };
    }

    case 'account:delete': {
      const accountId = params.accountId as string;
      auditLog({ event: 'account_delete', detail: `删除账号: ${accountId}`, accountId, success: true });
      db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
      await ctx.sessionManager.stopSession(accountId);
      closeChromeForAccount(accountId);
      accountOwners.delete(accountId);
      // 等待 Chrome 完全退出，避免 EBUSY 导致 profile 删除失败
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // 清理该账号的 Chrome profile（含 LocalAuth 会话）与残留会话目录，避免下次 hasSavedSession 误判或 Chrome 实例冲突
      try {
        const profileRoot = join(app.getPath('userData'), 'chrome-profiles', accountId);
        rmSync(profileRoot, { recursive: true, force: true });
        const sessionDir = join(app.getPath('userData'), 'whatsapp-sessions', `session-${accountId}`);
        rmSync(sessionDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(`Failed to clean up profile for deleted account ${accountId}:`, err);
      }
      return { success: true };
    }

    case 'account:login': {
      const accountId = params.accountId as string;
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as { machine_fingerprint: string | null } | undefined;
      if (!account) throw new Error('账号不存在');

      const currentFingerprint = generateDeviceFingerprint();
      if (account.machine_fingerprint && !verifyFingerprint(account.machine_fingerprint, currentFingerprint)) {
        auditLog({ event: 'account_login', detail: `指纹不匹配: ${accountId}`, accountId, success: false });
        throw new Error('设备指纹不匹配，该账号已绑定其他设备');
      }

      if (!account.machine_fingerprint) {
        db.prepare('UPDATE accounts SET machine_fingerprint = ? WHERE id = ?')
          .run(currentFingerprint, accountId);
      }

      const { port, wsEndpoint } = await launchChromeForAccount(accountId);
      await ctx.sessionManager.startSession(accountId, wsEndpoint, {
        phoneNumber: params.phoneNumber as string | undefined,
        chromePort: port
      });

      auditLog({ event: 'account_login', detail: `账号登录: ${accountId}`, accountId, success: true });
      db.prepare('INSERT INTO login_logs (account_id, action, detail) VALUES (?, ?, ?)')
        .run(accountId, 'login', '发起登录');

      return { success: true };
    }

    case 'account:logout': {
      const accountId = params.accountId as string;
      await ctx.sessionManager.stopSession(accountId);
      closeChromeForAccount(accountId);

      db.prepare(`UPDATE accounts SET status = 'offline', updated_time = ? WHERE id = ?`)
        .run(Math.floor(Date.now() / 1000), accountId);
      db.prepare('INSERT INTO login_logs (account_id, action, detail) VALUES (?, ?, ?)')
        .run(accountId, 'logout', '退出登录');

      return { success: true };
    }

    case 'account:request_pairing': {
      const accountId = params.accountId as string;
      const client = ctx.sessionManager.getSession(accountId);
      if (!client) throw new Error('会话未启动，请先点击登录');

      const cleanPhone = String(params.phoneNumber || '').replace(/[^0-9]/g, '');
      if (cleanPhone.length < 8) {
        throw new Error('手机号格式错误，请使用国际格式，如 8613800138000');
      }

      logger.info(`request_pairing called for ${accountId}, phone: ${cleanPhone}`);

      // 幂等：若初始化时已通过 pairWithPhoneNumber 生成配对码，直接复用，避免再次请求触发限速
      // 最多等待 25 秒让 initialize 内部的自动请求完成（Client.js 中 requestPairingCode 为异步触发）
      const existing = await ctx.sessionManager.waitForPairingCode(accountId, 25000);
      if (existing) {
        logger.info(`Reusing existing pairing code for ${accountId}: ${existing}`);
        return { success: true, code: existing, reused: true };
      }

      // 无自动生成的配对码（如旧会话恢复），此时才手动请求；失败时识别限速并给出友好提示
      try {
        logger.info(`Manually requesting pairing code for ${accountId}, phone: ${cleanPhone}`);
        const code = await client.requestPairingCode(cleanPhone);
        logger.info(`Pairing code received for ${accountId}: ${code}`);
        // 手动请求成功时立即保存，供本次 result 返回
        ctx.sessionManager.setPairingCode(accountId, code);
        return { success: true, code, reused: false };
      } catch (err) {
        const msg = String((err as Error).message || err);
        logger.error(`requestPairingCode failed for ${accountId}: ${msg}`);
        // WhatsApp 侧限速：单字母/数字（minified 后为 "t" 等）或含 rate-overlimit/429 均视为限速
        if (
          /rate[-_]?overlimit|Too many attempt|429/i.test(msg) ||
          /^[a-z]:?\s*[a-z]*$/i.test(msg.trim())
        ) {
          throw new Error(
            'WhatsApp 暂时限制了该号码的配对码请求（请求过于频繁）。' +
            '请等待 15~30 分钟后再试，或尝试换一个号码验证。'
          );
        }
        throw err;
      }
    }

    case 'account:request_pairing_with_phone': {
      const phoneNumber = String(params.phoneNumber || '').replace(/[^0-9]/g, '');
      if (phoneNumber.length < 8) {
        throw new Error('手机号格式错误，请使用国际格式，如 8613800138000');
      }

      const now = Math.floor(Date.now() / 1000);
      // 同号复用：10 分钟内同号的非在线账号直接复用（每次验证建新号会导致账号/Chrome 越堆越多）
      let id: string;
      const reuse = db.prepare(
        `SELECT id FROM accounts WHERE phone = ? AND status != 'online' AND created_at > ? ORDER BY created_at DESC LIMIT 1`
      ).get(phoneNumber, now - 600) as { id: string } | undefined;
      if (reuse) {
        id = reuse.id;
        try { await ctx.sessionManager.stopSession(id).catch(() => {}); } catch {}
        try { closeChromeForAccount(id); } catch {}
        db.prepare('INSERT INTO login_logs (account_id, action, detail) VALUES (?, ?, ?)')
          .run(id, 'create', `手机号验证复用: ${phoneNumber}`);
        logger.info(`Reusing recent account ${id} for phone ${phoneNumber}`);
      } else {
        // 创建新账号（复用 create 逻辑）
        id = uuidv4();
        const machineFingerprint = generateDeviceFingerprint();
        const name = `账号-${phoneNumber.slice(-8)}`;

        db.prepare(
          `INSERT INTO accounts (id, device_id, machine_fingerprint, name, status, created_at)
           VALUES (?, ?, ?, ?, 'offline', ?)`
        ).run(id, machineFingerprint, machineFingerprint, name, now);

        // 保存手机号到 phone 字段，便于后续员工端登录时触发配对流程
        db.prepare('UPDATE accounts SET phone = ? WHERE id = ?').run(phoneNumber, id);

        db.prepare('INSERT INTO login_logs (account_id, action, detail) VALUES (?, ?, ?)')
          .run(id, 'create', `手机号验证创建: ${phoneNumber}`);
      }

      if (ctx.clientId) {
        accountOwners.set(id, ctx.clientId);
      }

      // 无论验证成功或失败，账号都保留在账号管理器中待分配，因此失败时不再抛出
      // headless 启动 Chrome（前端验证不弹任何浏览器窗口）
      try {
        const { port, wsEndpoint } = await launchChromeForAccount(id, { headless: true });
        await ctx.sessionManager.startSession(id, wsEndpoint, {
          phoneNumber,
          chromePort: port,
          headless: true
        });

        db.prepare('INSERT INTO login_logs (account_id, action, detail) VALUES (?, ?, ?)')
          .run(id, 'login', `发起手机号验证: ${phoneNumber}`);

        // 等待配对码生成（最多 30 秒）
        const code = await ctx.sessionManager.waitForPairingCode(id, 30000);
        if (!code) {
          // 未生成配对码：立即关闭 Chrome 释放资源，账号保留待分配
          await ctx.sessionManager.stopSession(id).catch(() => {});
          closeChromeForAccount(id);
          logger.warn(`Pairing code timeout for ${id}, account kept as pending`);
          return { success: false, accountId: id, code: null, error: '获取配对码超时，WhatsApp 未返回配对码。账号已保留待分配，可稍后重试。' };
        }

        // 配对码已生成：保持 headless Chrome 后台运行，等待用户手机输入配对码完成关联；
        // 宽限 150 秒（H5 只显示 60 秒倒计时，但用户找手机、输码经常超时，60 秒会误杀刚配对好的会话）。
        // 账号始终保留待分配。
        setTimeout(() => {
          const st = ctx.sessionManager.getStatus(id);
          if (!st || st === 'ready' || st === 'authenticated') return;
          ctx.sessionManager.stopSession(id).catch(() => {});
          closeChromeForAccount(id);
          logger.info(`Auto-closed pending headless Chrome for ${id} after no pairing completion`);
        }, 150000);

        return { success: true, accountId: id, code };
      } catch (err) {
        const msg = String((err as Error).message || err);
        logger.warn(`request_pairing_with_phone failed for ${id}: ${msg}`);
        return { success: false, accountId: id, code: null, error: `验证未完成：${msg}。账号已保留待分配，可稍后重试。` };
      }
    }

    case 'account:logs': {
      return db.prepare('SELECT * FROM login_logs WHERE account_id = ? ORDER BY created_at DESC LIMIT 50').all(params.accountId);
    }

    // ===== 员工管理（仅桌面端管理员可操作） =====

    case 'employee:create': {
      const username = sanitizeSql(String(params.username || '').trim());
      const password = String(params.password || '');
      const name = params.name as string | undefined;
      const fingerprint = params.fingerprint as string | undefined;

      if (!username || !password) throw new Error('需要员工账号和密码');
      if (!isValidUsername(username)) throw new Error('员工账号只能包含字母、数字、下划线，长度 3-30');
      if (password.length < 6) throw new Error('密码至少 6 位');
      const exists = db.prepare('SELECT id FROM employees WHERE username = ?').get(username);
      if (exists) throw new Error('员工账号已存在');

      const { hash, salt } = hashPassword(password);
      const id = uuidv4();
      if (fingerprint && fingerprint.trim()) {
        db.prepare('INSERT INTO employees (id, username, password_hash, salt, name, machine_fingerprint) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, username, hash, salt, name || username, fingerprint.trim());
      } else {
        db.prepare('INSERT INTO employees (id, username, password_hash, salt, name) VALUES (?, ?, ?, ?, ?)')
          .run(id, username, hash, salt, name || username);
      }

      auditLog({ event: 'employee_create', detail: `创建员工: ${username}`, accountId: id, success: true });
      return { success: true, id, username, name: name || username };
    }

    case 'employee:list': {
      const rows = db.prepare('SELECT id, username, name, status, machine_fingerprint, created_at FROM employees ORDER BY created_at DESC').all();
      // 附带每个员工的账号数量
      return rows.map((row) => {
        const { c } = db.prepare('SELECT COUNT(*) c FROM accounts WHERE assigned_to = ?').get((row as { id: string }).id) as { c: number };
        const r = row as Record<string, unknown>;
        const bound = !!r.machine_fingerprint;
        return { ...r, accountCount: c, fingerprint_bound: bound };
      });
    }

    case 'employee:delete': {
      const employeeId = params.employeeId as string;
      auditLog({ event: 'employee_delete', detail: `删除员工: ${employeeId}`, employeeId, success: true });
      // 释放该员工名下的账号
      db.prepare('UPDATE accounts SET assigned_to = NULL WHERE assigned_to = ?').run(employeeId);
      db.prepare('DELETE FROM employees WHERE id = ?').run(employeeId);
      return { success: true };
    }

    case 'employee:assign': {
      const employeeId = params.employeeId as string;
      const accountId = params.accountId as string;
      const remark = params.remark ? String(params.remark).trim() : '';
      const account = db.prepare('SELECT id, status FROM accounts WHERE id = ?').get(accountId) as { id: string; status: string } | undefined;
      if (!account) throw new Error('账号不存在');
      const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId);
      if (!emp) throw new Error('员工不存在');
      // 若账号已分配给其他员工，先释放
      db.prepare('UPDATE accounts SET assigned_to = ?, remark = ? WHERE id = ?').run(employeeId, remark, accountId);
      db.prepare('INSERT INTO login_logs (account_id, action, detail) VALUES (?, ?, ?)')
        .run(accountId, 'assign', `分配给员工 ${employeeId}${remark ? `（备注：${remark}）` : ''}`);
      return { success: true };
    }

    case 'employee:unassign': {
      const accountId = params.accountId as string;
      db.prepare('UPDATE accounts SET assigned_to = NULL WHERE id = ?').run(accountId);
      db.prepare('INSERT INTO login_logs (account_id, action, detail) VALUES (?, ?, ?)')
        .run(accountId, 'unassign', '解除分配');
      return { success: true };
    }

    // ===== 员工端认证 =====

    case 'employee:login': {
      const username = String(params.username || '').trim();
      const password = String(params.password || '');
      const clientIp = ctx.clientInfo?.ip || 'unknown';

      // 员工登录 IP 白名单（环境变量优先，否则 app_settings；空=不限制；回环永远放行）
      {
        const { parseAllowList, isIpAllowed, normalizeIp } = await import('../utils/ipAllow');
        const envList = String(process.env.WAAM_EMPLOYEE_IP_ALLOWLIST || '').trim();
        let list: string[] = parseAllowList(envList);
        if (!envList) {
          try {
            const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get('employee_ip_allowlist') as { value: string } | undefined;
            list = parseAllowList(row?.value || '');
          } catch {}
        }
        if (!isIpAllowed(normalizeIp(clientIp), list)) {
          auditLog({ event: 'employee_login', detail: `IP不在白名单: ${username}`, ip: clientIp, success: false });
          throw new Error('当前 IP 无权登录员工端');
        }
      }

      // 限流检查：基于用户名 + IP
      const rateLimitKey = `login:${username}:${clientIp}`;
      const rateCheck = checkRateLimit(rateLimitKey);
      if (!rateCheck.allowed) {
        const retryMin = Math.ceil((rateCheck.retryAfterMs || 0) / 60000);
        auditLog({ event: 'employee_login', detail: `限流触发: ${username}`, ip: clientIp, success: false });
        throw new Error(`登录尝试过于频繁，请等待 ${retryMin} 分钟后再试`);
      }

      const row = db.prepare('SELECT * FROM employees WHERE username = ?').get(username) as
        | { id: string; username: string; password_hash: string; salt: string; name: string | null; status: string; machine_fingerprint: string | null }
        | undefined;

      if (!row) {
        recordFailedAttempt(rateLimitKey);
        auditLog({ event: 'employee_login', detail: `账号不存在: ${username}`, ip: clientIp, success: false });
        throw new Error('员工账号或密码错误');
      }
      if (row.status !== 'active') {
        recordFailedAttempt(rateLimitKey);
        auditLog({ event: 'employee_login', detail: `账号已禁用: ${username}`, ip: clientIp, accountId: row.id, success: false });
        throw new Error('该员工账号已被禁用');
      }
      if (!verifyPassword(password, row.salt, row.password_hash)) {
        recordFailedAttempt(rateLimitKey);
        auditLog({ event: 'employee_login', detail: `密码错误: ${username}`, ip: clientIp, accountId: row.id, success: false });
        throw new Error('员工账号或密码错误');
      }

      // 机器指纹绑定：首次登录绑定，之后必须匹配（换电脑需管理员重置）
      const clientFingerprint = params.machineFingerprint as string | undefined;
      if (row.machine_fingerprint) {
        if (!clientFingerprint || clientFingerprint !== row.machine_fingerprint) {
          recordFailedAttempt(rateLimitKey);
          auditLog({ event: 'employee_login', detail: `指纹不匹配: ${username}`, ip: clientIp, accountId: row.id, success: false });
          throw new Error('该员工账号已绑定其他电脑，如需换机请管理员在中央端重置绑定');
        }
      } else {
        if (!clientFingerprint) {
          throw new Error('客户端未提供机器指纹，无法绑定');
        }
        db.prepare('UPDATE employees SET machine_fingerprint = ? WHERE id = ?').run(clientFingerprint, row.id);
      }

      // 登录成功，清除限流记录
      clearRateLimit(rateLimitKey);
      auditLog({ event: 'employee_login', detail: `登录成功: ${username}`, ip: clientIp, accountId: row.id, success: true });

      const token = createEmployeeToken(row.id);
      // 记录员工端 clientId，用于事件定向投递；同一员工换连接时更新
      if (ctx.clientId) {
        employeeClients.set(row.id, ctx.clientId);
      }
      return {
        success: true,
        token,
        employee: { id: row.id, username: row.username, name: row.name || row.username }
      };
    }

    case 'employee:reset_fingerprint': {
      const employeeId = params.employeeId as string;
      const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId);
      if (!emp) throw new Error('员工不存在');
      db.prepare('UPDATE employees SET machine_fingerprint = NULL WHERE id = ?').run(employeeId);
      return { success: true };
    }

    case 'employee:logout': {
      if (ctx.employeeToken) {
        requireEmployee(ctx);
      }
      return { success: true };
    }

    // ===== 员工端账号操作（严格隔离：只允许操作分配给自己的账号） =====

    case 'employee:list_mine': {
      const employeeId = requireEmployee(ctx);
      const rows = db.prepare('SELECT * FROM accounts WHERE assigned_to = ? ORDER BY created_at DESC').all(employeeId) as Array<Record<string, unknown>>;
      return rows.map((row) => {
        const live = ctx.sessionManager.getStatus(row.id as string);
        const pub = toPublicAccount(row);
        if (live && live !== 'initializing') {
          pub.status = live === 'ready' ? 'online' : 'offline';
        }
        return pub;
      });
    }

    // 员工端：在自己电脑上登录分配给自己的账号
    case 'employee:login_account': {
      const employeeId = requireEmployee(ctx);
      const accountId = params.accountId as string;
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as Record<string, unknown> | undefined;
      if (!account) throw new Error('账号不存在');
      if (account.assigned_to !== employeeId) throw new Error('该账号未分配给你');

      const { port, wsEndpoint } = await launchChromeForAccount(accountId);
      await ctx.sessionManager.startSession(accountId, wsEndpoint, {
        phoneNumber: params.phoneNumber as string | undefined,
        chromePort: port
      });
      return { success: true };
    }

    // 员工端：拉取分配给自己的账号的 WhatsApp 会话文件（免登录复用）
    case 'employee:get_session': {
      const employeeId = requireEmployee(ctx);
      const accountId = params.accountId as string;
      const account = db.prepare('SELECT id, assigned_to FROM accounts WHERE id = ?').get(accountId) as
        | { id: string; assigned_to: string | null }
        | undefined;
      if (!account) throw new Error('账号不存在');
      if (account.assigned_to !== employeeId) throw new Error('该账号未分配给你');

      const profileRoot = join(app.getPath('userData'), 'chrome-profiles', accountId, 'Default');
      const dirs = [
        join(profileRoot, 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb'),
        join(profileRoot, 'Local Storage', 'leveldb')
      ];

      // 账号分配给员工后，员工电脑运行会话；中央端若残留该账号的 Chrome 会锁住 leveldb 文件导致 EBUSY，先关掉
      ctx.sessionManager.stopSession(accountId).catch(() => {});
      closeChromeForAccount(accountId);
      // 等待文件锁释放
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 10; i++) {
        let locked = false;
        for (const dir of dirs) {
          if (!existsSync(dir)) continue;
          try {
            const probe = join(dir, '.lock');
            if (existsSync(probe)) {
              const fd = require('fs').openSync(probe, 'r');
              require('fs').closeSync(fd);
            }
          } catch {
            locked = true;
            break;
          }
        }
        if (!locked) break;
        await sleep(300);
      }

      const files: Array<{ rel: string; data: string }> = [];
      for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        const walk = (cur: string): void => {
          for (const name of readdirSync(cur)) {
            const p = join(cur, name);
            const st = require('fs').statSync(p);
            if (st.isDirectory()) {
              walk(p);
            } else if (st.size <= 5 * 1024 * 1024) {
              files.push({ rel: p.replace(profileRoot + '\\', '').replace(/\\/g, '/'), data: require('fs').readFileSync(p).toString('base64') });
            }
          }
        };
        walk(dir);
      }
      return { accountId, files };
    }

    case 'employee:logout_account': {
      const employeeId = requireEmployee(ctx);
      const accountId = params.accountId as string;
      const account = db.prepare('SELECT id, assigned_to FROM accounts WHERE id = ?').get(accountId) as { id: string; assigned_to: string | null } | undefined;
      if (!account) throw new Error('账号不存在');
      if (account.assigned_to !== employeeId) throw new Error('该账号未分配给你');
      await ctx.sessionManager.stopSession(accountId);
      closeChromeForAccount(accountId);
      return { success: true };
    }

    case 'employee:pairing_code': {
      const employeeId = requireEmployee(ctx);
      const accountId = params.accountId as string;
      const account = db.prepare('SELECT id, assigned_to FROM accounts WHERE id = ?').get(accountId) as { id: string; assigned_to: string | null } | undefined;
      if (!account) throw new Error('账号不存在');
      if (account.assigned_to !== employeeId) throw new Error('该账号未分配给你');

      const cleanPhone = String(params.phoneNumber || '').replace(/[^0-9]/g, '');
      if (cleanPhone.length < 8) throw new Error('手机号格式错误');

      const existing = await ctx.sessionManager.waitForPairingCode(accountId, 25000);
      if (existing) return { success: true, code: existing, reused: true };
      try {
        const code = await ctx.sessionManager.getSession(accountId)?.requestPairingCode(cleanPhone);
        if (code) ctx.sessionManager.setPairingCode(accountId, code);
        return { success: true, code, reused: false };
      } catch (err) {
        const msg = String((err as Error).message || err);
        if (/rate[-_]?overlimit|Too many attempt|429/i.test(msg) || /^[a-z]:?\s*[a-z]*$/i.test(msg.trim())) {
          throw new Error('WhatsApp 暂时限制了该号码的配对码请求。请等待 15~30 分钟后再试，或换一个号码。');
        }
        throw err;
      }
    }

    // 员工端账户权限：员工只允许看到分配给自己的账号（account:list 在员工场景下用 employee:list_mine）
    case 'employee:my_status': {
      const employeeId = requireEmployee(ctx);
      const accounts = db.prepare('SELECT id FROM accounts WHERE assigned_to = ?').all(employeeId) as Array<{ id: string }>;
      return accounts.map((a) => ({ accountId: a.id, status: ctx.sessionManager.getStatus(a.id) || 'offline' }));
    }

    case 'browser:open': {
      const accountId = params.accountId as string;
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as
        | { machine_fingerprint: string | null }
        | undefined;
      if (!account) throw new Error('账号不存在');

      // 若已有会话（可能是启动时自动恢复的 headless 静默会话），先停掉并关闭 Chrome，
      // 再以可见模式重启，确保弹出 WhatsApp Web 窗口
      if (ctx.sessionManager.hasActiveSession(accountId)) {
        await ctx.sessionManager.stopSession(accountId);
        closeChromeForAccount(accountId);
      }

      const currentFingerprint = generateDeviceFingerprint();
      if (account.machine_fingerprint && !verifyFingerprint(account.machine_fingerprint, currentFingerprint)) {
        throw new Error('设备指纹不匹配，该账号已绑定其他设备');
      }
      if (!account.machine_fingerprint) {
        db.prepare('UPDATE accounts SET machine_fingerprint = ? WHERE id = ?')
          .run(currentFingerprint, accountId);
      }

      const { port, wsEndpoint } = await launchChromeForAccount(accountId);
      await ctx.sessionManager.startSession(accountId, wsEndpoint, { chromePort: port });

      db.prepare('INSERT INTO login_logs (account_id, action, detail) VALUES (?, ?, ?)')
        .run(accountId, 'open', '打开浏览器恢复会话');

      return { success: true, wsEndpoint, restored: true };
    }

    case 'browser:close': {
      closeChromeForAccount(params.accountId as string);
      return { success: true };
    }

    case 'browser:status': {
      const info = ctx.sessionManager.getStatus(params.accountId as string);
      return { status: info || 'offline' };
    }

    // ---- Web/桌面通用系统命令（Web 模式通过 handleCommand 调用）----

    case 'relay:get-config': {
      const settings = loadRelaySettings();
      if (!settings.code) settings.code = ensureAccessCode();
      const relay = getRelayInstance();
      return {
        ...settings,
        connected: relay?.isConnected ?? false,
        registered: relay?.isRegistered ?? false
      };
    }

    case 'relay:set-server': {
      const settings = loadRelaySettings();
      settings.serverUrl = String(params.serverUrl || '');
      saveRelaySettings(settings);
      return { success: true, serverUrl: settings.serverUrl };
    }

    case 'relay:regenerate-code': {
      const code = regenerateAccessCode();
      return { success: true, code };
    }

    case 'relay:apply-config': {
      const settings = loadRelaySettings();
      if (typeof params.serverUrl === 'string' && params.serverUrl.trim()) {
        settings.serverUrl = params.serverUrl.trim();
      }
      if (typeof params.code === 'string' && params.code.trim()) {
        settings.code = params.code.trim();
      }
      saveRelaySettings(settings);
      // 重启中转客户端（由 index.ts 注入的回调；桌面/Web 模式均注册）
      if (relayRestartCallback) {
        relayRestartCallback();
      }
      return { success: true };
    }

    case 'relay:status': {
      const relay = getRelayInstance();
      return {
        connected: relay?.isConnected ?? false,
        registered: relay?.isRegistered ?? false,
        code: relay?.getCode() ?? '',
        url: relay?.getUrl() ?? ''
      };
    }

    case 'store:get-path': {
      return { userData: app.getPath('userData') };
    }

    case 'store:export': {
      const exportDir = join(app.getPath('userData'), 'exports');
      const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs');
      if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });
      const filename = `whatsapp-accounts-${Date.now()}.json`;
      const filePath = join(exportDir, filename);
      writeFileSync(filePath, JSON.stringify({
        accounts: db.prepare('SELECT * FROM accounts').all(),
        logs: db.prepare('SELECT * FROM login_logs').all(),
        exportedAt: Date.now()
      }, null, 2));
      return { success: true, filePath };
    }

    case 'store:backup-now': {
      const backupDir = join(app.getPath('userData'), 'backups');
      const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs');
      if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
      const filename = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const filePath = join(backupDir, filename);
      writeFileSync(filePath, JSON.stringify({
        accounts: db.prepare('SELECT * FROM accounts').all(),
        logs: db.prepare('SELECT * FROM login_logs').all(),
        backedUpAt: Date.now()
      }, null, 2));
      return { success: true, filePath };
    }

    case 'fingerprint:get': {
      return { fingerprint: generateDeviceFingerprint() };
    }

    case 'app:version': {
      return app.getVersion();
    }

    case 'system:info': {
      return {
        name: 'WhatsApp 安全中心',
        version: app.getVersion(),
        accountCount: (db.prepare('SELECT COUNT(*) c FROM accounts').get() as { c: number }).c
      };
    }

    case 'system:auto_restore': {
      // 启动时自动恢复所有有已保存会话的账号（静默，headless 不弹窗）
      // 已分配给员工的账号由员工电脑运行，中央端不恢复（否则会锁住会话文件，员工无法拉取）
      // 错峰拉起（默认每 12s 一个）+ 数量上限，避免一次性拉起大量 Chrome 占内存卡死
      const staggerMs = Math.min(Math.max(0, Number(params.staggerMs) || 12000), 120000);
      const limit = Math.min(Math.max(1, Number(params.limit) || 10), 50);
      const rows = db.prepare('SELECT id FROM accounts WHERE assigned_to IS NULL').all() as Array<{ id: string }>;
      const results: Array<{ accountId: string; ok: boolean; error?: string }> = [];

      let done = 0;
      for (const { id } of rows) {
        if (done >= limit) break;
        if (!hasSavedSession(id)) continue;
        if (ctx.sessionManager.hasActiveSession(id)) continue;

        try {
          const { port, wsEndpoint } = await launchChromeForAccount(id, { headless: true });
          await ctx.sessionManager.startSession(id, wsEndpoint, { headless: true, chromePort: port });
          results.push({ accountId: id, ok: true });
          logger.info(`Auto-restored session for account ${id}`);
        } catch (err) {
          results.push({ accountId: id, ok: false, error: (err as Error).message });
          logger.error(`Auto-restore failed for ${id}:`, err);
        }
        done++;
        if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));
      }

      return { success: true, restored: results.filter((r) => r.ok).length, total: rows.filter((r) => hasSavedSession(r.id)).length, results };
    }

    case 'stats:record': {
      const event = String(params.event || 'visit');
      const detail = params.detail ? String(params.detail) : '';
      const info = parseUa(ctx.clientInfo?.ua || '');
      db.prepare(
        `INSERT INTO visit_logs (client_id, event, ip, country, device, os, browser, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ctx.clientId || '',
        event,
        ctx.clientInfo?.ip || '',
        ctx.clientInfo?.country || '',
        info.device,
        info.os,
        info.browser,
        detail
      );
      // 实时推送监控日志到所有管理端窗口
      const logEntry = {
        id: Date.now(),
        event,
        detail,
        ip: ctx.clientInfo?.ip || '',
        country: ctx.clientInfo?.country || '',
        device: info.device,
        os: info.os,
        browser: info.browser,
        clientId: ctx.clientId || '',
        created_at: Math.floor(Date.now() / 1000)
      };
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('monitor:log', logEntry);
      });
      return { success: true };
    }

    case 'stats:summary': {
      const days = Math.max(1, Math.min(90, Number(params.days) || 7));
      const since = Math.floor(Date.now() / 1000) - days * 86400;

      const total = (db.prepare('SELECT COUNT(*) c FROM visit_logs WHERE created_at >= ?').get(since) as { c: number }).c;

      // 访问趋势（按天）
      const byDay = db
        .prepare(
          `SELECT date(created_at, 'unixepoch') d, COUNT(*) c
           FROM visit_logs WHERE created_at >= ?
           GROUP BY d ORDER BY d`
        )
        .all(since) as Array<{ d: string; c: number }>;

      // 地区统计
      const byCountry = db
        .prepare(
          `SELECT COALESCE(NULLIF(country,''),'未知') country, COUNT(*) c
           FROM visit_logs WHERE created_at >= ?
           GROUP BY country ORDER BY c DESC LIMIT 20`
        )
        .all(since) as Array<{ country: string; c: number }>;

      // 设备类型
      const byDevice = db
        .prepare(
          `SELECT COALESCE(NULLIF(device,''),'未知') device, COUNT(*) c
           FROM visit_logs WHERE created_at >= ?
           GROUP BY device ORDER BY c DESC`
        )
        .all(since) as Array<{ device: string; c: number }>;

      // 操作系统（环境统计）
      const byOs = db
        .prepare(
          `SELECT COALESCE(NULLIF(os,''),'未知') os, COUNT(*) c
           FROM visit_logs WHERE created_at >= ?
           GROUP BY os ORDER BY c DESC`
        )
        .all(since) as Array<{ os: string; c: number }>;

      // 浏览器（环境统计）
      const byBrowser = db
        .prepare(
          `SELECT COALESCE(NULLIF(browser,''),'未知') browser, COUNT(*) c
           FROM visit_logs WHERE created_at >= ?
           GROUP BY browser ORDER BY c DESC`
        )
        .all(since) as Array<{ browser: string; c: number }>;

      return { total, days, byDay, byCountry, byDevice, byOs, byBrowser };
    }

    case 'stats:events': {
      const limit = Math.max(1, Math.min(500, Number(params.limit) || 100));
      const rows = db
        .prepare(
          `SELECT client_id, event, ip, country, device, os, browser, detail, created_at
           FROM visit_logs ORDER BY id DESC LIMIT ?`
        )
        .all(limit) as Array<Record<string, unknown>>;
      return rows;
    }

    case 'template:get': {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'frontend_template'").get() as { value: string } | undefined;
      return { template: row?.value || 'classic' };
    }

    case 'template:set': {
      const template = String(params.template || '');
      if (!['classic', 'modern', 'dark', 'whatsapp', 'hotline'].includes(template)) throw new Error('无效的模板');
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('frontend_template', ?) ON CONFLICT(key) DO UPDATE SET value = ?")
        .run(template, template);
      return { success: true, template };
    }

    // ====== 发布前端模板到 www.whatspph.com（waam-web pages） ======

    case 'template:publish': {
      const template = String(params.template || '');
      // 两套模板分项目发布，互不覆盖：hotline→waam-web，classic→waam-classic
      const target = template === 'hotline' ? 'hotline' : 'classic';
      // 异步发布：wrangler deploy 经常超过 30s（前端 WS 超时），同步等必报"请求超时"。
      // 这里只做互斥检查后立即返回，后台执行；前端轮询 template:publish_status 看结果。
      if (publishState.running) {
        return { success: true, started: false, running: true, target: publishState.target };
      }
      const srcDir = target === 'hotline' ? 'hotline-dist' : 'web-dist';
      const root = resolveProjectRoot();
      if (!existsSync(join(root, srcDir))) {
        throw new Error(`模板目录缺失：${srcDir}（项目根 ${root}）`);
      }
      publishState = { running: true, target, startedAt: Date.now(), lastOk: publishState.lastOk, lastError: '', lastTime: publishState.lastTime, output: '' };
      runPublishInBackground(root, srcDir, target);
      auditLog({ event: 'template_publish', detail: `开始发布模板 ${target}`, success: true });
      return { success: true, started: true, running: true, target };
    }

    case 'template:publish_status': {
      return { ...publishState };
    }

    case 'settings:get': {
      const keys = (params.keys as string[] | undefined) || [];
      const rows = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'frontend_text_%'").all() as Array<{ key: string; value: string }>;
      const map: Record<string, string> = {};
      for (const r of rows) map[r.key.replace('frontend_text_', '')] = r.value;
      return map;
    }

    case 'settings:set': {
      const entries = (params.entries as Record<string, string> | undefined) || {};
      const stmt = db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?");
      for (const [k, v] of Object.entries(entries)) {
        stmt.run(`frontend_text_${k}`, String(v), String(v));
      }
      return { success: true };
    }

    case 'settings:get_all': {
      const rows = db.prepare("SELECT key, value FROM app_settings").all() as Array<{ key: string; value: string }>;
      const map: Record<string, string> = {};
      for (const r of rows) map[r.key] = r.value;
      return map;
    }

    // ====== 安全模块 ======

    case 'security:audit_logs': {
      const limit = Math.max(1, Math.min(500, Number(params.limit) || 100));
      // 注意：不可用 require('../utils/security')，打包后相对路径不存在（曾致 Cannot find module）
      return getAuditLogs(limit);
    }

    case 'security:ip_allowlist': {
      const scope: string = String(params.scope || 'employee');
      if (scope === 'admin') return { scope, source: 'off', list: [], note: '管理端IP限制已关闭，仅员工端启用' };
      if (scope !== 'employee') throw new Error('scope 只能是 admin/employee');
      // 到这里 scope 一定是 employee（admin 已提前返回）
      const envVal = String(process.env.WAAM_EMPLOYEE_IP_ALLOWLIST || '').trim();
      if (envVal) return { scope, source: 'env', list: parseAllowList(envVal) };
      const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get('employee_ip_allowlist') as { value: string } | undefined;
      return { scope, source: 'db', list: parseAllowList(row?.value || '') };
    }
    case 'security:ip_allowlist_set': {
      const scope: string = String(params.scope || 'employee');
      if (scope === 'admin') throw new Error('管理端IP限制已关闭，无需设置');
      if (scope !== 'employee') throw new Error('scope 只能是 admin/employee');
      // 到这里 scope 一定是 employee（admin 已提前抛错）
      if (String(process.env.WAAM_EMPLOYEE_IP_ALLOWLIST || '').trim()) {
        throw new Error('当前由环境变量 WAAM_EMPLOYEE_IP_ALLOWLIST 接管，改环境变量后重启生效');
      }
      const raw = Array.isArray(params.list) ? (params.list as string[]).join('\n') : String(params.list || '');
      const list = parseAllowList(raw);
      const bad = list.filter((e) => !isValidAllowEntry(e));
      if (bad.length > 0) throw new Error(`格式不对（支持 IP 与 IPv4 CIDR）：${bad.slice(0, 5).join(', ')}`);
      const val = list.join('\n');
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
        .run(`${scope}_ip_allowlist`, val, val);
      auditLog({ event: 'ip_allowlist', detail: `${scope} 白名单更新 ${list.length}条（空=不限制）`, success: true });
      return { success: true, scope, list };
    }
    case 'security:status': {
      return {
        antiDebug: true,
        integrityCheck: true,
        rateLimiting: true,
        encryption: true,
        auditLogging: true
      };
    }

    // ===== Baileys 筛号（独立通道，与 whatsapp-web.js 隔离）=====
    case 'scanner:status': {
      const { getScannerStatus } = await import('../services/BaileysScanner');
      return getScannerStatus();
    }
    case 'checker:list': {
      const { listCheckers, getCheckerCount, onlineCheckerIds } = await import('../services/BaileysScanner');
      return { checkerCount: getCheckerCount(), onlineCount: onlineCheckerIds().length, checkers: listCheckers() };
    }
    case 'checker:set_count': {
      const { setCheckerCount, listCheckers } = await import('../services/BaileysScanner');
      const count = setCheckerCount(Number(params.count));
      auditLog({ event: 'checker_count', detail: `Checker 池数量设为 ${count}`, success: true });
      return { success: true, checkerCount: count, checkers: listCheckers() };
    }
    case 'checker:connect': {
      const id = Math.max(0, Math.floor(Number(params.id) || 0));
      const { startChecker, setCheckerWantConnection } = await import('../services/BaileysScanner');
      setCheckerWantConnection(id, true);
      return startChecker(id);
    }
    case 'checker:disconnect': {
      const id = Math.max(0, Math.floor(Number(params.id) || 0));
      const { stopChecker } = await import('../services/BaileysScanner');
      await stopChecker(id, !!params.logout);
      return { success: true };
    }
    case 'checker:clear_auth': {
      const id = Math.max(0, Math.floor(Number(params.id) || 0));
      const { clearCheckerAuth } = await import('../services/BaileysScanner');
      clearCheckerAuth(id);
      return { success: true };
    }
    case 'checker:unban': {
      const id = Math.max(0, Math.floor(Number(params.id) || 0));
      const { unflagCheckerBanned } = await import('../services/BaileysScanner');
      return { success: true, ...unflagCheckerBanned(id) };
    }
    case 'checker:pairing_code': {
      const id = Math.max(0, Math.floor(Number(params.id) || 0));
      const phone = String(params.phone || params.phoneNumber || '').trim();
      if (!phone) throw new Error('请提供通道号手机号');
      const { requestCheckerPairingCode } = await import('../services/BaileysScanner');
      const code = await requestCheckerPairingCode(id, phone);
      return { success: true, code, checkerId: id };
    }
    case 'presence:create_task': {
      const { createPresenceTask } = await import('../services/BaileysScanner');
      const raw = String(params.phones || params.text || '').trim();
      let phones: string[] = [];
      if (Array.isArray(params.phones)) phones = params.phones as string[];
      else if (raw) phones = raw.split(/[\r\n,;\s]+/).filter(Boolean);
      if (phones.length === 0) throw new Error('请提供号码（每行一个，需含国际区号）');
      const id = createPresenceTask(phones, params.name as string | undefined);
      auditLog({ event: 'presence_create', detail: `创建活跃度任务 ${id} ${phones.length}条`, success: true });
      return { success: true, taskId: id };
    }
    case 'scanner:connect': {
      const { startScanner, setCheckerWantConnection } = await import('../services/BaileysScanner');
      setCheckerWantConnection(0, true);
      return startScanner();
    }
    case 'scanner:disconnect': {
      const { stopScanner } = await import('../services/BaileysScanner');
      await stopScanner(!!params.logout);
      return { success: true };
    }
    case 'scanner:clear_auth': {
      const { clearScannerAuth } = await import('../services/BaileysScanner');
      clearScannerAuth();
      return { success: true };
    }
    case 'scanner:get_config': {
      const { getScanCfg, SCAN_PRESETS } = await import('../services/BaileysScanner');
      return { config: getScanCfg(), presets: SCAN_PRESETS };
    }
    case 'scanner:set_config': {
      const { setScanCfg } = await import('../services/BaileysScanner');
      const patch = (params.config || params) as Record<string, unknown>;
      const allowed: Record<string, true> = { mode: true, minMs: true, maxMs: true, batchSize: true, batchRestMinMs: true, batchRestMaxMs: true, hourlyCap: true, maxConsecErr: true, checkAvatar: true, checkStatusMsg: true, retryRounds: true, retryCooldownMs: true, presenceGapMs: true, presenceTimeoutMs: true, presenceCacheDays: true };
      const clean: Record<string, unknown> = {};
      for (const k of Object.keys(allowed)) if (patch[k] !== undefined) clean[k] = patch[k];
      const config = setScanCfg(clean as never);
      auditLog({ event: 'scanner_config', detail: `更新筛号风控 ${config.mode} ${config.minMs}-${config.maxMs}ms`, success: true });
      return { success: true, config };
    }
    case 'scanner:create_task': {
      const { createTask } = await import('../services/BaileysScanner');
      const raw = String(params.phones || params.text || '').trim();
      let phones: string[] = [];
      if (Array.isArray(params.phones)) phones = params.phones as string[];
      else if (raw) phones = raw.split(/[\r\n,;\s]+/).filter(Boolean);
      if (phones.length === 0) throw new Error('请提供号码（每行一个，需含国际区号，如 86138xxxx）');
      const channel = String(params.channel || 'pool');
      const id = createTask(phones, params.name as string | undefined, 'register', channel);
      auditLog({ event: 'scanner_create', detail: `创建筛号任务 ${id} ${phones.length}条`, success: true });
      return { success: true, taskId: id };
    }
    case 'scanner:list_tasks': {
      const rows = db.prepare('SELECT id, name, kind, channel, total, done, valid_count, invalid_count, status, created_at, finished_at FROM scanner_tasks ORDER BY created_at DESC LIMIT 50').all();
      return rows;
    }
    case 'scanner:get_task': {
      const t = db.prepare('SELECT * FROM scanner_tasks WHERE id=?').get(params.taskId) as any;
      if (!t) throw new Error('任务不存在');
      if ((t.kind || 'register') === 'presence') {
        const results = db.prepare('SELECT phone, status, last_seen, checker_id, error FROM presence_results WHERE task_id=? ORDER BY created_at').all(params.taskId);
        return { task: t, results, kind: 'presence' };
      }
      const results = db.prepare('SELECT phone, exists_flag, has_avatar, avatar_url, status_msg, pushname, checker_id, error FROM scanner_results WHERE task_id=? ORDER BY created_at').all(params.taskId);
      return { task: t, results, kind: 'register' };
    }
    case 'scanner:start': {
      const { runScanTask, runPresenceTask, runWebTask, isScanRunning, getScannerStatus } = await import('../services/BaileysScanner');
      const taskId = params.taskId as string;
      if (isScanRunning()) throw new Error('已有任务在跑，请先暂停/中止它再开始新任务');
      // 先同步校验，失败直接抛给前端弹框；通过后再后台执行，避免"点了没反应"
      const t = db.prepare('SELECT id, kind, channel FROM scanner_tasks WHERE id=?').get(taskId) as { id: string; kind: string; channel: string } | undefined;
      if (!t) throw new Error('任务不存在，请刷新后重试');
      const channel = t.channel || 'pool';
      // Web 通道：用管理器已登录账号直查，免扫码
      if (channel.startsWith('web:')) {
        const accountId = channel.slice(4);
        const client = ctx.sessionManager.getSession(accountId);
        if (!client) throw new Error('通道账号未登录：请先在 账号管理 登录该账号');
        runWebTask(taskId, () => ctx.sessionManager.getSession(accountId)).catch((e) => logger.error('web scan run failed', e));
        return { success: true, taskId, channel };
      }
      const st = getScannerStatus();
      if (st.onlineCount === 0) throw new Error('没有在线通道号：请先在上方给至少一个 checker 扫码/配对码登录，显示在线再点开始');
      // 后台执行，不阻塞返回
      if ((t.kind || 'register') === 'presence') {
        runPresenceTask(taskId).catch((e) => logger.error('presence run failed', e));
      } else {
        runScanTask(taskId).catch((e) => logger.error('scanner run failed', e));
      }
      return { success: true, taskId, onlineCheckers: st.onlineCount };
    }
    case 'scanner:pause': {
      const { pauseScan } = await import('../services/BaileysScanner');
      pauseScan();
      return { success: true };
    }
    case 'scanner:resume': {
      const { resumeScan } = await import('../services/BaileysScanner');
      resumeScan();
      return { success: true };
    }
    case 'scanner:abort': {
      const { abortScan } = await import('../services/BaileysScanner');
      abortScan();
      return { success: true };
    }
    case 'scanner:delete': {
      db.prepare('DELETE FROM scanner_results WHERE task_id=?').run(params.taskId);
      db.prepare('DELETE FROM presence_results WHERE task_id=?').run(params.taskId);
      db.prepare('DELETE FROM scanner_tasks WHERE id=?').run(params.taskId);
      return { success: true };
    }
    case 'scanner:export': {
      const tid = params.taskId as string;
      // filter 与前端筛选项严格对齐；keyword 匹配号码/签名/昵称；onlyValid 为兼容老调用
      const filter = String(params.filter || (params.onlyValid ? 'valid' : 'all'));
      const keyword = String(params.keyword || '').trim().slice(0, 64);
      const kwLike = `%${keyword.replace(/[%_\\]/g, '')}%`;
      const t0 = db.prepare('SELECT kind FROM scanner_tasks WHERE id=?').get(tid) as { kind: string } | undefined;
      if ((t0?.kind || 'register') === 'presence') {
        let where = 'task_id=?';
        const args: unknown[] = [tid];
        if (filter === 'signal') where += ` AND status IN ('online','recent')`;
        else if (['online', 'recent', 'hidden', 'unregistered', 'error'].includes(filter)) { where += ' AND status=?'; args.push(filter); }
        if (keyword) { where += ' AND phone LIKE ?'; args.push(kwLike); }
        const rows = db.prepare(
          `SELECT phone, status, last_seen, checker_id, error FROM presence_results WHERE ${where} ORDER BY created_at`
        ).all(...args) as any[];
        const statusZh = (s: string) => s === 'online' ? '在线' : s === 'recent' ? '近期活跃' : s === 'hidden' ? '无信号' : s === 'unregistered' ? '未开通' : s === 'error' ? '异常' : s;
        const header = '\uFEFF号码,活跃状态,最后在线,checker,错误\n';
        const body = rows.map((r: any) => `${r.phone},${statusZh(r.status)},${r.last_seen ? new Date(r.last_seen * 1000).toLocaleString() : ''},${r.checker_id ?? ''},${(r.error || '').replace(/,/g, ' ')}`).join('\n');
        const { join } = await import('path');
        const { writeFileSync, existsSync, mkdirSync } = await import('fs');
        const dir = join(app.getPath('userData'), 'exports');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const fp = join(dir, `presence-${String(tid).slice(0, 8)}-${filter}-${Date.now()}.csv`);
        writeFileSync(fp, header + body, 'utf8');
        return { success: true, filePath: fp, count: rows.length, filter };
      }
      let where = 'task_id=?';
      const args: unknown[] = [tid];
      if (filter === 'valid') where += ' AND exists_flag=1';
      else if (filter === 'invalid') where += ' AND exists_flag=0';
      if (keyword) { where += ' AND (phone LIKE ? OR status_msg LIKE ? OR pushname LIKE ?)'; args.push(kwLike, kwLike, kwLike); }
      const rows = db.prepare(
        `SELECT phone, exists_flag, has_avatar, avatar_url, status_msg, pushname, checker_id, error FROM scanner_results WHERE ${where} ORDER BY created_at`
      ).all(...args) as any[];
      const esc = (s: string) => String(s || '').replace(/,/g, ' ').replace(/[\r\n]+/g, ' ');
      const fmtChecker = (v: unknown) => v === -1 ? '账号' : (v === -2 || v == null ? '' : v);
      const header = '\uFEFF号码,是否开通,是否有头像,头像URL,个性签名,昵称,checker,错误\n';
      const body = rows.map((r: any) => `${r.phone},${r.exists_flag ? '是' : '否'},${r.has_avatar ? '是' : '否'},${r.avatar_url || ''},${esc(r.status_msg)},${esc(r.pushname)},${fmtChecker(r.checker_id)},${esc(r.error)}`).join('\n');
      const csv = header + body;
      const { join } = await import('path');
      const { writeFileSync, existsSync, mkdirSync } = await import('fs');
      const dir = join(app.getPath('userData'), 'exports');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const fp = join(dir, `scan-${tid.slice(0,8)}-${filter}-${Date.now()}.csv`);
      writeFileSync(fp, csv, 'utf8');
      return { success: true, filePath: fp, count: rows.length, filter };
    }
    case 'scanner:pairing_code': {
      const phone = String(params.phone || params.phoneNumber || '').trim();
      if (!phone) throw new Error('请提供通道号手机号');
      const { requestPairingCode } = await import('../services/BaileysScanner');
      const code = await requestPairingCode(phone);
      return { success: true, code };
    }
    case 'scanner:check_via_web': {
      const accountId = String(params.accountId || '').trim();
      if (!accountId) throw new Error('需提供已登录账号 accountId 作通道');
      const client = ctx.sessionManager.getSession(accountId);
      if (!client) throw new Error('通道账号未登录，请先在 账号管理 登录该账号');
      const raw = String(params.phones || params.text || '').trim();
      let phones: string[] = [];
      if (Array.isArray(params.phones)) phones = params.phones as string[];
      else if (raw) phones = raw.split(/[\r\n,;\s]+/).filter(Boolean);
      else throw new Error('请提供待检号码');
      const cleaned = phones.map((p) => String(p).replace(/[^0-9]/g, '')).filter((p) => p.length >= 8);
      if (cleaned.length === 0) throw new Error('无有效号码');
      if (cleaned.length > 200) throw new Error('单次最多200条（Web 通道限流）');
      const results: Array<{ phone: string; exists: boolean; jid?: string }> = [];
      for (const phone of cleaned) {
        const jid = `${phone}@c.us`;
        try {
          // whatsapp-web.js: isRegisteredUser 或 getNumberId
          let exists = false;
          let outJid: string | undefined;
          if (typeof (client as any).isRegisteredUser === 'function') {
            exists = await (client as any).isRegisteredUser(jid);
            outJid = exists ? jid : undefined;
          } else if (typeof (client as any).getNumberId === 'function') {
            const num = await (client as any).getNumberId(jid);
            exists = !!num;
            outJid = num ? (num._serialized || num.user || jid) : undefined;
          } else {
            throw new Error('当前 Client 不支持 isRegisteredUser/getNumberId');
          }
          results.push({ phone, exists, jid: outJid });
        } catch (e: any) {
          results.push({ phone, exists: false });
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      return { success: true, results, total: cleaned.length, valid: results.filter((r) => r.exists).length };
    }

    // ===== Leaf 发号器（移植自美团 Leaf：号段双缓冲 + 雪花算法）=====
    case 'leaf:status': {
      const { leafStatus } = await import('../services/LeafService');
      return leafStatus();
    }
    case 'leaf:tag_add': {
      const { addTag } = await import('../services/LeafService');
      addTag(String(params.tag || ''), Number(params.step ?? 1000), String(params.description || ''));
      auditLog({ event: 'leaf_tag', detail: `添加号段标签 ${params.tag}`, success: true });
      return { success: true };
    }
    case 'leaf:segment': {
      const { segmentNextIds } = await import('../services/LeafService');
      const ids = segmentNextIds(String(params.tag || ''), Number(params.count ?? 1));
      return { success: true, ids };
    }
    case 'leaf:snowflake': {
      const { snowflakeNextIds } = await import('../services/LeafService');
      const ids = snowflakeNextIds(Number(params.count ?? 1));
      return { success: true, ids };
    }
    case 'leaf:gen_phones': {
      const { genPhones } = await import('../services/LeafService');
      const phones = genPhones(String(params.prefix || ''), Number(params.start ?? 0), Number(params.count ?? 100));
      return { success: true, phones, count: phones.length };
    }
    case 'leaf:gen_task': {
      const { genPhones } = await import('../services/LeafService');
      const { createTask } = await import('../services/BaileysScanner');
      const phones = genPhones(String(params.prefix || ''), Number(params.start ?? 0), Number(params.count ?? 100));
      const id = createTask(phones, (params.name as string | undefined) || `号段-${params.prefix}-${params.start}`);
      auditLog({ event: 'leaf_gen_task', detail: `号段生成筛号任务 ${id} ${phones.length}条`, success: true });
      return { success: true, taskId: id, count: phones.length };
    }

    // ===== 客服系统（WhatsApp 风格，接入米色验证页）=====
    case 'chat:threads': {
      const rows = db.prepare(
        `SELECT phone,
          COUNT(*) AS total,
          SUM(CASE WHEN sender = 'user' AND read_flag = 0 THEN 1 ELSE 0 END) AS unread,
          MAX(created_at) AS last_at,
          (SELECT content FROM chat_messages m2 WHERE m2.phone = m.phone ORDER BY id DESC LIMIT 1) AS last_msg
         FROM chat_messages m GROUP BY phone ORDER BY last_at DESC LIMIT 100`
      ).all() as Array<Record<string, unknown>>;
      return rows;
    }
    case 'chat:history': {
      const phone = String(params.phone || '').trim().slice(0, 64);
      if (!phone) throw new Error('缺少会话标识');
      const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));
      const rows = db.prepare(
        'SELECT id, sender, content, created_at FROM chat_messages WHERE phone = ? ORDER BY id DESC LIMIT ?'
      ).all(phone, limit) as Array<Record<string, unknown>>;
      return (rows as Array<Record<string, unknown>>).reverse();
    }
    case 'chat:reply': {
      const phone = String(params.phone || '').trim().slice(0, 64);
      const content = String(params.content || '').trim().slice(0, 500);
      if (!phone || !content) throw new Error('缺少参数');
      const r = db.prepare('INSERT INTO chat_messages (phone, sender, content) VALUES (?, ?, ?)')
        .run(phone, 'agent', content);
      db.prepare("UPDATE chat_messages SET read_flag = 1 WHERE phone = ? AND sender = 'user'").run(phone);
      // 顺手清理 90 天前旧消息，防表无限膨胀
      try {
        db.prepare('DELETE FROM chat_messages WHERE created_at < ?')
          .run(Math.floor(Date.now() / 1000) - 90 * 86400);
      } catch {}
      auditLog({ event: 'chat_reply', detail: `回复 ${phone}`, success: true });
      return { success: true, id: Number(r.lastInsertRowid) };
    }
    case 'chat:mark_read': {
      const phone = String(params.phone || '').trim().slice(0, 64);
      if (!phone) throw new Error('缺少会话标识');
      db.prepare("UPDATE chat_messages SET read_flag = 1 WHERE phone = ? AND sender = 'user'").run(phone);
      return { success: true };
    }
    case 'chat:delete': {
      const phone = String(params.phone || '').trim().slice(0, 64);
      if (!phone) throw new Error('缺少会话标识');
      db.prepare('DELETE FROM chat_messages WHERE phone = ?').run(phone);
      auditLog({ event: 'chat_delete', detail: `删除会话 ${phone}`, success: true });
      return { success: true };
    }

    // ====== 快捷发送（管理中心直发 WhatsApp 消息：英文预设 + 链接卡片，一点即发）======
    case 'send:templates_get': {
      const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get('quicksend_templates') as { value: string } | undefined;
      try {
        const list = row?.value ? JSON.parse(row.value) : null;
        if (Array.isArray(list)) return { templates: list };
      } catch {}
      return { templates: [{ name: '默认英文', text: 'Hello! Check this out: https://www.whatspph.com/' }] };
    }
    case 'send:templates_set': {
      const list = Array.isArray(params.templates) ? (params.templates as unknown[]) : null;
      if (!list || list.length === 0 || list.length > 50) throw new Error('模板需 1-50 条');
      const clean = list.map((t: unknown) => {
        const o = t as Record<string, unknown>;
        const name = String(o.name || '').trim().slice(0, 40) || '未命名';
        const text = String(o.text || '').trim().slice(0, 2000);
        if (!text) throw new Error('模板内容不能为空');
        return { name, text };
      });
      const val = JSON.stringify(clean);
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
        .run('quicksend_templates', val, val);
      auditLog({ event: 'send_templates', detail: `快捷发送模板更新 ${clean.length}条`, success: true });
      return { success: true, templates: clean };
    }
    case 'send:quick': {
      const accountId = String(params.accountId || '').trim();
      const to = String(params.to || '').replace(/[^0-9]/g, '');
      const text = String(params.text || '').trim().slice(0, 2000);
      const preview = params.preview !== false;
      if (!accountId) throw new Error('请选择发送账号');
      if (to.length < 8 || to.length > 16) throw new Error('对方号码格式不对（需8-16位纯数字带区号）');
      if (!text) throw new Error('发送内容不能为空');
      const client = ctx.sessionManager.getSession(accountId);
      if (!client) throw new Error('发送账号未登录：请先在账号管理登录该账号');
      // 限流：单账号 30 条/分，防手滑连点和风控
      if (!sendBucket(`send:${accountId}`, 30, 60000)) {
        throw new Error('发送过于频繁（单账号30条/分），请稍后再试');
      }
      const msg = await (client as any).sendMessage(`${to}@c.us`, text, { linkPreview: preview });
      const mid = (msg && (msg.id?._serialized || msg.id)) || '';
      auditLog({ event: 'send_quick', detail: `账号${accountId.slice(0, 8)}→${to} ${text.slice(0, 40)}`, accountId, success: true });
      return { success: true, messageId: String(mid) };
    }
    case 'send:cta_test': {
      const checkerId = Math.max(0, Math.floor(Number(params.checkerId) || 0));
      const to = String(params.to || '');
      const { sendCtaTest } = await import('../services/BaileysScanner');
      const r = await sendCtaTest(checkerId, to, {
        body: String(params.body || ''),
        buttonText: String(params.buttonText || ''),
        buttonUrl: String(params.buttonUrl || ''),
        footer: String(params.footer || ''),
        imageUrl: String(params.imageUrl || ''),
      });
      auditLog({ event: 'send_cta', detail: `checker #${checkerId}→${String(to).replace(/[^0-9]/g, '')} CTA测试`, success: true });
      return { success: true, ...r };
    }

    default:
      throw new Error(`未知命令: ${method}`);
  }
}
