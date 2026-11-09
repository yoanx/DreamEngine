#!/usr/bin/env node
/* Seed a persistent Electron runtime used by electron-builder.
 *
 * Cache root defaults to %LOCALAPPDATA%\DreamEngine\build-cache on Windows.
 * The unpacked runtime is reused on every build, so packaging does not download
 * or extract the same Electron zip each time.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, "..");
const HUB = resolve(ROOT, "hub");
const packageInfo = JSON.parse(
  readFileSync(resolve(HUB, "node_modules/electron/package.json"), "utf8"),
);
const version = packageInfo.version;
const cacheRoot = resolve(
  process.env.DREAMENGINE_BUILD_CACHE ||
    join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local"), "DreamEngine", "build-cache"),
);
const runtimeRoot = resolve(cacheRoot, "electron-dist");
const runtimeDir = resolve(runtimeRoot, version);
const versionFile = resolve(runtimeDir, "version");

function assertInside(base, target) {
  const root = base.endsWith(sep) ? base : base + sep;
  if (target !== base && !target.startsWith(root)) {
    throw new Error(`Refusing to write outside build cache: ${target}`);
  }
}

function versionMatches(dir) {
  try {
    return readFileSync(resolve(dir, "version"), "utf8").trim().replace(/^v/, "") === version;
  } catch {
    return false;
  }
}

function findCachedZip() {
  const cache = join(process.env.LOCALAPPDATA || "", "electron", "Cache");
  if (!existsSync(cache)) return "";
  const fileName = `electron-v${version}-win32-x64.zip`;
  for (const entry of readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(cache, entry.name, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

assertInside(cacheRoot, runtimeRoot);
assertInside(cacheRoot, runtimeDir);
mkdirSync(cacheRoot, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });

if (versionMatches(runtimeDir)) {
  console.log(`Electron ${version} cache: ${runtimeDir}`);
  process.exit(0);
}

rmSync(runtimeDir, { recursive: true, force: true });

const installedDist = resolve(HUB, "node_modules/electron/dist");
if (versionMatches(installedDist)) {
  cpSync(installedDist, runtimeDir, { recursive: true });
} else {
  const zip = findCachedZip();
  if (!zip) {
    console.error(
      `No cached Electron ${version} zip found under %LOCALAPPDATA%\\electron\\Cache.\n` +
        "Run npm install in hub/ once, then rerun the build.",
    );
    process.exit(1);
  }
  const tempDir = resolve(runtimeRoot, `.tmp-${version}-${process.pid}`);
  assertInside(runtimeRoot, tempDir);
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  const { extract } = require(join(HUB, "node_modules/@electron-internal/extract-zip"));
  await extract(zip, { dir: tempDir });
  renameSync(tempDir, runtimeDir);
}

if (!versionMatches(runtimeDir)) {
  throw new Error(`Seeded Electron version mismatch at ${runtimeDir}`);
}
console.log(`Electron ${version} cache seeded: ${runtimeDir}`);
