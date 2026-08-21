import { app } from 'electron';
import { createHash } from 'crypto';
import { networkInterfaces } from 'os';

export function generateDeviceFingerprint(): string {
  const components = [
    app.getName(),
    app.getVersion(),
    process.platform,
    process.arch,
    getMachineId()
  ];

  return createHash('sha256')
    .update(components.join('|'))
    .digest('hex');
}

// 稳定的机器指纹：不随应用名称/版本变化，用于员工端机器绑定（防拷贝）
export function generateStableMachineFingerprint(): string {
  return createHash('sha256')
    .update([process.platform, process.arch, getMachineId()].join('|'))
    .digest('hex');
}

export function verifyFingerprint(stored: string, current: string): boolean {
  return stored === current;
}

function getMachineId(): string {
  const nets = networkInterfaces();
  const macs: string[] = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        macs.push(net.mac);
      }
    }
  }

  return createHash('sha256')
    .update(macs.sort().join(','))
    .digest('hex');
}