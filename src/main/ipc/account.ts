import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { handleCommand, CommandContext } from '../commands';
import { WhatsAppSessionManager } from '../services/WhatsAppSessionManager';

/**
 * 命令 → 参数映射表（IPC 与 Web RPC 共用）。
 * args 为调用方传入的原始参数数组，转换为 handleCommand 的 params 对象。
 */
export function buildCommandMethods(sessionManager: WhatsAppSessionManager): Array<[string, (...args: unknown[]) => Promise<unknown>]> {
  const ctx: CommandContext = { sessionManager };

  return [
    ['account:list', () => handleCommand(ctx, 'account:list', {})],
    ['account:create', (payload) => handleCommand(ctx, 'account:create', (payload as Record<string, unknown>) || {})],
    ['account:get', (accountId) => handleCommand(ctx, 'account:get', { accountId })],
    ['account:has_session', (accountId) => handleCommand(ctx, 'account:has_session', { accountId })],
    ['account:update', (accountId, payload) => handleCommand(ctx, 'account:update', { accountId, ...((payload as Record<string, unknown>) || {}) })],
    ['account:delete', (accountId) => handleCommand(ctx, 'account:delete', { accountId })],
    ['account:login', (accountId, options) => handleCommand(ctx, 'account:login', { accountId, phoneNumber: (options as { phoneNumber?: string } | undefined)?.phoneNumber })],
    ['account:logout', (accountId) => handleCommand(ctx, 'account:logout', { accountId })],
    ['account:request_pairing', (accountId, phoneNumber) => handleCommand(ctx, 'account:request_pairing', { accountId, phoneNumber })],
    ['account:request_pairing_with_phone', (phoneNumber) => handleCommand(ctx, 'account:request_pairing_with_phone', { phoneNumber })],
    ['account:logs', (accountId) => handleCommand(ctx, 'account:logs', { accountId })],
    ['employee:create', (payload) => handleCommand(ctx, 'employee:create', (payload as Record<string, unknown>) || {})],
    ['employee:list', () => handleCommand(ctx, 'employee:list', {})],
    ['employee:delete', (employeeId) => handleCommand(ctx, 'employee:delete', { employeeId })],
    ['employee:assign', (employeeId, accountId, remark) => handleCommand(ctx, 'employee:assign', { employeeId, accountId, remark })],
    ['employee:unassign', (accountId) => handleCommand(ctx, 'employee:unassign', { accountId })],
    ['employee:reset_fingerprint', (employeeId) => handleCommand(ctx, 'employee:reset_fingerprint', { employeeId })],
    ['stats:record', (event, detail) => handleCommand(ctx, 'stats:record', { event, detail })],
    ['stats:summary', (days) => handleCommand(ctx, 'stats:summary', { days })],
    ['stats:events', (limit) => handleCommand(ctx, 'stats:events', { limit })],
    ['feedback:submit', (payload) => handleCommand(ctx, 'feedback:submit', (payload as Record<string, unknown>) || {})],
    ['feedback:list', (status) => handleCommand(ctx, 'feedback:list', { status })],
    ['feedback:update_status', (id, status) => handleCommand(ctx, 'feedback:update_status', { id, status })],
    ['feedback:delete', (id) => handleCommand(ctx, 'feedback:delete', { id })],
    ['template:get', () => handleCommand(ctx, 'template:get', {})],
    ['template:set', (template) => handleCommand(ctx, 'template:set', { template })],
    ['relay:get-config', () => handleCommand(ctx, 'relay:get-config', {})],
    ['relay:set-server', (serverUrl) => handleCommand(ctx, 'relay:set-server', { serverUrl })],
    ['relay:regenerate-code', () => handleCommand(ctx, 'relay:regenerate-code', {})],
    ['relay:apply-config', (serverUrl, code) => handleCommand(ctx, 'relay:apply-config', { serverUrl, code })],
    ['relay:status', () => handleCommand(ctx, 'relay:status', {})],
    ['store:get-path', () => handleCommand(ctx, 'store:get-path', {})],
    ['store:export', () => handleCommand(ctx, 'store:export', {})],
    ['store:backup-now', () => handleCommand(ctx, 'store:backup-now', {})],
    ['fingerprint:get', () => handleCommand(ctx, 'fingerprint:get', {})],
    ['app:version', () => handleCommand(ctx, 'app:version', {})]
  ];
}

export function registerAccountIpc(ipc: typeof ipcMain, sessionManager: WhatsAppSessionManager): void {
  for (const [channel, fn] of buildCommandMethods(sessionManager)) {
    ipc.handle(channel, async (_event: IpcMainInvokeEvent, ...args: unknown[]) => fn(...args));
  }
}