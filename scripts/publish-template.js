#!/usr/bin/env node
// 发布指定模板到 waam-web pages (www.whatspph.com)
// 用法: node scripts/publish-template.js <classic|hotline>
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const tpl = process.argv[2];
if (!['classic', 'hotline'].includes(tpl)) {
  console.error('参数错误: classic 或 hotline');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
let src;
if (tpl === 'classic') {
  src = path.join(root, 'web-dist');       // 旧版 4 步验证
} else {
  src = path.join(root, 'hotline-dist');    // 米色客服版 (hotline2.html + 图)
}

if (!fs.existsSync(src)) {
  console.error(`产物不存在: ${src}`);
  process.exit(1);
}

console.log(`发布模板 ${tpl} -> waam-web (www.whatspph.com), from ${src}`);
try {
  execSync(`npx wrangler pages deploy "${src}" --project-name waam-web --branch main --commit-dirty=true`, {
    cwd: root,
    stdio: 'inherit'
  });
  console.log(`✅ 已发布 ${tpl} 到 www.whatspph.com`);
} catch (e) {
  console.error('发布失败:', e.message);
  process.exit(1);
}
