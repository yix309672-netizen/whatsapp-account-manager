import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const api = {
  accounts: {
    create: (payload?: { name?: string }) => ipcRenderer.invoke('account:create', payload),
    list: () => ipcRenderer.invoke('account:list'),
    get: (accountId: string) => ipcRenderer.invoke('account:get', accountId),
    hasSession: (accountId: string) => ipcRenderer.invoke('account:has_session', accountId),
    update: (accountId: string, payload: Record<string, string>) =>
      ipcRenderer.invoke('account:update', accountId, payload),
    remove: (accountId: string) => ipcRenderer.invoke('account:delete', accountId),
    login: (accountId: string, options?: { phoneNumber?: string }) =>
      ipcRenderer.invoke('account:login', accountId, options),
    logout: (accountId: string) => ipcRenderer.invoke('account:logout', accountId),
    requestPairing: (accountId: string, phoneNumber: string) =>
      ipcRenderer.invoke('account:request_pairing', accountId, phoneNumber),
    logs: (accountId: string) => ipcRenderer.invoke('account:logs', accountId)
  },
  employees: {
    create: (payload: { username: string; password: string; name?: string; fingerprint?: string }) =>
      ipcRenderer.invoke('employee:create', payload),
    list: () => ipcRenderer.invoke('employee:list'),
    delete: (employeeId: string) => ipcRenderer.invoke('employee:delete', employeeId),
    assign: (employeeId: string, accountId: string, remark?: string) =>
      ipcRenderer.invoke('employee:assign', employeeId, accountId, remark),
    unassign: (accountId: string) => ipcRenderer.invoke('employee:unassign', accountId),
    resetFingerprint: (employeeId: string) => ipcRenderer.invoke('employee:reset_fingerprint', employeeId)
  },
  browser: {
    open: (accountId: string) => ipcRenderer.invoke('browser:open', accountId),
    close: (accountId: string) => ipcRenderer.invoke('browser:close', accountId),
    status: (accountId: string) => ipcRenderer.invoke('browser:status', accountId)
  },
  fingerprint: {
    get: () => ipcRenderer.invoke('fingerprint:get')
  },
  app: {
    version: () => ipcRenderer.invoke('app:version')
  },
  store: {
    getPath: () => ipcRenderer.invoke('store:get-path'),
    export: () => ipcRenderer.invoke('store:export'),
    backupNow: () => ipcRenderer.invoke('store:backup-now')
  },
  relay: {
    getConfig: () => ipcRenderer.invoke('relay:get-config'),
    setServer: (serverUrl: string) => ipcRenderer.invoke('relay:set-server', serverUrl),
    regenerateCode: () => ipcRenderer.invoke('relay:regenerate-code'),
    applyConfig: (serverUrl?: string, code?: string) => ipcRenderer.invoke('relay:apply-config', serverUrl, code),
    status: () => ipcRenderer.invoke('relay:status')
  },
  employee: {
    connect: (serverUrl: string, code: string) => ipcRenderer.invoke('employee:connect', serverUrl, code),
    getConfig: () => ipcRenderer.invoke('employee:get_config'),
    login: (username: string, password: string) => ipcRenderer.invoke('employee:login', username, password),
    listMine: () => ipcRenderer.invoke('employee:list_mine'),
    loginAccount: (accountId: string, phoneNumber?: string) =>
      ipcRenderer.invoke('employee:login_account', accountId, phoneNumber),
    logoutAccount: (accountId: string) => ipcRenderer.invoke('employee:logout_account', accountId),
    pairingCode: (accountId: string, phoneNumber: string) =>
      ipcRenderer.invoke('employee:pairing_code', accountId, phoneNumber),
    myStatus: () => ipcRenderer.invoke('employee:my_status')
  },
  stats: {
    record: (event: string, detail?: string) => ipcRenderer.invoke('stats:record', event, detail),
    summary: (days?: number) => ipcRenderer.invoke('stats:summary', days),
    events: (limit?: number) => ipcRenderer.invoke('stats:events', limit)
  },
  feedback: {
    submit: (payload: { content: string; contact?: string }) =>
      ipcRenderer.invoke('feedback:submit', payload),
    list: (status?: string) => ipcRenderer.invoke('feedback:list', status),
    updateStatus: (id: string, status: string) => ipcRenderer.invoke('feedback:update_status', id, status),
    remove: (id: string) => ipcRenderer.invoke('feedback:delete', id)
  },
  templates: {
    get: () => ipcRenderer.invoke('template:get'),
    set: (template: string) => ipcRenderer.invoke('template:set', template)
  },
  on: (channel: string, callback: (data: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  }
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;