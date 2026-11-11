/* ============================================================
 * effects.js / effect_favorites.js 纯逻辑断言
 *
 * 全部使用临时目录构造四份数据文件，不读写真实用户目录，
 * 也不需要 Electron 或 After Effects：
 *   · 内置（L1 manifest）+ 插件（plugin_manifest）合并顺序与计数
 *   · 目录里待渲染 / 黑名单条目显示为占位（hasPreview:false）
 *   · 扫描启发式漏判的 AE 自带效果归回「AE 内置」分组
 *   · 收藏按 matchName 读写
 *   · clearPreview：删索引行与专属帧、保留共用拼图、回到待渲染
 *
 * 运行：npm test（或 node --test test/effects.test.js）
 * ============================================================ */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const effects = require("../core/effects");
const effectFavorites = require("../core/effect_favorites");
const { createPaths } = require("../core/paths");

const CATALOG_HEADER = "matchName\tdisplayName\tcategory\tplugin\texcluded\treason\tnoPreview";

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 1), "utf8");
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effects-"));
  const docs = path.join(root, "docs");
  const appData = path.join(root, "appdata");
  const paths = createPaths({ docsDir: docs, appData });
  fs.mkdirSync(path.join(paths.dataDir, "frames"), { recursive: true });
  fs.mkdirSync(paths.probe, { recursive: true });

  /* 内置效果：L1 8x8 整网的两个条目（一个 2 帧动图、一个单帧静图） */
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 1,
    cellSize: 64,
    columns: 2,
    width: 128,
    height: 64,
    sheets: [
      { index: 0, src: "frames/builtin_%04d.png" },
      { index: 1, src: "frames/static_%04d.png" },
    ],
    items: [
      { matchName: "ADBE Gaussian Blur", sheet: 0, x: 0, y: 0, frames: 24, fps: 24, effectPreviewVersion: 2 },
      { matchName: "ADBE Ramp", sheet: 1, x: 0, y: 0, frames: 24, fps: 24, effectPreviewVersion: 2 },
    ],
  });
  for (const file of ["builtin_0000.png", "builtin_0001.png", "static_0000.png"]) {
    fs.writeFileSync(path.join(paths.dataDir, "frames", file), "png");
  }

  /* 双语名字表：pluginHint=内置 的分类用于把 Keylight 等归回 AE 内置 */
  writeJson(path.join(paths.dataDir, "names.json"), {
    version: 1,
    items: [
      { matchName: "ADBE Gaussian Blur", nameZh: "高斯模糊", nameEn: "Gaussian Blur", categoryZh: "模糊和锐化", categoryEn: "Blur & Sharpen", pluginHint: "内置" },
      { matchName: "ADBE Ramp", nameZh: "渐变", nameEn: "Ramp", categoryZh: "生成", categoryEn: "Generate", pluginHint: "内置" },
      { matchName: "BCC_GLOW", nameZh: "BCC 发光", nameEn: "BCC Glow", categoryZh: "光效", categoryEn: "Glow", pluginHint: "BCC" },
    ],
  });

  /* Hub 已生成的插件预览：两条共用同一张拼图 */
  writeJson(paths.pluginManifest, {
    version: 1,
    items: [
      { matchName: "BCC_GLOW", frames: 24, duration: 1, fps: 24, sliceCellSize: 64, sliceColumns: 2, x: 0, y: 0, src: "frames/bcc_sheet.png", frameSrc: "frames/bcc_%04d.png", webpSrc: "frames/bcc.webp", stillSrc: "frames/bcc_still.webp", effectPreviewVersion: 2 },
      { matchName: "BCC_OTHER", frames: 24, fps: 24, sliceCellSize: 64, sliceColumns: 1, x: 64, y: 0, src: "frames/bcc_sheet.png", frameSrc: "frames/other_0000.png", effectPreviewVersion: 2 },
    ],
  });
  for (const file of ["bcc_sheet.png", "bcc_0000.png", "bcc_0001.png", "other_0000.png"]) {
    fs.writeFileSync(path.join(paths.dataDir, "frames", file), "png");
  }
  fs.writeFileSync(path.join(paths.dataDir, "frames", "bcc.webp"), "webp");
  fs.writeFileSync(path.join(paths.dataDir, "frames", "bcc_still.webp"), "webp");

  /* AE 扫描目录：已渲染、待渲染、黑名单、以及被启发式误判成第三方的 AE 自带效果 */
  fs.writeFileSync(
    paths.pluginCatalog,
    [
      CATALOG_HEADER,
      "BCC_GLOW\tBCC Glow\t光效\tBCC\t0\t\t0",
      "BCC_PENDING\tBCC Pending\t光效\tBCC\t0\t\t0",
      "BCC_BLOCKED\tBCC Blocked\t光效\tBCC\t0\t\t0",
      "Keylight 906\tKeylight\t生成\t其它插件\t0\t\t0",
    ].join("\r\n") + "\r\n",
    "utf8",
  );
  writeJson(path.join(paths.dataDir, "plugin_blacklist.json"), {
    version: 1,
    items: [{ matchName: "BCC_BLOCKED", reason: "crash" }],
  });

  return { root, paths };
}

