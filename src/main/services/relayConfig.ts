import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';

export interface RelaySettings {
  serverUrl: string;
  code: string;
}

const DEFAULTS: RelaySettings = {
  serverUrl: 'wss://waam-relay.yix309672.workers.dev/ws',
  code: ''
};

function configPath(): string {
  return join(app.getPath('userData'), 'relay-config.json');
}

function generateCode(): string {
  // 12 位大写字母+数字接入码
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

export function loadRelaySettings(): RelaySettings {
  try {
    const p = configPath();
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<RelaySettings>;
      return {
        serverUrl: parsed.serverUrl || DEFAULTS.serverUrl,
        code: parsed.code || ''
      };
    }
  } catch (err) {
    // fall through to defaults
  }
  return { ...DEFAULTS };
}

export function saveRelaySettings(settings: RelaySettings): void {
  const p = configPath();
  const dir = join(app.getPath('userData'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8');
}

export function ensureAccessCode(): string {
  const settings = loadRelaySettings();
  if (!settings.code) {
    settings.code = generateCode();
    saveRelaySettings(settings);
  }
  return settings.code;
}

export function regenerateAccessCode(): string {
  const settings = loadRelaySettings();
  settings.code = generateCode();
  saveRelaySettings(settings);
  return settings.code;
}