import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export interface EmployeeCredentials {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  name?: string;
}

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt || randomBytes(16).toString('hex');
  const hash = scryptSync(password, s, 64).toString('hex');
  return { hash, salt: s };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// 内存中的员工会话 token（key: token, value: employeeId）
const employeeSessions = new Map<string, { employeeId: string; createdAt: number }>();

export function createEmployeeToken(employeeId: string): string {
  const token = randomBytes(24).toString('hex');
  employeeSessions.set(token, { employeeId, createdAt: Date.now() });
  // 简单过期清理：超过 30 天的 token 丢弃
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [t, s] of employeeSessions) {
    if (s.createdAt < cutoff) employeeSessions.delete(t);
  }
  return token;
}

export function resolveEmployeeToken(token: string): string | null {
  const session = employeeSessions.get(token);
  return session ? session.employeeId : null;
}

export function revokeEmployeeToken(token: string): void {
  employeeSessions.delete(token);
}

export function clearEmployeeSessions(employeeId: string): void {
  for (const [t, s] of employeeSessions) {
    if (s.employeeId === employeeId) employeeSessions.delete(t);
  }
}