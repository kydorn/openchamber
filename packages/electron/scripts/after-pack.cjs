const fs = require('node:fs');
const path = require('node:path');

module.exports = (context) => {
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    const appBundlePath = path.join(context.appOutDir, `${appName}.app`);
    const resourcesPath = path.join(appBundlePath, 'Contents', 'Resources');
    const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

    if (!fs.existsSync(sourceAssetsPath)) {
      throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
    }

    fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
    return;
  }

  if (context.electronPlatformName === 'linux') {
    wrapLinuxExecutableForX11(context);
    return;
  }
};

function wrapLinuxExecutableForX11(context) {
  const appOutDir = context.appOutDir;
  const entries = fs.readdirSync(appOutDir, { withFileTypes: true });
  const executables = entries.filter((e) => {
    if (!e.isFile()) return false;
    if (e.name.endsWith('.bin')) return false;
    const full = path.join(appOutDir, e.name);
    try { return (fs.statSync(full).mode & 0o111) !== 0; }
    catch { return false; }
  });
  let main = executables.find((e) => !e.name.startsWith('chrome') && !e.name.startsWith('lib'));
  if (!main) main = executables[0];
  if (!main) throw new Error(`after-pack(linux): no executable found in ${appOutDir}`);

  const binName = main.name;
  const binPath = path.join(appOutDir, binName);
  const wrapperBinPath = binPath + '.bin';

  if (fs.existsSync(wrapperBinPath)) {
    fs.unlinkSync(wrapperBinPath);
  }
  fs.renameSync(binPath, wrapperBinPath);
  fs.chmodSync(wrapperBinPath, 0o755);

  const wrapper = [
    '#!/bin/sh',
    'exec "$(dirname "$0")/' + binName + '.bin" --ozone-platform=x11 "$@"',
    '',
  ].join('\n');
  fs.writeFileSync(binPath, wrapper, { mode: 0o755 });
  fs.chmodSync(binPath, 0o755);
}
