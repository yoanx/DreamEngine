/* ============================================================
 * effect_param_cache.js —— 插件效果参数树的分组缓存
 *
 * 数据来源：tools/dump_plugin_effect_params.ps1 把每个效果的参数树写到
 *   <probe>/effect_params_raw/<stamp>/<safe>/p0_dump.tsv
 * 并下一份 meta.json（matchName / plugin / category / aeVersion / fetchedAt）。
 *
 * 缓存位置：<userRoot>/effect_params/<safe plugin>__<safe category>.tsv
 * 每个效果一节：
 *   ## matchName: ADBE Glo2
 *   ## aeVersion: 25.0
 *   ## aeMajor: 2025
 *   ## fetchedAt: 2026-11-09T...
 *   ## count: 12
 *   <p0_dump.tsv 的数据行，列见文件头 # columns:>
 *
 * 只依赖 node:fs / node:path；写文件走「临时文件 + rename」的原子替换。
 * mergeRound 是幂等的：Hub 每完成一批就会调用一次，重复合并不会长重复行。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const { parseDump } = require("./manual_effect");

const CACHE_VERSION = 1;
const COLUMNS = [
  "indexPath",
  "path",
  "name",
  "type",
  "value",
  "canAnimate",
  "hasMin",
  "min",
  "hasMax",
  "max",
  "aux",
  "safe",
  "reason",
];
const UNKNOWN_PLUGIN = "unknown";
const UNKNOWN_CATEGORY = "uncategorized";

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch (_error) {
    return "";
  }
}

function cleanCell(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

/** 文件名里的一段：去掉路径非法字符，空白转下划线，保留中文等 Unicode 字符。 */
function safePart(value, fallback) {
  const text = String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .slice(0, 60);
  return text || fallback;
}

function cacheDir(paths) {
  return paths && paths.effectParamsRoot ? paths.effectParamsRoot : "";
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (_error) {
    // Windows 上目标被占用时偶尔会失败；删掉旧文件再重试一次。
    try { fs.rmSync(file, { force: true }); } catch (_ignored) { /* ignore */ }
    fs.renameSync(tmp, file);
  }
}

/** 解析一个分组缓存文件（只做一次线性扫描，不重复 parse 大文件）。 */
function parseCacheFile(text) {
  const header = {
    version: CACHE_VERSION,
    plugin: "",
    category: "",
    columns: COLUMNS.slice(),
  };
  const sections = [];
  let current = null;
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith("## ")) {
      const body = line.slice(3);
      const colon = body.indexOf(":");
      const key = (colon >= 0 ? body.slice(0, colon) : body).trim();
      const value = colon >= 0 ? body.slice(colon + 1).trim() : "";
      if (key === "matchName") {
        current = {
          matchName: value,
          aeVersion: "",
          aeMajor: "",
          fetchedAt: "",
          rows: [],
        };
        sections.push(current);
      } else if (current) {
        current[key] = value;
      }
      continue;
    }
    if (line.startsWith("# ")) {
      if (current) continue;
      const body = line.slice(2);
      const colon = body.indexOf(":");
      const key = (colon >= 0 ? body.slice(0, colon) : body).trim().toLowerCase();
      const value = colon >= 0 ? body.slice(colon + 1).trim() : "";
      if (key === "plugin") header.plugin = value;
      else if (key === "category") header.category = value;
      else if (key === "columns") {
        const columns = value.split("\t").map((cell) => cell.trim()).filter(Boolean);
        if (columns.length) header.columns = columns;
      } else if (key === "version") {
        header.version = Number(value) || CACHE_VERSION;
      }
      continue;
    }
    if (current) current.rows.push(line);
  }
  return { header, sections };
}

function serializeCacheFile(plugin, category, sections) {
  const out = [];
  out.push("# version: " + CACHE_VERSION);
  out.push("# plugin: " + cleanCell(plugin));
  out.push("# category: " + cleanCell(category));
  out.push("# columns: " + COLUMNS.join("\t"));
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    out.push("## matchName: " + cleanCell(section.matchName));
    out.push("## aeVersion: " + cleanCell(section.aeVersion));
    out.push("## aeMajor: " + cleanCell(section.aeMajor));
    out.push("## fetchedAt: " + cleanCell(section.fetchedAt));
    out.push("## count: " + section.rows.length);
    for (let r = 0; r < section.rows.length; r++) out.push(section.rows[r]);
  }
  return out.join("\r\n") + "\r\n";
}

function listCacheFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".tsv"))
      .sort();
  } catch (_error) {
    return [];
  }
}

