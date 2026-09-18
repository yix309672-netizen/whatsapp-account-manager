#!/usr/bin/env node
/**
 * 用 Cloudflare API Token 部署 Cloudflare Pages（Pages Direct Upload API）
 *
 * 为什么不用 wrangler：
 *   1) wrangler 4 要求 Node >= 22.12，而本机系统 Node 是 20.11.1
 *      （better-sqlite3 原生模块绑定该 ABI，不能升级系统 Node）；
 *   2) wrangler login 的 OAuth 需要浏览器点授权，无人值守场景很麻烦。
 *   本脚本只用 Node 内置的 fetch/crypto，任何 Node >= 18 都能跑。
 *
 * 凭据（二选一，按优先级）：
 *   1) 环境变量 CLOUDFLARE_API_TOKEN
 *   2) 项目根目录的 .cf-token 文件（已 gitignore，内容：第一行 token，第二行可选 account id）
 *
 * 用法：
 *   node scripts/cf-pages-deploy.js [目录] [项目名] [分支]
 *   默认： hotline-dist  waam-web  main
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.cloudflare.com/client/v4';

function readTokenFile() {
  const p = path.resolve(__dirname, '..', '.cf-token');
  if (!fs.existsSync(p)) return { token: '', accountId: '' };
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { token: lines[0] || '', accountId: lines[1] || '' };
}

async function api(token, method, url, body, isForm) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(isForm ? {} : body ? { 'Content-Type': 'application/json' } : {})
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.success === false) {
    const errs = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ') || text.slice(0, 300);
    throw new Error(`HTTP ${res.status} ${url} -> ${errs}`);
  }
  return json.result;
}

/** 递归收集目录下所有文件（相对路径用 / 分隔） */
function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push({ full, rel: '/' + path.relative(root, full).split(path.sep).join('/') });
    }
  };
  walk(root);
  return out;
}

function guessType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
  })[ext] || 'application/octet-stream';
}

async function resolveAccountId(token, fromFile) {
  if (fromFile) return fromFile;
  const accounts = await api(token, 'GET', '/accounts');
  if (!accounts || !accounts.length) throw new Error('token 无法列出任何账号（缺少 Account:Read 权限？）');
  if (accounts.length > 1) {
    console.log(`注意：token 可见 ${accounts.length} 个账号，使用第一个：${accounts[0].name}`);
  }
  return accounts[0].id;
}

async function main() {
  const dir = process.argv[2] || 'hotline-dist';
  const project = process.argv[3] || 'waam-web';
  const branch = process.argv[4] || 'main';

  const fileCfg = readTokenFile();
  const token = process.env.CLOUDFLARE_API_TOKEN || fileCfg.token;
  if (!token) {
    console.error('缺少 API Token。请二选一：');
    console.error('  1) 设置环境变量 CLOUDFLARE_API_TOKEN');
    console.error(`  2) 在 ${path.resolve(__dirname, '..', '.cf-token')} 写入：第一行 token，第二行 account id（可选）`);
    process.exit(2);
  }

  const root = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(root)) {
    console.error(`目录不存在: ${root}`);
    process.exit(2);
  }

  const accountId = await resolveAccountId(token, fileCfg.accountId);
  console.log(`账号: ${accountId}`);
  console.log(`项目: ${project}   分支: ${branch}   目录: ${root}`);

  // 1) 逐文件算 sha256，构造 manifest
  const files = collectFiles(root);
  const manifest = {};
  const bodies = new Map();
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    manifest[f.rel] = hash;
    bodies.set(hash, { buf, type: guessType(f.full) });
  }
  console.log(`待上传 ${files.length} 个文件，去重后 ${bodies.size} 个 blob`);

  // 2) 创建部署（先带完整 manifest，让 Cloudflare 告知哪些已存在）
  let res = await api(token, 'POST', `/accounts/${accountId}/pages/projects/${project}/deployments`, {
    branch,
    commit_dirty: true
  });
  const deploymentId = res.id;
  console.log(`创建部署: ${deploymentId}`);

  const upload = async (hashes) => {
    const form = new FormData();
    form.append('manifest', JSON.stringify(
      Object.fromEntries(Object.entries(manifest).filter(([, h]) => hashes.includes(h)))
    ));
    for (const h of hashes) {
      const b = bodies.get(h);
      if (b) form.append(h, new Blob([b.buf], { type: b.type }), h);
    }
    return api(token, 'POST', `/accounts/${accountId}/pages/projects/${project}/deployments/${deploymentId}/assets`, form, true);
  };

  // 先尝试全量上传（若已存在同名内容，Cloudflare 会返回需要上传的哈希列表）
  let r = await upload([...bodies.keys()]);
  let need = r && r.jwt ? (r.missing || r.needed || r.upload_hashes || []) : (r || []);
  if (Array.isArray(need) && need.length) {
    console.log(`仍有 ${need.length} 个文件需要上传…`);
    r = await upload(need);
    need = r && r.jwt ? (r.missing || r.needed || r.upload_hashes || []) : (r || []);
  }

  // 3) 提交部署
  const final = await api(token, 'POST', `/accounts/${accountId}/pages/projects/${project}/deployments/${deploymentId}/finalize`, {});
  console.log('部署完成 ✅');
  if (final && final.url) console.log(`预览地址: ${final.url}`);
  console.log(`生产地址: https://${project}.pages.dev`);
}

main().catch((e) => {
  console.error('部署失败:', e.message);
  process.exit(1);
});
