/* Convert user-rendered preset PNG frame sequences to static WebP sequences. */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const previewPaths = require("./preview_paths");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1), "utf8");
  fs.renameSync(temp, file);
}

function expandFrames(paths, template, count) {
  const files = [];
  const text = String(template || "");
  for (let index = 0; index < Math.max(1, Number(count) || 1); index++) {
    const relative = text.replace("%04d", String(index).padStart(4, "0"));
    const file = previewPaths.resolveFile(paths, relative);
    if (!file || !fs.existsSync(file)) return [];
    files.push(file);
  }
  return files;
}

async function convertPresetPreviews(paths, options = {}) {
  const manifestPath = paths.presetPluginManifest;
  const manifest = readJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.items)) return { ok: true, converted: 0 };
  const quality = Math.max(1, Math.min(100, Number(options.quality) || 80));
  let converted = 0;
  for (const item of manifest.items) {
    if (!item || !item.path || /\.webp$/i.test(String(item.frameSrc || ""))) continue;
    let sourceTemplate = String(item.rawFrameSrc || item.frameSrc || item.src || "");
    if (sourceTemplate && !sourceTemplate.includes("%04d") && Number(item.frames) > 1) {
      sourceTemplate = sourceTemplate.replace(/_0000\.png$/i, "_%04d.png");
    }
    if (!/\.png$/i.test(sourceTemplate)) continue;
    const sourceFiles = expandFrames(paths, sourceTemplate, item.frames);
    if (!sourceFiles.length) continue;
    const folder = String(item.folder || "preset");
    const relativeDir = String(item.frameSrc || "")
      .replace(/\\/g, "/")
      .replace(/^previews\//, "")
      .split("/")
      .slice(0, -1)
      .join("/");
    const logicalDir = relativeDir || `presets/${folder}`;
    const base = path.basename(sourceTemplate).replace(/_%04d\.png$/i, "");
    const outputDir = path.dirname(sourceFiles[0]);
    const stillIndex = Math.max(0, Math.min(sourceFiles.length - 1, Number(item.stillFrame) || 0));
    const outputNames = new Set();
    for (let index = 0; index < sourceFiles.length; index++) {
      const outputName = `${base}_${String(index).padStart(4, "0")}.webp`;
      const output = path.join(outputDir, outputName);
      outputNames.add(outputName.toLowerCase());
      await sharp(sourceFiles[index]).webp({ quality, effort: 4 }).toFile(output);
    }
    item.rawFrameSrc = sourceTemplate;
    item.src = `previews/${logicalDir}/${base}_0000.webp`;
    item.frameSrc = `previews/${logicalDir}/${base}_%04d.webp`;
    item.stillSrc = `previews/${logicalDir}/${base}_${String(stillIndex).padStart(4, "0")}.webp`;
    item.stillFrame = stillIndex;
    item.format = "webp-sequence";
    delete item.webpSrc;
    for (const source of sourceFiles) {
      try { fs.unlinkSync(source); } catch { /* keep source if locked */ }
    }
    for (const name of fs.readdirSync(outputDir)) {
      if (!name.toLowerCase().startsWith(base.toLowerCase() + "_")) continue;
      if (!/\.(png|webp)$/i.test(name)) continue;
      if (outputNames.has(name.toLowerCase())) continue;
      try { fs.unlinkSync(path.join(outputDir, name)); } catch { /* 文件被占用时留到下次处理 */ }
    }
    converted++;
  }
  if (converted) writeJsonAtomic(manifestPath, manifest);
  return { ok: true, converted };
}

module.exports = { convertPresetPreviews };