test("effects.list：内置 + 插件合并、计数与占位状态", () => {
  const { paths } = makeWorkspace();
  const lib = effects.list(paths);

  assert.equal(lib.ok, true);
  assert.equal(lib.counts.total, 7);
  assert.equal(lib.counts.builtin, 3);
  assert.equal(lib.counts.plugin, 4);
  assert.equal(lib.counts.rendered, 4);
  assert.equal(lib.counts.pending, 3);

  const byName = new Map(lib.items.map((item) => [item.matchName, item]));
  assert.deepEqual(byName.get("ADBE Gaussian Blur").name, "高斯模糊");
  assert.equal(byName.get("ADBE Gaussian Blur").frames, 24);
  assert.equal(byName.get("ADBE Gaussian Blur").animated, true);
  assert.equal(byName.get("ADBE Gaussian Blur").renderable, true);

  /* 已生成预览的插件条目 */
  const glow = byName.get("BCC_GLOW");
  assert.equal(glow.source, "plugin");
  assert.equal(glow.hasPreview, true);
  assert.equal(glow.renderable, true);
  assert.equal(glow.generated, true);
  assert.equal(glow.fps, 24);
  assert.equal(glow.duration, 1);
  assert.equal(glow.webpSrc, path.join(paths.dataDir, "frames/bcc.webp"));
  assert.equal(glow.stillSrc, path.join(paths.dataDir, "frames/bcc_still.webp"));

  /* 目录里还没渲染的条目：占位、可渲染、待渲染 */
  const pending = byName.get("BCC_PENDING");
  assert.equal(pending.hasPreview, false);
  assert.equal(pending.status, "pending");
  assert.equal(pending.renderable, true);
  assert.equal(pending.frames, 0);

  /* 黑名单条目：占位并带原因 */
  const blocked = byName.get("BCC_BLOCKED");
  assert.equal(blocked.status, "blacklisted");
  assert.equal(blocked.reason, "crash");

  /* 名字表标为内置的分类：Keylight 归回 AE 内置分组 */
  const keylight = byName.get("Keylight 906");
  assert.equal(keylight.source, "builtin");
  assert.equal(keylight.plugin, "内置");

  /* 内置严格按 manifest 顺序 */
  assert.deepEqual(
    lib.items.slice(0, 2).map((item) => item.matchName),
    ["ADBE Gaussian Blur", "ADBE Ramp"],
  );
});

test("effect_favorites：缺失/损坏文件退化为空，切换按 matchName 落盘", () => {
  const { paths } = makeWorkspace();
  assert.deepEqual(effectFavorites.read(paths).items, []);

  let result = effectFavorites.toggle(paths, "BCC_GLOW");
  assert.equal(result.ok, true);
  assert.equal(result.favorite, true);
  assert.deepEqual(effectFavorites.read(paths).items, ["BCC_GLOW"]);

  const lib = effects.list(paths);
  const glow = lib.items.find((item) => item.matchName === "BCC_GLOW");
  assert.equal(glow.favorite, true);

  result = effectFavorites.toggle(paths, "BCC_GLOW");
  assert.equal(result.favorite, false);
  assert.deepEqual(effectFavorites.read(paths).items, []);

  fs.writeFileSync(paths.effectFavorites, "{not json", "utf8");
  assert.deepEqual(effectFavorites.read(paths).items, []);
});

