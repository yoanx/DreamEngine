const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const builder = require("../core/effect_preview_builder");
const { createPaths } = require("../core/paths");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1), "utf8");
}

async function makeSheet(file, colors) {
  const cells = [];
  for (let index = 0; index < colors.length; index++) {
    cells.push({
      input: await sharp({
        create: { width: 10, height: 10, channels: 4, background: colors[index] },
      })
        .png()
        .toBuffer(),
      left: index * 10,
      top: 0,
    });
  }
  await sharp({
    create: { width: colors.length * 10, height: 10, channels: 4, background: "#00000000" },
  })
    .composite(cells)
    .png()
    .toFile(file);
}

test("effect_preview_builder 把拼图帧裁成动画 WebP 并回写 manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  await makeSheet(path.join(thumbs, "batch_0000.png"), ["#ff0000", "#00ff00"]);
  await makeSheet(path.join(thumbs, "batch_0001.png"), ["#0000ff", "#ffff00"]);
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 2,
    width: 20,
    height: 10,
    sheets: [{ index: 0, src: "thumbs/batch_0000.png", width: 20, height: 10 }],
    items: [{
      matchName: "ADBE Glo2",
      sheet: 0,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      frames: 2,
      fps: 24,
      duration: 0.084,
      frameSrc: "thumbs/batch_%04d.png",
    }],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  const result = await builder.buildEffectPreviews(paths, { quality: 78 });
  assert.equal(result.ok, true);
  assert.equal(result.built, 1);

  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8"));
  const item = manifest.items[0];
  assert.equal(item.webpSrc, "thumbs/webp/内置/ADBE Glo2.webp");
  assert.equal(item.stillSrc, "thumbs/webp/内置/stills/ADBE Glo2.webp");
  assert.ok(fs.existsSync(path.join(paths.dataDir, item.webpSrc)));
  assert.ok(fs.existsSync(path.join(paths.dataDir, item.stillSrc)));
  assert.equal(fs.existsSync(path.join(thumbs, "batch_0000.png")), false);
  assert.equal(fs.existsSync(path.join(thumbs, "batch_0001.png")), false);

  const metadata = await sharp(path.join(paths.dataDir, item.webpSrc), { animated: true }).metadata();
  assert.equal(metadata.width, 10);
  assert.equal(metadata.pageHeight, 10);
  assert.ok(metadata.pages <= 2);
});

test("同一效果重新渲染时使用稳定文件名并覆盖旧 WebP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-overwrite-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 2,
    width: 20,
    height: 10,
    sheets: [{ index: 0, src: "thumbs/batch_0000.png", width: 20, height: 10 }],
    items: [{
      matchName: "ADBE Glo2",
      sheet: 0,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      frames: 2,
      fps: 24,
      duration: 0.084,
      frameSrc: "thumbs/batch_%04d.png",
    }],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  await makeSheet(path.join(thumbs, "batch_0000.png"), ["#ff0000", "#00ff00"]);
  await makeSheet(path.join(thumbs, "batch_0001.png"), ["#ff0000", "#00ff00"]);
  await builder.buildEffectPreviews(paths, { quality: 78 });
  const first = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8")).items[0].webpSrc;

  await makeSheet(path.join(thumbs, "batch_0000.png"), ["#0000ff", "#ffff00"]);
  await makeSheet(path.join(thumbs, "batch_0001.png"), ["#0000ff", "#ffff00"]);
  await builder.buildEffectPreviews(paths, { quality: 78 });
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8"));
  const second = manifest.items[0].webpSrc;

  assert.equal(first, "thumbs/webp/内置/ADBE Glo2.webp");
  assert.equal(second, first);
  assert.equal(
    fs.readdirSync(path.join(thumbs, "webp"), { recursive: true })
      .filter((name) => name.endsWith(".webp") && !name.includes("stills")).length,
    1,
  );
});

test("静态首帧使用动画的中间帧并记录 stillFrame", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-middle-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  await makeSheet(path.join(thumbs, "batch_0000.png"), ["#ff0000", "#00ff00"]);
  await makeSheet(path.join(thumbs, "batch_0001.png"), ["#0000ff", "#ffff00"]);
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 2,
    width: 20,
    height: 10,
    sheets: [{ index: 0, src: "thumbs/batch_0000.png", width: 20, height: 10 }],
    items: [{
      matchName: "ADBE Middle Frame",
      sheet: 0,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      frames: 2,
      fps: 24,
      frameSrc: "thumbs/batch_%04d.png",
    }],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  await builder.buildEffectPreviews(paths, { quality: 78 });

  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8"));
  const item = manifest.items[0];
  assert.equal(item.stillFrame, 1);
  const raw = await sharp(path.join(paths.dataDir, item.stillSrc)).raw().toBuffer();
  assert.deepEqual([...raw.subarray(0, 3)], [0, 0, 255]);
});

