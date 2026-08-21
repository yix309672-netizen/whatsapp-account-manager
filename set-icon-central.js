const { rcedit } = require('rcedit');
const path = require('path');
const fs = require('fs');

exports.default = async function(context) {
  const appOutDir = context.appOutDir;
  const exeName = context.packager.appInfo.productFilename + '.exe';
  const exePath = path.join(appOutDir, exeName);
  const iconPath = path.join(context.outDir, '..', 'resources', 'central-icon.ico');
  
  if (fs.existsSync(exePath) && fs.existsSync(iconPath)) {
    await rcedit(exePath, { icon: iconPath });
    console.log('Set icon on', exePath);
  }
};
