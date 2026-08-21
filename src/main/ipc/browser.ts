import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { handleCommand, CommandContext } from '../commands';
import { WhatsAppSessionManager } from '../services/WhatsAppSessionManager';

export function registerBrowserIpc(ipc: typeof ipcMain, sessionManager: WhatsAppSessionManager): void {
  const ctx: CommandContext = { sessionManager };

  ipc.handle('browser:open', async (_event: IpcMainInvokeEvent, accountId: string) =>
    handleCommand(ctx, 'browser:open', { accountId })
  );

  ipc.handle('browser:close', async (_event: IpcMainInvokeEvent, accountId: string) =>
    handleCommand(ctx, 'browser:close', { accountId })
  );

  ipc.handle('browser:status', async (_event: IpcMainInvokeEvent, accountId: string) =>
    handleCommand(ctx, 'browser:status', { accountId })
  );
}