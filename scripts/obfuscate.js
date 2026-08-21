const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const targets = ['dist/main', 'dist/preload'];

async function main() {
  let count = 0;
  for (const dir of targets) {
    const fullDir = path.join(__dirname, '..', dir);
    if (!fs.existsSync(fullDir)) continue;
    for (const file of fs.readdirSync(fullDir).filter((f) => f.endsWith('.js'))) {
      const full = path.join(fullDir, file);
      const code = fs.readFileSync(full, 'utf8');
      const result = await minify(code, {
        compress: {
          passes: 2,
          drop_console: false
        },
        mangle: true,
        format: { comments: false, beautify: false }
      });
      fs.writeFileSync(full, result.code || code);
      count++;
    }
  }
  console.log(`Obfuscated ${count} files`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});