test("effects.clearPreview：删索引与专属帧、保留共用拼图、回到待渲染", () => {
  const { paths } = makeWorkspace();
  const result = effects.clearPreview(paths, "BCC_GLOW");

  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);
  assert.ok(result.deleted >= 2);
  assert.equal(fs.existsSync(path.join(paths.dataDir, "frames", "bcc_0000.png")), false);
  assert.equal(fs.existsSync(path.join(paths.dataDir, "frames", "bcc_0001.png")), false);
  assert.equal(fs.existsSync(path.join(paths.dataDir, "frames", "bcc.webp")), false);
  assert.equal(fs.existsSync(path.join(paths.dataDir, "frames", "bcc_still.webp")), false);
  /* 仍被 BCC_OTHER 引用的拼图不能删 */
  assert.equal(fs.existsSync(path.join(paths.dataDir, "frames", "bcc_sheet.png")), true);
  assert.equal(fs.existsSync(path.join(paths.dataDir, "frames", "other_0000.png")), true);

  const remaining = JSON.parse(fs.readFileSync(paths.pluginManifest, "utf8")).items;
  assert.deepEqual(remaining.map((item) => item.matchName), ["BCC_OTHER"]);

  /* 清空后回到待渲染占位 */
  const lib = effects.list(paths);
  const glow = lib.items.find((item) => item.matchName === "BCC_GLOW");
  assert.equal(glow.hasPreview, false);
  assert.equal(glow.status, "pending");

  assert.equal(effects.clearPreview(paths, "BCC_GLOW").reason, "not_found");
  assert.equal(effects.clearPreview(paths, "").reason, "invalid_match_name");
});

test("effects.list：只有动画 WebP、没有 PNG 帧的效果仍然可见", () => {
  const { paths } = makeWorkspace();
  writeJson(path.join(paths.dataDir, "manifest.json"), {
    version: 2,
    cellSize: 360,
    columns: 4,
    width: 1440,
    height: 1440,
    sheets: [],
    items: [{
      matchName: "ADBE Gaussian Blur",
      frames: 24,
      fps: 24,
      duration: 1,
      webpSrc: "frames/blur.webp",
      stillSrc: "frames/blur_still.webp",
      effectPreviewVersion: 2,
    }],
  });
  fs.writeFileSync(path.join(paths.dataDir, "frames", "blur.webp"), "webp");
  fs.writeFileSync(path.join(paths.dataDir, "frames", "blur_still.webp"), "webp");
  writeJson(paths.pluginManifest, { version: 1, items: [], sheets: [] });

  const item = effects.list(paths).items.find((entry) => entry.matchName === "ADBE Gaussian Blur");
  assert.equal(item.hasPreview, true);
  assert.equal(item.framePattern, "");
  assert.equal(item.webpSrc, path.join(paths.dataDir, "frames/blur.webp"));
  assert.equal(item.stillSrc, path.join(paths.dataDir, "frames/blur_still.webp"));
});

test("内置效果在统一效果渲染器重渲后只出现一条，并采用新预览", () => {
  const { paths } = makeWorkspace();
  writeJson(paths.pluginManifest, {
    version: 1,
    cellSize: 720,
    columns: 2,
    width: 1440,
    height: 1440,
    sheets: [{ index: 2000, src: "frames/new_0000.png", width: 1440, height: 1440 }],
    items: [{
      matchName: "ADBE Gaussian Blur",
      sheet: 2000,
      x: 0,
      y: 0,
      width: 720,
      height: 720,
      sliceColumns: 2,
      sliceCellSize: 720,
      sliceWidth: 1440,
      sliceHeight: 1440,
      frames: 24,
      fps: 24,
      duration: 1,
      frameSrc: "frames/new_%04d.png",
      webpSrc: "frames/new.webp",
      stillSrc: "frames/new_still.webp",
      plugin: "内置",
      effectPreviewVersion: 2,
    }],
  });
  fs.writeFileSync(path.join(paths.dataDir, "frames", "new.webp"), "webp");
  fs.writeFileSync(path.join(paths.dataDir, "frames", "new_still.webp"), "webp");

  const matches = effects.list(paths).items.filter((item) => item.matchName === "ADBE Gaussian Blur");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].frames, 24);
  assert.equal(matches[0].source, "builtin");
  assert.equal(matches[0].renderable, true);
  assert.equal(matches[0].webpSrc, path.join(paths.dataDir, "frames/new.webp"));
});