test("预览 WebP 按插件分目录存储", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-plugin-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  await makeSheet(path.join(thumbs, "batch_1000_0000.png"), ["#ff0000", "#00ff00"]);
  await makeSheet(path.join(thumbs, "batch_1000_0001.png"), ["#0000ff", "#ffff00"]);
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [],
  });
  writeJson(paths.pluginManifest, {
    version: 1,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [{ index: 1000, src: "thumbs/batch_1000_0000.png", width: 10, height: 10 }],
    items: [{
      matchName: "BCC_GLOW",
      plugin: "BCC",
      sheet: 1000,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      frames: 2,
      fps: 24,
      frameSrc: "thumbs/batch_1000_%04d.png",
    }],
  });

  await builder.buildEffectPreviews(paths, { quality: 78 });

  const manifest = JSON.parse(fs.readFileSync(paths.pluginManifest, "utf8"));
  assert.equal(manifest.items[0].webpSrc, "thumbs/webp/BCC/BCC_GLOW.webp");
  assert.equal(manifest.items[0].stillSrc, "thumbs/webp/BCC/stills/BCC_GLOW.webp");
});

test("WebP 被 Sharp 合并为单页时写入 animated.json", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-static-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  await makeSheet(path.join(thumbs, "batch_0000_0000.png"), ["#ff0000", "#ff0000"]);
  await makeSheet(path.join(thumbs, "batch_0000_0001.png"), ["#ff0000", "#ff0000"]);
  await makeSheet(path.join(thumbs, "batch_0001_0000.png"), ["#00ff00", "#0000ff"]);
  await makeSheet(path.join(thumbs, "batch_0001_0001.png"), ["#0000ff", "#00ff00"]);
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 2,
    width: 20,
    height: 10,
    sheets: [],
    items: [
      {
        matchName: "ADBE Static",
        sheet: 0,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        frames: 2,
        fps: 24,
        frameSrc: "thumbs/batch_0000_%04d.png",
      },
      {
        matchName: "ADBE Animated",
        sheet: 1,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        frames: 2,
        fps: 24,
        frameSrc: "thumbs/batch_0001_%04d.png",
      },
    ],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  await builder.buildEffectPreviews(paths, { quality: 78 });

  const index = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "animated.json"), "utf8"));
  assert.deepEqual(index.items, [{ matchName: "ADBE Static", animated: false }]);
});

test("被 Hub 归为内置的效果写入内置目录，而不是原始扫描插件名", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-classify-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  fs.mkdirSync(paths.probe, { recursive: true });
  fs.writeFileSync(
    paths.pluginCatalog,
    "matchName\tdisplayName\tcategory\tplugin\texcluded\treason\tnoPreview\r\n" +
      "Mettle SkyBox Chromatic Aberrat\tVR 色差\t沉浸式视频\t其它插件\t0\t\t0\r\n",
    "utf8",
  );
  await makeSheet(path.join(thumbs, "batch_1001_0000.png"), ["#ff0000", "#00ff00"]);
  await makeSheet(path.join(thumbs, "batch_1001_0001.png"), ["#0000ff", "#ffff00"]);
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [],
  });
  writeJson(paths.pluginManifest, {
    version: 1,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [{ index: 1001, src: "thumbs/batch_1001_0000.png", width: 10, height: 10 }],
    items: [{
      matchName: "Mettle SkyBox Chromatic Aberrat",
      plugin: "其它插件",
      sheet: 1001,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      frames: 2,
      fps: 24,
      frameSrc: "thumbs/batch_1001_%04d.png",
    }],
  });

  await builder.buildEffectPreviews(paths, { quality: 78 });

  const manifest = JSON.parse(fs.readFileSync(paths.pluginManifest, "utf8"));
  assert.equal(
    manifest.items[0].webpSrc,
    "thumbs/webp/内置/Mettle SkyBox Chromatic Aberrat.webp",
  );
});

