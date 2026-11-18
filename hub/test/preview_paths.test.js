const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createPaths } = require("../core/paths");
const previewPaths = require("../core/preview_paths");
const install = require("../core/install");

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-preview-paths-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  fs.mkdirSync(path.join(paths.dataDir, "thumbs"), { recursive: true });
  return { root, paths };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text == null ? "x" : text, "utf8");
}

function writeJson(file, value) {
  write(file, JSON.stringify(value, null, 1));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("预览路径：默认根、旧 thumbs 路径和越界路径按约定解析", () => {
  const { paths } = workspace();
  assert.equal(
    previewPaths.resolveFile(paths, "previews/effects/a.png"),
    path.join(paths.dataDir, "previews", "effects", "a.png"),
  );
  assert.equal(
    previewPaths.resolveFile(paths, "thumbs/batch_001.png"),
    path.join(paths.dataDir, "thumbs", "batch_001.png"),
  );
  assert.equal(previewPaths.resolveFile(paths, "../escape.png"), "");
});

test("切换预览根目录会迁移效果与预设文件并更新索引", () => {
  const { root, paths } = workspace();
  const target = path.join(root, "chosen-previews");
  const effectFrame0 = path.join(paths.dataDir, "thumbs", "batch_001_0000.png");
  const effectFrame1 = path.join(paths.dataDir, "thumbs", "batch_001_0001.png");
  const effectSheet = path.join(paths.dataDir, "thumbs", "batch_001.png");
  const presetFrame = path.join(paths.dataDir, "thumbs", "preset_001_0000.png");
  const presetPluginFrame = path.join(paths.dataDir, "thumbs", "preset_002_0000.png");
  const builtinFrame = path.join(paths.dataDir, "thumbs", "builtin_0000.png");
  for (const file of [effectFrame0, effectFrame1, effectSheet, presetFrame, presetPluginFrame, builtinFrame]) {
    write(file, path.basename(file));
  }

  writeJson(path.join(paths.dataDir, "plugin_manifest.json"), {
    version: 1,
    items: [{
      matchName: "Effect.One",
      src: "thumbs/batch_001.png",
      frameSrc: "thumbs/batch_001_%04d.png",
      frames: 2,
    }],
    sheets: [{ index: 1, src: "thumbs/batch_001.png" }],
  });
  writeJson(path.join(paths.dataDir, "preset_manifest.json"), {
    version: 1,
    items: [{
      name: "Preset One",
      path: "C:/presets/one.ffx",
      src: "thumbs/preset_001_0000.png",
      frameSrc: "thumbs/preset_001_%04d.png",
      frames: 1,
    }],
  });
  writeJson(path.join(paths.dataDir, "preset_plugin_manifest.json"), {
    version: 1,
    items: [{
      name: "Preset Two",
      path: "C:/presets/two.ffx",
      src: "thumbs/preset_002_0000.png",
      frameSrc: "thumbs/preset_002_%04d.png",
      frames: 1,
    }],
  });
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    items: [{
      matchName: "Builtin.One",
      src: "thumbs/builtin_0000.png",
      frameSrc: "thumbs/builtin_%04d.png",
      frames: 1,
    }],
    sheets: [{ index: 0, src: "thumbs/builtin_0000.png" }],
  });
  write(
    path.join(paths.dataDir, "previews.tsv"),
    "matchName\tsheet\tcell\tframes\tframeTemplate\tkey\n" +
      "Builtin.One\t0\t0\t1\tthumbs/builtin_%04d.png\tkey\n",
  );  write(
    path.join(paths.dataDir, "plugin_previews.tsv"),
    "matchName\tsheet\tcell\tframes\tframeTemplate\tkey\n" +
      "Effect.One\t1\t0\t2\tthumbs/batch_001_%04d.png\tkey\n",
  );

  const result = previewPaths.migratePreviewRoot(paths, target);
  assert.equal(result.ok, true);

  assert.ok(fs.existsSync(path.join(target, "effects", "batch_001_0000.png")));
  assert.ok(fs.existsSync(path.join(target, "effects", "batch_001_0001.png")));
  assert.ok(fs.existsSync(path.join(target, "presets", "preset-one", "preset_001_0000.png")));
  assert.ok(fs.existsSync(path.join(target, "presets", "preset-two", "preset_002_0000.png")));
  assert.ok(fs.existsSync(path.join(target, "effects", "builtin_0000.png")));
  assert.equal(fs.existsSync(builtinFrame), false);

  const plugin = readJson(path.join(paths.dataDir, "plugin_manifest.json"));
  assert.equal(plugin.items[0].src, "previews/effects/batch_001.png");
  assert.equal(plugin.items[0].frameSrc, "previews/effects/batch_001_%04d.png");
  assert.equal(plugin.sheets[0].src, "previews/effects/batch_001.png");

  const preset = readJson(path.join(paths.dataDir, "preset_manifest.json"));
  assert.equal(preset.items[0].src, "previews/presets/preset-one/preset_001_0000.png");
  assert.equal(preset.items[0].frameSrc, "previews/presets/preset-one/preset_001_%04d.png");

  const presetPlugin = readJson(path.join(paths.dataDir, "preset_plugin_manifest.json"));
  assert.equal(presetPlugin.items[0].src, "previews/presets/preset-two/preset_002_0000.png");
  assert.equal(presetPlugin.items[0].frameSrc, "previews/presets/preset-two/preset_002_%04d.png");

  const builtin = readJson(path.join(paths.dataDir, "manifest.json"));
  assert.equal(builtin.items[0].src, "previews/effects/builtin_0000.png");
  assert.equal(builtin.items[0].frameSrc, "previews/effects/builtin_%04d.png");
  assert.equal(builtin.sheets[0].src, "previews/effects/builtin_0000.png");

  const tsv = fs.readFileSync(path.join(paths.dataDir, "plugin_previews.tsv"), "utf8");
  assert.match(tsv, /previews\/effects\/batch_001_%04d\.png/);
  const builtinTsv = fs.readFileSync(path.join(paths.dataDir, "previews.tsv"), "utf8");
  assert.match(builtinTsv, /previews\/effects\/builtin_%04d\.png/);

  const settings = readJson(paths.previewSettings);
  assert.equal(settings.root, target);
  assert.equal(readJson(path.join(paths.dataDir, "preview_settings.json")).root, target);
  const secondTarget = path.join(root, "chosen-previews-2");
  const second = previewPaths.migratePreviewRoot(paths, secondTarget);
  assert.equal(second.ok, true);
  assert.ok(fs.existsSync(path.join(secondTarget, "effects", "batch_001_0000.png")));
  assert.ok(fs.existsSync(path.join(secondTarget, "presets", "preset-one", "preset_001_0000.png")));
  assert.equal(fs.existsSync(path.join(target, "effects", "batch_001_0000.png")), false);
  assert.equal(
    readJson(path.join(paths.dataDir, "plugin_manifest.json")).items[0].frameSrc,
    "previews/effects/batch_001_%04d.png",
  );
});

