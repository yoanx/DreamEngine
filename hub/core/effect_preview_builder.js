const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const { encodeAnimatedWebp } = require("./preview_codec");
const { createPluginResolver } = require("./effects");

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
  const root = path.resolve(paths.dataDir);
  const full = path.resolve(root, String(relative || "").replace(/\//g, path.sep));
  return full.startsWith(root + path.sep) ? full : "";
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
  if (resolvePlugin) {
    return safeFileStem(resolvePlugin(item, fallbackName), fallbackName);
  }
  return safeFileStem(
    item && item.plugin,
    fallbackName,
  );
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
  if (!builtin || !plugin) return;
  const thumbs = path.join(paths.dataDir, "thumbs");
  if (!fs.existsSync(thumbs)) return;

  const referenced = new Set();
  const unresolved = new Set();
  for (const doc of [builtin, plugin]) {
    for (const item of (doc && doc.items) || []) {
      if (!item) continue;
      const rawFiles = rawFilesForItem(paths, item);
      for (const file of rawFiles) referenced.add(path.resolve(file).toLowerCase());
      const webp = item.webpSrc ? dataFile(paths, item.webpSrc) : "";
      if (webp && fs.existsSync(webp)) continue;
      for (const file of rawFiles) {
        unresolved.add(path.resolve(file).toLowerCase());
      }
    }
  }

  for (const name of fs.readdirSync(thumbs)) {
    if (!/^batch_.*\.png$/i.test(name)) continue;
    const file = path.join(thumbs, name);
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

function cleanupUnreferencedWebp(paths, builtin, plugin) {
  if (!builtin || !plugin) return;
  const folder = path.join(paths.dataDir, "thumbs", "webp");
  if (!fs.existsSync(folder)) return;
  const legacyName = /^(?:builtin|plugin)_[0-9a-f]{16}(?:_still)?\.webp$/i;

  const referenced = new Set();
  for (const doc of [builtin, plugin]) {
    for (const item of (doc && doc.items) || []) {
      if (!item) continue;
      for (const relative of [item.webpSrc, item.stillSrc]) {
        const file = dataFile(paths, relative);
        if (file) referenced.add(path.resolve(file).toLowerCase());
      }
    }
  }

  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!/\.webp$/i.test(entry.name)) continue;
      if (referenced.has(path.resolve(file).toLowerCase())) continue;
      const relative = path.relative(folder, file);
      const rootLevel = relative && !relative.includes(path.sep);
      if (!legacyName.test(entry.name) && !rootLevel) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        /* 文件被占用时留到下次处理 */
      }
    }
  };
  visit(folder);
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
  const files = frameFiles(paths, item);
  if (!files.length) return null;
  const frames = await cropFrames(files, cropGeometry(item, manifest));
  const fps = Math.max(1, Number(item.fps) || 24);
  const qualityValue = Math.max(1, Math.min(100, Number(quality) || 80));
  const pluginName = previewPluginName(item, prefix, resolvePlugin);
  const folder = path.join(paths.dataDir, "thumbs", "webp", pluginName);
  const stillFolder = path.join(folder, "stills");
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(stillFolder, { recursive: true });
  const base = previewBaseName(item, prefix);
  const stillIndex = Math.floor(frames.length / 2);
  const webpFile = path.join(folder, `${base}.webp`);
  const stillFile = path.join(stillFolder, `${base}.webp`);
  const still = await sharp(frames[stillIndex]).webp({ quality: qualityValue }).toBuffer();

  let pages = 1;
  if (frames.length > 1) {
    const metadata = await sharp(frames[0]).metadata();
    const animated = await encodeAnimatedWebp(frames, {
      width: metadata.width,
      height: metadata.height,
      fps,
      quality: qualityValue,
    });
    pages = Number((await sharp(animated, { animated: true }).metadata()).pages) || 1;
    fs.writeFileSync(webpFile, animated);
    fs.writeFileSync(stillFile, still);
  } else {
    fs.writeFileSync(webpFile, still);
    fs.writeFileSync(stillFile, still);
  }
  item.webpSrc = `thumbs/webp/${pluginName}/${base}.webp`;
  item.stillSrc = `thumbs/webp/${pluginName}/stills/${base}.webp`;
  item.stillFrame = stillIndex;
  return { pages };
}

async function buildManifest(paths, file, manifest, prefix, quality, resolvePlugin, changed) {
  if (!manifest || !Array.isArray(manifest.items)) return 0;
  let built = 0;
  for (const item of manifest.items) {
    const preview = await writePreview(paths, item, manifest, prefix, quality, resolvePlugin);
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
