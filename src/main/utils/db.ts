import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';

let db: Database.Database | null = null;

export function initDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const userDataPath = app.getPath('userData');
      const dbDir = join(userDataPath, 'database');
      if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

      const dbPath = join(dbDir, 'accounts.db');
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');

      runMigrations();
      logger.info(`Database initialized at ${dbPath}`);
      resolve();
    } catch (err) {
      logger.error('Database init failed:', err);
      reject(err);
    }
  });
}

function runMigrations(): void {
  if (!db) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      machine_fingerprint TEXT,
      name TEXT,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      login_time INTEGER,
      updated_time INTEGER,
      session_path TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_login_logs_account_id ON login_logs(account_id);

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_employees_username ON employees(username);

    CREATE TABLE IF NOT EXISTS visit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT,
      event TEXT NOT NULL DEFAULT 'visit',
      ip TEXT,
      country TEXT,
      device TEXT,
      os TEXT,
      browser TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_visit_logs_created ON visit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_visit_logs_event ON visit_logs(event);
    CREATE INDEX IF NOT EXISTS idx_visit_logs_country ON visit_logs(country);
    CREATE INDEX IF NOT EXISTS idx_visit_logs_device ON visit_logs(device);

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      content TEXT NOT NULL,
      contact TEXT,
      ip TEXT,
      country TEXT,
      device TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);

  // 迁移：初始化默认前端模板配置
  const tpl = db.prepare("SELECT value FROM app_settings WHERE key = 'frontend_template'").get();
  if (!tpl) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('frontend_template', 'classic')").run();
  }

  // 迁移：旧版本迁移中断时 login_logs 的外键可能指向 accounts_old，需重建指向 accounts
  const loginLogsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='login_logs'").get() as { sql: string } | undefined)?.sql ?? '';
  if (loginLogsSql.includes('accounts_old')) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE login_logs RENAME TO login_logs_old');

      db.exec(`
        CREATE TABLE login_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id TEXT NOT NULL,
          action TEXT NOT NULL,
          detail TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_login_logs_account_id ON login_logs(account_id);
      `);

      db.exec(`
        INSERT INTO login_logs (id, account_id, action, detail, created_at)
        SELECT id, account_id, action, detail, created_at
        FROM login_logs_old
      `);

      db.exec('DROP TABLE login_logs_old');
      db.exec('COMMIT');
      logger.info('Migrated login_logs table: fixed FOREIGN KEY to reference accounts');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // 迁移：旧版本 device_id 为 UNIQUE。若 device_id 列上仍有 UNIQUE 约束，重建 accounts 表去掉它，
  // 并将 device_id/machine_fingerprint 统一为当前机器指纹。
  const idxs = db.prepare("PRAGMA index_list('accounts')").all() as Array<{ name: string; unique: number }>;
  const hasUniqueDeviceId = idxs.some((idx) => {
    if (idx.unique !== 1) return false;
    const cols = db!.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === 'device_id');
  });

  const cols = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  const hasFingerprint = cols.some((c) => c.name === 'machine_fingerprint');

  // 上次迁移中断留下的残留表，先清理
  const hasOldTable = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts_old'").get()) !== undefined;

  if (hasOldTable) {
    // 若 accounts 表仍存在且有数据，说明迁移已完成但旧表未清理；否则数据还在 accounts_old，需恢复
    const accountsCount = (db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c;
    if (accountsCount === 0) {
      // accounts 为空而 accounts_old 有数据：迁移中断在 RENAME 之后，尝试恢复数据
      const oldCount = (db.prepare('SELECT COUNT(*) AS c FROM accounts_old').get() as { c: number }).c;
      if (oldCount > 0) {
        const oldCols = db.prepare('PRAGMA table_info(accounts_old)').all() as Array<{ name: string }>;
        const hasOldFp = oldCols.some((c) => c.name === 'machine_fingerprint');
        if (hasOldFp) {
          db.exec(`
            INSERT INTO accounts (id, device_id, machine_fingerprint, name, phone, status, login_time, updated_time, session_path, created_at)
            SELECT id, device_id, machine_fingerprint, name, phone, status, login_time, updated_time, session_path, created_at
            FROM accounts_old
          `);
        } else {
          db.exec(`
            INSERT INTO accounts (id, device_id, name, phone, status, login_time, updated_time, session_path, created_at)
            SELECT id, device_id, name, phone, status, login_time, updated_time, session_path, created_at
            FROM accounts_old
          `);
        }
      }
    }
    db.exec('DROP TABLE IF EXISTS accounts_old');
    logger.info('Migrated accounts table: cleaned up leftover accounts_old');
  }

  if (hasUniqueDeviceId) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE accounts RENAME TO accounts_old');

      db.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          machine_fingerprint TEXT,
          name TEXT,
          phone TEXT,
          status TEXT NOT NULL DEFAULT 'offline',
          login_time INTEGER,
          updated_time INTEGER,
          session_path TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
      `);

      if (hasFingerprint) {
        db.exec(`
          INSERT INTO accounts (id, device_id, machine_fingerprint, name, phone, status, login_time, updated_time, session_path, created_at)
          SELECT id, device_id, machine_fingerprint, name, phone, status, login_time, updated_time, session_path, created_at
          FROM accounts_old
        `);
      } else {
        db.exec(`
          INSERT INTO accounts (id, device_id, name, phone, status, login_time, updated_time, session_path, created_at)
          SELECT id, device_id, name, phone, status, login_time, updated_time, session_path, created_at
          FROM accounts_old
        `);
      }

      db.exec('DROP TABLE accounts_old');
      db.exec('COMMIT');
      logger.info('Migrated accounts table: removed UNIQUE constraint on device_id');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } else if (!hasFingerprint) {
    db.exec('ALTER TABLE accounts ADD COLUMN machine_fingerprint TEXT');
    logger.info('Migrated accounts table: added machine_fingerprint column');
  }

  // 迁移：accounts 表新增 assigned_to 列（员工分配）
  const accountsCols = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
  if (!accountsCols.some((c) => c.name === 'assigned_to')) {
    db.exec('ALTER TABLE accounts ADD COLUMN assigned_to TEXT');
    logger.info('Migrated accounts table: added assigned_to column');
  }

  // 迁移：accounts 表新增 remark 列（分配账号给员工时的备注/传话）
  const accountsCols2 = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
  if (!accountsCols2.some((c) => c.name === 'remark')) {
    db.exec('ALTER TABLE accounts ADD COLUMN remark TEXT');
    logger.info('Migrated accounts table: added remark column');
  }

  // 迁移：scanner_results 新增 status_msg（个性签名）/ pushname（昵称，仅 Web 通道尽力取）列
  try {
    const srCols = db.prepare('PRAGMA table_info(scanner_results)').all() as Array<{ name: string }>;
    if (!srCols.some((c) => c.name === 'status_msg')) {
      db.exec('ALTER TABLE scanner_results ADD COLUMN status_msg TEXT');
      logger.info('Migrated scanner_results table: added status_msg column');
    }
    if (!srCols.some((c) => c.name === 'pushname')) {
      db.exec('ALTER TABLE scanner_results ADD COLUMN pushname TEXT');
      logger.info('Migrated scanner_results table: added pushname column');
    }
  } catch (err) { logger.warn('Migrate scanner_results columns failed:', err); }

  // 开机对账：上次意外中断（重启/崩溃/断电）时 status 停留在 running 的任务全部改回 paused，
  // 断点保留（结果行都在），点 开始 即从断点继续。每次启动都执行，幂等无害。
  try {
    const r = db.prepare("UPDATE scanner_tasks SET status='paused' WHERE status='running'").run();
    if ((r.changes as number) > 0) logger.info(`Reconciled ${r.changes} interrupted scanner task(s) to paused`);
  } catch (err) { logger.warn('Reconcile scanner tasks failed:', err); }

  // 迁移：scanner_tasks 新增 channel 列（pool=Checker池，web:<accountId>=管理器已登录账号直查）
  try {
    const chCols = db.prepare('PRAGMA table_info(scanner_tasks)').all() as Array<{ name: string }>;
    if (!chCols.some((c) => c.name === 'channel')) {
      db.exec("ALTER TABLE scanner_tasks ADD COLUMN channel TEXT NOT NULL DEFAULT 'pool'");
      logger.info('Migrated scanner_tasks table: added channel column');
    }
  } catch (err) { logger.warn('Migrate scanner_tasks channel failed:', err); }

  // 迁移：scanner_tasks 新增 kind 列（register=注册筛查，presence=活跃度）
  try {
    const taskCols = db.prepare('PRAGMA table_info(scanner_tasks)').all() as Array<{ name: string }>;
    if (!taskCols.some((c) => c.name === 'kind')) {
      db.exec("ALTER TABLE scanner_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'register'");
      logger.info('Migrated scanner_tasks table: added kind column');
    }
  } catch (err) { logger.warn('Migrate scanner_tasks kind failed:', err); }

  // 迁移：employees 表新增 machine_fingerprint 列（员工端机器绑定）
  const empCols = db.prepare('PRAGMA table_info(employees)').all() as Array<{ name: string }>;
  if (!empCols.some((c) => c.name === 'machine_fingerprint')) {
    db.exec('ALTER TABLE employees ADD COLUMN machine_fingerprint TEXT');
    logger.info('Migrated employees table: added machine_fingerprint column');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS scanner_tasks (
      id TEXT PRIMARY KEY,
      name TEXT,
      phones_json TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      done INTEGER NOT NULL DEFAULT 0,
      valid_count INTEGER NOT NULL DEFAULT 0,
      invalid_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS scanner_results (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      jid TEXT,
      exists_flag INTEGER NOT NULL DEFAULT 0,
      has_avatar INTEGER NOT NULL DEFAULT 0,
      avatar_url TEXT,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY(task_id) REFERENCES scanner_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scanner_results_task ON scanner_results(task_id);
    CREATE INDEX IF NOT EXISTS idx_scanner_tasks_status ON scanner_tasks(status);

    -- 活跃度任务：presence_results 存 presence 结果；presence_cache 跨任务去重（默认7天内不重查）
    CREATE TABLE IF NOT EXISTS presence_results (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      jid TEXT,
      status TEXT NOT NULL DEFAULT 'hidden',
      last_seen INTEGER,
      checker_id INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY(task_id) REFERENCES scanner_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_presence_results_task ON presence_results(task_id);
    CREATE TABLE IF NOT EXISTS presence_cache (
      phone TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_seen INTEGER,
      checked_at INTEGER NOT NULL
    );

    -- 客服聊天：phone 为手机号或 guest-id；sender=user|agent|system
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT 'user',
      content TEXT NOT NULL,
      read_flag INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_phone ON chat_messages(phone);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);

    -- Leaf 号段模式：biz_tag 主键，max_id 已分配最大值，step 步长（移植自美团 Leaf leaf_alloc）
    CREATE TABLE IF NOT EXISTS leaf_alloc (
      biz_tag TEXT PRIMARY KEY,
      max_id INTEGER NOT NULL DEFAULT 0,
      step INTEGER NOT NULL DEFAULT 1000,
      description TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);

  // 初始化默认管理员账号（仅当 admin_users 为空时）
  // 密码来源（按优先级，绝不在仓库里放明文密码）：
  // 1) 环境变量 WAAM_ADMIN_PASSWORD；2) userData 下 web-admin-password.txt（已 gitignore）；
  // 3) 都没有则随机生成并写入该文件。密码只写本地文件，日志里只给文件路径。
  const adminCount = (db.prepare('SELECT COUNT(*) c FROM admin_users').get() as { c: number }).c;
  if (adminCount === 0) {
    const username = '小易';
    const { randomBytes, createHash } = require('crypto');
    const { join } = require('path');
    const { existsSync, readFileSync, writeFileSync } = require('fs');
    const { app } = require('electron');
    let password = String(process.env.WAAM_ADMIN_PASSWORD || '').trim();
    const pwdFile = join(app.getPath('userData'), 'web-admin-password.txt');
    if (!password && existsSync(pwdFile)) {
      try { password = String(readFileSync(pwdFile, 'utf8')).trim().split(/\s+/)[0] || ''; } catch {}
    }
    if (!password) {
      password = randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || randomBytes(8).toString('hex');
      try { writeFileSync(pwdFile, password + '\n', 'utf8'); } catch (e) { logger.warn('Write admin password file failed:', e); }
    }
    const salt = randomBytes(16).toString('hex');
    const password_hash = createHash('sha256').update(salt + password).digest('hex');
    const id = require('uuid').v4 ? require('uuid').v4() : 'admin-default';
    try {
      db.prepare('INSERT INTO admin_users (id, username, password_hash, salt) VALUES (?, ?, ?, ?)')
        .run(id, username, password_hash, salt);
      logger.info(`Seeded default admin user: 小易（初始密码见环境变量 WAAM_ADMIN_PASSWORD 或本地文件 ${pwdFile}）`);
    } catch (e) {
      logger.warn('Seed admin_users failed:', e);
    }
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}