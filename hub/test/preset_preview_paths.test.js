const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const presets = require("../core/presets");
const { createPaths } = require("../core/paths");
const previewPaths = require("../core/preview_paths");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1), "utf8");
}

test("presets.list 读取自定义预览根目录中的预设帧", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-preset-root-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const preset = path.join(paths.presets, "One.ffx");
  fs.mkdirSync(path.dirname(preset), { recursive: true });
  fs.writeFileSync(preset, "preset", "utf8");

  const customRoot = path.join(root, "chosen");
  previewPaths.writeSettings(paths, customRoot);
  writeJson(paths.presetPluginManifest, {
    version: 1,
    items: [{
      name: "One",
      path: preset,
      frames: 2,
      fps: 24,
      duration: 0.08,
      src: "previews/presets/one_0000.png",
      frameSrc: "previews/presets/one_%04d.png",
      stillSrc: "previews/presets/one_0001.png",
      sliceCellSize: 360,
      plugin: true,
    }],
  });
  const frame0 = path.join(customRoot, "presets", "one_0000.png");
  const frame1 = path.join(customRoot, "presets", "one_0001.png");
  fs.mkdirSync(path.dirname(frame0), { recursive: true });
  fs.writeFileSync(frame0, "0", "utf8");
  fs.writeFileSync(frame1, "1", "utf8");

  const item = presets.list(paths).items.find((entry) => entry.path === preset);
  assert.equal(item.thumb, frame1);
  assert.equal(item.framePattern, path.join(customRoot, "presets", "one_%04d.png"));
  assert.equal(item.cellSize, 360);
});
