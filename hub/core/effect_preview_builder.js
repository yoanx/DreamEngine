const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const { createPluginResolver } = require("./effects");
const previewPaths = require("./preview_paths");
const previewNames = require("./preview_names");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 1), "utf8");
}

function dataFile(paths, relative) {
  const direct = previewPaths.resolveFile(paths, relative);
  if (direct && fs.existsSync(direct)) return direct;
  const raw = String(relative || "").replace(/\\/g, "/").replace(/^previews\//i, "");
  if (!raw) return direct;
  const candidates = [];
  if (raw.indexOf("effects/") === 0) {
    candidates.push(path.join(paths.dataDir, "thumbs", raw.slice("effects/".length)));
  }
  candidates.push(path.join(paths.dataDir, "thumbs", raw));
  candidates.push(path.join(paths.dataDir, raw));
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return direct;
}

function safeFileStem(value, fallback) {
  let stem = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!stem) stem = String(fallback || "effect");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = "_" + stem;
  if (stem.length > 120) stem = stem.slice(0, 120).replace(/[. ]+$/g, "");
  return stem || "effect";
}

/* matchName 是效果的稳定唯一标识；同一效果重渲必须落到同一个文件名。 */
function previewBaseName(item, fallback) {
  return safeFileStem(
    item && (item.matchName || item.displayName || item.name),
    fallback || "effect",
  );
}

function previewPluginName(item, fallback, resolvePlugin) {
  const fallbackName = fallback === "builtin" ? "内置" : "其它插件";
  const plugin = resolvePlugin
    ? resolvePlugin(item, fallbackName)
    : (item && item.plugin);
  return previewNames.effectFolder(plugin || fallbackName);
}

function rawFilesForItem(paths, item) {
  const output = new Set();
  const add = (relative) => {
    const file = dataFile(paths, relative);
    if (file) output.add(file);
  };
  const template = String(item.frameSrc || item.src || "");
  if (template) {
    const frames = Math.max(1, Number(item.frames) || 1);
    if (template.includes("%04d")) {
      for (let index = 0; index < frames; index++) {
        add(template.replace("%04d", String(index).padStart(4, "0")));
      }
    } else {
      add(template);
    }
  }
  if (item.src && item.src !== item.frameSrc) add(item.src);
  return output;
}

function cleanupIntermediatePngs(paths, builtin, plugin, options = {}) {
  // 渲染脚本正在写 manifest 时 readJson 会失败；此时不能把未归属的 PNG
  // 当成孤儿删掉，等下一批状态更新再重试。
  if (!builtin && !plugin) return;
  // 已生成 WebP 帧序列的条目可以安全删除原始 PNG 帧。
  for (const doc of [builtin, plugin]) {
    for (const item of (doc && doc.items) || []) {
      if (!item || !String(item.frameSrc || "").toLowerCase().endsWith(".webp")) continue;
      const rawTemplate = String(item.rawFrameSrc || "");
      if (!rawTemplate) continue;
      const rawPngs = [...rawFilesForItem(paths, { frameSrc: rawTemplate, frames: item.frames })];
      const webpFrames = [...rawFilesForItem(paths, item)];
      if (!webpFrames.length || !webpFrames.every((file) => fs.existsSync(file))) continue;
      for (const file of rawPngs) {
        try { fs.unlinkSync(file); } catch { /* 文件被占用时留到下次处理 */ }
      }
    }
  }

  const roots = [...new Set([
    path.resolve(paths.dataDir, "thumbs"),
    path.resolve(previewPaths.currentRoot(paths), "effects"),
  ])];

  const referenced = new Set();
  const unresolved = new Set();
  for (const doc of [builtin, plugin]) {
    for (const item of (doc && doc.items) || []) {
      if (!item) continue;
      const rawFiles = rawFilesForItem(paths, item);
      for (const file of rawFiles) referenced.add(path.resolve(file).toLowerCase());
      if (!rawFiles.length || !rawFiles.every((file) => fs.existsSync(file))) {
        for (const file of rawFiles) unresolved.add(path.resolve(file).toLowerCase());
      }
    }
  }

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!/^batch_.*\.png$/i.test(name)) continue;
      const file = path.join(root, name);
      const key = path.resolve(file).toLowerCase();
      if (!referenced.has(key) && options.cleanupOrphans !== true) continue;
      if (unresolved.has(key)) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        /* 文件被占用时留到下次处理 */
      }
    }
  }
}

