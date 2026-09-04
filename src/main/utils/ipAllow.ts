import type { IncomingMessage } from 'http';

// IP 登录白名单：支持精确 IP（v4/v6）与 IPv4 CIDR（如 192.168.1.0/24）。
// 空名单 = 不限制。本机回环（127.x/::1）永远放行，保证本机运维不被锁死。

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

export function isLoopback(ip: string): boolean {
  const v = String(ip || '').trim().toLowerCase();
  if (LOOPBACK.has(v)) return true;
  // 127.0.0.0/8 全段
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
  return false;
}

export function normalizeIp(ip: string): string {
  let v = String(ip || '').trim();
  // 去端口（[v6]:port 或 v4:port 形态尽量剥离；裸 v6 含冒号不动）
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end > 0) v = v.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) {
    v = v.slice(0, v.lastIndexOf(':'));
  }
  if (v.toLowerCase().startsWith('::ffff:')) {
    const rest = v.slice(7);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
  }
  return v.toLowerCase();
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p < 0 || p > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function matchCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const mask = Math.floor(Number(bits));
  if (!base || !(mask >= 0 && mask <= 32)) return false;
  const a = ipv4ToInt(base);
  const b = ipv4ToInt(ip);
  if (a === null || b === null) return false;
  if (mask === 0) return true;
  const m = mask === 32 ? 0xffffffff : (~((1 << (32 - mask)) - 1) >>> 0);
  return (a & m) === (b & m);
}

export function parseAllowList(raw: string): string[] {
  return String(raw || '')
    .split(/[\r\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 500);
}

export function isValidAllowEntry(entry: string): boolean {
  const e = String(entry || '').trim().toLowerCase();
  if (!e) return false;
  if (e.includes('/')) {
    const [base, bits] = e.split('/');
    const mask = Math.floor(Number(bits));
    return ipv4ToInt(base) !== null && mask >= 0 && mask <= 32;
  }
  if (ipv4ToInt(e) !== null) return true;
  // IPv6 精确匹配（不做 CIDR，保持简单；v6 网段需求极少）
  if (e.includes(':') && /^[0-9a-f:]+$/i.test(e)) return true;
  return false;
}

/** 空名单返回 true（不限制）；回环永远 true */
export function isIpAllowed(rawIp: string, allowList: string[]): boolean {
  const ip = normalizeIp(rawIp);
  if (!ip || ip === 'unknown') return false;
  if (isLoopback(ip)) return true;
  if (!allowList || allowList.length === 0) return true;
  for (const entry of allowList) {
    const e = String(entry || '').trim().toLowerCase();
    if (!e) continue;
    if (e === ip) return true;
    if (e.includes('/') && matchCidr(ip, e)) return true;
  }
  return false;
}

/** 取客户端真实 IP：Cloudflare 优先，其次 XFF 首跳，最后 socket */
export function getClientIp(req: IncomingMessage): string {
  const h = req.headers;
  const cf = h['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return normalizeIp(cf);
  const xff = h['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return normalizeIp(xff.split(',')[0]);
  const sock = (req.socket?.remoteAddress || '') as string;
  return normalizeIp(sock);
}
