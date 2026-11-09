/* ============================================================
 * catalog.js —— 插件效果目录（AE 扫描产物）的读取与选择校验
 *
 * 数据来源：<Probe>/plugin_effect_catalog.tsv（AE 内脚本写出）
 *   matchName \t displayName \t category \t plugin \t excluded \t reason \t noPreview
 *
 * Hub 只读文件、不碰 AE：
 *   · 目录本身由专用 AE 实例扫描生成（见 tools/generate_plugin_effects.ps1 -CatalogOnly）
 *   · 已生成 / 已跳过状态从现有两份索引合并出来
 *   · 用户勾选后写 next_plugin_batch.tsv，交给 ps1 的 -Todo 模式
 *
 * 本文件不依赖 electron，可脱离 GUI 用 Node 直接测。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

const CATALOG_HEADER = [
  "matchName",
  "displayName",
  "category",
  "plugin",
  "excluded",
  "reason",
  "noPreview",
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

/** names.json：matchName -> { nameEn, nameZh, categoryEn, categoryZh } */
function readNames(paths) {
  const map = new Map();
  const doc = readJson(path.join(paths.dataDir, "names.json"));
  for (const item of (doc && doc.items) || []) {
    if (item && item.matchName) map.set(item.matchName, item);
  }
  return map;
}

/** plugin_manifest.json：已生成预览的 matchName 集合 */
function readRendered(paths) {
  const set = new Set();
  const doc = readJson(paths.pluginManifest);
  for (const item of (doc && doc.items) || []) {
    if (item && item.matchName) set.add(item.matchName);
  }
  return set;
}

/** plugin_blacklist.json：matchName -> reason */
function readBlacklist(paths) {
  const map = new Map();
  const doc = readJson(path.join(paths.dataDir, "plugin_blacklist.json"));
  for (const item of (doc && doc.items) || []) {
    if (item && item.matchName) map.set(item.matchName, item.reason || "crash");
  }
  return map;
}

function statusFor(excluded, noPreview, blacklist, rendered, matchName) {
  if (excluded) return { status: "excluded", reason: "" };
  if (noPreview) return { status: "no_preview", reason: "no_preview" };
  if (blacklist.has(matchName)) {
    return { status: "blacklisted", reason: blacklist.get(matchName) || "crash" };
  }
  if (rendered.has(matchName)) return { status: "rendered", reason: "" };
  return { status: "pending", reason: "" };
}

function countStatuses(items) {
  const counts = {
    total: items.length,
    pending: 0,
    rendered: 0,
    blacklisted: 0,
    excluded: 0,
    noPreview: 0,
  };
  for (const item of items) {
    if (item.status === "rendered") counts.rendered++;
    else if (item.status === "blacklisted") counts.blacklisted++;
    else if (item.status === "excluded") counts.excluded++;
    else if (item.status === "no_preview") counts.noPreview++;
    else counts.pending++;
  }
  return counts;
}

/**
 * 只读扫描元信息（AE 版本 / 扫描时间 / 条数），供属性获取等旁路流程使用。
 * @param {ReturnType<import("./paths").createPaths>} paths
 */
function readCatalogMeta(paths) {
  const meta = readJson(paths.pluginCatalogMeta) || {};
  return {
    ok: Object.keys(meta).length > 0,
    aeExe: String(meta.aeExe || ""),
    aeVersion: String(meta.aeVersion || ""),
    aeMajor: Number(meta.aeMajor) || 0,
    scannedAt: String(meta.scannedAt || ""),
    count: Number(meta.count) || 0,
  };
}

/**
 * 只读 catalog TSV 的原始行（保持文件行序）与扫描元信息。
 * readCatalog 与效果库共用这一份解析，避免两处各写一遍、顺序悄悄漂移。
 * @param {ReturnType<import("./paths").createPaths>} paths
 */
function readCatalogRows(paths) {
  const result = {
    ok: false,
    reason: "no_catalog",
    path: paths.pluginCatalog,
    scannedAt: "",
    aeMajor: 0,
    aeVersion: "",
    rows: [],
  };

  let stat;
  try {
    stat = fs.statSync(paths.pluginCatalog);
  } catch {
    return result;
  }

  const text = readText(paths.pluginCatalog);
  const meta = readJson(paths.pluginCatalogMeta) || {};
  const rows = [];
  let skippedHeader = false;

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const cells = line.split("\t");
    if (!skippedHeader && cells[0] === "matchName") {
      skippedHeader = true;
      continue;
    }
    skippedHeader = true;
    const matchName = String(cells[0] || "");
    if (!matchName) continue;

    rows.push({
      matchName,
      displayName: String(cells[1] || ""),
      category: String(cells[2] || ""),
      plugin: String(cells[3] || "其它插件"),
      excluded: cells[4] === "1",
      reason: String(cells[5] || ""),
      noPreview: cells[6] === "1",
    });
  }

  return {
    ok: true,
    reason: "",
    path: paths.pluginCatalog,
    scannedAt: String(meta.scannedAt || new Date(stat.mtimeMs).toISOString()),
    aeMajor: Number(meta.aeMajor) || 0,
    aeVersion: String(meta.aeVersion || ""),
    rows,
  };
}

