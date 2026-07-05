// afterAllArtifactBuild hook: embed AppImage update information (.upd_info ELF
// section) so external updaters (GearLever, AppImageUpdate) can delta-update
// OpenChamber on Linux. electron-builder does NOT embed this natively — it
// writes its own app-update.yml for electron-updater, which has no Linux
// auto-update provider. See packages/electron/AGENTS.md notes on this.
//
// Strategy: for each produced AppImage, extract to a temp AppDir and repack
// with `appimagetool -n -u gh-releases-zsync|<owner>|<repo>|latest|<glob>`.
// Returns the generated .zsync paths so electron-builder publishes them
// alongside the AppImage in the GitHub release.
//
// appimagetool resolution (no FUSE required at any step):
//   1. cached static ELF at ~/.cache/openchamber/appimagetool/appimagetool
//   2. $APPIMAGETOOL env override (AppImage or static ELF; if AppImage,
//      extract the inner /usr/bin/appimagetool and cache it)
//   3. appimagetool on PATH (same dual-shape handling as env)
//   4. download appimagetool-<arch>.AppImage from the AppImage continuous
//      release, extract, cache — first run only; subsequent builds hit #1
//
// The inner appimagetool binary is statically linked, so it runs on any
// x86_64/arm64/armhf Linux without dependencies. The AppImage runtime's
// --appimage-extract path also doesn't need FUSE, so the entire hook is
// FUSE-less: download -> extract -> run static ELF.
//
// Caveat (known, acceptable for v1): electron-builder already computed
// sha512/blockmap for the original AppImage and wrote latest-linux.yml with
// those hashes. After repacking, those hashes are stale. electron-updater
// cannot auto-update on Linux regardless, so this does not regress any
// working flow. If we later care, set publishAutoUpdate:false for linux.
//
// Skip conditions (never fail the build):
//   - no AppImage in artifacts (mac/win CI, local dev)
//   - appimagetool unobtainable AND no network AND no env override
//   - repack fails (warn + continue with original)

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APPTOOL_BASE_URL = 'https://github.com/AppImage/appimagetool/releases/download/continuous';
const APPTOOL_ARCH_MAP = { x64: 'x86_64', arm64: 'aarch64', arm: 'armhf' };

const appImageToolCacheDir = () => path.join(os.homedir(), '.cache', 'openchamber', 'appimagetool');

