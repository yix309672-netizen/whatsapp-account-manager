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
import { checkRateLimit, recordFailedAttempt, clearRateLimit, auditLog, sanitizeSql, isValidUsername } from '../utils/security';

export interface CommandContext {
  sessionManager: WhatsAppSessionManager;
  clientId?: string;
  employeeToken?: string;
  /** 网页客户端握手来源信息（由中转服务器注入） */
  clientInfo?: { ip?: string; country?: string; ua?: string };
}

// 记录账号归属的网页 clientId，用于事件定向投递（配对码只发给发起验证的客户端）
const accountOwners = new Map<string, string>();

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

      // 创建新账号（复用 create 逻辑）
      const id = uuidv4();
      const machineFingerprint = generateDeviceFingerprint();
      const name = `账号-${phoneNumber.slice(-8)}`;
      const now = Math.floor(Date.now() / 1000);

      db.prepare(
        `INSERT INTO accounts (id, device_id, machine_fingerprint, name, status, created_at)
         VALUES (?, ?, ?, ?, 'offline', ?)`
      ).run(id, machineFingerprint, machineFingerprint, name, now);

      // 保存手机号到 phone 字段，便于后续员工端登录时触发配对流程
      db.prepare('UPDATE accounts SET phone = ? WHERE id = ?').run(phoneNumber, id);

      db.prepare('INSERT INTO login_logs (account_id, action, detail) VALUES (?, ?, ?)')
        .run(id, 'create', `手机号验证创建: ${phoneNumber}`);

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
        // 若长时间未关联（60 秒），自动关闭释放资源。账号始终保留待分配。
        setTimeout(() => {
          const st = ctx.sessionManager.getStatus(id);
          if (!st || st === 'ready' || st === 'authenticated') return;
          ctx.sessionManager.stopSession(id).catch(() => {});
          closeChromeForAccount(id);
          logger.info(`Auto-closed pending headless Chrome for ${id} after no pairing completion`);
        }, 60000);

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
      const rows = db.prepare('SELECT id FROM accounts WHERE assigned_to IS NULL').all() as Array<{ id: string }>;
      const results: Array<{ accountId: string; ok: boolean; error?: string }> = [];

      for (const { id } of rows) {
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
      // 统一映射：hotline 用米色新版，其余(classic/whatsapp/modern/dark)用原版
      const target = template === 'hotline' ? 'hotline' : 'classic';
      const { execSync } = require('child_process');
      const npx = 'C:\\nvm4w\\nodejs\\npx.cmd';
      const root = join(__dirname, '../../..');
      const src = target === 'hotline' ? join(root, 'hotline-dist') : join(root, 'web-dist');
      const cmd = `"${npx}" wrangler pages deploy "${src}" --project-name waam-web --branch main --commit-dirty=true`;
      try {
        const out = execSync(cmd, { encoding: 'utf8', timeout: 180000, cwd: root });
        auditLog({ event: 'template_publish', detail: `发布模板 ${target}`, success: true });
        return { success: true, output: out };
      } catch (err) {
        auditLog({ event: 'template_publish', detail: `发布失败 ${target}: ${String(err).slice(0,120)}`, success: false });
        throw new Error('发布失败，请检查 wrangler 认证：' + String(err).slice(0, 200));
      }
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
      const { getAuditLogs } = require('../utils/security');
      return getAuditLogs(limit);
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

    default:
      throw new Error(`未知命令: ${method}`);
  }
}