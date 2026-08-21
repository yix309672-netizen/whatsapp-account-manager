import { app } from 'electron';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from './logger';

// ==================== 1. 进程保护（反调试） ====================

let debugCheckTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 检测是否被调试（反调试）
 * 检测方式：检查 NODE_OPTIONS 环境变量、inspect 参数、调试端口
 */
export function detectDebugger(): boolean {
  // 检查命令行参数
  const args = process.argv.join(' ').toLowerCase();
  if (args.includes('--inspect') || args.includes('--debug') || args.includes('--remote-debugging-port')) {
    // 排除我们自己启动的 Chrome（远程调试端口是用于 WhatsApp 的）
    if (!args.includes('--remote-debugging-port=0')) {
      return true;
    }
  }

  // 检查环境变量
  const nodeOptions = (process.env.NODE_OPTIONS || '').toLowerCase();
  if (nodeOptions.includes('--inspect') || nodeOptions.includes('--debug')) {
    return true;
  }

  // 检查调试器是否附加（Windows）
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const result = execSync('powershell.exe -NoProfile -Command "Get-Process -Id ' + process.pid + ' | Select-Object -ExpandProperty DebuggerAttached"', {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      }).trim();
      if (result === 'True') return true;
    } catch {
      // 无法检测时不视为异常
    }
  }

  return false;
}

/**
 * 启动反调试保护（定期检测）
 */
export function startAntiDebug(): void {
  if (debugCheckTimer) return;

  // 启动时立即检测一次
  if (detectDebugger()) {
    logger.error('Debugger detected at startup, exiting...');
    app.quit();
    return;
  }

  // 每 5 秒检测一次
  debugCheckTimer = setInterval(() => {
    if (detectDebugger()) {
      logger.error('Debugger detected during runtime, exiting...');
      app.quit();
    }
  }, 5000);

  logger.info('Anti-debug protection started');
}

/**
 * 停止反调试保护
 */
export function stopAntiDebug(): void {
  if (debugCheckTimer) {
    clearInterval(debugCheckTimer);
    debugCheckTimer = null;
  }
}

// ==================== 2. 完整性校验 ====================

const INTEGRITY_FILE = 'integrity.dat';

/**
 * 计算文件 SHA256 哈希
 */
function fileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 保存应用完整性校验值
 * 在首次运行时计算并保存，后续启动时验证
 */
export function saveIntegrityHash(): void {
  try {
    const asarPath = join(app.getAppPath(), 'app.asar');
    if (!existsSync(asarPath)) return;

    const hash = fileHash(asarPath);
    const integrityPath = join(app.getPath('userData'), INTEGRITY_FILE);

    // 如果已有校验值，验证是否匹配
    if (existsSync(integrityPath)) {
      const saved = readFileSync(integrityPath, 'utf8');
      if (saved !== hash) {
        logger.error('Integrity check FAILED: app.asar has been modified!');
        logger.error(`Expected: ${saved}`);
        logger.error(`Got: ${hash}`);
        // 记录但不退出（可能是正常更新）
        logger.warn('Integrity mismatch detected - application may have been tampered');
      }
    } else {
      // 首次运行，保存校验值
      writeFileSync(integrityPath, hash, 'utf8');
      logger.info(`Integrity hash saved: ${hash}`);
    }
  } catch (err) {
    logger.warn('Integrity check skipped:', err);
  }
}

// ==================== 3. 网络防护（限流） ====================

interface RateLimitEntry {
  count: number;
  firstAttempt: number;
  lastAttempt: number;
  blockedUntil: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

const RATE_LIMIT_CONFIG = {
  maxAttempts: 5,           // 最大尝试次数
  windowMs: 15 * 60 * 1000, // 15 分钟窗口
  blockDurationMs: 30 * 60 * 1000 // 封锁 30 分钟
};

/**
 * 检查 IP/账号 是否被限流
 */
export function checkRateLimit(key: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry) {
    return { allowed: true };
  }

  // 检查是否仍在封锁期
  if (entry.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterMs: entry.blockedUntil - now
    };
  }

  // 检查是否在时间窗口内
  if (now - entry.firstAttempt > RATE_LIMIT_CONFIG.windowMs) {
    // 窗口已过期，重置
    rateLimitMap.delete(key);
    return { allowed: true };
  }

  // 检查尝试次数
  if (entry.count >= RATE_LIMIT_CONFIG.maxAttempts) {
    entry.blockedUntil = now + RATE_LIMIT_CONFIG.blockDurationMs;
    rateLimitMap.set(key, entry);
    return {
      allowed: false,
      retryAfterMs: RATE_LIMIT_CONFIG.blockDurationMs
    };
  }

  return { allowed: true };
}

