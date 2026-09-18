// tailwind.config.cjs — 与 postcss.config.cjs 同理：
// package.json 没有 "type": "module"，ESM 的 export default 只能靠 Tailwind 内部用
// jiti 转译才不报错（和之前 postcss 那个构建失败的坑同源）。用 CJS 更稳。
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
    "./src/renderer/index.html",
    "./web/**/*.{js,ts,jsx,tsx}",
    "./web/index.html"
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d'
        },
        whatsapp: {
          green: '#25D366',
          'green-dark': '#128C7E',
          'green-light': '#DCF8C6',
          'bg-dark': '#111B21',
          'bg-chat': '#0B141A',
          'text-primary': '#E9EDEF',
          'text-secondary': '#8696A0'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
};
