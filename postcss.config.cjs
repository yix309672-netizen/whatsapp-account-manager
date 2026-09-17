// 用 .cjs + CommonJS 语法：package.json 没有 "type": "module"，
// 原先的 postcss.config.js（export default）会被 Node 当成 CJS 解析而报
// "Unexpected token 'export'"，导致 vite 构建直接失败。
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
};
