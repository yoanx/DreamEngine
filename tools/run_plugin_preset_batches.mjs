#!/usr/bin/env node
/* ============================================================
 * run_plugin_preset_batches.mjs —— 含插件预设预览的批量驱动（自动多轮）
 *
 * 为什么必须离线：面板与 AE 同进程，插件混渲会直接杀掉用户正在用的 AE。
 * 本脚本每轮拉起一个**专用 AE 实例**，逐条隔离渲染；插件把 AE 搞崩也只
 * 影响这一轮，未配对的 BEGIN 会在下一轮自动拉黑并跳过。
 *
 * 用法（先保存并关闭 AE）：
 *   node tools/run_plugin_preset_batches.mjs [--background photo] [--limit 40]
 *        [--rounds 40] [--timeout 240] [--force]
 *
 *   --background 内置 5 种（photo/text/solid/shape/pattern）或自定义图片绝对路径
 *   --force      连面板已经生成过的预设也重新渲一遍
 *
 * 每轮结束都会从 TSV 重新生成面板要读的 data/preset_plugin_manifest.json，
 * 随时 Ctrl+C 可停，下次再跑从断点继续。
 * ============================================================ */

import {
  readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { bestAfterFX } = require(resolve(ROOT, "hub/core/ae.js"));
const { createPaths } = require(resolve(ROOT, "hub/core/paths.js"));
const previewPaths = require(resolve(ROOT, "hub/core/preview_paths.js"));
const PROBE = resolve(homedir(), "Documents/DreamEngineProbe");
const PRESET_DIR = resolve(homedir(), "Documents/DreamEngine/presets");
const RUNTIME_DATA = resolve(
  process.env.APPDATA || "",
  "Adobe/CEP/extensions/com.dreamengine.panel/data",
);

const TODO = resolve(PROBE, "next_preset_plugin_batch.tsv");
const BG_FILE = resolve(PROBE, "preset_plugin_background.txt");
const LOG = resolve(PROBE, "preset_plugin_run.log");
const ENTRIES = resolve(PROBE, "preset_plugin_previews.tsv");
const BLACKLIST = resolve(PROBE, "preset_plugin_blacklist.tsv");
const PANEL_INDEX = resolve(RUNTIME_DATA, "preset_manifest.json");
const PLUGIN_INDEX = resolve(RUNTIME_DATA, "preset_plugin_manifest.json");
const SCRIPT = resolve(ROOT, "tools/run_plugin_preset_preview.jsx");
const PATHS = createPaths({
  docsDir: resolve(homedir(), "Documents"),
  appData: process.env.APPDATA || undefined,
});
const PREVIEW_ROOT = previewPaths.currentRoot(PATHS);
const PREVIEW_ROOT_FILE = resolve(PROBE, "preset_preview_root.txt");

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}
const limit = Number(arg("--limit", "40")) || 40;
const maxRounds = Number(arg("--rounds", "40")) || 40;
const timeoutSec = Number(arg("--timeout", "240")) || 240;
const background = arg("--background", "") || defaultBackground();
const force = process.argv.indexOf("--force") > 0;
const AE = arg("--ae", bestAfterFX());

if (!existsSync(AE)) {
  console.error("找不到 AE：" + AE);
  process.exit(1);
}
if (!existsSync(PRESET_DIR)) {
  console.error("预设库目录不存在：" + PRESET_DIR);
  process.exit(1);
}
mkdirSync(PROBE, { recursive: true });
writeFileSync(PREVIEW_ROOT_FILE, PREVIEW_ROOT + "\\r\\n", "utf8");

function logLines() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split(/\r?\n/).filter((l) => l.trim());
}

function aeRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"], {
      encoding: "utf8",
    });
    return out.indexOf("AfterFX.exe") >= 0;
  } catch (e) {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readTsv(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split("\t"));
}

/** 库里的 .ffx（支持一层子目录），路径统一成正斜杠 */
function collectPresets() {
  const out = [];
  function walk(dir, depth) {
    if (depth > 2) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.ffx$/i.test(name)) out.push(p.replace(/\\/g, "/"));
    }
  }
  walk(PRESET_DIR, 0);
  return out.sort();
}

