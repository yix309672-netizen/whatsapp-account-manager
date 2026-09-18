#!/usr/bin/env node
/**
 * 用 Cloudflare API Token 部署 Cloudflare Pages（Pages Direct Upload）
 *
 * 为什么不用 wrangler：
 *   1) wrangler 4 要求 Node >= 22.12，而本机系统 Node 是 20.11.1
 *      （better-sqlite3 原生模块绑定该 ABI，不能升级系统 Node）；
 *   2) wrangler login 的 OAuth 需要在浏览器点授权，无人值守场景很麻烦。
 *   本脚本只用 Node 内置能力（fetch / crypto / FormData / Blob），Node >= 18 即可。
 *
 * 流程（对着 wrangler 的实现还原，端点容易搞错，这里记下来）：
 *   1) POST /accounts/{acct}/pages/projects/{proj}/deployments   multipart: manifest + branch
 *   2) GET  /accounts/{acct}/pages/projects/{proj}/upload-token  -> JWT（后续资产接口用它鉴权）
 *   3) POST /pages/assets/check-missing                          body {hashes} -> 还缺哪些
 *   4) POST /pages/assets/upload                                 body [{key,value(base64),metadata,base64}]
 *   5) POST /pages/assets/upsert-hashes                          body {hashes}（可选，加速下次部署）
 *   6) 轮询 GET deployments/{id}，等 latest_stage.name == 'deploy' && status == 'success'
 *
 * 凭据（优先级）：
 *   1) 环境变量 CLOUDFLARE_API_TOKEN
 *   2) 项目根目录 .cf-token（已 gitignore）：第一行 token，第二行可选 account id
 *
 * 用法：node scripts/cf-pages-deploy.js [目录] [项目名] [分支]
 *       默认 hotline-dist  waam-web  main
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.cloudflare.com/client/v4';
const MAX_ASSET_BYTES = 20 * 1024 * 1024; // 单个资产上限（超出需走 multipart 分片，本项目用不到）

function readTokenFile() {
  const p = path.resolve(__dirname, '..', '.cf-token');
  if (!fs.existsSync(p)) return { token: '', accountId: '' };
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { token: lines[0] || '', accountId: lines[1] || '' };
}

async function api(token, method, url, body, opts = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${url}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.success === false) {
    const errs = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ') || text.slice(0, 300);
    throw new Error(`HTTP ${res.status} ${method} ${url} -> ${errs}`);
  }
  return json.result;
}

function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push({ full, rel: '/' + path.relative(root, full).split(path.sep).join('/') });
    }
  };
  walk(root);
  return out;
}

function guessType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
  })[ext] || 'application/octet-stream';
}

async function resolveAccountId(token, fromFile) {
  if (fromFile) return fromFile;
  const accounts = await api(token, 'GET', '/accounts');
  if (!accounts || !accounts.length) throw new Error('token 无法列出账号（缺少 Account Settings:Read 权限？可在 .cf-token 第二行手填 account id）');
  return accounts[0].id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = process.argv[2] || 'hotline-dist';
  const project = process.argv[3] || 'waam-web';
  const branch = process.argv[4] || 'main';

  const cfg = readTokenFile();
  const token = process.env.CLOUDFLARE_API_TOKEN || cfg.token;
  if (!token) {
    console.error('缺少 API Token：请设置 CLOUDFLARE_API_TOKEN，或在仓库根目录的 .cf-token 写入第一行 token。');
    process.exit(2);
  }
  const root = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(root)) { console.error(`目录不存在: ${root}`); process.exit(2); }

  const accountId = await resolveAccountId(token, cfg.accountId);
  console.log(`账号: ${accountId}`);
  console.log(`项目: ${project}   分支: ${branch}`);
  console.log(`目录: ${root}`);

  // 收集文件 + manifest
  const files = collectFiles(root);
  const manifest = {};
  const byHash = new Map();
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    if (buf.length > MAX_ASSET_BYTES) throw new Error(`文件过大(${buf.length}): ${f.rel}`);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    manifest[f.rel] = hash;
    byHash.set(hash, { buf, type: guessType(f.full) });
  }
  console.log(`文件 ${files.length} 个，去重后 ${byHash.size} 个 blob`);

  // 1) 创建部署（multipart：manifest + branch）
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('branch', branch);
  form.append('commit_dirty', 'true');
  const deployment = await api(token, 'POST', `/accounts/${accountId}/pages/projects/${project}/deployments`, form);
  const deployId = deployment.id;
  console.log(`部署已创建: ${deployId}`);

  // 2) 取资产上传用的 JWT
  // ⚠️ 这个接口返回的是 **对象** { jwt: "eyJ..." }，不是字符串。
  // 直接把对象塞进 Authorization 头会变成 "Bearer [object Object]" -> 403 8000013。
  const tokenRes = await api(token, 'GET', `/accounts/${accountId}/pages/projects/${project}/upload-token`);
  const jwt = typeof tokenRes === 'string' ? tokenRes : (tokenRes && tokenRes.jwt);
  if (!jwt || typeof jwt !== 'string') {
    throw new Error(`upload-token 返回格式异常: ${JSON.stringify(tokenRes).slice(0, 120)}`);
  }
  console.log(`已获取资产上传凭据（jwt ${jwt.length} 字符）`);

  // 3) 询问还缺哪些 hash
  const allHashes = [...byHash.keys()];
  let missing = await api(token, 'POST', '/pages/assets/check-missing', { hashes: allHashes }, { bearer: jwt });
  if (!Array.isArray(missing)) missing = allHashes;
  console.log(`需要上传 ${missing.length} / ${byHash.size} 个 blob`);

  // 4) 上传（JSON + base64）
  if (missing.length) {
    const payload = missing.map((h) => {
      const b = byHash.get(h);
      return b ? { key: h, value: b.buf.toString('base64'), metadata: { contentType: b.type }, base64: true } : null;
    }).filter(Boolean);
    await api(token, 'POST', '/pages/assets/upload', payload, { bearer: jwt });
    console.log(`已上传 ${payload.length} 个 blob`);
    // 5) upsert（可选，加速下次）
    try { await api(token, 'POST', '/pages/assets/upsert-hashes', { hashes: allHashes }, { bearer: jwt }); } catch { /* 不影响本次部署 */ }
  }

  // 6) 等部署完成
  process.stdout.write('等待部署完成');
  for (let i = 0; i < 12; i++) {
    await sleep(Math.min(1000 * Math.pow(2, i), 8000));
    process.stdout.write('.');
    let d;
    try { d = await api(token, 'GET', `/accounts/${accountId}/pages/projects/${project}/deployments/${deployId}`); }
    catch { continue; }
    const stage = d && d.latest_stage;
    if (stage && stage.name === 'deploy' && stage.status === 'success') {
      console.log('\n✅ 部署完成');
      console.log(`预览地址: ${d.url || deployment.url}`);
      console.log(`生产地址: https://${project}.pages.dev`);
      const alias = (d.aliases || []).find((a) => a.endsWith('.pages.dev'));
      if (alias) console.log(`别名地址: https://${alias}`);
      return;
    }
    if (stage && stage.status === 'failure') {
      throw new Error(`部署失败: ${stage.name} / ${stage.status}`);
    }
  }
  console.log('\n⚠️ 轮询超时，但资产已上传，稍后到 Cloudflare 后台看部署状态即可');
  console.log(`部署 ID: ${deployId}`);
}

main().catch((e) => { console.error('部署失败:', e.message); process.exit(1); });