/** 由解析结果生成参数行：valueType 规则沿用 manual_effect.parseDump。 */
function toParam(row) {
  const indexPath = String(row.indexPath || "");
  const type = String(row.type || "unknown");
  const valueType = String(row.valueType || "text");
  const parts = String(row.path || "").split(" / ");
  let group = parts.length && parts[0] ? parts[0] : "";
  if (!group) {
    const segments = indexPath.split(".");
    group = segments.length ? segments[0] : "";
  }
  return {
    indexPath,
    path: row.path,
    name: row.name,
    type,
    value: row.value,
    valueText: row.valueText,
    valueType,
    depth: indexPath ? indexPath.split(".").length : 0,
    group,
    leaf: type !== "Group",
    readOnly: !(type === "OneD" || type === "Checkbox" || valueType === "array"),
    canAnimate: !!row.canAnimate,
    hasMin: !!row.hasMin,
    min: Number(row.min) || 0,
    hasMax: !!row.hasMax,
    max: Number(row.max) || 0,
  };
}

/**
 * 扫描缓存目录。不依赖 index.json：文件本身就是唯一数据源。
 * @returns {{ok:boolean, items:Array, groups:Array, missing?:boolean}}
 */
function readIndex(paths) {
  const dir = cacheDir(paths);
  if (!dir) return { ok: false, reason: "no_paths" };
  const files = listCacheFiles(dir);
  if (!files.length) {
    return { ok: true, items: [], groups: [], missing: true };
  }
  const items = [];
  const groups = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const parsed = parseCacheFile(readText(file));
    let groupCount = 0;
    for (const section of parsed.sections) {
      if (!section.matchName) continue;
      groupCount++;
      items.push({
        matchName: section.matchName,
        plugin: parsed.header.plugin,
        category: parsed.header.category,
        aeVersion: section.aeVersion,
        aeMajor: Number(section.aeMajor) || 0,
        fetchedAt: section.fetchedAt,
        count: section.rows.length,
      });
    }
    groups.push({
      plugin: parsed.header.plugin,
      category: parsed.header.category,
      file: name,
      count: groupCount,
    });
  }
  return { ok: true, items, groups };
}

/**
 * 读取单个效果的参数行。
 * @returns {{ok:true,matchName,meta,params:Array}|{ok:false,reason:string}}
 */
function readEffect(paths, matchName) {
  const dir = cacheDir(paths);
  if (!dir) return { ok: false, reason: "no_paths" };
  const wanted = String(matchName || "").trim();
  if (!wanted) return { ok: false, reason: "not_found" };
  const files = listCacheFiles(dir);
  for (const name of files) {
    const parsed = parseCacheFile(readText(path.join(dir, name)));
    for (const section of parsed.sections) {
      if (section.matchName !== wanted) continue;
      const headerLine = parsed.header.columns.join("\t");
      const dumpText = [headerLine].concat(section.rows).join("\r\n");
      const rows = parseDump(dumpText);
      const params = rows.map(toParam);
      return {
        ok: true,
        matchName: section.matchName,
        meta: {
          plugin: parsed.header.plugin,
          category: parsed.header.category,
          aeVersion: section.aeVersion,
          aeMajor: Number(section.aeMajor) || 0,
          fetchedAt: section.fetchedAt,
          file: name,
        },
        params,
      };
    }
  }
  return { ok: false, reason: "not_found" };
}

function hasParam(paths, matchName) {
  return readEffect(paths, matchName).ok;
}

function collectRawEntries(paths) {
  const root = paths && paths.effectParamsRaw;
  if (!root) return [];
  const entries = [];
  let stamps = [];
  try {
    stamps = fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory());
  } catch (_error) {
    return [];
  }
  for (const stamp of stamps) {
    const stampDir = path.join(root, stamp.name);
    let effects = [];
    try {
      effects = fs.readdirSync(stampDir, { withFileTypes: true }).filter((item) => item.isDirectory());
    } catch (_error) {
      continue;
    }
    for (const effect of effects) {
      const dir = path.join(stampDir, effect.name);
      const metaPath = path.join(dir, "meta.json");
      const dumpPath = path.join(dir, "p0_dump.tsv");
      let meta = null;
      try {
        meta = JSON.parse(readText(metaPath));
      } catch (_error) {
        meta = null;
      }
      if (!meta || !String(meta.matchName || "").trim()) continue;
      let stat = null;
      try {
        stat = fs.statSync(dumpPath);
      } catch (_error) {
        stat = null;
      }
      if (!stat || !stat.isFile() || stat.size <= 64) continue;
      const fetchedAt = String(meta.fetchedAt || stat.mtime.toISOString());
      entries.push({
        matchName: String(meta.matchName).trim(),
        plugin: String(meta.plugin || "").trim(),
        category: String(meta.category || "").trim(),
        aeVersion: String(meta.aeVersion || "").trim(),
        fetchedAt,
        dumpPath,
        time: Date.parse(fetchedAt) || stat.mtimeMs,
      });
    }
  }
  return entries;
}

function readDumpRows(file) {
  const lines = readText(file).split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line) rows.push(line);
  }
  return rows;
}

