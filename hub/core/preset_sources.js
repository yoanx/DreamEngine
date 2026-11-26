/* ============================================================
 * preset_sources.js —— AE 外部预设索引（只读，不复制文件）
 *
 * 数据来源（按所选 AE 版本）：
 *   1. <AE 安装目录>\Support Files\Presets   （自带的 .ffx 预设，含插件厂商预设包）
 *   2. <我的文档>\Adobe\After Effects <年份>\User Presets
 *
 * 扫描结果写到 <Probe>/preset_catalog.json，Hub 预设库读取并合并展示；
 * 文件本身不进 DreamEngine 预设库，不复制、不修改。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

const VERSION = 1;
const CATALOG_TTL_MS = 10 * 60 * 1000;

function readCatalog(paths) {
  try {
    const doc = JSON.parse(fs.readFileSync(paths.presetCatalog, "utf8").replace(/^\uFEFF/, ""));
    if (!doc || doc.version !== VERSION || !Array.isArray(doc.items)) return null;
    return doc;
  } catch {
    return null;
  }
}

function writeCatalog(paths, doc) {
  fs.mkdirSync(paths.probe, { recursive: true });
  const text = JSON.stringify(doc, null, 1) + "\r\n";
  fs.writeFileSync(paths.presetCatalog, text, "utf8");
}

function normalize(value) {
  return String(value || "").replace(/\\/g, "/");
}

/** 从 AfterFX.exe 反推安装目录、Presets 目录、年份 */
function describeAe(aeExe) {
  const exe = path.resolve(String(aeExe || ""));
  const support = path.dirname(exe);
  const install = path.dirname(support);
  const installName = path.basename(install);
  const yearMatch = installName.match(/(\d{4})/);
  return {
    exe,
    support,
    install,
    installName,
    year: yearMatch ? Number(yearMatch[1]) : 0,
    installPresets: path.join(support, "Presets"),
  };
}

function walkFfx(dir, callback, depth) {
  if ((depth || 0) > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFfx(full, callback, (depth || 0) + 1);
    } else if (entry.isFile() && /\.ffx$/i.test(entry.name)) {
      callback(full);
    }
  }
}

function scanRoot(rootPath, kind, items, seen) {
  if (!rootPath) return 0;
  let stat;
  try {
    stat = fs.statSync(rootPath);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return 0;

  let count = 0;
  const rootNormalized = normalize(path.resolve(rootPath));
  walkFfx(rootPath, (full) => {
    const normalized = normalize(path.resolve(full));
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    let fileStat;
    try {
      fileStat = fs.statSync(full);
    } catch {
      return;
    }
    const relative = normalized.substring(rootNormalized.length + 1);
    const parts = relative.split("/");
    const source = kind === "user"
      ? "用户预设"
      : parts.length > 1
        ? parts[0]
        : "AE 内置";
    items.push({
      path: normalized,
      name: path.basename(full).replace(/\.ffx$/i, ""),
      fileName: path.basename(full),
      relative,
      /* 相对扫描根的文件夹路径（不含文件名）：用户预设靠它分层展示 */
      folderPath: parts.slice(0, -1).join("/"),
      source,
      sourceKind: kind,
      size: fileStat.size,
      mtime: fileStat.mtimeMs,
    });
    count++;
  });
  return count;
}

/**
 * 扫描所选 AE 版本的预设目录并写 preset_catalog.json。
 * @param {ReturnType<import("./paths").createPaths>} paths
 * @param {{aeExe?: string, force?: boolean}} [options]
 */
function scanAePresets(paths, options = {}) {
  const aeExe = String(options.aeExe || "");
  if (!aeExe) return { ok: false, reason: "no_ae" };
  const ae = describeAe(aeExe);
  const cached = readCatalog(paths);
  if (!options.force && cached && normalize(cached.aeExe).toLowerCase() === normalize(ae.exe).toLowerCase()) {
    const scanned = Date.parse(cached.scannedAt || "");
    if (Number.isFinite(scanned) && Date.now() - scanned < CATALOG_TTL_MS) {
      return { ...cached, ok: true, cached: true };
    }
  }

  const userPresets = ae.year
    ? path.join(paths.docsDir, "Adobe", `After Effects ${ae.year}`, "User Presets")
    : "";
  const items = [];
  const seen = new Set();
  const installCount = scanRoot(ae.installPresets, "install", items, seen);
  const userCount = scanRoot(userPresets, "user", items, seen);
  items.sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source, "zh");
    return a.name.localeCompare(b.name, "zh");
  });

  const doc = {
    version: VERSION,
    aeExe: normalize(ae.exe),
    aeVersion: String(ae.year || ""),
    aeMajor: ae.year || 0,
    scannedAt: new Date().toISOString(),
    count: items.length,
    roots: [
      {
        kind: "install",
        path: normalize(ae.installPresets),
        exists: installCount >= 0 && fs.existsSync(ae.installPresets),
        count: installCount,
      },
      {
        kind: "user",
        path: normalize(userPresets),
        exists: userPresets ? fs.existsSync(userPresets) : false,
        count: userCount,
      },
    ],
    items,
  };
  writeCatalog(paths, doc);
  return { ...doc, ok: true, cached: false };
}

/** 判断某个 .ffx 是否在当前外部目录索引里 */
function isExternalPreset(paths, fullPath) {
  const catalog = readCatalog(paths);
  if (!catalog) return false;
  const key = normalize(path.resolve(String(fullPath || ""))).toLowerCase();
  return (catalog.items || []).some((item) => normalize(item.path).toLowerCase() === key);
}

module.exports = {
  VERSION,
  readCatalog,
  writeCatalog,
  scanAePresets,
  isExternalPreset,
  describeAe,
};
