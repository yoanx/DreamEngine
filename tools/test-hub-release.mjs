#!/usr/bin/env node
/* Read-only validation for the generated DreamEngine Hub NSIS installer. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = resolve(ROOT, "hub/dist");
const CACHE = resolve(process.env.LOCALAPPDATA || "", "DreamEngine", "build-cache");
const HUB_PACKAGE = JSON.parse(readFileSync(resolve(ROOT, "hub/package.json"), "utf8"));
const INSTALLER = resolve(DIST, `DreamEngine-Hub-Setup-${HUB_PACKAGE.version}.exe`);
const BLOCKMAP = `${INSTALLER}.blockmap`;

function find7za(dir) {
  if (!existsSync(dir)) return "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = find7za(full);
      if (found) return found;
    } else if (entry.name.toLowerCase() === "7za.exe") {
      return full;
    }
  }
  return "";
}

assert.ok(existsSync(INSTALLER), `Missing installer: ${INSTALLER}`);
assert.ok(existsSync(BLOCKMAP), `Missing blockmap: ${BLOCKMAP}`);
assert.ok(statSync(INSTALLER).size > 100 * 1024 * 1024, "Installer is unexpectedly small");

const seven = find7za(CACHE);
assert.ok(seven, `7za.exe not found under persistent cache: ${CACHE}`);
execFileSync(seven, ["t", INSTALLER], { stdio: "pipe" });
const listing = execFileSync(seven, ["l", INSTALLER], { encoding: "utf8" });
for (const required of [
  "resources\\panel\\extension\\index.html",
  "resources\\panel\\extension\\css\\fonts\\NotoSansSC-VF.ttf",
  "resources\\panel\\extension\\css\\fonts\\OFL.txt",
  "resources\\panel\\extension\\svg\\apply.svg",
  "resources\\panel\\extension\\svg\\mode-multi.svg",
  "resources\\panel\\extension\\svg\\magnet.svg",
  "resources\\panel\\l1\\manifest.json",
  "resources\\tools\\generate_plugin_presets.ps1",
  "resources\\tools\\ae_watchdog.ps1",
  "resources\\tools\\ae_crash_guard.ps1",
  "resources\\tools\\manual_probe.ps1",
  "resources\\tools\\manual_probe.jsx",
  "resources\\tools\\dump_plugin_effect_params.ps1",
  "resources\\tools\\DreamEnginePNG.aep",
  "resources\\tools\\run_plugin_preset_loader.jsx",
  "resources\\tools\\run_plugin_preset_preview.jsx",
  "resources\\tools\\generate_plugin_effects.ps1",
  "resources\\tools\\run_plugin_preview.jsx",
  "resources\\tools\\run_plugin_preview_loader.jsx",
  "resources\\installer\\install_dreamengine.ps1",
  "resources\\installer\\uninstall_dreamengine.ps1",
  "DreamEngine Hub.exe",
]) {
  assert.ok(listing.includes(required), `Installer is missing ${required}`);
}

const hash = createHash("sha256").update(readFileSync(INSTALLER)).digest("hex").toUpperCase();
const report = {
  installer: INSTALLER,
  bytes: statSync(INSTALLER).size,
  sha256: hash,
  version: HUB_PACKAGE.version,
};
writeFileSync(resolve(DIST, `DreamEngine-Hub-Setup-${HUB_PACKAGE.version}.report.json`), JSON.stringify(report, null, 2) + "\n");
console.log(`[PASS] Hub installer validated: ${INSTALLER}`);
console.log(`       ${(report.bytes / 1024 / 1024).toFixed(2)} MB  SHA256 ${hash}`);