function cleanupUnreferencedWebp(paths, builtin, plugin) {
  if (!builtin && !plugin) return;
  const folders = [...new Set([
    path.resolve(paths.dataDir, "thumbs", "webp"),
    path.resolve(previewPaths.currentRoot(paths), "effects", "webp"),
  ])];
  const legacyName = /^(?:builtin|plugin)_[0-9a-f]{16}(?:_still)?\.webp$/i;

  const referenced = new Set();
  for (const doc of [builtin, plugin]) {
    for (const item of (doc && doc.items) || []) {
      if (!item) continue;
      for (const relative of [item.webpSrc, item.stillSrc]) {
        const file = dataFile(paths, relative);
        if (file) referenced.add(path.resolve(file).toLowerCase());
      }
      for (const file of rawFilesForItem(paths, item)) {
        referenced.add(path.resolve(file).toLowerCase());
      }
    }
  }

  const visit = (dir, base) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file, base);
        continue;
      }
      if (!/\.webp$/i.test(entry.name)) continue;
      if (referenced.has(path.resolve(file).toLowerCase())) continue;
      const relative = path.relative(base, file);
      const rootLevel = relative && !relative.includes(path.sep);
      if (!legacyName.test(entry.name) && !rootLevel) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        /* 文件被占用时留到下次处理 */
      }
    }
  };
  for (const folder of folders) visit(folder, folder);
}

function readStaticPreviewNames(paths) {
  const still = new Set();
  const file = path.join(paths.dataDir, "animated.json");
  const data = readJson(file, null);
  for (const item of (data && data.items) || []) {
    if (item && item.matchName && item.animated === false) still.add(item.matchName);
  }
  return still;
}

function updateAnimationIndex(paths, builtin, plugin, changed) {
  const still = readStaticPreviewNames(paths);
  for (const [matchName, pages] of changed) {
    if (pages <= 1) still.add(matchName);
    else still.delete(matchName);
  }
  const current = new Set();
  for (const doc of [builtin, plugin]) {
    for (const item of (doc && doc.items) || []) {
      if (item && item.matchName) current.add(item.matchName);
    }
  }
  const index = {
    version: 1,
    items: [...still]
      .filter((matchName) => current.has(matchName))
      .map((matchName) => ({ matchName, animated: false })),
  };
  fs.writeFileSync(
    path.join(paths.dataDir, "animated.json"),
    JSON.stringify(index, null, 1),
    "utf8",
  );
}

function frameFiles(paths, item) {
  const template = String(item.frameSrc || item.src || "");
  if (!template) return [];
  const frames = Math.max(1, Number(item.frames) || 1);
  if (!template.includes("%04d")) {
    const file = dataFile(paths, template);
    return file && fs.existsSync(file) ? [file] : [];
  }
  const output = [];
  for (let index = 0; index < frames; index++) {
    const file = dataFile(paths, template.replace("%04d", String(index).padStart(4, "0")));
    if (!file || !fs.existsSync(file)) return [];
    output.push(file);
  }
  return output;
}

function cropGeometry(item, manifest) {
  return {
    left: Math.max(0, Number(item.x) || 0),
    top: Math.max(0, Number(item.y) || 0),
    width: Math.max(1, Number(item.width) || Number(manifest.cellSize) || 720),
    height: Math.max(1, Number(item.height) || Number(manifest.cellSize) || 720),
  };
}

