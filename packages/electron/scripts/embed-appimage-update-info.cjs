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
// Caveat (known, acceptable for v1): electron-builder already computed
// sha512/blockmap for the original AppImage and wrote latest-linux.yml with
// those hashes. After repacking, those hashes are stale. electron-updater
// cannot auto-update on Linux regardless, so this does not regress any
// working flow. If we later care, set publishAutoUpdate:false for linux.
//
// Skip conditions (never fail the build):
//   - no AppImage in artifacts (mac/win CI, local dev)
//   - appimagetool not on PATH and APPIMAGETOOL env unset
//   - repack fails (warn + continue with original)

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resolveAppImageTool = () => {
  const fromEnv = process.env.APPIMAGETOOL;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const onPath = spawnSync('command', ['-v', 'appimagetool'], { encoding: 'utf8', shell: os.platform() === 'win32' });
  if (onPath.status === 0) {
    const found = String(onPath.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (found) return found;
  }
  return null;
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

// Minimal self-check: node scripts/embed-appimage-update-info.cjs
// Exercises the hook against a copy of appimagetool's own AppImage (a known-good
// type-2 AppImage). Skips with exit 0 if appimagetool not found. Fails loudly
// (exit 1) if the hook mis-orchestrates extract/repack/verify.
if (require.main === module) {
  const assert = require('node:assert');
  const { spawnSync } = require('node:child_process');

  const tool = process.env.APPIMAGETOOL || resolveAppImageTool();
  if (!tool) {
    console.log('[self-check] appimagetool not found; skipping (ok in non-Linux CI)');
    process.exit(0);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-hook-selfcheck-'));
  try {
    const subject = path.join(workDir, 'OpenChamber-0.0.0-linux-x64.AppImage');
    fs.copyFileSync(tool, subject);
    fs.chmodSync(subject, 0o755);

    const buildResult = {
      artifactPaths: [subject],
      packager: { config: { publish: { owner: 'selfcheck-owner', repo: 'selfcheck-repo' } }, appInfo: { productName: 'OpenChamber' } },
    };

    module.exports(buildResult).then((extra) => {
      assert.deepStrictEqual(extra, [`${subject}.zsync`], 'should return zsync path');

      const verify = spawnSync(subject, ['--appimage-updateinfo'], { encoding: 'utf8' });
      const embedded = String(verify.stdout || '').trim();
      assert.strictEqual(
        embedded,
        'gh-releases-zsync|selfcheck-owner|selfcheck-repo|latest|OpenChamber-*linux-x64.AppImage.zsync',
        'embedded .upd_info must match',
      );
      assert.ok(fs.existsSync(`${subject}.zsync`), 'zsync file must exist');
      console.log('[self-check] OK: .upd_info embedded, zsync returned');
      process.exit(0);
    }).catch((err) => {
      console.error('[self-check] FAILED:', err.message);
      process.exit(1);
    });
  } finally {
    // Best-effort cleanup; defer until process exits so spawned verifications finish.
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {} }, 1000);
  }
}
