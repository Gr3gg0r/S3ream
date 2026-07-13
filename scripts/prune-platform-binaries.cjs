// electron-builder afterPack hook: keep only the FFmpeg/FFprobe binaries for the
// platform+arch being packaged. The @ffmpeg-installer/@ffprobe-installer platform
// packages carry no os/cpu constraints, so pnpm installs every variant and all of
// them would otherwise land in the bundle (more than 2x bloat).
const fs = require("node:fs");
const path = require("node:path");

const ARCH_BY_ID = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
const PLATFORM_PREFIXES = ["darwin-", "win32-", "linux-"];
const SCOPES = ["@ffmpeg-installer", "@ffprobe-installer"];

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function prunePlatformBinaries(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH_BY_ID[context.arch] ?? "x64";
  const keep = new Set(
    arch === "universal" ? [`${platform}-arm64`, `${platform}-x64`] : [`${platform}-${arch}`],
  );

  const resources = [
    path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
    ),
    path.join(context.appOutDir, "resources"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!resources) {
    return;
  }

  for (const scope of SCOPES) {
    const scopeDir = path.join(resources, "app.asar.unpacked", "node_modules", scope);
    if (!fs.existsSync(scopeDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(scopeDir)) {
      const isPlatformPackage = PLATFORM_PREFIXES.some((prefix) => entry.startsWith(prefix));
      if (isPlatformPackage && !keep.has(entry)) {
        fs.rmSync(path.join(scopeDir, entry), { recursive: true, force: true });
      }
    }
  }
};