test("切换预览根目录失败时保留旧索引和旧文件", () => {
  const { root, paths } = workspace();
  const target = path.join(root, "target-is-a-file");
  write(target, "not a directory");
  const frame = path.join(paths.dataDir, "thumbs", "batch_001_0000.png");
  write(frame, "frame");
  writeJson(path.join(paths.dataDir, "plugin_manifest.json"), {
    version: 1,
    items: [{ matchName: "Effect.One", frameSrc: "thumbs/batch_001_%04d.png", frames: 1 }],
  });
  const before = fs.readFileSync(path.join(paths.dataDir, "plugin_manifest.json"), "utf8");

  const result = previewPaths.migratePreviewRoot(paths, target);
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(paths.dataDir, "plugin_manifest.json"), "utf8"), before);
  assert.ok(fs.existsSync(frame));
  assert.equal(fs.existsSync(paths.previewSettings), false);
});

test("安装状态统计自定义根目录中的效果与预设预览", () => {
  const { root, paths } = workspace();
  const customRoot = path.join(root, "counted");
  previewPaths.writeSettings(paths, customRoot);
  write(path.join(paths.dataDir, "thumbs", "legacy.png"), "legacy");
  write(path.join(customRoot, "effects", "effect.webp"), "effect");
  write(path.join(customRoot, "presets", "preset.png"), "preset");

  assert.equal(install.status(paths).thumbCount, 3);
});

test("迁移遇到同名不同内容文件时失败并保留旧文件", () => {
  const { root, paths } = workspace();
  const target = path.join(root, "conflict-target");
  const source = path.join(paths.dataDir, "thumbs", "batch_001_0000.png");
  const destination = path.join(target, "effects", "batch_001_0000.png");
  write(source, "old");
  write(destination, "newer-content");
  writeJson(path.join(paths.dataDir, "plugin_manifest.json"), {
    version: 1,
    items: [{ matchName: "Effect.One", frameSrc: "thumbs/batch_001_%04d.png", frames: 1 }],
  });
  const before = fs.readFileSync(path.join(paths.dataDir, "plugin_manifest.json"), "utf8");

  const result = previewPaths.migratePreviewRoot(paths, target);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "migration_failed");
  assert.ok(fs.existsSync(source));
  assert.equal(fs.readFileSync(destination, "utf8"), "newer-content");
  assert.equal(fs.readFileSync(path.join(paths.dataDir, "plugin_manifest.json"), "utf8"), before);
  assert.equal(fs.existsSync(paths.previewSettings), false);
});

