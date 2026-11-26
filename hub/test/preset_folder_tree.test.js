const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const presetSources = require("../core/preset_sources");
const { createPaths } = require("../core/paths");

test("AE 用户预设保留相对文件夹路径，供侧栏分层", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-preset-folders-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const support = path.join(root, "Adobe After Effects 2023", "Support Files");
  fs.mkdirSync(path.join(support, "Presets", "Backgrounds"), { recursive: true });
  fs.writeFileSync(path.join(support, "AfterFX.exe"), "");
  fs.writeFileSync(path.join(support, "Presets", "Backgrounds", "foo.ffx"), "x");
  const userRoot = path.join(paths.docsDir, "Adobe", "After Effects 2023", "User Presets");
  fs.mkdirSync(path.join(userRoot, "※预设", "shake"), { recursive: true });
  fs.writeFileSync(path.join(userRoot, "※预设", "shake", "igshake.ffx"), "x");

  const doc = presetSources.scanAePresets(paths, {
    aeExe: path.join(support, "AfterFX.exe"),
    force: true,
  });
  assert.equal(doc.ok, true);

  const user = doc.items.find((item) => item.name === "igshake");
  assert.ok(user, "应识别用户预设");
  assert.equal(user.sourceKind, "user");
  assert.equal(user.source, "用户预设");
  assert.equal(user.folderPath, "※预设/shake");

  const install = doc.items.find((item) => item.name === "foo");
  assert.equal(install.folderPath, "Backgrounds");
});

test("Hub 侧栏把用户预设按文件夹层级展示", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.match(app, /function presetFolderPath/);
  assert.match(app, /function isUserPreset/);
  assert.match(app, /ae:用户预设:/);
  assert.match(app, /presetFolderCollapsed/);
  assert.match(app, /category-toggle/);
});