/** AE 主版本号：catalog metadata 缺失时从 exe 版本号反推（25 → 2025）。 */
function deriveAeMajor(aeVersion) {
  const match = String(aeVersion || "").match(/^(\d+)/);
  if (!match) return 0;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (number >= 100) return number;
  if (number >= 23) return number + 2000;
  if (number >= 14) return number + 2003;
  return number;
}

function buildIndexPayload(paths) {
  const index = readIndex(paths);
  return {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    groups: index.groups || [],
    items: index.items || [],
  };
}

/**
 * 把 <probe>/effect_params_raw/* / * /p0_dump.tsv 合并进分组缓存。
 * 同一 matchName 以较新的 fetchedAt 覆盖旧节；重复调用结果不变。
 * @param {object} paths createPaths() 的结果
 * @param {{aeVersion?:string, aeMajor?:number}} [options]
 * @returns {{ok:boolean, merged:number, groups:Array}}
 */
function mergeRound(paths, options) {
  const dir = cacheDir(paths);
  if (!dir) return { ok: false, reason: "no_paths" };
  const opts = options || {};
  const entries = collectRawEntries(paths);

  // matchName → 最新一条原始 dump
  const latest = new Map();
  for (const entry of entries) {
    const previous = latest.get(entry.matchName);
    if (!previous || entry.time >= previous.time) latest.set(entry.matchName, entry);
  }

  // plugin + category → 需要写入的节
  const groups = new Map();
  for (const entry of latest.values()) {
    const plugin = entry.plugin || UNKNOWN_PLUGIN;
    const category = entry.category || UNKNOWN_CATEGORY;
    const key = plugin + "\u0000" + category;
    if (!groups.has(key)) {
      groups.set(key, {
        plugin,
        category,
        file: safePart(plugin, UNKNOWN_PLUGIN) + "__" + safePart(category, UNKNOWN_CATEGORY) + ".tsv",
        updates: [],
      });
    }
    groups.get(key).updates.push(entry);
  }

  fs.mkdirSync(dir, { recursive: true });
  let merged = 0;
  for (const group of groups.values()) {
    const file = path.join(dir, group.file);
    const parsed = parseCacheFile(readText(file));
    const sections = parsed.sections.slice();
    const byName = new Map();
    for (const section of sections) byName.set(section.matchName, section);
    for (const entry of group.updates) {
      // 具体一次 dump 的 meta.json 记着真实 AE 版本，优先于调用方传入的兜底值
      const aeVersion = String(entry.aeVersion || opts.aeVersion || "");
      const aeMajor = deriveAeMajor(aeVersion) || Number(opts.aeMajor) || 0;
      const section = {
        matchName: entry.matchName,
        aeVersion,
        aeMajor,
        fetchedAt: entry.fetchedAt,
        rows: readDumpRows(entry.dumpPath),
      };
      const existing = byName.get(entry.matchName);
      if (existing) {
        existing.aeVersion = section.aeVersion;
        existing.aeMajor = section.aeMajor;
        existing.fetchedAt = section.fetchedAt;
        existing.rows = section.rows;
      } else {
        sections.push(section);
        byName.set(section.matchName, section);
      }
      merged++;
    }
    const text = serializeCacheFile(group.plugin, group.category, sections);
    if (text !== readText(file)) writeFileAtomic(file, text);
  }

  writeFileAtomic(
    path.join(dir, "index.json"),
    JSON.stringify(buildIndexPayload(paths)),
  );

  const index = readIndex(paths);
  return { ok: true, merged, groups: index.groups || [] };
}

/**
 * 删除若干效果的缓存节（「重新获取」前清掉旧数据）。
 * @returns {{ok:boolean, removed:number}}
 */
function removeParams(paths, matchNames) {
  const dir = cacheDir(paths);
  if (!dir) return { ok: false, reason: "no_paths" };
  const wanted = new Set(
    (Array.isArray(matchNames) ? matchNames : [matchNames])
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  );
  if (!wanted.size) return { ok: true, removed: 0 };
  let removed = 0;
  for (const name of listCacheFiles(dir)) {
    const file = path.join(dir, name);
    const parsed = parseCacheFile(readText(file));
    if (!parsed.sections.some((section) => wanted.has(section.matchName))) continue;
    const sections = [];
    for (const section of parsed.sections) {
      if (wanted.has(section.matchName)) {
        removed++;
        continue;
      }
      sections.push(section);
    }
    if (!sections.length) {
      try { fs.rmSync(file, { force: true }); } catch (_error) { /* ignore */ }
    } else {
      writeFileAtomic(file, serializeCacheFile(parsed.header.plugin, parsed.header.category, sections));
    }
  }
  writeFileAtomic(path.join(dir, "index.json"), JSON.stringify(buildIndexPayload(paths)));
  return { ok: true, removed };
}

module.exports = {
  readIndex,
  readEffect,
  mergeRound,
  hasParam,
  removeParams,
  CACHE_VERSION,
  COLUMNS,
};