function donePaths() {
  const set = new Set();
  for (const row of readTsv(ENTRIES)) {
    if (row.length < 3 || !row[1] || !/^\d+$/.test(row[2])) continue;
    const animated = row[4] === "true";
    const duration = Number(row[9]) || 0;
    const fps = Number(row[10]) || 0;
    if (!animated || (duration > 0 && fps >= 6)) set.add(row[1]);
  }
  return set;
}

function blacklistPaths() {
  const set = new Set();
  for (const row of readTsv(BLACKLIST)) {
    if (row[0] && row[0] !== "matchName") set.add(row[0]);
  }
  return set;
}

/** 没显式传 --background 时，跟随面板最后一次生成预览所用的背景 */
function defaultBackground() {
  if (!existsSync(PANEL_INDEX)) return "photo";
  try {
    const j = JSON.parse(readFileSync(PANEL_INDEX, "utf8"));
    const items = j.items || [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].background) return items[i].background;
    }
  } catch (e) {}
  return "photo";
}

/** 面板里已经生成过的内置预设，离线不必重渲（--force 可覆盖） */
function panelDonePaths() {
  if (force || !existsSync(PANEL_INDEX)) return new Set();
  try {
    const j = JSON.parse(readFileSync(PANEL_INDEX, "utf8"));
    return new Set((j.items || []).map((i) => String(i.path || "").replace(/\\/g, "/")));
  } catch (e) {
    return new Set();
  }
}

function bestStillFrame(folder, base, frames, ext = "png") {
  const fallback = Math.max(0, Math.floor(frames / 2));
  const dir = resolve(PREVIEW_ROOT, "presets", folder || "");
  let best = fallback;
  let bestSize = -1;
  for (let i = 0; i < frames; i++) {
    const file = join(dir, `${base}_${String(i).padStart(4, "0")}.${ext}`);
    if (!existsSync(file)) continue;
    const size = statSync(file).size;
    if (size > bestSize) {
      best = i;
      bestSize = size;
    }
  }
  return best;
}
function frameExtension(folder, base, frames) {
  const dir = resolve(PREVIEW_ROOT, "presets", folder || "");
  for (let i = 0; i < Math.max(1, frames); i++) {
    if (existsSync(join(dir, `${base}_${String(i).padStart(4, "0")}.webp`))) return "webp";
  }
  return "png";
}
/** 从 TSV 生成面板读的独立索引（面板的 preset_manifest.json 不动） */
function buildPluginIndex() {
  const byPath = new Map();
  for (const row of readTsv(ENTRIES)) {
    if (row.length < 9 || row[0].charAt(0) === "#") continue;
    const sheet = Number(row[2]);
    if (!Number.isFinite(sheet)) continue;
    const base = "preset_" + String(sheet).padStart(3, "0");
    const cellSize = Number(row[11]) === 360 ? 360 : 720;
    const folder = String(row[12] || "");
    const prefix = folder ? `previews/presets/${folder}/` : "previews/presets/";
    const frames = Number(row[3]) || 1;
    const frameExt = frameExtension(folder, base, frames);
    const stillFrame = bestStillFrame(folder, base, frames, frameExt);
    byPath.set(row[1], {
      name: row[0],
      path: row[1],
      sheet,
      folder,
      src: `${prefix}${base}_0000.${frameExt}`,
      frameSrc: `${prefix}${base}_%04d.${frameExt}`,
      stillSrc: `${prefix}${base}_${String(stillFrame).padStart(4, "0")}.${frameExt}`,
      stillFrame,
      frames,
      format: frameExt === "webp" ? "webp-sequence" : "png",
      animated: row[4] === "true",
      keyStart: Number(row[5]) || 0,
      keyEnd: Number(row[6]) || 0,
      duration: Number(row[9]) || 0,
      fps: Number(row[10]) || 0,
      background: row[7] || "photo",
      plugins: row[8] ? Array.from(new Set(row[8].split(",").filter(Boolean))) : [],
      plugin: true,
      sliceColumns: 1,
      sliceCellSize: cellSize,
      sliceWidth: cellSize,
      sliceHeight: cellSize,
      x: 0,
      y: 0,
      width: cellSize,
      height: cellSize,
    });
  }
  const items = Array.from(byPath.values());
  writeFileSync(PLUGIN_INDEX, JSON.stringify({ version: 1, items }, null, 1), "utf8");
  return items.length;
}

