#!/usr/bin/env node
/* Prepare clean resources consumed by electron-builder.
 * Runtime previews and indexes must never enter the installer.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const HUB = resolve(ROOT, "hub");
const RELEASE = resolve(HUB, "build/release");
const PANEL_SRC = resolve(ROOT, "cep/com.dreamengine.panel");
const L1_SRC = resolve(ROOT, "dist/L1");
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
rmSync(RELEASE, { recursive: true, force: true });
mkdirSync(resolve(RELEASE, "panel/extension/data"), { recursive: true });
mkdirSync(resolve(RELEASE, "panel/l1"), { recursive: true });
mkdirSync(resolve(RELEASE, "tools"), { recursive: true });
mkdirSync(resolve(RELEASE, "installer"), { recursive: true });

for (const name of ["CSXS", "css", "engine", "js", "svg"]) {
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
copyRequired(resolve(L1_SRC, "names.json"), resolve(RELEASE, "panel/l1/names.json"));
copyRequired(resolve(L1_SRC, "previews.tsv"), resolve(RELEASE, "panel/l1/previews.tsv"));
copyRequired(resolve(L1_SRC, "thumbs"), resolve(RELEASE, "panel/l1/thumbs"));
for (const name of ["animated.json", "build-report.json"]) {
  const source = resolve(L1_SRC, name);
  if (existsSync(source)) {
    cpSync(source, resolve(RELEASE, "panel/l1", name));
  }
}

for (const name of [
  "ae_watchdog.ps1",
  "ae_crash_guard.ps1",
  "manual_probe.ps1",
  "manual_probe.jsx",
  "dump_plugin_effect_params.ps1",
  "generate_plugin_presets.ps1",
  "DreamEnginePNG.aep",
  "run_plugin_preset_loader.jsx",
  "run_plugin_preset_preview.jsx",
  "generate_plugin_effects.ps1",
  "run_plugin_preview.jsx",
  "run_plugin_preview_loader.jsx",
]) {
  copyRequired(resolve(TOOLS_SRC, name), resolve(RELEASE, "tools", name));
}
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

console.log(`Hub resources prepared: ${RELEASE}`);
console.log(`  panel ${report.panelVersion}, hub ${basename(HUB)} ${report.hubVersion}`);
