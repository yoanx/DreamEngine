const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createPaths } = require("../core/paths");
const uiPrefs = require("../core/ui_prefs");

test("ui_prefs：缺文件回退中文，非法语言不落盘", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-ui-prefs-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });

  assert.equal(uiPrefs.read(paths).panelLang, "zh");

  const saved = uiPrefs.setPanelLang(paths, "en");
  assert.equal(saved.ok, true);
  assert.equal(uiPrefs.read(paths).panelLang, "en");

  const rejected = uiPrefs.setPanelLang(paths, "fr");
  assert.equal(rejected.ok, false);
  assert.equal(uiPrefs.read(paths).panelLang, "en");

  const doc = JSON.parse(fs.readFileSync(paths.uiPrefs, "utf8"));
  assert.equal(doc.panelLang, "en");
});

test("ui_prefs 与面板读的是同一个文件", () => {
  const paths = createPaths({ docsDir: "C:/docs", appData: "C:/appdata" });
  assert.ok(paths.uiPrefs.replace(/\\/g, "/").endsWith("/DreamEngine/ui_prefs.json"));

  const lib = fs.readFileSync(
    path.join(__dirname, "..", "..", "cep", "com.dreamengine.panel", "js", "library.js"),
    "utf8",
  );
  assert.match(lib, /"\/DreamEngine\/ui_prefs\.json"/);
  assert.match(lib, /panelLang/);
});
