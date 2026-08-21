import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { loadRelaySettings, saveRelaySettings, ensureAccessCode, regenerateAccessCode } from '../services/relayConfig';
import { getRelayInstance } from '../services/RelayClient';

export function registerRelayIpc(ipc: typeof ipcMain): void {
  ipc.handle('relay:get-config', async () => {
    const settings = loadRelaySettings();
    if (!settings.code) settings.code = ensureAccessCode();
    const relay = getRelayInstance();
    return {
      ...settings,
      connected: relay?.isConnected ?? false,
      registered: relay?.isRegistered ?? false
    };
  });

  ipc.handle('relay:set-server', async (_event: IpcMainInvokeEvent, serverUrl: string) => {
    const settings = loadRelaySettings();
    settings.serverUrl = serverUrl;
    saveRelaySettings(settings);
    return { success: true, serverUrl };
  });

  ipc.handle('relay:regenerate-code', async () => {
    const code = regenerateAccessCode();
    return { success: true, code };
  });

  ipc.handle('relay:status', async () => {
    const relay = getRelayInstance();
    return {
      connected: relay?.isConnected ?? false,
      registered: relay?.isRegistered ?? false,
      code: relay?.getCode() ?? '',
      url: relay?.getUrl() ?? ''
    };
  });
}