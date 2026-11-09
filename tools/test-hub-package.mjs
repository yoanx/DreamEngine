#!/usr/bin/env node
/* DreamEngine Hub 安装包契约测试。
 * 只验证可重复生成的构建配置与干净资源目录，不启动安装器。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HUB = resolve(ROOT, "hub");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const read = (path) => readFileSync(path, "utf8");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("[PASS] " + name);
  } catch (error) {
    failed++;
    console.log("[FAIL] " + name);
    console.log("       " + String(error.message || error).split("\n").slice(0, 8).join("\n       "));
  }
}

const pkg = readJson(resolve(HUB, "package.json"));

test("Hub package 暴露资源准备、目录打包和 NSIS 安装器命令", () => {
  assert.equal(pkg.scripts["build:resources"], "node ../tools/prepare_hub_bundle.mjs");
  assert.equal(pkg.scripts.pack, "node ../tools/build_hub.mjs --dir");
  assert.equal(pkg.scripts.dist, "node ../tools/build_hub.mjs --win nsis");
  const builder = read(resolve(ROOT, "tools/build_hub.mjs"));
  assert.match(builder, /ELECTRON_BUILDER_BINARIES_MIRROR/);
  assert.match(builder, /npmmirror\.com/);
  assert.match(builder, /DreamEngine.*build-cache|build-cache.*DreamEngine/);
  assert.match(builder, /electronDist/);
  assert.match(builder, /ELECTRON_BUILDER_CACHE/);
  assert.match(builder, /electron_config_cache/);
  assert.ok(existsSync(resolve(ROOT, "tools/prepare_hub_bundle.mjs")));
  assert.ok(existsSync(resolve(ROOT, "tools/sign_config.mjs")));
  assert.ok(existsSync(resolve(ROOT, "tools/seed_build_cache.mjs")));
});

test("Hub package 固定 electron-builder 并声明应用身份", () => {
  assert.match(pkg.devDependencies["electron-builder"], /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.build.appId, "com.dreamengine.hub");
  assert.equal(pkg.build.productName, "DreamEngine Hub");
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.include, "build/installer.nsh");
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, true);
});

test("Hub 的 PowerShell 脚本带 UTF-8 BOM，兼容 Windows PowerShell 5", () => {
  for (const name of [
    "ae_watchdog.ps1",
    "ae_crash_guard.ps1",
    "manual_probe.ps1",
    "dump_plugin_effect_params.ps1",
    "generate_plugin_presets.ps1",
    "generate_plugin_effects.ps1",
    "install_dreamengine.ps1",
    "uninstall_dreamengine.ps1",
  ]) {
    const bytes = readFileSync(resolve(ROOT, "tools", name));
    assert.deepEqual(
      [...bytes.subarray(0, 3)],
      [0xEF, 0xBB, 0xBF],
      `${name} 缺少 UTF-8 BOM，Windows PowerShell 5 会按 ANSI 错误解析中文`,
    );
  }
});

test("Hub 窗口、程序和安装器统一使用品牌图标", () => {
  assert.equal(pkg.build.win.icon, "assets/icon.ico");
  assert.equal(pkg.build.nsis.installerIcon, "assets/icon.ico");
  assert.equal(pkg.build.nsis.uninstallerIcon, "assets/icon.ico");
  assert.equal(pkg.build.nsis.installerHeaderIcon, "assets/icon.ico");
  assert.ok(existsSync(resolve(HUB, "assets/icon.ico")));
  assert.ok(existsSync(resolve(HUB, "assets/icon.png")));
  assert.match(read(resolve(HUB, "main.js")), /icon:\s*path\.join\(__dirname,\s*"assets",\s*"icon\.ico"\)/);
  assert.match(read(resolve(HUB, "renderer/index.html")), /brand-mark\.png/);
});

test("安装器资源包含面板、字体、L1、离线渲染工具和安装脚本", () => {
  const resources = pkg.build.extraResources.map((item) => item.to);
  assert.ok(resources.includes("panel"));
  assert.ok(resources.includes("tools"));
  assert.ok(resources.includes("installer"));

  execFileSync(process.execPath, [resolve(ROOT, "tools/prepare_hub_bundle.mjs")], {
    cwd: ROOT,
    stdio: "pipe",
  });

  const release = resolve(HUB, "build/release");
  assert.ok(existsSync(resolve(release, "panel/extension/index.html")));
  assert.ok(existsSync(resolve(HUB, "assets/fonts/NotoSansSC-VF.ttf")));
  assert.ok(existsSync(resolve(release, "panel/extension/css/fonts/NotoSansSC-VF.ttf")));
  assert.ok(existsSync(resolve(release, "panel/extension/css/fonts/OFL.txt")));
  assert.ok(existsSync(resolve(release, "panel/extension/js/about.js")));
  assert.ok(existsSync(resolve(release, "panel/extension/js/sidebar_resize.js")));
  assert.ok(existsSync(resolve(release, "panel/extension/engine/previewgen.jsx")));
  assert.ok(existsSync(resolve(HUB, "renderer/about.js")));
  assert.ok(existsSync(resolve(release, "panel/extension/data/names.json")));
  assert.ok(existsSync(resolve(release, "panel/l1/manifest.json")));
  assert.ok(existsSync(resolve(release, "tools/ae_watchdog.ps1")));
  assert.ok(existsSync(resolve(release, "tools/ae_crash_guard.ps1")));
  assert.ok(existsSync(resolve(release, "tools/manual_probe.ps1")));
  assert.ok(existsSync(resolve(release, "tools/manual_probe.jsx")));
  assert.ok(existsSync(resolve(release, "tools/dump_plugin_effect_params.ps1")));
  assert.ok(existsSync(resolve(release, "tools/generate_plugin_presets.ps1")));
  assert.ok(existsSync(resolve(release, "tools/DreamEnginePNG.aep")));
  assert.ok(existsSync(resolve(release, "tools/run_plugin_preset_preview.jsx")));
  assert.ok(existsSync(resolve(release, "tools/run_plugin_preset_loader.jsx")));
  assert.ok(existsSync(resolve(release, "tools/generate_plugin_effects.ps1")));
  assert.ok(existsSync(resolve(release, "tools/run_plugin_preview.jsx")));
  assert.ok(existsSync(resolve(release, "tools/run_plugin_preview_loader.jsx")));
  assert.ok(existsSync(resolve(release, "installer/install_dreamengine.ps1")));
  assert.ok(existsSync(resolve(release, "installer/uninstall_dreamengine.ps1")));
});

test("干净资源不夹带开发机的运行时预览和索引", () => {
  const data = resolve(HUB, "build/release/panel/extension/data");
  assert.equal(existsSync(resolve(data, "thumbs")), false);
  assert.equal(existsSync(resolve(data, "manifest.json")), false);
  assert.equal(existsSync(resolve(data, "plugin_manifest.json")), false);
  assert.equal(existsSync(resolve(data, "preset_manifest.json")), false);
  assert.equal(existsSync(resolve(data, "preset_plugin_manifest.json")), false);
});

test("NSIS 安装和卸载复用脚本，卸载清理范围覆盖 CEP 本地存储", () => {
  const nsis = read(resolve(HUB, "build/installer.nsh"));
  const installer = read(resolve(ROOT, "tools/install_dreamengine.ps1"));
  const uninstaller = read(resolve(ROOT, "tools/uninstall_dreamengine.ps1"));
  assert.match(nsis, /!macro customInstall/);
  assert.match(nsis, /install_dreamengine\.ps1/);
  assert.match(nsis, /-Source/);
  assert.match(nsis, /-Quiet/);
  assert.match(nsis, /powershell\.exe/);
  assert.match(nsis, /!macro customUnInstall/);
  assert.match(nsis, /uninstall_dreamengine\.ps1/);
  assert.match(nsis, /\$\{isUpdated\}/);
  assert.match(installer, /install-state\.json/);
  assert.match(installer, /PlayerDebugMode/);
  assert.match(uninstaller, /cep_cache/);
  assert.match(uninstaller, /com\.dreamengine\.panel\.main/);
  assert.match(uninstaller, /DreamEngineProbe/);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exitCode = 1;
