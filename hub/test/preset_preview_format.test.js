const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { createPaths } = require("../core/paths");
const previewPaths = require("../core/preview_paths");
const { convertPresetPreviews } = require("../core/preset_preview_format");

test("用户渲染的预设 PNG 帧可转换为 WebP 帧序列", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-preset-webp-"));
  const paths = createPaths({ docsDir: path.join(root, "docs"), appData: path.join(root, "appdata") });
  const folder = path.join(previewPaths.currentRoot(paths), "presets", "test");
  fs.mkdirSync(folder, { recursive: true });
  for (let i = 0; i < 2; i++) {
    await sharp({ create: { width: 10, height: 10, channels: 3, background: i ? "#00ff00" : "#ff0000" } })
      .png()
      .toFile(path.join(folder, `preset_000_${String(i).padStart(4, "0")}.png`));
  }
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.presetPluginManifest, JSON.stringify({
    version: 1,
    items: [{
      name: "Test",
      path: "C:/Presets/Test.ffx",
      sheet: 0,
      folder: "test",
      frames: 2,
      stillFrame: 1,
      src: "previews/presets/test/preset_000_0000.png",
      frameSrc: "previews/presets/test/preset_000_%04d.png",
      stillSrc: "previews/presets/test/preset_000_0001.png",
    }],
  }, null, 1));
  const result = await convertPresetPreviews(paths, { quality: 80 });
  assert.equal(result.converted, 1);
  const item = JSON.parse(fs.readFileSync(paths.presetPluginManifest, "utf8")).items[0];
  assert.equal(item.frameSrc, "previews/presets/test/preset_000_%04d.webp");
  assert.equal(item.format, "webp-sequence");
  assert.ok(fs.existsSync(path.join(folder, "preset_000_0000.webp")));
  assert.ok(fs.existsSync(path.join(folder, "preset_000_0001.webp")));
  assert.equal(fs.existsSync(path.join(folder, "preset_000_0000.png")), false);
});
