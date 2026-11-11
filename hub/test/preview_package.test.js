const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const previewPackage = require("../core/preview_package");
const { createPaths } = require("../core/paths");

function makeWorkspace(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `de-preview-${label}-`));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  fs.mkdirSync(path.join(paths.dataDir, "thumbs"), { recursive: true });
  return { root, paths };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1), "utf8");
}

function writeEffectFile(paths, relative, text) {
  const file = path.join(paths.dataDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

test("效果预览包导出后导入另一个库：合并、同名覆盖、不碰预设", async () => {
  const source = makeWorkspace("source");
  writeJson(path.join(source.paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 360,
    columns: 4,
    width: 1440,
    height: 1440,
    sheets: [{ index: 0, src: "thumbs/source_builtin_0000.png", width: 1440, height: 1440 }],
    items: [{
      matchName: "ADBE Glo2",
      sheet: 0,
      x: 0,
      y: 0,
      width: 360,
      height: 360,
      frames: 24,
      fps: 24,
      duration: 1,
      frameSrc: "thumbs/source_builtin_%04d.png",
    }],
  });
  for (let frame = 0; frame < 36; frame++) {
    writeEffectFile(
      source.paths,
      `thumbs/source_builtin_${String(frame).padStart(4, "0")}.png`,
      `builtin-${frame}`,
    );
  }
  writeJson(source.paths.pluginManifest, {
    version: 1,
    cellSize: 360,
    columns: 1,
    width: 360,
    height: 360,
    sheets: [{ index: 1000, src: "thumbs/source_plugin_0000.png", width: 360, height: 360 }],
    items: [{
      matchName: "BCC_GLOW",
      sheet: 1000,
      x: 0,
      y: 0,
      width: 360,
      height: 360,
      sliceColumns: 1,
      sliceCellSize: 360,
      sliceWidth: 360,
      sliceHeight: 360,
      frames: 24,
      fps: 24,
      duration: 1,
      frameSrc: "thumbs/source_plugin_%04d.png",
      webpSrc: "thumbs/source_plugin.webp",
      stillSrc: "thumbs/source_plugin_still.webp",
    }],
  });
  for (let frame = 0; frame < 36; frame++) {
    writeEffectFile(
      source.paths,
      `thumbs/source_plugin_${String(frame).padStart(4, "0")}.png`,
      `plugin-${frame}`,
    );
  }
  writeEffectFile(source.paths, "thumbs/source_plugin.webp", "plugin-webp");
  writeEffectFile(source.paths, "thumbs/source_plugin_still.webp", "plugin-still");
  writeJson(source.paths.presetManifest, {
    version: 1,
    items: [{ name: "source-only-preset", src: "thumbs/preset_000_0000.png" }],
  });

  const zipFile = path.join(source.root, "effect-previews.zip");
  const exported = await previewPackage.exportEffectPreviews(source.paths, zipFile);
  assert.equal(exported.ok, true);
  assert.equal(exported.items, 2);
  assert.equal(exported.files, 26);
  assert.ok(fs.statSync(zipFile).size > 0);

  const target = makeWorkspace("target");
  writeJson(path.join(target.paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 360,
    columns: 4,
    width: 1440,
    height: 1440,
    sheets: [{ index: 0, src: "thumbs/local_sheet.png", width: 1440, height: 1440 }],
    items: [
      {
        matchName: "ADBE Glo2",
        sheet: 0,
        x: 0,
        y: 0,
        width: 360,
        height: 360,
        frames: 1,
        fps: 12,
        duration: 0.08,
        src: "thumbs/local_sheet.png",
      },
      {
        matchName: "ADBE Twirl",
        sheet: 0,
        x: 360,
        y: 0,
        width: 360,
        height: 360,
        frames: 1,
        fps: 12,
        duration: 0.08,
        src: "thumbs/local_sheet.png",
      },
    ],
  });
  writeEffectFile(target.paths, "thumbs/local_sheet.png", "local");
  writeJson(target.paths.pluginManifest, {
    version: 1,
    cellSize: 360,
    columns: 1,
    width: 360,
    height: 360,
    sheets: [],
    items: [],
  });
  writeJson(target.paths.presetManifest, {
    version: 1,
    items: [{ name: "keep-me", src: "thumbs/preset_keep_0000.png" }],
  });
  writeEffectFile(target.paths, "thumbs/preset_keep_0000.png", "preset");

  const imported = await previewPackage.importEffectPreviews(target.paths, zipFile);
  assert.equal(imported.ok, true);
  assert.equal(imported.added, 2);
  assert.equal(imported.replaced, 1);

  const builtin = JSON.parse(fs.readFileSync(path.join(target.paths.dataDir, "manifest.json"), "utf8"));
  const byBuiltin = new Map(builtin.items.map((item) => [item.matchName, item]));
  assert.equal(byBuiltin.get("ADBE Glo2").frames, 24);
  assert.equal(byBuiltin.get("ADBE Glo2").fps, 24);
  assert.match(byBuiltin.get("ADBE Glo2").frameSrc, /^thumbs\/import_[^/]+\//);
  assert.equal(byBuiltin.get("ADBE Twirl").src, "thumbs/local_sheet.png");

  const plugin = JSON.parse(fs.readFileSync(target.paths.pluginManifest, "utf8"));
  assert.equal(plugin.items.length, 1);
  assert.equal(plugin.items[0].matchName, "BCC_GLOW");
  assert.equal(plugin.items[0].frames, 24);
  assert.match(plugin.items[0].webpSrc, /^thumbs\/import_[^/]+\/source_plugin\.webp$/);
  assert.match(plugin.items[0].stillSrc, /^thumbs\/import_[^/]+\/source_plugin_still\.webp$/);

  const preset = JSON.parse(fs.readFileSync(target.paths.presetManifest, "utf8"));
  assert.equal(preset.items[0].name, "keep-me");
  assert.equal(fs.readFileSync(path.join(target.paths.dataDir, "thumbs/preset_keep_0000.png"), "utf8"), "preset");

  const importedFrame = path.join(
    target.paths.dataDir,
    byBuiltin.get("ADBE Glo2").frameSrc.replace("%04d", "0000"),
  );
  assert.equal(fs.readFileSync(importedFrame, "utf8"), "builtin-0");
});

test("导出效果预览包支持按插件筛选", async () => {
  const source = makeWorkspace("plugin-filter");
  writeJson(path.join(source.paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [{
      matchName: "ADBE Glo2",
      frames: 24,
      fps: 24,
      webpSrc: "thumbs/webp/内置/ADBE Glo2.webp",
    }],
  });
  writeJson(source.paths.pluginManifest, {
    version: 1,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [
      {
        matchName: "BCC_GLOW",
        plugin: "BCC",
        frames: 24,
        fps: 24,
        webpSrc: "thumbs/webp/BCC/BCC_GLOW.webp",
        stillSrc: "thumbs/webp/BCC/stills/BCC_GLOW.webp",
      },
      {
        matchName: "S_GLOW",
        plugin: "Sapphire",
        frames: 24,
        fps: 24,
        webpSrc: "thumbs/webp/Sapphire/S_GLOW.webp",
        stillSrc: "thumbs/webp/Sapphire/stills/S_GLOW.webp",
      },
    ],
  });
  writeEffectFile(source.paths, "thumbs/webp/内置/ADBE Glo2.webp", "builtin");
  writeEffectFile(source.paths, "thumbs/webp/BCC/BCC_GLOW.webp", "bcc");
  writeEffectFile(source.paths, "thumbs/webp/BCC/stills/BCC_GLOW.webp", "bcc-still");
  writeEffectFile(source.paths, "thumbs/webp/Sapphire/S_GLOW.webp", "sapphire");
  writeEffectFile(source.paths, "thumbs/webp/Sapphire/stills/S_GLOW.webp", "sapphire-still");

  const zipFile = path.join(source.root, "bcc-only.zip");
  const exported = await previewPackage.exportEffectPreviews(source.paths, zipFile, {
    plugins: ["BCC"],
  });
  assert.equal(exported.ok, true);
  assert.equal(exported.items, 1);
  assert.equal(exported.files, 2);

  const target = makeWorkspace("plugin-filter-target");
  writeJson(path.join(target.paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [],
  });
  writeJson(target.paths.pluginManifest, {
    version: 1,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [],
  });
  const imported = await previewPackage.importEffectPreviews(target.paths, zipFile);
  assert.equal(imported.ok, true);
  const plugin = JSON.parse(fs.readFileSync(target.paths.pluginManifest, "utf8"));
  assert.deepEqual(plugin.items.map((item) => item.matchName), ["BCC_GLOW"]);
});

test("导出按 Hub 内置分类处理扫描器归为其它插件的效果", async () => {
  const source = makeWorkspace("builtin-classify");
  fs.mkdirSync(source.paths.probe, { recursive: true });
  fs.writeFileSync(
    source.paths.pluginCatalog,
    "matchName\tdisplayName\tcategory\tplugin\texcluded\treason\tnoPreview\r\n" +
      "Mettle SkyBox Chromatic Aberrat\tVR 色差\t沉浸式视频\t其它插件\t0\t\t0\r\n",
    "utf8",
  );
  writeJson(path.join(source.paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [],
  });
  writeJson(source.paths.pluginManifest, {
    version: 1,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [{
      matchName: "Mettle SkyBox Chromatic Aberrat",
      plugin: "其它插件",
      frames: 24,
      fps: 24,
      webpSrc: "thumbs/webp/内置/Mettle SkyBox Chromatic Aberrat.webp",
      stillSrc: "thumbs/webp/内置/stills/Mettle SkyBox Chromatic Aberrat.webp",
    }],
  });
  writeEffectFile(
    source.paths,
    "thumbs/webp/内置/Mettle SkyBox Chromatic Aberrat.webp",
    "mettle",
  );
  writeEffectFile(
    source.paths,
    "thumbs/webp/内置/stills/Mettle SkyBox Chromatic Aberrat.webp",
    "mettle-still",
  );

  const zipFile = path.join(source.root, "builtin-only.zip");
  const exported = await previewPackage.exportEffectPreviews(source.paths, zipFile, {
    plugins: ["内置"],
  });
  assert.equal(exported.ok, true);
  assert.equal(exported.items, 1);
});
