import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { generateDeviceFingerprint } from '../services/fingerprint';

export function registerFingerprintIpc(ipc: typeof ipcMain): void {
  ipc.handle('fingerprint:get', async () => {
    return { fingerprint: generateDeviceFingerprint() };
  });
}