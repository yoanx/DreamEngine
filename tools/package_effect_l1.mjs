#!/usr/bin/env node
/* ============================================================
 * package_effect_l1.mjs —— L1 内置效果打包（单文件动画形态）
 *
 * 历史：旧版把每个效果拆成 N 个帧文件并重编码到 q80；现已统一为
 *       「一个效果 = 一个动画 WebP + 一张封面」，码流原样复用、零重编码
 *
 * 源数据有两种形态，本脚本都吃：
 *   ① item.webpSrc 已经是动画 WebP  → 原样复制
 *   ② item.frameSrc 是 %04d 帧模板 → 逐帧取码流合并成动画
 * 内置条目通常在 data/manifest.json，插件条目在 data/plugin_manifest.json，
 * 两个文件都会读（旧脚本优先取 plugin_manifest.json，会把内置条目全漏掉）。
 *
 * 用法：
 *   node tools/package_effect_l1_anim.mjs [dataDir] [outDir] [previewDir] [--limit N] [--fps 24]
 * ============================================================ */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { existingFrames, mergeFramesToAnimatedWebp } from "./lib/webp_anim.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { createPaths } = require("../hub/core/paths");
const { createPluginResolver } = require("../hub/core/effects");
const sharp = require("../hub/node_modules/sharp");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
function opt(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const LIMIT = Number(opt("limit", 0));
const FPS = Number(opt("fps", 24));

const DATA_DIR = resolve(args[0] || join(
  process.env.APPDATA || "", "Adobe", "CEP", "extensions", "com.dreamengine.panel", "data"));
const OUT_DIR = resolve(args[1] || join(ROOT, "dist", "L1"));
const PREVIEW_DIR = resolve(args[2] || join(ROOT, "dist", "previews"));
const TARGET_DIR = join(PREVIEW_DIR, "effects", "webp", "builtin");

const fail = (m) => { console.error(m); process.exit(1); };
const readJson = (f) => JSON.parse(readFileSync(f, "utf8").replace(/^\uFEFF/, ""));

function safeStem(value, fallback) {
  let stem = String(value || "").trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!stem) stem = String(fallback || "effect");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = "_" + stem;
  if (stem.length > 120) stem = stem.slice(0, 120).replace(/[. ]+$/g, "");
  return stem || "effect";
}

/* 内置条目在 manifest.json，插件条目在 plugin_manifest.json —— 两个都要读 */
const sourceFiles = ["manifest.json", "plugin_manifest.json"]
  .map((f) => join(DATA_DIR, f))
  .filter(existsSync);
if (!sourceFiles.length) fail(`缺少 manifest.json / plugin_manifest.json（${DATA_DIR}）`);

const sources = sourceFiles.map((f) => ({ file: f, data: readJson(f) }));
const baseMeta = sources.find((s) => basename(s.file) === "manifest.json")?.data || sources[0].data;

const paths = createPaths();
paths.dataDir = DATA_DIR;
const resolvePlugin = createPluginResolver(paths);

/* 内置 + 至少有一种预览源；帧数不再限制为 24 */
let items = sources
  .flatMap((s) => s.data.items || [])
  /* 清单里的 plugin 字段是权威：L1 清单里的条目本来就是内置包选中的，
     Keylight、VISINF 这类会被分类器按名单判成第三方，但确实打包过。
     只有清单没标时才回落到分类器判断。 */
  .filter((item) => item
    && (item.plugin === "内置" || resolvePlugin(item, "其它插件") === "内置")
    && (item.webpSrc || item.frameSrc) && item.stillSrc);
if (LIMIT > 0) items = items.slice(0, LIMIT);
if (!items.length) fail("没有找到带 webpSrc/frameSrc + stillSrc 的内置条目");

rmSync(TARGET_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(TARGET_DIR, "anim"), { recursive: true });
mkdirSync(join(TARGET_DIR, "stills"), { recursive: true });

