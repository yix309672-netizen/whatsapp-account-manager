/*** Web API — 浏览器端通过 WebSocket 调用 handleCommand，与 preload 的 window.api 保持同接口 ***/
type Listener = (data: unknown) => void;

let ws: WebSocket | null = null;
let pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let eventListeners = new Map<string, Set<Listener>>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
  const stored = localStorage.getItem("waam_fp");
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
  const raw = parts.join("|") + "|" + Date.now().toString(36).slice(-4);
  const fp = await sha256Hex(raw);
  cachedFp = fp;
  try { localStorage.setItem("waam_fp", fp); } catch { /* */ }
  return fp;
}

function getCachedFpSync(): string {
  if (cachedFp) return cachedFp;
  const s = localStorage.getItem("waam_fp");
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

function ensureConnected(): Promise<WebSocket> {
  return new Promise(async (resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve(ws);
      return;
    }
    const token = localStorage.getItem("waam_token") || "";
    if (!token) {
      reject(new Error("未登录"));
      return;
    }
    const url = await getWsUrl(token);
    const sock = new WebSocket(url);
    let settled = false;
    sock.onopen = () => {
      ws = sock;
      // 心跳
      const ping = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ id: genId(), method: "ping", params: {} }));
        } else {
          clearInterval(ping);
        }
      }, 30000);
      sock.addEventListener("close", () => clearInterval(ping));
      if (!settled) { settled = true; resolve(sock); }
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
      if (!settled) { settled = true; reject(new Error("WebSocket 连接失败")); }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      // 自动重连（仅当仍有 token）
      if (localStorage.getItem("waam_token")) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          ensureConnected().catch(() => {});
        }, 3000);
      }
    };
    setTimeout(() => {
      if (!settled && sock.readyState !== WebSocket.OPEN) {
        settled = true;
        try { sock.close(); } catch { /* */ }
        reject(new Error("WebSocket 连接超时"));
      }
    }, 8000);
  });
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
  browser: {
    open: (accountId: string) => wsInvoke("browser:open", { accountId }),
    close: (accountId: string) => wsInvoke("browser:close", { accountId }),
    status: (accountId: string) => wsInvoke("browser:status", { accountId }),
  },
  fingerprint: {
    get: () => wsInvoke("fingerprint:get", {}),
  },
  app: {
    version: () => wsInvoke("app:version", {}),
  },
  store: {
    getPath: () => wsInvoke("store:get-path", {}),
    export: () => wsInvoke("store:export", {}),
    backupNow: () => wsInvoke("store:backup-now", {}),
  },
  relay: {
    getConfig: () => wsInvoke("relay:get-config", {}),
    setServer: (serverUrl: string) => wsInvoke("relay:set-server", { serverUrl }),
    regenerateCode: () => wsInvoke("relay:regenerate-code", {}),
    applyConfig: (serverUrl?: string, code?: string) => wsInvoke("relay:apply-config", { serverUrl, code }),
    status: () => wsInvoke("relay:status", {}),
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
  feedback: {
    submit: (payload: { content: string; contact?: string }) => wsInvoke("feedback:submit", payload as unknown as Record<string, unknown>),
    list: (status?: string) => wsInvoke("feedback:list", { status }),
    updateStatus: (id: string, status: string) => wsInvoke("feedback:update_status", { id, status }),
    remove: (id: string) => wsInvoke("feedback:delete", { id }),
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

export async function fetchCaptcha(): Promise<{ id: string; svg: string }> {
  const fp = await collectBrowserFp();
  const res = await fetch("/api/captcha", {
    headers: { "X-Browser-Fp": fp, "X-Fingerprint": fp },
  });
  const data = await res.json().catch(() => ({})) as { ok?: boolean; id?: string; svg?: string; error?: string };
  if (!res.ok || !data.ok || !data.id || !data.svg) {
    throw new Error(data.error || "验证码获取失败");
  }
  return { id: data.id, svg: data.svg };
}

export async function loginAdmin(username: string, password: string, captchaId: string, captcha: string): Promise<string> {
  const fp = await collectBrowserFp();
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Browser-Fp": fp, "X-Fingerprint": fp },
    body: JSON.stringify({ username, password, captchaId, captcha }),
  });
  const data = await res.json().catch(() => ({})) as { ok?: boolean; token?: string; error?: string };
  if (!res.ok || !data.ok || !data.token) {
    throw new Error(data.error || "登录失败");
  }
  localStorage.setItem("waam_token", data.token);
  // 触发下一次 wsInvoke 时自动连接
  return data.token;
}

export function logoutAdmin(): void {
  const token = localStorage.getItem("waam_token") || "";
  if (token && ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ id: genId(), method: "logout", params: {} })); } catch { /* */ }
  }
  localStorage.removeItem("waam_token");
  if (ws) { try { ws.close(); } catch { /* */ } ws = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  pending.forEach((p) => p.reject(new Error("已退出登录")));
  pending.clear();
}

export function getToken(): string | null {
  return localStorage.getItem("waam_token");
}

export function getBrowserFpSync(): string {
  return getCachedFpSync();
}
