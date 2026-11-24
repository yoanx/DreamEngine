const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const builder = require("../core/effect_preview_builder");
const { createPaths } = require("../core/paths");
const previewPaths = require("../core/preview_paths");

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

test("effect_preview_builder 把拼图帧裁成 WebP 帧序列并回写 manifest", async () => {
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
  const result = await builder.buildEffectPreviews(paths, { quality: 78 });
  assert.equal(result.ok, true);
  assert.equal(result.built, 1);

  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8"));
  const item = manifest.items[0];
  assert.equal(item.frameSrc, undefined, "动画形态不写 frameSrc");
  assert.equal(item.webpSrc, "previews/effects/webp/builtin/anim/ADBE Glo2.webp");
  assert.equal(item.src, "previews/effects/webp/builtin/stills/ADBE Glo2.webp");
  assert.equal(item.stillSrc, "previews/effects/webp/builtin/stills/ADBE Glo2.webp");
  assert.ok(fs.existsSync(previewPaths.resolveFile(paths, item.webpSrc)));
  assert.ok(fs.existsSync(previewPaths.resolveFile(paths, item.stillSrc)));
  assert.equal(fs.existsSync(path.join(thumbs, "batch_0000.png")), false);
  assert.equal(fs.existsSync(path.join(thumbs, "batch_0001.png")), false);

  const metadata = await sharp(previewPaths.resolveFile(paths, item.webpSrc)).metadata();
  assert.equal(metadata.width, 10);
  assert.equal(metadata.pages, 2, "两帧应合成一个两页动画");
});

test("旧版单文件动画 WebP 会拆成 WebP 帧序列", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-legacy-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const legacy = path.join(paths.dataDir, "thumbs", "webp", "builtin", "ADBE Legacy.webp");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const frames = [];
  for (const color of ["#ff0000", "#00ff00"]) {
    frames.push(await sharp({ create: { width: 10, height: 10, channels: 3, background: color } })
      .png()
      .toBuffer());
  }
  await sharp(frames, { join: { animated: true } })
    .webp({ quality: 80, delay: [100, 100] })
    .toFile(legacy);
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [{
      matchName: "ADBE Legacy",
      sheet: 0,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      frames: 24,
      fps: 24,
      duration: 1,
      frameSrc: "previews/effects/batch_0000_%04d.png",
      webpSrc: "previews/effects/webp/builtin/ADBE Legacy.webp",
      stillFrame: 1,
    }],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  const result = await builder.buildEffectPreviews(paths, { quality: 78 });
  assert.equal(result.ok, true);
  const item = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8")).items[0];
  assert.equal(item.format, "webp-animated");
  assert.equal(item.frameSrc, undefined, "动画形态不应再写 frameSrc");
  assert.equal(item.frames, 2);
  // 旧版动画文件应当被搬到 anim/ 下并原样保留，不再拆成帧序列
  assert.equal(item.webpSrc, "previews/effects/webp/builtin/anim/ADBE Legacy.webp");
  assert.ok(fs.existsSync(previewPaths.resolveFile(paths, item.webpSrc)));
  assert.ok(fs.existsSync(previewPaths.resolveFile(paths, item.stillSrc)));
  const migrated = await sharp(previewPaths.resolveFile(paths, item.webpSrc)).metadata();
  assert.equal(migrated.pages, 2, "迁移后仍是两页动画");
  assert.equal(fs.existsSync(legacy), false, "旧位置的动画文件应被清理");
  const second = await builder.buildEffectPreviews(paths, { quality: 78 });
  assert.equal(second.built, 0);
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

  assert.equal(first, "previews/effects/webp/builtin/anim/ADBE Glo2.webp");
  assert.equal(second, first);
  // 重渲落到同一个文件名：anim/ 下只有这一个动画文件
  const animDir = path.join(previewPaths.currentRoot(paths), "effects", "webp", "builtin", "anim");
  assert.deepEqual(fs.readdirSync(animDir).filter((n) => n.endsWith(".webp")), ["ADBE Glo2.webp"]);
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
  const raw = await sharp(previewPaths.resolveFile(paths, item.stillSrc)).raw().toBuffer();
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
  assert.equal(manifest.items[0].webpSrc, "previews/effects/webp/bcc/anim/BCC_GLOW.webp");
  assert.equal(manifest.items[0].stillSrc, "previews/effects/webp/bcc/stills/BCC_GLOW.webp");
});