/**
 * 读取目录并合并状态。
 * @param {ReturnType<import("./paths").createPaths>} paths
 */
function readCatalog(paths) {
  const empty = {
    ok: false,
    reason: "no_catalog",
    scannedAt: "",
    aeMajor: 0,
    aeVersion: "",
    counts: { total: 0, pending: 0, rendered: 0, blacklisted: 0, excluded: 0, noPreview: 0 },
    items: [],
  };

  const catalogRows = readCatalogRows(paths);
  if (!catalogRows.ok) return empty;

  const names = readNames(paths);
  const rendered = readRendered(paths);
  const blacklist = readBlacklist(paths);
  const items = [];

  for (const row of catalogRows.rows) {
    const matchName = row.matchName;
    const state = statusFor(row.excluded, row.noPreview, blacklist, rendered, matchName);
    const nameRecord = names.get(matchName) || {};

    items.push({
      matchName,
      displayName: row.displayName,
      nameEn: String(nameRecord.nameEn || row.displayName || matchName),
      nameZh: String(nameRecord.nameZh || ""),
      category: row.category,
      categoryEn: String(nameRecord.categoryEn || ""),
      categoryZh: String(nameRecord.categoryZh || ""),
      plugin: row.plugin,
      status: state.status,
      reason: state.status === "excluded" ? row.reason || "excluded" : state.reason,
      frames: 6,
      selectable: state.status !== "excluded" && state.status !== "no_preview",
    });
  }

  items.sort((a, b) => {
    if (a.plugin !== b.plugin) return a.plugin.localeCompare(b.plugin, "zh");
    const ac = a.categoryZh || a.category;
    const bc = b.categoryZh || b.category;
    if (ac !== bc) return ac.localeCompare(bc, "zh");
    return (a.nameZh || a.nameEn).localeCompare(b.nameZh || b.nameEn, "zh");
  });

  return {
    ok: true,
    scannedAt: catalogRows.scannedAt,
    aeMajor: catalogRows.aeMajor,
    aeVersion: catalogRows.aeVersion,
    counts: countStatuses(items),
    items,
  };
}

/**
 * 把用户勾选的 matchName 转成可渲染集合。
 * @param {object} catalog readCatalog 的返回值
 * @param {string[]} matchNames
 * @param {boolean} force 强制重渲（允许 rendered / blacklisted）
 */
function filterSelection(catalog, matchNames, force) {
  const byName = new Map();
  for (const item of (catalog && catalog.items) || []) byName.set(item.matchName, item);

  const selected = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of matchNames || []) {
    const matchName = String(raw || "");
    if (!matchName || seen.has(matchName)) continue;
    seen.add(matchName);
    const item = byName.get(matchName);
    if (!item) {
      skipped.push({ matchName, status: "unknown" });
      continue;
    }
    if (!item.selectable) {
      skipped.push({ matchName, status: item.status, reason: item.reason });
      continue;
    }
    if (!force && (item.status === "rendered" || item.status === "blacklisted")) {
      skipped.push({ matchName, status: item.status, reason: item.reason });
      continue;
    }
    selected.push(item);
  }

  return { selected, skipped };
}

/**
 * 运行计划的选择模式：undefined 才是全量；显式空数组仍然是一次选集，
 * 只是这次没有可渲染目标，不能悄悄退化成全量。
 */
function planSelection(catalog, matchNames, force) {
  if (!Array.isArray(matchNames)) {
    return { mode: "all", selected: [], skipped: [] };
  }
  const result = filterSelection(catalog, matchNames, force);
  return { mode: "selection", selected: result.selected, skipped: result.skipped };
}

/** 写选择文件（无表头，格式与 run_plugin_preview.jsx 的 legacy 模式一致） */
function writeSelection(paths, items) {
  const rows = [];
  for (const item of items || []) {
    const matchName = String(item.matchName || "").replace(/[\t\r\n]/g, " ");
    if (!matchName) continue;
    rows.push(
      [
        matchName,
        String(Number(item.frames) || 6),
        String(item.plugin || "其它插件").replace(/[\t\r\n]/g, " "),
      ].join("\t"),
    );
  }
  fs.mkdirSync(paths.probe, { recursive: true });
  fs.writeFileSync(paths.pluginSelection, rows.join("\r\n") + (rows.length ? "\r\n" : ""), "utf8");
  return rows.length;
}

module.exports = {
  CATALOG_HEADER,
  readCatalog,
  readCatalogRows,
  readCatalogMeta,
  filterSelection,
  planSelection,
  writeSelection,
  readNames,
  readRendered,
  readBlacklist,
  countStatuses,
};