async function cropFrames(files, geometry) {
  const output = [];
  for (const file of files) {
    output.push(
      await sharp(file)
        .extract(geometry)
        .png()
        .toBuffer(),
    );
  }
  return output;
}

async function writePreview(paths, item, manifest, prefix, quality, resolvePlugin) {
  // 已经是 WebP 序列且没有原始 PNG 时直接复用；否则会把裁好的单帧
  // 再按旧拼图坐标裁一次，导致重启 Hub 后预览错位。
  if (item && !item.rawFrameSrc && /\.webp$/i.test(String(item.frameSrc || ""))) return null;
  if (!item.rawFrameSrc && /\.png$/i.test(String(item.frameSrc || item.src || ""))) {
    item.rawFrameSrc = String(item.frameSrc || item.src);
  }
  const inputItem = item.rawFrameSrc ? { ...item, frameSrc: item.rawFrameSrc } : item;
  const files = frameFiles(paths, inputItem);
  if (!files.length) return null;
  const frames = await cropFrames(files, cropGeometry(item, manifest));
  const qualityValue = Math.max(1, Math.min(100, Number(quality) || 80));
  const pluginName = previewPluginName(item, prefix, resolvePlugin);
  const folder = path.join(previewPaths.currentRoot(paths), "effects", "webp", pluginName);
  const framesFolder = path.join(folder, "frames");
  const stillFolder = path.join(folder, "stills");
  fs.mkdirSync(framesFolder, { recursive: true });
  fs.mkdirSync(stillFolder, { recursive: true });
  const base = previewBaseName(item, prefix);
  const stillIndex = Math.floor(frames.length / 2);
  const stillFile = path.join(stillFolder, `${base}.webp`);
  const still = await sharp(frames[stillIndex]).webp({ quality: qualityValue }).toBuffer();
  for (let index = 0; index < frames.length; index++) {
    const frameFile = path.join(framesFolder, `${base}_${String(index).padStart(4, "0")}.webp`);
    fs.writeFileSync(frameFile, await sharp(frames[index]).webp({ quality: qualityValue }).toBuffer());
  }
  fs.writeFileSync(stillFile, still);
  item.src = previewPaths.logicalValue("effects", `webp/${pluginName}/frames/${base}_0000.webp`);
  item.frameSrc = previewPaths.logicalValue("effects", `webp/${pluginName}/frames/${base}_%04d.webp`);
  item.stillSrc = previewPaths.logicalValue("effects", `webp/${pluginName}/stills/${base}.webp`);
  item.stillFrame = stillIndex;
  item.frames = frames.length;
  item.format = "webp-sequence";
  delete item.webpSrc;
  return { pages: frames.length };
}

/**
 * 旧版本把效果预览存成单张动画 WebP。新版统一存静态 WebP 帧序列，
 * 没有原始 PNG 时直接从动画 WebP 的每一页拆帧，避免用户升级后预览消失。
 */
