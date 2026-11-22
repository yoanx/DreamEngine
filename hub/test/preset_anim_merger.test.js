const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { mergePresetPreviews } = require("../core/preset_anim_merger");
const { createPaths } = require("../core/paths");
const previewPaths = require("../core/preview_paths");

function makePaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const paths = createPaths({
    docsDir: path.join(root, "docs"),
    appData: path.join(root, "appdata"),
  });
  return { root, paths };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1), "utf8");
}

async function makeFrames(dir, base, count, size = 16) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let index = 0; index < count; index++) {
    const file = path.join(dir, `${base}_${String(index).padStart(4, "0")}.webp`);
    await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: `#${(index * 37 % 200 + 30).toString(16).padStart(2, "0")}3355`,
      },
    })
      .webp()
      .toFile(file);
    files.push(file);
  }
  return files;
}

test("预设帧序列合并成单文件动画，并改写索引", async () => {
  const { paths } = makePaths("de-preset-anim-");
  const frameDir = path.join(previewPaths.currentRoot(paths), "bundled", "presets", "demo");
  const files = await makeFrames(frameDir, "preset_900", 3);

  const relative = files.map((file) => {
    const rel = path.relative(previewPaths.currentRoot(paths), file).split(path.sep).join("/");
    return `previews/${rel}`;
  });

  writeJson(path.join(paths.dataDir, "preset_plugin_manifest.json"), {
    version: 1,
    items: [{
      name: "demo",
      path: "C:/presets/demo.ffx",
      frames: 3,
      fps: 24,
      src: relative[0],
      frameSrc: relative[0].replace("_0000", "_%04d"),
      format: "webp-sequence",
      animated: true,
    }],
  });

  const result = await mergePresetPreviews(paths, { quality: 80 });
  assert.equal(result.ok, true);
  assert.equal(result.merged, 1);
  assert.deepEqual(result.failed, []);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(paths.dataDir, "preset_plugin_manifest.json"), "utf8"),
  );
  const item = manifest.items[0];
  assert.equal(item.format, "webp-animated");
  assert.equal(item.frameSrc, undefined, "合并后不应再留帧模板");
  assert.match(item.webpSrc, /demo\/preset_900\.webp$/);
  assert.match(item.stillSrc, /demo\/preset_900_still\.webp$/);
  assert.equal(item.frames, 3);

  const animFile = previewPaths.resolveFile(paths, item.webpSrc);
  const meta = await sharp(animFile, { animated: true }).metadata();
  assert.equal(meta.pages, 3, "三帧应合成一个三页动画");
  assert.ok(fs.existsSync(previewPaths.resolveFile(paths, item.stillSrc)), "封面要单独存");

  // 帧文件在合并成功后清理
  for (const file of files) assert.equal(fs.existsSync(file), false, "旧帧应被删除");
});

test("帧不全时保持原样，不误删也不改索引", async () => {
  const { paths } = makePaths("de-preset-anim-skip-");
  const frameDir = path.join(previewPaths.currentRoot(paths), "bundled", "presets", "partial");
  await makeFrames(frameDir, "preset_901", 1);

  const rel = "previews/bundled/presets/partial/preset_901_%04d.webp";
  writeJson(path.join(paths.dataDir, "preset_plugin_manifest.json"), {
    version: 1,
    items: [{
      name: "partial",
      frames: 3,
      src: rel.replace("_%04d", "_0000"),
      frameSrc: rel,
      format: "webp-sequence",
    }],
  });

  const result = await mergePresetPreviews(paths, { quality: 80 });
  assert.equal(result.merged, 0);
  assert.equal(result.skipped, 1);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(paths.dataDir, "preset_plugin_manifest.json"), "utf8"),
  );
  assert.equal(manifest.items[0].frameSrc, rel, "跳过时索引必须原样保留");
  assert.equal(manifest.items[0].webpSrc, undefined);
});
