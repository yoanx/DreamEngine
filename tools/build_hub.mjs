#!/usr/bin/env node
/* Build DreamEngine Hub with the same local mirror strategy used for Electron. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveSignArgs } from "./sign_config.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HUB = resolve(ROOT, "hub");
const BUILDER = resolve(HUB, "node_modules/electron-builder/cli.js");
const cacheRoot = resolve(
  process.env.DREAMENGINE_BUILD_CACHE ||
    join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local"), "DreamEngine", "build-cache"),
);
const electronVersion = JSON.parse(
  readFileSync(resolve(HUB, "node_modules/electron/package.json"), "utf8"),
).version;
const electronDist = resolve(cacheRoot, "electron-dist", electronVersion);

if (!existsSync(BUILDER)) {
  console.error("electron-builder is not installed. Run npm install in hub/ first.");
  process.exit(1);
}

mkdirSync(cacheRoot, { recursive: true });
const seed = spawnSync(process.execPath, [resolve(ROOT, "tools/seed_build_cache.mjs")], {
  cwd: ROOT,
  env: { ...process.env, DREAMENGINE_BUILD_CACHE: cacheRoot },
  stdio: "inherit",
});
if (seed.status !== 0) process.exit(seed.status || 1);

const prepare = spawnSync(process.execPath, [resolve(ROOT, "tools/prepare_hub_bundle.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
});
if (prepare.status !== 0) process.exit(prepare.status || 1);

const env = {
  ...process.env,
  DREAMENGINE_BUILD_CACHE: cacheRoot,
  ELECTRON_CACHE: resolve(cacheRoot, "electron"),
  electron_config_cache: resolve(cacheRoot, "electron"),
  ELECTRON_BUILDER_CACHE: resolve(cacheRoot, "electron-builder"),
  ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    "https://npmmirror.com/mirrors/electron-builder-binaries/",
};
mkdirSync(env.ELECTRON_CACHE, { recursive: true });
mkdirSync(env.ELECTRON_BUILDER_CACHE, { recursive: true });
const sign = resolveSignArgs(env);
console.log(`[build_hub] 签名：${sign.note}`);

const args = [
  BUILDER,
  ...process.argv.slice(2),
  ...sign.args,
  `--config.electronDist=${electronDist}`,
];
const build = spawnSync(process.execPath, args, {
  cwd: HUB,
  env,
  stdio: "inherit",
});
process.exit(build.status === null ? 1 : build.status);
