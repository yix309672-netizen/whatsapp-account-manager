import { app } from 'electron';
import { join } from 'path';
import { createWriteStream, existsSync, mkdirSync } from 'fs';

const logDir = join(app.getPath('userData'), 'logs');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

const logFile = join(logDir, `app-${new Date().toISOString().split('T')[0]}.log`);
const fileStream = createWriteStream(logFile, { flags: 'a' });

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function stringifyArg(a: unknown): string {
  if (a instanceof Error) {
    return `${a.name}: ${a.message}`;
  }
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

function formatMessage(level: LogLevel, ...args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const message = args.map(stringifyArg).join(' ');
  return `${prefix} ${message}`;
}

let handlingFatal = false;

function writeLog(msg: string): void {
  try {
    fileStream.write(msg + '\n');
  } catch {
    // 日志流写入失败时忽略，避免再次触发异常
  }
}

// ==================== 控制台输出保护 ====================
// 背景（实测踩坑）：主进程 stdout 被上层管道接走、而管道对端先退出时（systemd 接管、
// 终端关闭、PowerShell 管道被杀等），写 console 会抛 EPIPE。这个异常不是同步 throw，
// 而是 stream 上未处理的 'error' 事件 → uncaughtException；同时对端关闭后
// fs.WriteStream 的挂起写也会同步抛 EPIPE。两者都会把正在处理的 HTTP 请求一起打死，
// 表现为「登录接口一直挂住不返回」。这里做三件事：
//   1) 给 stdout/stderr 挂 'error' 兜底监听，吞掉 EPIPE/ERR_STREAM_DESTROYED；
//   2) 写 console 连续失败达到阈值后直接停用控制台输出（日志仍落文件）；
//   3) 可用 WAAM_NO_CONSOLE=1 在容器/服务化场景彻底关掉控制台输出。
const CONSOLE_FAIL_LIMIT = 20;
let consoleWriteFails = 0;
let consoleEnabled = process.env.WAAM_NO_CONSOLE !== '1';

function isBrokenPipe(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END';
}

for (const stream of [process.stdout, process.stderr]) {
  try {
    stream.on('error', (err: unknown) => {
      if (isBrokenPipe(err)) {
        if (consoleEnabled) {
          consoleEnabled = false;
          writeLog(`[WARN] 控制台输出已停用（${(err as { code?: string }).code}），日志继续写入文件`);
        }
        return;
      }
      // 非管道错误不吞，交给全局 uncaughtException 处理
      throw err;
    });
  } catch {
    // 拿不到 stream（极端环境）时忽略
  }
}

function writeConsole(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
  if (!consoleEnabled) return;
  try {
    if (level === 'debug') console.debug(msg);
    else if (level === 'info') console.info(msg);
    else if (level === 'warn') console.warn(msg);
    else console.error(msg);
  } catch (err) {
    // stdout/stderr 管道断开（EPIPE）时忽略，避免触发 uncaughtException 递归
    consoleWriteFails++;
    if (consoleWriteFails >= CONSOLE_FAIL_LIMIT || isBrokenPipe(err)) {
      consoleEnabled = false;
      writeLog(`[WARN] 控制台输出已停用（连续失败 ${consoleWriteFails} 次：${(err as Error)?.message}），日志继续写入文件`);
    }
  }
}

export const logger = {
  debug: (...args: unknown[]) => {
    const msg = formatMessage('debug', ...args);
    writeConsole('debug', msg);
    writeLog(msg);
  },
  info: (...args: unknown[]) => {
    const msg = formatMessage('info', ...args);
    writeConsole('info', msg);
    writeLog(msg);
  },
  warn: (...args: unknown[]) => {
    const msg = formatMessage('warn', ...args);
    writeConsole('warn', msg);
    writeLog(msg);
  },
  error: (...args: unknown[]) => {
    const msg = formatMessage('error', ...args);
    writeConsole('error', msg);
    writeLog(msg);
  }
};

process.on('uncaughtException', (err) => {
  // 防止 console.error 抛 EPIPE 时无限递归
  if (handlingFatal) return;
  handlingFatal = true;
  // 致命路径只落文件，不再写 console，避免控制台已断时自己把自己刷爆
  if (isBrokenPipe(err)) {
    writeLog(`[${new Date().toISOString()}] [WARN] 控制台写入失败已忽略: ${(err as Error)?.message}`);
  } else {
    logger.error('Uncaught Exception:', err);
  }
  handlingFatal = false;
});

process.on('unhandledRejection', (reason) => {
  if (handlingFatal) return;
  handlingFatal = true;
  logger.error('Unhandled Rejection:', reason);
  handlingFatal = false;
});