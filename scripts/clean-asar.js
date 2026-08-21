const asar = require('@electron/asar');
const path = require('path');
const fs = require('fs');

const ASAR_PATH = 'C:\\Users\\39712\\Desktop\\kuai-z 2.5.0\\resources\\app.asar';
const TMP_DIR = 'C:\\Users\\39712\\Desktop\\kuai-z 2.5.0\\_asar_tmp';
const BACKUP = ASAR_PATH + '.bak';

async function main() {
  // 1. Backup original
  if (fs.existsSync(BACKUP)) fs.unlinkSync(BACKUP);
  fs.copyFileSync(ASAR_PATH, BACKUP);
  console.log('Backup created: ' + BACKUP);

  // 2. Extract
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  asar.extractAll(ASAR_PATH, TMP_DIR);
  console.log('Extracted to: ' + TMP_DIR);

  // 3. Count before
  const countBefore = countFiles(TMP_DIR);
  const sizeBefore = dirSize(TMP_DIR);
  console.log('\nBefore: ' + countBefore + ' files, ' + (sizeBefore / 1024 / 1024).toFixed(1) + ' MB');

  // 4. Remove files
  let removed = 0;
  const removePatterns = [
    // electron-updater - not needed for manual distribution
    { match: /node_modules[\\/]electron-updater/, reason: 'electron-updater' },
    // TypeScript source files (compiled JS runs fine)
    { match: /node_modules[\\/]zod[\\/]src[\\/]/, reason: 'zod/src' },
    { match: /node_modules[\\/]puppeteer-core[\\/]src[\\/]/, reason: 'puppeteer-core/src' },
    { match: /node_modules[\\/]@puppeteer[\\/]browsers[\\/]src[\\/]/, reason: '@puppeteer/browsers/src' },
    { match: /node_modules[\\/]puppeteer[\\/]src[\\/]/, reason: 'puppeteer/src' },
    { match: /node_modules[\\/]webdriver-bidi-protocol[\\/]src[\\/]/, reason: 'webdriver-bidi-protocol/src' },
    { match: /node_modules[\\/]agent-base[\\/]src[\\/]/, reason: 'agent-base/src' },
    // Test files
    { match: /\.test\.(js|ts)$/, reason: 'test file' },
    { match: /\.spec\.(js|ts)$/, reason: 'spec file' },
    { match: /[\\/]__tests__[\\/]/, reason: '__tests__ dir' },
    { match: /[\\/]test[\\/]/, reason: 'test dir' },
    { match: /[\\/]tests[\\/]/, reason: 'tests dir' },
    // Documentation
    { match: /\.md$/, reason: 'markdown doc' },
    { match: /[\\/]README$/, reason: 'README' },
    // Coverage reports
    { match: /[\\/]coverage[\\/]/, reason: 'coverage report' },
    // Changelog files
    { match: /CHANGELOG/, reason: 'changelog' },
    { match: /CHANGES/, reason: 'changes file' },
  ];

  function walkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
      } else {
        const rel = path.relative(TMP_DIR, full).replace(/\\/g, '/');
        for (const pattern of removePatterns) {
          if (pattern.match.test(rel)) {
            try {
              fs.unlinkSync(full);
              removed++;
            } catch {}
            break;
          }
        }
      }
    }
  }

  walkDir(TMP_DIR);
  console.log('Removed: ' + removed + ' files');

  // 5. Remove empty directories
  function cleanEmptyDirs(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sub = path.join(dir, entry.name);
        cleanEmptyDirs(sub);
        try {
          const remaining = fs.readdirSync(sub);
          if (remaining.length === 0) {
            fs.rmdirSync(sub);
          }
        } catch {}
      }
    }
  }
  cleanEmptyDirs(TMP_DIR);

  // 6. Count after
  const countAfter = countFiles(TMP_DIR);
  const sizeAfter = dirSize(TMP_DIR);
  console.log('After:  ' + countAfter + ' files, ' + (sizeAfter / 1024 / 1024).toFixed(1) + ' MB');
  console.log('Saved:  ' + (countBefore - countAfter) + ' files, ' + ((sizeBefore - sizeAfter) / 1024 / 1024).toFixed(1) + ' MB');

  // 7. Repack
  if (fs.existsSync(ASAR_PATH)) fs.unlinkSync(ASAR_PATH);
  asar.createPackage(TMP_DIR, ASAR_PATH);
  const newSize = fs.statSync(ASAR_PATH).size;
  console.log('\nNew asar: ' + (newSize / 1024 / 1024).toFixed(1) + ' MB');

  // 8. Cleanup
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('Temp dir cleaned');

  // 9. Remove backup
  // fs.unlinkSync(BACKUP);
  console.log('Backup kept at: ' + BACKUP);
}

function countFiles(dir) {
  let count = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

function dirSize(dir) {
  let size = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += dirSize(full);
    } else {
      size += fs.statSync(full).size;
    }
  }
  return size;
}

main().catch(e => console.error(e));
