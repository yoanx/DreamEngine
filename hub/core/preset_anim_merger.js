/* ============================================================
 * preset_anim_merger.js —— 把预设的帧序列合并成单文件动画
 *
 * 预设渲染仍由 AE 产出单帧图（PNG 或 WebP），本模块在渲染完成后
 * 把它们合成「一个预设 = 一个动画 WebP」，并把索引改成 webpSrc 形态，
 * 面板据此按单文件播放（与效果侧同一套读取逻辑）。
 *
 * 只在用户选择「WebP 动画文件」时调用；PNG/WebP 序列模式完全不碰。
 * ============================================================ */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const previewPaths = require("./preview_paths");
const { mergeWebpBuffers } = require("./webp_anim");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

/** "previews/xxx" → <previewRoot>/xxx */
function rootOf(paths, options) {
  return options && options.previewRoot
    ? path.resolve(options.previewRoot)
    : previewPaths.currentRoot(paths);
}

function diskPath(paths, logical, options) {
  const rel = String(logical || "").replace(/\\/g, "/").replace(/^previews\//i, "");
  return path.join(rootOf(paths, options), rel);
}

function frameList(paths, item, options) {
  const template = String(item.frameSrc || "");
  const count = Math.max(1, Number(item.frames) || 1);
  if (!template) {
    const single = item.src ? diskPath(paths, item.src, options) : "";
    return single && fs.existsSync(single) ? [single] : [];
  }
  const files = [];
  for (let index = 0; index < count; index++) {
    const rel = template.replace("%04d", String(index).padStart(4, "0"));
    const file = diskPath(paths, rel, options);
    if (!fs.existsSync(file)) return [];
    files.push(file);
  }
  return files;
}

/**
 * @param {import('./paths').Paths} paths
 * @param {{ manifestFile?: string, quality?: number, fps?: number, dryRun?: boolean }} [options]
 */
async function mergePresetPreviews(paths, options = {}) {
  const manifestFile = options.manifestFile || path.join(paths.dataDir, "preset_plugin_manifest.json");
  const data = readJson(manifestFile, null);
  if (!data || !Array.isArray(data.items)) {
    return { ok: true, merged: 0, skipped: 0, failed: [], reason: "no_manifest" };
  }
  const quality = Math.max(1, Math.min(100, Number(options.quality) || 80));
  /* Windows 上 sharp 会一直持有文件句柄，不关掉缓存则 unlink 报 EPERM。
     效果侧构建器踩过同一个坑（那里叫 restoreSharpCache）。 */
  const previousCache = sharp.cache();
  sharp.cache({ memory: previousCache.memory.max, files: 0, items: previousCache.items.max });
  let merged = 0;
  let skipped = 0;
  const limit = Number(options.limit) || 0;
  const failed = [];

  for (const item of data.items) {
    if (!item || !item.matchName && !item.name) continue;

    const files = frameList(paths, item, options);
    /* 单帧或帧不全：保持原样，交给原有序列路径显示 */
    if (files.length <= 1) {
      skipped++;
      continue;
    }
    if (limit && (merged + failed.length) >= limit) break;
    if (limit && (merged + failed.length) >= limit) break;
    const label = item.matchName || item.name;
    try {
      const frameDir = path.dirname(files[0]);
      const base = path.basename(files[0]).replace(/_\d+\.(png|webp)$/i, "");
      const animFile = path.join(frameDir, `${base}.webp`);

      /* 帧本来就是 WebP 时直接复用码流，不重编码（重编码会慢几十倍并且掉画质）；
         只有 PNG 之类的源才走 sharp 编码。 */
      const buffers = [];
      for (const file of files) {
        if (/.webp$/i.test(file)) {
          buffers.push(fs.readFileSync(file));
        } else {
          buffers.push(await sharp(file).webp({ quality }).toBuffer());
        }
      }
      const meta = await sharp(files[0]).metadata();
      const fps = Number(item.fps) || Number(options.fps) || 24;
      const bytes = mergeWebpBuffers(buffers, {
        width: Number(meta.width) || 720,
        height: Number(meta.height) || 720,
        delayMs: 1000 / fps,
      });
      if (!options.dryRun) fs.writeFileSync(animFile, bytes);

      /* 预设预览在 previews/bundled/presets/... 下，'bundled' 不是 preview_paths
         认可的类别（只有 effects/presets），所以这里不能走 logicalValue，
         直接按「previewRoot 相对路径 + previews/ 前缀」拼，与索引里既有写法一致。 */
      const animLogical = toLogical(paths, animFile, options);
      const stillIndex = Math.min(
        files.length - 1,
        Math.max(0, Number.isFinite(Number(item.stillFrame)) ? Number(item.stillFrame) : Math.floor(files.length / 2)),
      );

      /* 封面单独存一份：如果直接用动画文件当封面，面板就分不清「静止」
         和「播放」，悬停语义会丢。 */
      const stillFile = path.join(frameDir, `${base}_still.webp`);
      if (!options.dryRun) {
        const stillBytes = await sharp(files[stillIndex]).webp({ quality }).toBuffer();
        fs.writeFileSync(stillFile, stillBytes);
      }
      const stillLogical = animLogical.replace(/[^/]+$/, `${base}_still.webp`);

      item.webpSrc = animLogical;
      item.src = stillLogical;
      item.stillSrc = stillLogical;
      item.stillFrame = stillIndex;
      item.frames = files.length;
      item.fps = fps;
      item.format = "webp-animated";
      item.animated = true;
      delete item.frameSrc;

      /* 合并成功后再删帧文件：中途失败还能回退到序列形态 */
      if (!options.dryRun) {
        /* Windows 上逐个 unlink 极慢（Defender 实时扫描，实测 239ms/个），
           rename 只要 9ms，所以先挪进回收目录，由调用方最后一次性删。 */
        for (const file of files) {
          if (options.trashDir) await moveToTrash(file, options.trashDir);
          else await removeWithRetry(file);
        }
      }
      merged++;
    } catch (error) {
      failed.push({ name: label, reason: String((error && error.message) || error) });
    }
  }

  if (!options.dryRun && merged > 0) {
    fs.writeFileSync(manifestFile, JSON.stringify(data, null, 1), "utf8");
  }
  return { ok: true, merged, skipped, failed };
}

/** 挪进回收目录（同一卷内 rename 不产生数据拷贝，比逐个 unlink 快一个数量级） */
async function moveToTrash(file, trashDir) {
  try {
    const target = path.join(trashDir, path.basename(path.dirname(file)));
    fs.mkdirSync(target, { recursive: true });
    fs.renameSync(file, path.join(target, path.basename(file)));
    return true;
  } catch {
    return removeWithRetry(file);
  }
}

/** 删除文件，失败重试（句柄释放有延迟） */
async function removeWithRetry(file) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  return false;
}

/** 绝对路径 → 索引里的逻辑路径（previews/ 开头） */
function toLogical(paths, file, options) {
  const root = rootOf(paths, options);
  const rel = path.relative(root, path.resolve(file)).split(path.sep).join("/");
  return "previews/" + rel;
}

module.exports = { mergePresetPreviews };