/**
 * 记录一次尝试（失败时调用）
 */
export function recordFailedAttempt(key: string): void {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now - entry.firstAttempt > RATE_LIMIT_CONFIG.windowMs) {
    rateLimitMap.set(key, {
      count: 1,
      firstAttempt: now,
      lastAttempt: now,
      blockedUntil: 0
    });
  } else {
    entry.count++;
    entry.lastAttempt = now;
    rateLimitMap.set(key, entry);
  }
}

/**
 * 清除成功登录后的尝试记录
 */
export function clearRateLimit(key: string): void {
  rateLimitMap.delete(key);
}

// ==================== 4. 数据加密 ====================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * 从应用名称派生加密密钥
 * 每次安装会生成唯一密钥，存储在 userData 目录
 */
function getEncryptionKey(): Buffer {
  const keyFile = join(app.getPath('userData'), '.ek');
  if (existsSync(keyFile)) {
    return Buffer.from(readFileSync(keyFile, 'utf8'), 'hex');
  }
  // 生成新密钥
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString('hex'), 'utf8');
  return key;
}

/**
 * 加密字符串（AES-256-GCM）
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  // 格式: iv + tag + ciphertext (hex)
  return iv.toString('hex') + tag.toString('hex') + encrypted;
}

/**
 * 解密字符串
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(ciphertext.slice(0, IV_LENGTH * 2), 'hex');
  const tag = Buffer.from(ciphertext.slice(IV_LENGTH * 2, (IV_LENGTH + TAG_LENGTH) * 2), 'hex');
  const encrypted = ciphertext.slice((IV_LENGTH + TAG_LENGTH) * 2);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ==================== 5. 审计日志 ====================

interface AuditLog {
  timestamp: number;
  event: string;
  detail: string;
  ip?: string;
  accountId?: string;
  employeeId?: string;
  success: boolean;
}

const auditLogs: AuditLog[] = [];
const MAX_AUDIT_LOGS = 1000;

/**
 * 记录审计日志
 */
export function auditLog(log: Omit<AuditLog, 'timestamp'>): void {
  const entry: AuditLog = { ...log, timestamp: Date.now() };
  auditLogs.push(entry);

  // 保持日志数量在限制内
  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.splice(0, auditLogs.length - MAX_AUDIT_LOGS);
  }

  // 写入日志文件
  try {
    const logDir = join(app.getPath('userData'), 'logs');
    if (!existsSync(logDir)) {
      require('fs').mkdirSync(logDir, { recursive: true });
    }
    const logFile = join(logDir, `audit-${new Date().toISOString().slice(0, 10)}.log`);
    const line = `[${new Date(entry.timestamp).toISOString()}] ${entry.success ? 'OK' : 'FAIL'} ${entry.event}: ${entry.detail}${entry.ip ? ` [IP:${entry.ip}]` : ''}\n`;
    require('fs').appendFileSync(logFile, line, 'utf8');
  } catch {
    // 日志写入失败不影响业务
  }

  logger.info(`[AUDIT] ${entry.success ? 'OK' : 'FAIL'} ${entry.event}: ${entry.detail}`);
}

/**
 * 获取审计日志（最近 N 条）
 */
export function getAuditLogs(limit = 100): AuditLog[] {
  return auditLogs.slice(-limit);
}

// ==================== 6. 输入校验 ====================

/**
 * 防 SQL 注入：过滤危险字符
 */
export function sanitizeSql(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/['";\\]/g, '')  // 移除引号、分号、反斜杠
    .replace(/--/g, '')       // 移除 SQL 注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
    .trim();
}

/**
 * 校验用户名格式（只允许字母、数字、下划线）
 */
export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,30}$/.test(username);
}

/**
 * 校验手机号格式
 */
export function isValidPhone(phone: string): boolean {
  const cleaned = phone.replace(/[^0-9]/g, '');
  return cleaned.length >= 8 && cleaned.length <= 15;
}

/**
 * 防 XSS：转义 HTML 特殊字符
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==================== 7. 启动安全检查 ====================

/**
 * 应用启动时执行所有安全检查
 */
export function initSecurity(): void {
  logger.info('Initializing security module...');

  // 1. 反调试
  startAntiDebug();

  // 2. 完整性校验
  saveIntegrityHash();

  // 3. 清理过期的限流记录（每小时清理一次）
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
      if (entry.blockedUntil > 0 && entry.blockedUntil < now) {
        rateLimitMap.delete(key);
      }
    }
  }, 60 * 60 * 1000);

  logger.info('Security module initialized');
}

/**
 * 应用退出时清理
 */
export function cleanupSecurity(): void {
  stopAntiDebug();
}
