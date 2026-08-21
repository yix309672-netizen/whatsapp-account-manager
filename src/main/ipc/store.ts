import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { getDb } from '../utils/db';

export function registerStoreIpc(ipc: typeof ipcMain): void {
  ipc.handle('store:get-path', async () => {
    return { userData: app.getPath('userData') };
  });

  ipc.handle('store:export', async () => {
    const db = getDb();
    const accounts = db.prepare('SELECT * FROM accounts').all();
    const logs = db.prepare('SELECT * FROM login_logs').all();

    const exportDir = join(app.getPath('userData'), 'exports');
    if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });

    const filename = `whatsapp-accounts-${Date.now()}.json`;
    const filePath = join(exportDir, filename);
    writeFileSync(filePath, JSON.stringify({ accounts, logs, exportedAt: Date.now() }, null, 2));

    return { success: true, filePath };
  });

  ipc.handle('store:backup-now', async () => {
    const db = getDb();
    const backupDir = join(app.getPath('userData'), 'backups');
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

    const filename = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filePath = join(backupDir, filename);

    const snapshot = {
      accounts: db.prepare('SELECT * FROM accounts').all(),
      logs: db.prepare('SELECT * FROM login_logs').all(),
      backedUpAt: Date.now()
    };

    writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    return { success: true, filePath };
  });
}