test("WebP 帧序列按页数写入 animated.json", async () => {
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
  assert.deepEqual(index.items, []);
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
    "previews/effects/webp/builtin/anim/Mettle SkyBox Chromatic Aberrat.webp",
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
  assert.equal(fs.existsSync(previewPaths.resolveFile(paths, "previews/effects/webp/builtin/stills/ADBE Glo2.webp")), true);
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
  assert.match(manifest.items[0].webpSrc, /^previews\/effects\/webp\/.+\/anim\/[^/]+\.webp$/);
  assert.equal(manifest.items[1].frameSrc, "thumbs/batch_0001_%04d.png");
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

test("effect_preview_builder 将 WebP 写入自定义预览根目录的 effects 子目录", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-custom-root-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const customRoot = path.join(root, "chosen");
  previewPaths.writeSettings(paths, customRoot);
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

  await builder.buildEffectPreviews(paths, { quality: 78 });

  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8"));
  const item = manifest.items[0];
  assert.match(item.webpSrc, /^previews\/effects\/webp\/.+\/anim\/[^/]+\.webp$/);
  assert.match(item.stillSrc, /^previews\/effects\/webp\//);
  assert.ok(fs.existsSync(previewPaths.resolveFile(paths, item.webpSrc)));
  assert.ok(fs.existsSync(previewPaths.resolveFile(paths, item.stillSrc)));
});

/* ---------- 回归：整网坐标残留导致的裁剪越界 ---------- */

async function makeCells(files, width, height, colors) {
  for (let index = 0; index < files.length; index++) {
    await sharp({ create: { width, height, channels: 4, background: colors[index] } })
      .png()
      .toFile(files[index]);
  }
}

test("帧已是单格图时，索引里残留的整网 x 偏移不再导致 extract 越界", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-single-cell-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  const frames = [
    path.join(thumbs, "single_0000.png"),
    path.join(thumbs, "single_0001.png"),
  ];
  await makeCells(frames, 10, 10, ["#ff0000", "#00ff00"]);

  // x=10 是拼图时代「第二列」的偏移；帧本身只有 10x10，
  // 旧实现在这里抛 libvips extract_area: bad extract area，整批中断
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 2,
    width: 20,
    height: 10,
    items: [{
      matchName: "ADBE Single Cell",
      sheet: 0,
      x: 10,
      y: 0,
      width: 10,
      height: 10,
      frames: 2,
      fps: 24,
      frameSrc: "thumbs/single_%04d.png",
    }],
  });

  const result = await builder.buildEffectPreviews(paths, { quality: 78 });
  assert.equal(result.ok, true);
  assert.equal(result.built, 1);
  assert.deepEqual(result.failed, []);

  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8"));
  const out = await sharp(
    previewPaths.resolveFile(paths, manifest.items[0].webpSrc),
  ).metadata();
  assert.equal(out.width, 10);
  assert.equal(out.height, 10);
});

test("单条数据损坏时只跳过它，其余效果照常生成", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-partial-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const thumbs = path.join(paths.dataDir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });

  await makeCells([path.join(thumbs, "good_0000.png"), path.join(thumbs, "good_0001.png")],
    10, 10, ["#123456", "#654321"]);
  // 坏条目：帧只有 8x8，却声明裁剪区 10x10
  await makeCells([path.join(thumbs, "bad_0000.png"), path.join(thumbs, "bad_0001.png")],
    8, 8, ["#000000", "#ffffff"]);

  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    items: [
      {
        matchName: "ADBE Good", sheet: 0, x: 0, y: 0, width: 10, height: 10,
        frames: 2, fps: 24, frameSrc: "thumbs/good_%04d.png",
      },
      {
        matchName: "ADBE Bad", sheet: 0, x: 0, y: 0, width: 10, height: 10,
        frames: 2, fps: 24, frameSrc: "thumbs/bad_%04d.png",
      },
    ],
  });

  const result = await builder.buildEffectPreviews(paths, { quality: 78 });
  assert.equal(result.ok, true);
  assert.equal(result.built, 1, "好条目应正常生成");
  assert.equal(result.failed.length, 1, "坏条目应被单独记录");
  assert.equal(result.failed[0].matchName, "ADBE Bad");
  assert.match(result.failed[0].reason, /裁剪越界/);
  assert.match(result.failed[0].reason, /ADBE Bad/);
});

test("已是最终单文件形态的预览会被跳过，不会把 stillSrc 当源帧覆写", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-webp-final-"));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  const still = path.join(paths.dataDir, "previews", "effects", "webp", "builtin", "stills", "ADBE Final.webp");
  const anim = path.join(paths.dataDir, "previews", "effects", "webp", "builtin", "anim", "ADBE Final.webp");
  fs.mkdirSync(path.dirname(still), { recursive: true });
  fs.mkdirSync(path.dirname(anim), { recursive: true });
  const frames = [];
  for (const color of ["#ff0000", "#00ff00"]) {
    frames.push(await sharp({ create: { width: 10, height: 10, channels: 3, background: color } })
      .png()
      .toBuffer());
  }
  await sharp(frames[0]).webp({ quality: 80 }).toFile(still);
  await sharp(frames, { join: { animated: true } }).webp({ quality: 80, delay: [100, 100] }).toFile(anim);
  const stillBefore = fs.readFileSync(still);
  const animBefore = fs.readFileSync(anim);

  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 10,
    columns: 1,
    width: 10,
    height: 10,
    sheets: [],
    items: [{
      matchName: "ADBE Final",
      sheet: 0, x: 0, y: 0, width: 10, height: 10,
      frames: 2, fps: 24,
      format: "webp-animated",
      webpSrc: "previews/effects/webp/builtin/anim/ADBE Final.webp",
      stillSrc: "previews/effects/webp/builtin/stills/ADBE Final.webp",
      src: "previews/effects/webp/builtin/stills/ADBE Final.webp",
      stillFrame: 0,
    }],
  });
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  const result = await builder.buildEffectPreviews(paths, { quality: 78 });
  assert.equal(result.ok, true);
  assert.equal(result.built, 0);
  assert.equal(result.failed.length, 0, "最终形态不应被误报成跳过/失败");
  assert.deepEqual(fs.readFileSync(still), stillBefore, "不应重写 stillSrc");
  assert.deepEqual(fs.readFileSync(anim), animBefore, "不应重写 anim 文件");
  const item = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8")).items[0];
  assert.equal(item.webpSrc, "previews/effects/webp/builtin/anim/ADBE Final.webp");
  assert.equal(item.format, "webp-animated");
});
