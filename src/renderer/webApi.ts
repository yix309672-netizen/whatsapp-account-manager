/*** Web API — 浏览器端通过 WebSocket 调用 handleCommand，与 preload 的 window.api 保持同接口 ***/
type Listener = (data: unknown) => void;

let ws: WebSocket | null = null;
let pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let eventListeners = new Map<string, Set<Listener>>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsFailCount = 0;

// ===== 安全的本地存储访问 =====
// 隐私模式/禁用站点数据时 localStorage 会直接抛 SecurityError。
// 以前是裸调用 → collectBrowserFp 直接 reject → 登录页验证码永远"加载中"且没有任何提示。
function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 存储不可用，忽略 */ }
}
function lsRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// ===== 指纹浏览器：真实浏览器指纹采集（防机器人/爬虫） =====
let cachedFp: string | null = null;

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  // 降级：简易哈希
  let h = 0;
  for (let i = 0; i < input.length; i++) h = Math.imul(31, h) + input.charCodeAt(i) | 0;
  const hex = Math.abs(h).toString(16).padStart(8, "0");
  // 扩展至64位
  return (hex + hex + hex + hex + hex + hex + hex + hex).slice(0, 64);
}

async function collectBrowserFp(): Promise<string> {
  if (cachedFp) return cachedFp;
  const stored = lsGet("waam_fp");
  if (stored && /^[a-f0-9]{64}$/i.test(stored)) {
    cachedFp = stored;
    return stored;
  }
  const parts: string[] = [];
  try {
    parts.push(navigator.userAgent || "");
    parts.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
    parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone || "");
    parts.push(navigator.language || "");
    parts.push(String(navigator.hardwareConcurrency || 0));
    parts.push(String((navigator as unknown as { deviceMemory?: number }).deviceMemory || 0));
    // canvas 指纹
    try {
      const c = document.createElement("canvas");
      c.width = 200; c.height = 50;
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.textBaseline = "top";
        ctx.font = "14px Arial";
        ctx.fillStyle = "#00a884";
        ctx.fillRect(0, 0, 200, 50);
        ctx.fillStyle = "#fff";
        ctx.fillText(navigator.userAgent.slice(0, 30), 4, 4);
        parts.push(c.toDataURL().slice(0, 200));
      }
    } catch { /* ignore */ }
    // webgl 指纹
    try {
      const c2 = document.createElement("canvas");
      const gl = (c2.getContext("webgl") || c2.getContext("experimental-webgl")) as WebGLRenderingContext | null;
      if (gl) {
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (ext) {
          parts.push(String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || ""));
          parts.push(String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || ""));
        }
      }
    } catch { /* ignore */ }
  } catch { /* ignore */ }
  // ⚠️ 不要在这里混入 Date.now() 之类的随机量！
  // 这个指纹会被服务端当作"机器指纹"参与设备绑定（员工登录/账号绑定），
  // 一旦每次加载都不同，员工端就会反复报"已绑定其他电脑"，
  // 管理员重置绑定后再刷新又变新值 —— 形成死循环。
  const raw = parts.join("|");
  const fp = await sha256Hex(raw);
  cachedFp = fp;
  lsSet("waam_fp", fp);
  return fp;
}

function getCachedFpSync(): string {
  if (cachedFp) return cachedFp;
  const s = lsGet("waam_fp");
  if (s && /^[a-f0-9]{64}$/i.test(s)) { cachedFp = s; return s; }
  return "";
}

