#!/usr/bin/env node
/* Prepare clean resources consumed by electron-builder.
 * Runtime previews and indexes must never enter the installer.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const HUB = resolve(ROOT, "hub");
const RELEASE = resolve(HUB, "build/release");
const BUILD_DIR = resolve(HUB, "build");
const PANEL_SRC = resolve(ROOT, "cep/com.dreamengine.panel");
const L1_SRC = resolve(ROOT, "dist/L1");
const PRESET_SRC = resolve(ROOT, "dist/presets");
const PREVIEW_SRC = resolve(ROOT, "dist/previews");
const TOOLS_SRC = resolve(ROOT, "tools");

function assertInside(base, target) {
  const root = base.endsWith(sep) ? base : base + sep;
  if (target !== base && !target.startsWith(root)) {
    throw new Error(`Refusing to write outside generated build directory: ${target}`);
  }
}

function copyRequired(from, to) {
  if (!existsSync(from)) throw new Error(`Required build input is missing: ${from}`);
  cpSync(from, to, { recursive: true });
}

assertInside(HUB, RELEASE);
/* 不直接 rm -rf 暂存目录：部分环境（本机装了实时扫描/回收站钩子）会拦截
   大批量删除，构建直接失败。改名让位即可，旧目录留给下次清理。 */
if (existsSync(RELEASE)) {
  renameSync(RELEASE, resolve(BUILD_DIR, `release.stale-${Date.now()}`));
}
mkdirSync(resolve(RELEASE, "panel/extension/data"), { recursive: true });
mkdirSync(resolve(RELEASE, "panel/l1"), { recursive: true });
mkdirSync(resolve(RELEASE, "panel/presets"), { recursive: true });
mkdirSync(resolve(RELEASE, "panel/previews"), { recursive: true });
mkdirSync(resolve(RELEASE, "tools"), { recursive: true });
mkdirSync(resolve(RELEASE, "installer"), { recursive: true });

for (const name of ["assets", "CSXS", "css", "engine", "js", "svg"]) {
  copyRequired(resolve(PANEL_SRC, name), resolve(RELEASE, "panel/extension", name));
}
copyRequired(resolve(PANEL_SRC, "index.html"), resolve(RELEASE, "panel/extension/index.html"));

for (const name of ["names.json", "names.tsv", "l1-targets.tsv"]) {
  const source = resolve(PANEL_SRC, "data", name);
  if (existsSync(source)) {
    cpSync(source, resolve(RELEASE, "panel/extension/data", name), { recursive: true });
  }
}

