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

function writeConsole(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
  try {
    if (level === 'debug') console.debug(msg);
    else if (level === 'info') console.info(msg);
    else if (level === 'warn') console.warn(msg);
    else console.error(msg);
  } catch {
    // stdout/stderr 管道断开（EPIPE）时忽略，避免触发 uncaughtException 递归
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
  logger.error('Uncaught Exception:', err);
  handlingFatal = false;
});

process.on('unhandledRejection', (reason) => {
  if (handlingFatal) return;
  handlingFatal = true;
  logger.error('Unhandled Rejection:', reason);
  handlingFatal = false;
});