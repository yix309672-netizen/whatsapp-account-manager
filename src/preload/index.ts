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
  app: {
    version: () => ipcRenderer.invoke('app:version')
  },
  employee: {
    connect: (serverUrl: string, code?: string) => ipcRenderer.invoke('employee:connect', serverUrl, code),
    getConfig: () => ipcRenderer.invoke('employee:get_config'),
    status: () => ipcRenderer.invoke('employee:status'),
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
  templates: {
    get: () => ipcRenderer.invoke('template:get'),
    set: (template: string) => ipcRenderer.invoke('template:set', { template }),
    publish: (template: string) => ipcRenderer.invoke('template:publish', { template }),
    publishStatus: () => ipcRenderer.invoke('template:publish_status', {})
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (entries: Record<string, string>) => ipcRenderer.invoke('settings:set', { entries })
  },
  // 通用命令透传（scanner/leaf 等自定义命令；与 webApi.invoke 对齐，主进程侧由 __invoke__ 接 handleCommand）
  invoke: (method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke('__invoke__', method, params || {}),
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