/* ---------- 安全红线：绝不在用户 AE 开着的时候拉起实例 ---------- */
if (aeRunning()) {
  console.error(
    "检测到 AE 正在运行。插件预设渲染会让 AE 进程崩溃，\n" +
    "请先保存工程并完全关闭 AE，再运行本脚本。",
  );
  process.exit(1);
}

const panelDone = panelDonePaths();
let totalOk = 0;
let totalFail = 0;

for (let round = 1; round <= maxRounds; round++) {
  // 上一轮渲完 app.quit，但退出要几秒；等不干净就直接杀（这是本脚本拉起的实例）
  if (aeRunning()) {
    let waited = 0;
    while (aeRunning() && waited < 8) {
      sleep(2000);
      waited += 2;
    }
    if (aeRunning()) {
      try { execFileSync("taskkill", ["/IM", "AfterFX.exe", "/F"], { stdio: "ignore" }); } catch (e) {}
      sleep(2000);
    }
  }

  const done = donePaths();
  const black = blacklistPaths();
  const candidates = collectPresets().filter(
    (p) => !done.has(p) && !black.has(p) && !panelDone.has(p),
  );
  if (!candidates.length) {
    // 幂等刷新一次索引（格式更新 / 插件名单去重），不启动 AE
    buildPluginIndex();
    console.log(`第 ${round} 轮：没有待渲的预设，收工。`);
    break;
  }

  const batch = candidates.slice(0, limit);
  writeFileSync(TODO, batch.join("\n") + "\n", "utf8");
  writeFileSync(BG_FILE, background, "utf8");

  const before = logLines().length;
  const child = spawn(AE, ["-r", SCRIPT], { detached: true, stdio: "ignore" });
  child.unref();

  const startedAt = Date.now();
  const roundTimeoutMs = Math.max(timeoutSec, batch.length * 30) * 1000;
  let crashed = false;
  while (true) {
    sleep(4000);
    const lines = logLines();
    if (lines.length > before && lines[lines.length - 1].indexOf("RESULT") === 0) break;
    if (!aeRunning()) { crashed = true; break; }
    if (Date.now() - startedAt > roundTimeoutMs) {
      console.error(`第 ${round} 轮超时，终止 AE 继续。`);
      try { execFileSync("taskkill", ["/IM", "AfterFX.exe", "/F"], { stdio: "ignore" }); } catch (e) {}
      break;
    }
  }

  const fresh = logLines().slice(before);
  let ok = 0;
  let fail = 0;
  const failed = [];
  for (const line of fresh) {
    if (line.indexOf("OK|") === 0) ok++;
    else if (line.indexOf("FAIL|") === 0) {
      fail++;
      failed.push(line.split("|")[1].split("/").pop());
    }
  }
  totalOk += ok;
  totalFail += fail;
  const indexed = buildPluginIndex();
  console.log(
    `第 ${round} 轮：请求 ${batch.length} 条，成功 ${ok}，失败 ${fail}` +
      `，索引累计 ${indexed} 条` +
      (crashed ? "（AE 进程消失，下一轮自动拉黑崩溃条目）" : "") +
      (failed.length ? " 失败：" + failed.slice(0, 3).join("、") : ""),
  );
  if (!ok && !fail) {
    console.log("本轮没有产出（可能 AE 启动失败），停一下再看。");
    break;
  }
}

console.log(`\n累计：成功 ${totalOk}，失败 ${totalFail}`);
console.log("索引：" + PLUGIN_INDEX);
console.log("日志：" + LOG);