const probeVersion = (file) => {
  try {
    const r = spawnSync(file, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && /appimagetool/i.test(String(r.stdout || '')) ? String(r.stdout).trim() : null;
  } catch {
    return null;
  }
};

const extractInnerAppImageTool = (appImagePath) => {
  const cacheDir = appImageToolCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const extract = spawnSync(appImagePath, ['--appimage-extract'], { cwd: cacheDir, encoding: 'utf8' });
  if (extract.status !== 0) {
    throw new Error(`--appimage-extract exited ${extract.status}: ${extract.stderr || extract.stdout}`);
  }
  const inner = path.join(cacheDir, 'squashfs-root', 'usr', 'bin', 'appimagetool');
  if (!fs.existsSync(inner)) {
    throw new Error('appimagetool AppImage did not contain usr/bin/appimagetool');
  }
  const finalPath = path.join(cacheDir, 'appimagetool');
  fs.copyFileSync(inner, finalPath);
  fs.rmSync(path.join(cacheDir, 'squashfs-root'), { recursive: true, force: true });
  fs.chmodSync(finalPath, 0o755);
  return finalPath;
};

const downloadAppImageToolAppImage = (arch) => {
  const url = `${APPTOOL_BASE_URL}/appimagetool-${arch}.AppImage`;
  const destDir = appImageToolCacheDir();
  fs.mkdirSync(destDir, { recursive: true });
  const downloadPath = path.join(destDir, `appimagetool-${arch}.AppImage`);
  console.log(`[appimage-update-info] downloading appimagetool from ${url}`);
  const curl = spawnSync('curl', ['-fL', '--retry', '3', '-o', downloadPath, url], { encoding: 'utf8' });
  if (curl.status !== 0) {
    throw new Error(`curl failed (exit ${curl.status}): ${curl.stderr || curl.stdout || ''}`);
  }
  fs.chmodSync(downloadPath, 0o755);
  return downloadPath;
};

const resolveAppImageTool = () => {
  const cacheDir = appImageToolCacheDir();
  const cachedBinary = path.join(cacheDir, 'appimagetool');

  // 1. Cached static ELF from a previous run (the common path after first build).
  if (fs.existsSync(cachedBinary) && probeVersion(cachedBinary)) {
    return cachedBinary;
  }

  // 2. $APPIMAGETOOL env override. Accepts a static ELF directly, or an
  //    AppImage (we extract and cache the inner binary).
  const fromEnv = process.env.APPIMAGETOOL;
  if (fromEnv && fs.existsSync(fromEnv)) {
    if (probeVersion(fromEnv)) return fromEnv;
    try {
      console.log('[appimage-update-info] APPIMAGETOOL is an AppImage, extracting inner binary');
      return extractInnerAppImageTool(fromEnv);
    } catch (err) {
      throw new Error(`APPIMAGETOOL=${fromEnv} did not run directly and extraction failed: ${err.message}`);
    }
  }

  // 3. appimagetool on PATH (system install; same dual-shape handling).
  const which = spawnSync('which', ['appimagetool'], { encoding: 'utf8' });
  if (which.status === 0) {
    const found = String(which.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (found && fs.existsSync(found)) {
      if (probeVersion(found)) return found;
      try {
        return extractInnerAppImageTool(found);
      } catch {
        // fall through to download
      }
    }
  }

  // 4. Download + extract + cache. First-run only on a clean machine; the
  //    cached ELF survives across builds. CI may need to persist the cache
  //    dir (e.g. actions/cache ~ steps caching ~/.cache/openchamber).
  if (process.env.APPTOOL_NO_DOWNLOAD === '1') {
    return null;
  }
  const arch = APPTOOL_ARCH_MAP[process.arch];
  if (!arch) {
    console.warn(`[appimage-update-info] no appimagetool binary for arch ${process.arch}; set APPIMAGETOOL env`);
    return null;
  }
  let downloaded;
  try {
    downloaded = downloadAppImageToolAppImage(arch);
  } catch (err) {
    console.warn(`[appimage-update-info] download failed: ${err.message}`);
    return null;
  }
  try {
    const extracted = extractInnerAppImageTool(downloaded);
    // Best-effort: drop the downloaded AppImage now that we have the inner ELF.
    try { fs.rmSync(downloaded, { force: true }); } catch {}
    return extracted;
  } catch (err) {
    console.warn(`[appimage-update-info] extract failed: ${err.message}`);
    return null;
  }
};

const resolveRepo = (buildResult) => {
  // Prefer CI env (matches appimagetool -g semantics), fall back to publish config, then hardcode.
  if (process.env.GITHUB_REPOSITORY) {
    const [owner, ...rest] = process.env.GITHUB_REPOSITORY.split('/');
    const repo = rest.join('/');
    if (owner && repo) return { owner, repo };
  }
  const publish = buildResult?.packager?.config?.publish || buildResult?.configuration?.publish;
  if (publish?.owner && publish?.repo) return { owner: publish.owner, repo: publish.repo };
  return { owner: 'openchamber', repo: 'openchamber' };
};

const archFromAppImageName = (file) => {
  const base = path.basename(file);
  // Matches `...-linux-x86_64.AppImage`, `...-linux-arm64.AppImage`, `...-linux-aarch64.AppImage`, `...-linux-armv7l.AppImage`, `...-linux-ia32.AppImage`
  // Allow underscores since electron-builder's ${arch} token produces `x86_64`/`aarch64` on Linux.
  const m = base.match(/-linux-([a-z0-9_]+)\.AppImage$/i);
  return m ? m[1] : null;
};

const productName = (buildResult) =>
  buildResult?.packager?.appInfo?.productName || buildResult?.configuration?.productName || 'OpenChamber';

module.exports = async (buildResult) => {
  const artifactPaths = Array.isArray(buildResult?.artifactPaths) ? buildResult.artifactPaths : [];
  const appImages = artifactPaths.filter((p) => String(p).endsWith('.AppImage'));
  if (appImages.length === 0) return [];

  const tool = resolveAppImageTool();
  if (!tool) {
    console.warn('[appimage-update-info] appimagetool not found (set APPIMAGETOOL env or install it); skipping .upd_info embedding');
    return [];
  }

  const { owner, repo } = resolveRepo(buildResult);
  const name = productName(buildResult);
  const extraFiles = [];

  for (const appImagePath of appImages) {
    const arch = archFromAppImageName(appImagePath);
    if (!arch) {
      console.warn(`[appimage-update-info] could not parse arch from ${path.basename(appImagePath)}; skipping`);
      continue;
    }
    // Glob matches future release filenames (version wildcard via *). Must match the .zsync filename we publish.
    const zsyncGlob = `${name}-*linux-${arch}.AppImage.zsync`;
    const updateInfo = `gh-releases-zsync|${owner}|${repo}|latest|${zsyncGlob}`;

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-appimage-repack-'));
    try {
      // 1. Extract the AppImage to an AppDir (type-2 runtime feature, no FUSE needed).
      const extract = spawnSync(appImagePath, ['--appimage-extract'], { cwd: workDir, encoding: 'utf8' });
      if (extract.status !== 0) {
        throw new Error(`--appimage-extract exited ${extract.status}: ${extract.stderr || extract.stdout}`);
      }
      const appDir = path.join(workDir, 'squashfs-root');
      if (!fs.existsSync(appDir)) throw new Error('squashfs-root not produced after extract');

      // 2. Repack with update info. -n skips AppStream validation (electron-built AppDirs may lack compliant metainfo).
      // cwd is set to the AppImage's directory so zsyncmake drops the .zsync next to it (we expect `${appImagePath}.zsync`).
      const repack = spawnSync(tool, ['-n', '-u', updateInfo, appDir, appImagePath], { cwd: path.dirname(appImagePath), encoding: 'utf8' });
      if (repack.status !== 0) {
        throw new Error(`appimagetool repack exited ${repack.status}: ${repack.stderr || repack.stdout}`);
      }

      // 3. Verify the ELF section actually landed.
      const verify = spawnSync(appImagePath, ['--appimage-updateinfo'], { encoding: 'utf8' });
      const embedded = String(verify.stdout || '').trim();
      if (embedded !== updateInfo) {
        throw new Error(`.upd_info verify failed: expected "${updateInfo}", got "${embedded}"`);
      }

      const zsyncPath = `${appImagePath}.zsync`;
      if (fs.existsSync(zsyncPath)) {
        extraFiles.push(zsyncPath);
      }

      console.log(`[appimage-update-info] embedded .upd_info into ${path.basename(appImagePath)}: ${updateInfo}`);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  return extraFiles;
};
