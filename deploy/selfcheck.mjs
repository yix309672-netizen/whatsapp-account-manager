// 部署后自检：验证码 -> 登录 -> WebSocket 调用几条只读命令
// 用法: node deploy/selfcheck.mjs <http://127.0.0.1:9527> <用户名> <密码>
// 依赖: npm i ws（仓库已有 ws 依赖，直接在项目目录跑即可）
import { WebSocket } from 'ws';

const [base, username, password] = process.argv.slice(2);
if (!base || !username || !password) {
  console.error('用法: node deploy/selfcheck.mjs <baseUrl> <username> <password>');
  process.exit(1);
}

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const fp = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const H = { 'User-Agent': BROWSER_UA, 'X-Browser-Fp': fp };

async function captcha() {
  const res = await fetch(`${base}/api/captcha`, { headers: H, signal: AbortSignal.timeout(10000) });
  const c = await res.json();
  if (!c.ok) throw new Error('验证码接口失败: ' + JSON.stringify(c));
  return { id: c.id, text: [...String(c.svg).matchAll(/>([A-Z2-9])<\/text>/g)].map((m) => m[1]).join('') };
}

const cap = await captcha();
console.log(`[1] 验证码 = ${cap.text}`);
if (cap.text.length !== 4) throw new Error('验证码解析异常，SVG 结构可能变了');

const body = new TextEncoder().encode(
  JSON.stringify({ username, password, captchaId: cap.id, captcha: cap.text })
);
const loginRes = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body,
  signal: AbortSignal.timeout(15000)
});
const login = await loginRes.json();
if (!login.ok) throw new Error(`登录失败 HTTP ${loginRes.status}: ${JSON.stringify(login)}`);
console.log(`[2] 登录成功 token=${String(login.token).slice(0, 12)}...`);

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${login.token}&fp=${fp}`, {
  headers: { 'User-Agent': BROWSER_UA }
});
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', (e) => reject(new Error('WS 连接失败: ' + e.message)));
  setTimeout(() => reject(new Error('WS 连接超时')), 15000);
});
console.log('[3] WS 已连接');

function invoke(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => reject(new Error(`超时: ${method}`)), 20000);
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      m.ok ? resolve(m.data) : reject(new Error(`${method} -> ${m.error}`));
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

let failed = 0;
for (const method of ['app:version', 'account:list', 'employee:list', 'stats:summary', 'relay:status', 'system:info']) {
  try {
    const data = await invoke(method);
    const brief = JSON.stringify(data);
    console.log(`    ${method} => ${brief.length > 200 ? brief.slice(0, 200) + '...' : brief}`);
  } catch (e) {
    console.log(`    ${method} => 错误: ${e.message}`);
    failed++;
  }
}
ws.close();

const total = 6;
console.log(`\n结果: ${total - failed}/${total} 个命令成功`);
process.exit(failed ? 2 : 0);