async function extractExistingWebp(paths, item, manifest, prefix, quality, resolvePlugin) {
  if (!item || !item.webpSrc) return null;
  if (String(item.frameSrc || "").toLowerCase().endsWith(".webp")) return null;
  const source = dataFile(paths, item.webpSrc);
  if (!source || !fs.existsSync(source)) return null;
  const previousCache = sharp.cache();
  sharp.cache({ memory: previousCache.memory.max, files: 0, items: previousCache.items.max });
  let metadata;
  try {
    metadata = await sharp(source, { animated: true }).metadata();
  } catch {
    restoreSharpCache(previousCache);
    return null;
  }
  const pages = Math.max(1, Number(metadata && metadata.pages) || 1);
  const qualityValue = Math.max(1, Math.min(100, Number(quality) || 80));
  const pluginName = previewPluginName(item, prefix, resolvePlugin);
  const folder = path.join(previewPaths.currentRoot(paths), "effects", "webp", pluginName);
  const framesFolder = path.join(folder, "frames");
  const stillFolder = path.join(folder, "stills");
  fs.mkdirSync(framesFolder, { recursive: true });
  fs.mkdirSync(stillFolder, { recursive: true });
  const base = previewBaseName(item, prefix);
  const stillIndex = Math.min(
    pages - 1,
    Math.max(0, Number.isFinite(Number(item.stillFrame)) ? Number(item.stillFrame) : Math.floor(pages / 2)),
  );
  const oldStill = dataFile(paths, item.stillSrc);
  const stillFile = path.join(stillFolder, `${base}.webp`);
  for (let index = 0; index < pages; index++) {
    const frameFile = path.join(framesFolder, `${base}_${String(index).padStart(4, "0")}.webp`);
    await sharp(source, { page: index, pages: 1 })
      .webp({ quality: qualityValue, effort: 4 })
      .toFile(frameFile);
  }
  if (oldStill && fs.existsSync(oldStill) && path.resolve(oldStill) !== path.resolve(stillFile)) {
    fs.copyFileSync(oldStill, stillFile);
  } else {
    await sharp(source, { page: stillIndex, pages: 1 })
      .webp({ quality: qualityValue, effort: 4 })
      .toFile(stillFile);
  }
  item.src = previewPaths.logicalValue("effects", `webp/${pluginName}/frames/${base}_0000.webp`);
  item.frameSrc = previewPaths.logicalValue("effects", `webp/${pluginName}/frames/${base}_%04d.webp`);
  item.stillSrc = previewPaths.logicalValue("effects", `webp/${pluginName}/stills/${base}.webp`);
  item.stillFrame = stillIndex;
  item.frames = pages;
  item.format = "webp-sequence";
  delete item.webpSrc;
  for (const file of [source, oldStill]) {
    if (!file || path.resolve(file) === path.resolve(stillFile)) continue;
    await removeFileWithRetry(file);
  }
  restoreSharpCache(previousCache);
  return { pages };
}

function restoreSharpCache(cache) {
  sharp.cache({
    memory: cache.memory.max,
    files: cache.files.max,
    items: cache.items.max,
  });
}

async function removeFileWithRetry(file) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  return false;
}

async function buildManifest(paths, file, manifest, prefix, quality, resolvePlugin, changed) {
  if (!manifest || !Array.isArray(manifest.items)) return 0;
  let built = 0;
  for (const item of manifest.items) {
    const preview = await writePreview(paths, item, manifest, prefix, quality, resolvePlugin) ||
      await extractExistingWebp(paths, item, manifest, prefix, quality, resolvePlugin);
    if (preview) {
      built++;
      changed.set(item.matchName, preview.pages);
    }
  }
  writeJson(file, manifest);
  return built;
}

async function buildEffectPreviews(paths, options = {}) {
  const builtinFile = path.join(paths.dataDir, "manifest.json");
  const pluginFile = paths.pluginManifest || path.join(paths.dataDir, "plugin_manifest.json");
  const builtin = readJson(builtinFile, null);
  const plugin = readJson(pluginFile, null);
  const resolvePlugin = createPluginResolver(paths);
  const changed = new Map();
  let built = 0;
  if (builtin) {
    built += await buildManifest(
      paths, builtinFile, builtin, "builtin", options.quality, resolvePlugin, changed,
    );
  }
  if (plugin) {
    built += await buildManifest(
      paths, pluginFile, plugin, "plugin", options.quality, resolvePlugin, changed,
    );
  }
  if (options.cleanupRaw !== false) cleanupIntermediatePngs(paths, builtin, plugin, options);
  cleanupUnreferencedWebp(paths, builtin, plugin);
  if (changed.size) updateAnimationIndex(paths, builtin, plugin, changed);
  return { ok: true, built };
}

module.exports = { buildEffectPreviews };