/* 路径兜底：老版本把 内置/其它插件 写成中文目录 */
const resolveUnder = (rel) => [
  join(DATA_DIR, rel),
  join(DATA_DIR, rel.replace("thumbs/webp/builtin/", "thumbs/webp/内置/")),
  join(DATA_DIR, rel.replace("thumbs/webp/builtin/", "thumbs/webp/其它插件/")),
  join(PREVIEW_DIR, String(rel).replace(/^previews\//, "")),
].find(existsSync) || null;

const packaged = [];
let animatedCount = 0, staticCount = 0, mergedCount = 0, copiedCount = 0, skipped = 0;
let srcBytes = 0;

for (const item of items) {
  const base = safeStem(item.matchName, "effect");
  const stillRel = `previews/effects/webp/builtin/stills/${base}.webp`;
  const stillAbs = join(PREVIEW_DIR, stillRel.replace(/^previews\//, ""));

  const stillFile = resolveUnder(item.stillSrc);
  if (stillFile) copyFileSync(stillFile, stillAbs);
  else await sharp(resolveUnder(item.webpSrc) || resolveUnder(item.frameSrc.replace("%04d", "0000")))
    .webp({ quality: 80 }).toFile(stillAbs);

  let webpRel = "", pages = 1, source = "";

  /* ① 源就是动画 WebP：原样复制 */
  const animSource = item.webpSrc ? resolveUnder(item.webpSrc) : null;
  if (animSource) {
    const meta = await sharp(animSource, { animated: true }).metadata();
    pages = Math.max(1, Number(meta && meta.pages) || 1);
    if (pages > 1) {
      webpRel = `previews/effects/webp/builtin/anim/${base}.webp`;
      copyFileSync(animSource, join(PREVIEW_DIR, webpRel.replace(/^previews\//, "")));
      srcBytes += statSync(animSource).size;
      copiedCount++;
      source = "copy";
    }
  }

  /* ② 源是帧序列：逐帧取码流合并 */
  if (!webpRel && item.frameSrc) {
    const frames = existingFrames(item.frameSrc, Number(item.frames) || 64, resolveUnder);
    pages = Math.max(1, frames.length);
    if (frames.length > 1) {
      webpRel = `previews/effects/webp/builtin/anim/${base}.webp`;
      const animAbs = join(PREVIEW_DIR, webpRel.replace(/^previews\//, ""));
      const merged = await mergeFramesToAnimatedWebp(frames, {
        fps: Number(item.fps) || FPS,
        outFile: animAbs,
      });
      srcBytes += frames.reduce((s, f) => s + statSync(f).size, 0);
      mergedCount++;
      source = "merge";
      if (merged.pages !== pages) pages = merged.pages;
    } else if (frames.length === 0) {
      skipped++;
    }
  }

  if (webpRel) animatedCount++; else staticCount++;

  packaged.push({
    ...item,
    plugin: "内置",
    src: stillRel,
    stillSrc: stillRel,
    stillFrame: 0,
    webpSrc: webpRel || undefined,
    frameSrc: undefined,
    frames: pages,
    fps: Number(item.fps) || FPS,
    effectPreviewVersion: 2,
    format: webpRel ? "webp-animated" : "webp-still",
    key: item.key || "l1:" + item.matchName,
    _source: source,
  });
}

for (const it of packaged) delete it._source;

const manifest = {
  version: 3,
  aeMajor: Number(baseMeta.aeMajor) || 0,
  cellSize: Number(baseMeta.cellSize) || 720,
  columns: Number(baseMeta.columns) || 1,
  width: Number(baseMeta.width) || 720,
  height: Number(baseMeta.height) || 720,
  sheets: [],
  items: packaged,
};
writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

const stillList = packaged.filter((i) => Number(i.frames) <= 1)
  .map((i) => ({ matchName: i.matchName, animated: false }));
writeFileSync(join(OUT_DIR, "animated.json"),
  JSON.stringify({ version: 1, items: stillList }, null, 1), "utf8");

const namesFile = join(DATA_DIR, "names.json");
if (existsSync(namesFile)) copyFileSync(namesFile, join(OUT_DIR, "names.json"));

/* 保留旧列结构，避免读取方解析失败；单文件形态下 frameTemplate 为空 */
const tsv = ["matchName\tsheet\tcell\tframes\tframeTemplate\tkey\taeMajor"];
for (const it of packaged) {
  tsv.push([it.matchName, "0", "0", String(it.frames), "", it.key, String(baseMeta.aeMajor || 0)].join("\t"));
}
writeFileSync(join(OUT_DIR, "previews.tsv"), tsv.join("\r\n"), "utf8");

let files = 0, bytes = 0;
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else { files++; bytes += statSync(full).size; }
  }
})(TARGET_DIR);

writeFileSync(join(OUT_DIR, "build-report.json"), JSON.stringify({
  format: "webp-animated-single-file",
  items: packaged.length,
  animated: animatedCount,
  staticOnly: staticCount,
  copiedFromAnimatedSource: copiedCount,
  mergedFromFrames: mergedCount,
  framesMissing: skipped,
  files,
  bytes,
  sourceBytes: srcBytes,
  recompressed: false,
  source: DATA_DIR,
  generatedAt: new Date().toISOString(),
}, null, 2) + "\n", "utf8");

console.log(`动画形态打包：${packaged.length} 个效果（动画 ${animatedCount} / 静态 ${staticCount}）`);
console.log(`  其中 源动画复制 ${copiedCount}，帧序列合并 ${mergedCount}，无帧跳过 ${skipped}`);
console.log(`产出 ${files} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MiB（源 ${(srcBytes / 1024 / 1024).toFixed(1)} MiB，未重编码）`);
console.log(`索引：${OUT_DIR}/manifest.json`);