// 防回归：index.html / css 里引用的本地资源必须真的进了 bundle。
// 之前漏拷 svg/，装到别的机器上曲线页工具栏图标全是空白（开发机用 Junction 看不出来）。
const referenced = new Set();
for (const file of ["index.html", ...readdirSync(resolve(PANEL_SRC, "css")).filter((n) => n.endsWith(".css")).map((n) => `css/${n}`)]) {
  const text = readFileSync(resolve(PANEL_SRC, file), "utf8");
  for (const match of text.matchAll(/(?:src|href)="([^"#?:]+)"|url\(([^)'"]+)\)/g)) {
    const ref = String(match[1] || match[2] || "").trim();
    if (!ref || ref.startsWith("http") || ref.startsWith("data:") || ref.startsWith("/")) continue;
    referenced.add(ref.replace(/^\.\//, ""));
  }
}
const missing = [...referenced].filter((ref) => !existsSync(resolve(RELEASE, "panel/extension", ref)));
assert.equal(missing.length, 0, `bundle 缺少被引用的资源: ${missing.join(", ")}`);

copyRequired(resolve(L1_SRC, "manifest.json"), resolve(RELEASE, "panel/l1/manifest.json"));
copyRequired(resolve(PRESET_SRC, "manifest.json"), resolve(RELEASE, "panel/presets/manifest.json"));
if (existsSync(resolve(PRESET_SRC, "build-report.json"))) {
  cpSync(resolve(PRESET_SRC, "build-report.json"), resolve(RELEASE, "panel/presets/build-report.json"));
}
copyRequired(PREVIEW_SRC, resolve(RELEASE, "panel/previews"));
copyRequired(resolve(L1_SRC, "names.json"), resolve(RELEASE, "panel/l1/names.json"));
copyRequired(resolve(L1_SRC, "previews.tsv"), resolve(RELEASE, "panel/l1/previews.tsv"));
const l1Previews = resolve(L1_SRC, "previews");
if (existsSync(l1Previews)) {
  cpSync(l1Previews, resolve(RELEASE, "panel/l1/previews"), { recursive: true });
}
const l1Thumbs = resolve(L1_SRC, "thumbs");
if (existsSync(l1Thumbs)) {
  cpSync(l1Thumbs, resolve(RELEASE, "panel/l1/thumbs"), { recursive: true });
}
for (const name of ["animated.json"]) {
  const source = resolve(L1_SRC, name);
  if (existsSync(source)) {
    cpSync(source, resolve(RELEASE, "panel/l1", name));
  }
}

for (const name of [
  "ae_watchdog.ps1",
  "ae_crash_guard.ps1",
  "ae_render_template.ps1",
  "manual_probe.ps1",
  "manual_probe.jsx",
  "dump_plugin_effect_params.ps1",
  "generate_plugin_presets.ps1",
  "DreamEnginePNG.aep",
  "build_png_template.jsx",
  "run_template_builder_loader.jsx",
  "run_plugin_preset_loader.jsx",
  "run_plugin_preset_preview.jsx",
  "generate_plugin_effects.ps1",
  "run_plugin_preview.jsx",
  "run_plugin_preview_loader.jsx",
]) {
  copyRequired(resolve(TOOLS_SRC, name), resolve(RELEASE, "tools", name));
}
copyRequired(resolve(TOOLS_SRC, "templates"), resolve(RELEASE, "tools/templates"));
copyRequired(resolve(ROOT, "hub/installer/migrate_previews.ps1"), resolve(RELEASE, "tools/migrate_previews.ps1"));
copyRequired(resolve(ROOT, "hub/installer/migrate_previews.ps1"), resolve(RELEASE, "installer/migrate_previews.ps1"));
copyRequired(
  resolve(TOOLS_SRC, "install_dreamengine.ps1"),
  resolve(RELEASE, "installer/install_dreamengine.ps1"),
);
copyRequired(
  resolve(TOOLS_SRC, "uninstall_dreamengine.ps1"),
  resolve(RELEASE, "installer/uninstall_dreamengine.ps1"),
);

const panelVersionMatch = readFileSync(
  resolve(PANEL_SRC, "CSXS/manifest.xml"),
  "utf8",
).match(/ExtensionBundleVersion="([^"]+)"/);
const hubPackage = JSON.parse(readFileSync(resolve(HUB, "package.json"), "utf8"));
const report = {
  hubVersion: hubPackage.version,
  panelVersion: panelVersionMatch ? panelVersionMatch[1] : "",
  generatedAt: new Date().toISOString(),
};
writeFileSync(resolve(RELEASE, "build-report.json"), JSON.stringify(report, null, 2) + "\n");

/* 清理历次让位留下的旧暂存目录（含上次构建中断的残留）。删不掉就留下，
   下次再试——大批量删除被实时扫描/回收站钩子拦截时不能让构建失败。 */
for (const name of readdirSync(BUILD_DIR)) {
  if (!name.startsWith("release.stale-")) continue;
  try {
    rmSync(resolve(BUILD_DIR, name), { recursive: true, force: true });
  } catch (err) {
    console.warn(`  kept stale build dir ${name}: ${err.code || err.message}`);
  }
}

console.log(`Hub resources prepared: ${RELEASE}`);
console.log(`  panel ${report.panelVersion}, hub ${basename(HUB)} ${report.hubVersion}`);