test("重新渲染后删除不再引用的旧哈希 WebP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-cleanup-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(path.join(thumbs, "webp"), { recursive: true });
  await makeSheet(path.join(thumbs, "batch_0000.png"), ["#ff0000", "#00ff00"]);
  await makeSheet(path.join(thumbs, "batch_0001.png"), ["#0000ff", "#ffff00"]);
  fs.writeFileSync(path.join(thumbs, "webp", "builtin_deadbeefdeadbeef.webp"), "old");
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 2,
    width: 20,
    height: 10,
    sheets: [{ index: 0, src: "thumbs/batch_0000.png", width: 20, height: 10 }],
    items: [{
      matchName: "ADBE Glo2",
      sheet: 0,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      frames: 2,
      fps: 24,
      frameSrc: "thumbs/batch_%04d.png",
      webpSrc: "thumbs/webp/builtin_deadbeefdeadbeef.webp",
    }],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  await builder.buildEffectPreviews(paths, { quality: 78 });

  assert.equal(fs.existsSync(path.join(thumbs, "webp", "builtin_deadbeefdeadbeef.webp")), false);
  assert.equal(fs.existsSync(path.join(thumbs, "webp", "内置", "ADBE Glo2.webp")), true);
});

test("批次清理删除旧根目录 WebP，但保留插件目录内的命名 WebP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-named-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const webp = path.join(paths.dataDir, "thumbs", "webp");
  fs.mkdirSync(webp, { recursive: true });
  const named = path.join(webp, "BCC", "ADBE Another Effect.webp");
  fs.mkdirSync(path.dirname(named), { recursive: true });
  const oldRootNamed = path.join(webp, "ADBE Old Root.webp");
  const legacy = path.join(webp, "builtin_deadbeefdeadbeef.webp");
  fs.writeFileSync(named, "named");
  fs.writeFileSync(oldRootNamed, "old-root");
  fs.writeFileSync(legacy, "legacy");
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  await builder.buildEffectPreviews(paths, { quality: 78 });

  assert.equal(fs.existsSync(named), true);
  assert.equal(fs.existsSync(oldRootNamed), false);
  assert.equal(fs.existsSync(legacy), false);
});

test("已完成条目的 WebP 生成后立即清理自己的 PNG，不等所有条目完成", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-partial-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  await makeSheet(path.join(thumbs, "batch_0000_0000.png"), ["#ff0000", "#00ff00"]);
  await makeSheet(path.join(thumbs, "batch_0000_0001.png"), ["#0000ff", "#ffff00"]);
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 2,
    width: 20,
    height: 10,
    sheets: [{ index: 0, src: "thumbs/batch_0000_0000.png", width: 20, height: 10 }],
    items: [
      {
        matchName: "ADBE Glo2",
        sheet: 0,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        frames: 2,
        fps: 24,
        frameSrc: "thumbs/batch_0000_%04d.png",
      },
      {
        matchName: "ADBE Pending",
        sheet: 1,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        frames: 2,
        fps: 24,
        frameSrc: "thumbs/batch_0001_%04d.png",
      },
    ],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  await builder.buildEffectPreviews(paths, { quality: 78 });

  assert.equal(fs.existsSync(path.join(thumbs, "batch_0000_0000.png")), false);
  assert.equal(fs.existsSync(path.join(thumbs, "batch_0000_0001.png")), false);
  assert.equal(fs.existsSync(path.join(thumbs, "batch_0001_0000.png")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8"));
  assert.match(manifest.items[0].webpSrc, /^thumbs\/webp\/.+\.webp$/);
  assert.equal(manifest.items[1].webpSrc, undefined);
});

test("帧序列未写齐时不生成 WebP，也不清理已有 PNG", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-incomplete-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  await makeSheet(path.join(thumbs, "batch_0000_0000.png"), ["#ff0000", "#00ff00"]);
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 2,
    width: 20,
    height: 10,
    sheets: [{ index: 0, src: "thumbs/batch_0000_0000.png", width: 20, height: 10 }],
    items: [{
      matchName: "ADBE Incomplete",
      sheet: 0,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      frames: 2,
      fps: 24,
      frameSrc: "thumbs/batch_0000_%04d.png",
    }],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  await builder.buildEffectPreviews(paths, { quality: 78 });

  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8"));
  assert.equal(manifest.items[0].webpSrc, undefined);
  assert.equal(fs.existsSync(path.join(thumbs, "batch_0000_0000.png")), true);
});

test("批次清理不会删除尚未写入 manifest 的新 PNG", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-orphan-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  const orphan = path.join(thumbs, "batch_9999_0000.png");
  await makeSheet(orphan, ["#ff0000", "#00ff00"]);
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 2,
    width: 20,
    height: 10,
    sheets: [],
    items: [],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  await builder.buildEffectPreviews(paths, { quality: 78 });

  assert.equal(fs.existsSync(orphan), true);
});
