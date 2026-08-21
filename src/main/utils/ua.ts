// 解析 User-Agent：设备类型 / 操作系统 / 浏览器

export interface UaInfo {
  device: string;
  os: string;
  browser: string;
}

export function parseUa(ua: string): UaInfo {
  const u = ua || '';

  let device = 'desktop';
  if (/iPad|Tablet|PlayBook/i.test(u)) {
    device = 'tablet';
  } else if (/Mobi|iPhone|iPod|Android.*Mobile/i.test(u)) {
    device = 'mobile';
  }

  let os = '未知';
  if (/Windows/i.test(u)) {
    os = 'Windows';
  } else if (/Mac OS X|Macintosh/i.test(u)) {
    os = 'macOS';
  } else if (/Android/i.test(u)) {
    os = 'Android';
  } else if (/iPhone|iPad|iPod/i.test(u)) {
    os = 'iOS';
  } else if (/Linux/i.test(u)) {
    os = 'Linux';
  } else if (/CrOS/i.test(u)) {
    os = 'ChromeOS';
  }

  let browser = '未知';
  if (/Edg\//i.test(u)) {
    browser = 'Edge';
  } else if (/OPR\/|Opera/i.test(u)) {
    browser = 'Opera';
  } else if (/Chrome\//i.test(u)) {
    browser = 'Chrome';
  } else if (/Firefox\//i.test(u)) {
    browser = 'Firefox';
  } else if (/Safari\//i.test(u)) {
    browser = 'Safari';
  } else if (/MicroMessenger/i.test(u)) {
    browser = '微信内置浏览器';
  }

  return { device, os, browser };
}