/* ============================================================
 * 动静判定回归（frames 统一写 24，只有 animated.json 能区分单帧）
 * ============================================================ */

test("animated.json 标记为静态的条目判为静止，即使 manifest 写 frames=24", () => {
  const { paths } = makeWorkspace();
  /* 内置 ADBE Ramp 与插件 BCC_GLOW 都是 frames=24，但产出的 WebP 只有 1 页 */
  writeJson(path.join(paths.dataDir, "animated.json"), {
    version: 1,
    items: [
      { matchName: "ADBE Ramp", animated: false },
      { matchName: "BCC_GLOW", animated: false },
    ],
  });

  const byName = new Map(effects.list(paths).items.map((item) => [item.matchName, item]));

  /* 静态：判为静止，UI 才会给「静止帧」标记、不做无意义的 hover 播放 */
  assert.equal(byName.get("ADBE Ramp").frames, 24);
  assert.equal(byName.get("ADBE Ramp").animated, false);
  assert.equal(byName.get("BCC_GLOW").animated, false);

  /* 动态：不在索引里的条目照常判为动画，不能因为修静态误伤真动图 */
  assert.equal(byName.get("ADBE Gaussian Blur").animated, true);
});

test("animated.json 缺失或损坏时回退到 frames>1，不把动图当静图", () => {
  const { paths } = makeWorkspace();

  const before = new Map(effects.list(paths).items.map((item) => [item.matchName, item]));
  assert.equal(before.get("ADBE Gaussian Blur").animated, true);
  assert.equal(before.get("ADBE Ramp").animated, true);
  assert.equal(before.get("BCC_GLOW").animated, true);

  fs.writeFileSync(path.join(paths.dataDir, "animated.json"), "{not json", "utf8");
  const after = new Map(effects.list(paths).items.map((item) => [item.matchName, item]));
  assert.equal(after.get("ADBE Gaussian Blur").animated, true);
  assert.equal(after.get("ADBE Ramp").animated, true);
});

test("animated.json 里 animated:true 与已不存在的条目不影响判定", () => {
  const { paths } = makeWorkspace();
  writeJson(path.join(paths.dataDir, "animated.json"), {
    version: 1,
    items: [
      /* 构建器只写 false；显式 true 不应被当成静态，也不该覆盖 frames 判定 */
      { matchName: "ADBE Ramp", animated: true },
      /* 清单里已经没有这条（例如取消渲染过），不能让它污染其它条目 */
      { matchName: "ADBE Removed", animated: false },
      { matchName: "", animated: false },
      null,
    ],
  });

  const byName = new Map(effects.list(paths).items.map((item) => [item.matchName, item]));
  assert.equal(byName.get("ADBE Ramp").animated, true);
  assert.equal(byName.get("ADBE Gaussian Blur").animated, true);
});

test("缺少当前预览版本的旧效果预览会被标记为待重渲", () => {
  const { paths } = makeWorkspace();
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8"));
  delete manifest.items[0].effectPreviewVersion;
  writeJson(path.join(paths.dataDir, "manifest.json"), manifest);

  const item = effects.list(paths).items.find((entry) => entry.matchName === "ADBE Gaussian Blur");
  assert.equal(item.previewCurrent, false);
  assert.equal(item.status, "pending");
  assert.equal(item.reason, "legacy_preview");
});

test("版本号正确但帧数不是 24 的预览仍会被判为旧预览", () => {
  const { paths } = makeWorkspace();
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "manifest.json"), "utf8"));
  manifest.items[0].effectPreviewVersion = 2;
  manifest.items[0].frames = 6;
  writeJson(path.join(paths.dataDir, "manifest.json"), manifest);

  const item = effects.list(paths).items.find((entry) => entry.matchName === "ADBE Gaussian Blur");
  assert.equal(item.previewCurrent, false);
  assert.equal(item.status, "pending");
});
