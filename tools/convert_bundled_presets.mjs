#!/usr/bin/env node
/* ============================================================
 * convert_bundled_presets.mjs —— 把安装包自带预设的帧序列转成单文件动画
 *
 * 与 Hub 运行时那条路径（渲染完成后调 IPC）用的是同一个合并器，
 * 只是这里直接对着 dist/ 的产物工作，不需要 AE、不需要重渲：
 * 帧文件已在 dist/previews/bundled/presets 下，合并后原地替换索引。
 *
 * 用法：node tools/convert_bundled_presets.mjs [--limit N] [--dry-run]
 * ============================================================ */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { rmSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { mergePresetPreviews } = require("../hub/core/preset_anim_merger.js");

const limitIdx = process.argv.indexOf("--limit");
const dryRun = process.argv.includes("--dry-run");
const limit = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : 0;

/* 构建期只需要 dataDir 兜底；预览根目录显式指向 dist，
   这样逻辑路径 "previews/bundled/presets/..." 会落到 dist/previews/bundled/presets/... */
const paths = { dataDir: resolve(ROOT, "dist") };

const started = Date.now();
const result = await mergePresetPreviews(paths, {
  manifestFile: resolve(ROOT, "dist/presets/manifest.json"),
  /* previewRoot 是「包含 effects/、bundled/ 的那一层」，即 dist/previews */
  previewRoot: resolve(ROOT, "dist/previews"),
  quality: 80,
  /* 帧文件先挪进回收目录，最后一次性删除（逐个删在 Windows 上慢两个数量级） */
  trashDir: resolve(ROOT, "dist/_trash"),
  dryRun,
  limit,
});

rmSync(resolve(ROOT, "dist/_trash"), { recursive: true, force: true });
console.log(`预设合并：${result.merged} 个转成动画，${result.skipped} 个保持原样（单帧或帧不全）`);
if (result.failed.length) {
  console.log(`失败 ${result.failed.length} 个：`);
  for (const f of result.failed.slice(0, 8)) console.log("  -", f.name, "|", f.reason);
}
console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s${dryRun ? "（dry-run，未写盘）" : ""}`);