test("预览占用空间统计包含效果、预设和旧 thumbs", () => {
  const { root, paths } = workspace();
  const customRoot = path.join(root, "sized");
  previewPaths.writeSettings(paths, customRoot);
  write(path.join(paths.dataDir, "thumbs", "legacy.bin"), "123");
  write(path.join(customRoot, "effects", "effect.bin"), "12345");
  write(path.join(customRoot, "presets", "preset.bin"), "1234567");

  assert.deepEqual(previewPaths.storageInfo(paths), { bytes: 15, files: 3 });
});

test("用户设置缺失时读取 data 镜像中的预览根目录", () => {
  const { root, paths } = workspace();
  const customRoot = path.join(root, "mirror-root");
  writeJson(path.join(paths.dataDir, "preview_settings.json"), { version: 1, root: customRoot });
  assert.equal(previewPaths.currentRoot(paths), customRoot);
});


test("切换预览根目录后清理旧效果/预设空目录和旧 thumbs", () => {
  const { root, paths } = workspace();
  const oldRoot = path.join(root, "old-previews");
  const target = path.join(root, "new-previews");
  previewPaths.writeSettings(paths, oldRoot);
  write(path.join(oldRoot, "effects", "nested", "effect.png"), "effect");
  write(path.join(oldRoot, "presets", "nested", "preset.png"), "preset");
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 1,
    items: [{ matchName: "Effect.One", src: "previews/effects/nested/effect.png" }],
  });
  writeJson(path.join(paths.dataDir, "preset_manifest.json"), {
    version: 1,
    items: [{ name: "Preset One", path: "C:/presets/one.ffx", src: "previews/presets/nested/preset.png" }],
  });

  const result = previewPaths.migratePreviewRoot(paths, target);
  assert.equal(result.ok, true);
  assert.ok(result.removedDirectories >= 4);
  assert.equal(fs.existsSync(path.join(oldRoot, "effects")), false);
  assert.equal(fs.existsSync(path.join(oldRoot, "presets")), false);
  assert.equal(fs.existsSync(oldRoot), false);
  assert.equal(fs.existsSync(path.join(paths.dataDir, "thumbs")), false);
});

test("恢复默认预览根目录会迁回 data/previews 并写回空设置", () => {
  const { root, paths } = workspace();
  const customRoot = path.join(root, "custom-previews");
  previewPaths.writeSettings(paths, customRoot);
  write(path.join(customRoot, "effects", "effect.png"), "effect");
  writeJson(path.join(paths.dataDir, "plugin_manifest.json"), {
    version: 1,
    items: [{ matchName: "Effect.One", frameSrc: "previews/effects/effect.png" }],
  });

  const result = previewPaths.resetPreviewRoot(paths);
  assert.equal(result.ok, true);
  assert.equal(previewPaths.currentRoot(paths), previewPaths.defaultRoot(paths));
  assert.equal(readJson(paths.previewSettings).root, "");
  assert.ok(fs.existsSync(path.join(previewPaths.defaultRoot(paths), "effects", "effect.png")));
  assert.equal(fs.existsSync(path.join(customRoot, "effects")), false);
  assert.equal(fs.existsSync(customRoot), false);
});

test("预设 WebP 帧序列迁移时保留每一帧的编号", () => {
  const { paths } = workspace();
  const legacy = path.join(previewPaths.currentRoot(paths), "presets", "legacy");
  write(path.join(legacy, "preset_001_0000.webp"), "0");
  write(path.join(legacy, "preset_001_0001.webp"), "1");
  writeJson(path.join(paths.dataDir, "preset_plugin_manifest.json"), {
    version: 1,
    items: [{
      name: "Preset One",
      path: "C:/presets/one.ffx",
      folder: "legacy",
      src: "previews/presets/legacy/preset_001_0000.webp",
      frameSrc: "previews/presets/legacy/preset_001_%04d.webp",
      frames: 2,
    }],
  });

  const result = previewPaths.migratePreviewLayout(paths);
  assert.equal(result.ok, true);
  const item = readJson(path.join(paths.dataDir, "preset_plugin_manifest.json")).items[0];
  assert.equal(item.frameSrc, "previews/presets/preset-one/preset_001_%04d.webp");
  assert.ok(fs.existsSync(path.join(previewPaths.currentRoot(paths), "presets", "preset-one", "preset_001_0000.webp")));
  assert.ok(fs.existsSync(path.join(previewPaths.currentRoot(paths), "presets", "preset-one", "preset_001_0001.webp")));
});