async function getWsUrl(token: string): Promise<string> {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const fp = await collectBrowserFp();
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}&fp=${encodeURIComponent(fp)}`;
}

function dispatchEvent(channel: string, data: unknown): void {
  const set = eventListeners.get(channel);
  if (set) {
    for (const cb of set) {
      try { cb(data); } catch { /* ignore */ }
    }
  }
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// 并发合并用的"正在连接"promise。
// 不加这个的话首屏 app.version() 与 loadAccounts() 会各建一条 WS（StrictMode 下 4 条），
// 服务端 clients 会保留全部连接 → 每个事件被重复派发 N 次，且旧 socket 永不关闭。
let connecting: Promise<WebSocket> | null = null;

function ensureConnected(): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (connecting) return connecting;

  connecting = (async (): Promise<WebSocket> => {
    const token = lsGet("waam_token") || "";
    if (!token) throw new Error("未登录");
    const url = await getWsUrl(token);
    const sock = new WebSocket(url);
    // 记录这条连接是否曾经成功打开过：只有"从没连上过"才可能是令牌失效，
    // 用来区分"网络抖动/服务重启"与"401 令牌过期"（以前混在一起，抖动 5 次就清 token 强制重登）。
    let everOpened = false;

    return await new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };

      sock.onopen = () => {
        everOpened = true;
        ws = sock;
        wsFailCount = 0;
        const ping = setInterval(() => {
          if (sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({ id: genId(), method: "ping", params: {} }));
          } else {
            clearInterval(ping);
          }
        }, 30000);
        sock.addEventListener("close", () => clearInterval(ping));
        settle(() => resolve(sock));
      };

      sock.onmessage = (ev) => {
        let msg: { id?: string; ok?: boolean; data?: unknown; error?: string; type?: string; channel?: string };
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.type === "event" && msg.channel) {
          dispatchEvent(msg.channel, msg.data);
          return;
        }
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.data);
          else p.reject(new Error(msg.error || "请求失败"));
        }
      };

      sock.onerror = () => {
        settle(() => reject(new Error("WebSocket 连接失败")));
      };

      sock.onclose = () => {
        if (ws === sock) ws = null;
        // ⚠️ 断线时把所有在途请求 reject 掉：否则用户点按钮后 UI 会一直转圈
        // 直到 30s 超时（重连成功也不会补发）。
        for (const [id, p] of pending) {
          pending.delete(id);
          p.reject(new Error("连接已断开，请重试"));
        }
        if (!lsGet("waam_token")) return;
        // 只有"从未成功打开过"才计入失败——那是令牌/握手问题；
        // 曾经连上过的断开属于网络抖动或服务重启，交给重连即可。
        if (!everOpened) {
          wsFailCount++;
          if (wsFailCount >= 5) {
            wsFailCount = 0;
            lsRemove("waam_token");
            lsRemove("waam_role");
            location.reload();
            return;
          }
        }
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          connecting = null; // 允许下一次调用重新发起
          ensureConnected().catch(() => { /* 交给下次调用或心跳重试 */ });
        }, 3000);
      };

      setTimeout(() => {
        if (sock.readyState !== WebSocket.OPEN) {
          try { sock.close(); } catch { /* ignore */ }
          settle(() => reject(new Error("WebSocket 连接超时")));
        }
      }, 8000);
    });
  })();

  // 无论成功失败都清掉缓存，避免把失败结果永久缓存住
  connecting.catch(() => {}).finally(() => { connecting = null; });
  return connecting;
}

function wsInvoke(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return ensureConnected().then((sock) => {
    const id = genId();
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sock.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("请求超时"));
        }
      }, 30000);
    });
  });
}

// 构造与 preload 形态一致的 api
export const webApi = {
  accounts: {
    create: (payload?: { name?: string }) => wsInvoke("account:create", (payload as Record<string, unknown>) || {}),
    list: () => wsInvoke("account:list", {}),
    get: (accountId: string) => wsInvoke("account:get", { accountId }),
    hasSession: (accountId: string) => wsInvoke("account:has_session", { accountId }),
    update: (accountId: string, payload: Record<string, string>) => wsInvoke("account:update", { accountId, ...(payload as Record<string, unknown>) }),
    remove: (accountId: string) => wsInvoke("account:delete", { accountId }),
    login: (accountId: string, options?: { phoneNumber?: string }) => wsInvoke("account:login", { accountId, phoneNumber: options?.phoneNumber }),
    logout: (accountId: string) => wsInvoke("account:logout", { accountId }),
    requestPairing: (accountId: string, phoneNumber: string) => wsInvoke("account:request_pairing", { accountId, phoneNumber }),
    logs: (accountId: string) => wsInvoke("account:logs", { accountId }),
  },
  employees: {
    create: (payload: { username: string; password: string; name?: string; fingerprint?: string }) => wsInvoke("employee:create", payload as unknown as Record<string, unknown>),
    list: () => wsInvoke("employee:list", {}),
    delete: (employeeId: string) => wsInvoke("employee:delete", { employeeId }),
    assign: (employeeId: string, accountId: string, remark?: string) => wsInvoke("employee:assign", { employeeId, accountId, remark }),
    unassign: (accountId: string) => wsInvoke("employee:unassign", { accountId }),
    resetFingerprint: (employeeId: string) => wsInvoke("employee:reset_fingerprint", { employeeId }),
  },
  app: {
    version: () => wsInvoke("app:version", {}),
  },
  employee: {
    connect: (serverUrl: string, code: string) => wsInvoke("employee:connect", { serverUrl, code }),
    getConfig: () => wsInvoke("employee:get_config", {}),
    login: (username: string, password: string) => wsInvoke("employee:login", { username, password }),
    listMine: () => wsInvoke("employee:list_mine", {}),
    loginAccount: (accountId: string, phoneNumber?: string) => wsInvoke("employee:login_account", { accountId, phoneNumber }),
    logoutAccount: (accountId: string) => wsInvoke("employee:logout_account", { accountId }),
    pairingCode: (accountId: string, phoneNumber: string) => wsInvoke("employee:pairing_code", { accountId, phoneNumber }),
    myStatus: () => wsInvoke("employee:my_status", {}),
  },
  stats: {
    record: (event: string, detail?: string) => wsInvoke("stats:record", { event, detail }),
    summary: (days?: number) => wsInvoke("stats:summary", { days }),
    events: (limit?: number) => wsInvoke("stats:events", { limit }),
  },
  templates: {
    get: () => wsInvoke("template:get", {}),
    set: (template: string) => wsInvoke("template:set", { template }),
    publish: (template: string) => wsInvoke("template:publish", { template }),
    publishStatus: () => wsInvoke("template:publish_status", {}),
  },
  settings: {
    get: () => wsInvoke("settings:get", {}),
    set: (entries: Record<string, string>) => wsInvoke("settings:set", { entries }),
  },
  leaf: {
    status: () => wsInvoke("leaf:status", {}),
    tagAdd: (tag: string, step?: number, description?: string) => wsInvoke("leaf:tag_add", { tag, step, description }),
    segment: (tag: string, count: number) => wsInvoke("leaf:segment", { tag, count }),
    snowflake: (count: number) => wsInvoke("leaf:snowflake", { count }),
    genPhones: (prefix: string, start: number, count: number) => wsInvoke("leaf:gen_phones", { prefix, start, count }),
    genTask: (prefix: string, start: number, count: number, name?: string) => wsInvoke("leaf:gen_task", { prefix, start, count, name }),
  },
  chat: {
    threads: () => wsInvoke("chat:threads", {}),
    history: (phone: string, limit?: number) => wsInvoke("chat:history", { phone, limit }),
    reply: (phone: string, content: string) => wsInvoke("chat:reply", { phone, content }),
    markRead: (phone: string) => wsInvoke("chat:mark_read", { phone }),
    remove: (phone: string) => wsInvoke("chat:delete", { phone }),
  },
  // 通用 invoke，供 scanner 等自定义命令使用（与 preload 的 window.api.invoke 对齐）
  invoke: (method: string, params: Record<string, unknown> = {}) => wsInvoke(method, params),
  on: (channel: string, callback: (data: unknown) => void) => {
    let set = eventListeners.get(channel);
    if (!set) { set = new Set(); eventListeners.set(channel, set); }
    set.add(callback);
    return () => {
      const s = eventListeners.get(channel);
      if (s) s.delete(callback);
    };
  },
};

export function isBrowser(): boolean {
  // Electron 渲染进程有 window.api（由 preload 注入），浏览器没有
  return typeof (window as unknown as { api?: unknown }).api === "undefined";
}

export function installWebApi(): void {
  if (isBrowser()) {
    (window as unknown as { api: typeof webApi }).api = webApi as unknown as typeof window.api;
  }
}

/**
 * 带超时的 fetch。
 * 隧道回源挂起时，不带超时的登录请求会让按钮永远停在"登录中…"（用户只能刷新）。
 */
async function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCaptcha(): Promise<{ id: string; svg: string }> {
  const fp = await collectBrowserFp();
  const res = await fetchWithTimeout("/api/captcha", {
    headers: { "X-Browser-Fp": fp, "X-Fingerprint": fp },
  }, 10000);
  const data = await res.json().catch(() => ({})) as { ok?: boolean; id?: string; svg?: string; error?: string };
  if (!res.ok || !data.ok || !data.id || !data.svg) {
    throw new Error(data.error || "验证码获取失败");
  }
  return { id: data.id, svg: data.svg };
}

export async function loginAdmin(username: string, password: string, captchaId: string, captcha: string): Promise<string> {
  const fp = await collectBrowserFp();
  const res = await fetchWithTimeout("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Browser-Fp": fp, "X-Fingerprint": fp },
    body: JSON.stringify({ username, password, captchaId, captcha }),
  }, 20000);
  const data = await res.json().catch(() => ({})) as { ok?: boolean; token?: string; error?: string };
  if (!res.ok || !data.ok || !data.token) {
    throw new Error(data.error || "登录失败");
  }
  lsSet("waam_token", data.token);
  lsSet("waam_role", "admin");
  // 触发下一次 wsInvoke 时自动连接
  return data.token;
}

export async function loginEmployee(username: string, password: string, captchaId: string, captcha: string): Promise<string> {
  const fp = await collectBrowserFp();
  const res = await fetchWithTimeout("/api/employee-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Browser-Fp": fp, "X-Fingerprint": fp },
    body: JSON.stringify({ username, password, captchaId, captcha, fingerprint: getCachedFpSync() }),
  }, 20000);
  const data = await res.json().catch(() => ({})) as { ok?: boolean; token?: string; error?: string };
  if (!res.ok || !data.ok || !data.token) {
    throw new Error(data.error || "登录失败");
  }
  lsSet("waam_token", data.token);
  lsSet("waam_role", "employee");
  return data.token;
}

export function getRole(): string {
  return lsGet("waam_role") || "admin";
}

export function logoutAdmin(): void {
  const token = lsGet("waam_token") || "";
  if (token && ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ id: genId(), method: "logout", params: {} })); } catch { /* */ }
  }
  lsRemove("waam_token");
  lsRemove("waam_role");
  if (ws) { try { ws.close(); } catch { /* */ } ws = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  pending.forEach((p) => p.reject(new Error("已退出登录")));
  pending.clear();
}

export function getToken(): string | null {
  return lsGet("waam_token");
}

export function getBrowserFpSync(): string {
  return getCachedFpSync();
}
