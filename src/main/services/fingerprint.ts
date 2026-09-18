import { app } from 'electron';
import { createHash } from 'crypto';
import { networkInterfaces } from 'os';

/**
 * 兼容用的旧版指纹：**曾经**包含应用名称与版本号。
 *
 * 历史 bug：账号绑定用的是这个值，于是每次升级（或 dev 与打包切换，app.getName() 不同）
 * 算出来的指纹都会变 → 所有存量账号登录时报「设备指纹不匹配，该账号已绑定其他设备」。
 * 现在不再用它做绑定，只保留用于**校验历史数据**，让老账号能平滑过渡（见 verifyFingerprint）。
 */
export function legacyDeviceFingerprint(): string {
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

/**
 * 设备指纹（当前用于账号绑定）。
 * 只由 platform/arch/机器标识组成，**不含应用名称与版本**，因此升级不会导致失配。
 * 保留这个名字是为了不改动所有调用点。
 */
export function generateDeviceFingerprint(): string {
  return generateStableMachineFingerprint();
}

// 稳定的机器指纹：不随应用名称/版本变化，用于员工端机器绑定（防拷贝）
export function generateStableMachineFingerprint(): string {
  return createHash('sha256')
    .update([process.platform, process.arch, getMachineId()].join('|'))
    .digest('hex');
}

/**
 * 校验设备指纹。
 * 除了当前稳定指纹，还接受**旧版含版本号的指纹**，这样升级后老账号第一次登录不会
 * 被拒；调用方在成功后会把这个字段重写为稳定指纹（见 commands 里的 rewritten 逻辑），
 * 之后就一直走稳定值。不这样做的话，一次升级就会把所有存量账号锁死。
 */
export function verifyFingerprint(stored: string, current: string): boolean {
  if (!stored) return true;
  if (stored === current) return true;
  try {
    return stored === legacyDeviceFingerprint();
  } catch {
    return false;
  }
}

/** 已存指纹是否为旧版（需要升级为稳定指纹） */
export function isLegacyFingerprint(stored: string): boolean {
  if (!stored) return false;
  try {
    return stored === legacyDeviceFingerprint() && stored !== generateStableMachineFingerprint();
  } catch {
    return false;
  }
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