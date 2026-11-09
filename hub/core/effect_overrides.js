/* ============================================================
 * effect_overrides.js —— 效果手动调参的覆盖表
 *
 * 文件：<userRoot>/effect_overrides.tsv
 *   matchName  preset  scene  enabled  paramIndex  paramPath  value  valueType  verified  note
 *
 * 设计：
 *   · 一行一个参数；效果级字段重复，便于人读/手改。
 *   · preset 相对 <userRoot>，必须落在 effect_presets/ 下；只接受 .ffx。
 *   · 缺失 / 损坏 / 单行非法都退化为「跳过该行」，不阻塞渲染。
 *   · 写入前校验全部行；失败不落盘；成功用临时文件替换，并留一份 .bak。
 *   · 不依赖 electron：可脱离 GUI 用 Node 直接测。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

const VERSION = 1;
const HEADER = [
  "matchName",
  "preset",
  "scene",
  "enabled",
  "paramIndex",
  "paramPath",
  "value",
  "valueType",
  "verified",
  "note",
];
const SCENES = new Set([
  "footage-2d",
  "solid-2d",
  "text",
  "shape-mask",
  "adjustment",
  "two-layer-input",
  "3d-camera",
]);
const VALUE_TYPES = new Set(["number", "boolean", "array"]);

/** 覆盖表路径：优先用 paths 里的唯一定义，缺失时按 userRoot 约定兜底 */
function overridesPath(paths) {
  return paths.effectOverrides || path.join(paths.userRoot, "effect_overrides.tsv");
}

/** .ffx 兜底预设目录 */
function presetsDir(paths) {
  return paths.effectPresets || path.join(paths.userRoot, "effect_presets");
}

/** 读 UTF-8 文本并去掉 BOM；读不到返回 null（区分「缺失」与「空文件」） */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
}

/** TSV 单元格：不允许 tab / 换行，避免一行被拆成多列 */
function sanitizeCell(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

/**
 * 校验并规范化 preset 路径。
 * 接受 `foo.ffx`（自动补 effect_presets/）或 `effect_presets/sub/foo.ffx`；
 * 拒绝绝对路径、盘符、`..`、非 .ffx。返回 null 表示非法，"" 表示未设置。
 */
function normalizePreset(value) {
  const raw = String(value === null || value === undefined ? "" : value)
    .trim()
    .replace(/\\/g, "/");
  if (!raw) return "";
  if (raw.includes("\u0000")) return null;
  if (raw.startsWith("/") || raw.startsWith("//") || /^[a-zA-Z]:/.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  const prefixed = raw.toLowerCase().startsWith("effect_presets/")
    ? raw
    : "effect_presets/" + raw;
  if (!/\.ffx$/i.test(prefixed)) return null;
  return prefixed;
}

/** preset 相对路径 → 绝对路径；越界或非法返回 "" */
function presetAbsolute(paths, preset) {
  const normalized = normalizePreset(preset);
  if (!normalized) return "";
  const root = path.resolve(presetsDir(paths));
  const full = path.resolve(paths.userRoot, normalized);
  const rootLower = root.toLowerCase();
  const fullLower = full.toLowerCase();
  if (fullLower !== rootLower && !fullLower.startsWith(rootLower + path.sep)) return "";
  return full;
}

function presetExists(paths, preset) {
  const full = presetAbsolute(paths, preset);
  return full ? fs.existsSync(full) : false;
}

function parseEnabled(value) {
  const text = String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase();
  if (!text) return true;
  if (text === "1" || text === "true" || text === "yes" || text === "on") return true;
  if (text === "0" || text === "false" || text === "no" || text === "off") return false;
  return undefined;
}

function parseVerified(value) {
  const text = String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (text === "1" || text === "true") return true;
  if (text === "0" || text === "false") return false;
  return undefined;
}

function parseArray(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad_array" };
  }
  if (!Array.isArray(parsed) || !parsed.length) return { ok: false, reason: "bad_array" };
  for (const item of parsed) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return { ok: false, reason: "bad_array" };
    }
  }
  return { ok: true, value: parsed, valueType: "array" };
}

/** 解析 value/valueType；空值返回 null（preset-only 行） */
function parseValue(valueType, value) {
  const type = String(valueType === null || valueType === undefined ? "" : valueType)
    .trim()
    .toLowerCase();
  const raw = String(value === null || value === undefined ? "" : value).trim();

  if (!type) {
    if (!raw) return { ok: true, value: null, valueType: "" };
    if (/^(true|false)$/i.test(raw)) {
      return { ok: true, value: raw.toLowerCase() === "true", valueType: "boolean" };
    }
    if (raw.startsWith("[")) return parseArray(raw);
    const number = Number(raw);
    if (Number.isFinite(number)) return { ok: true, value: number, valueType: "number" };
    return { ok: false, reason: "unknown_value_type" };
  }

  if (!VALUE_TYPES.has(type)) return { ok: false, reason: "bad_value_type" };

  if (type === "number") {
    if (!raw) return { ok: false, reason: "bad_number" };
    const number = Number(raw);
    if (!Number.isFinite(number)) return { ok: false, reason: "bad_number" };
    return { ok: true, value: number, valueType: "number" };
  }

  if (type === "boolean") {
    if (/^(true|1)$/i.test(raw)) return { ok: true, value: true, valueType: "boolean" };
    if (/^(false|0)$/i.test(raw)) return { ok: true, value: false, valueType: "boolean" };
    return { ok: false, reason: "bad_boolean" };
  }

  if (!raw) return { ok: false, reason: "bad_array" };
  return parseArray(raw);
}

/** 写入前的对象值规范化：接受 number / boolean / array / 可推断字符串 */
function normalizeValue(value, valueType) {
  const type = String(valueType === null || valueType === undefined ? "" : valueType)
    .trim()
    .toLowerCase();
  if (type) {
    return parseValue(type, Array.isArray(value) ? JSON.stringify(value) : value);
  }
  if (value === null || value === undefined || value === "") {
    return { ok: true, value: null, valueType: "" };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: "bad_number" };
    return { ok: true, value, valueType: "number" };
  }
  if (typeof value === "boolean") return { ok: true, value, valueType: "boolean" };
  if (Array.isArray(value)) {
    if (!value.length) return { ok: false, reason: "bad_array" };
    for (const item of value) {
      if (typeof item !== "number" || !Number.isFinite(item)) {
        return { ok: false, reason: "bad_array" };
      }
    }
    return { ok: true, value: value.slice(), valueType: "array" };
  }
  if (typeof value === "string") return parseValue("", value);
  return { ok: false, reason: "bad_value" };
}

function serializeValue(item) {
  if (!item || item.value === null || item.value === undefined) return "";
  if (item.valueType === "boolean") return item.value ? "true" : "false";
  if (item.valueType === "array") return JSON.stringify(item.value);
  if (item.valueType === "number") return String(item.value);
  return "";
}

/** 表头单元格 → 列号；必须有 matchName，其余列容忍缺失 */
function headerIndex(cells) {
  const index = new Map();
  for (let i = 0; i < cells.length; i++) {
    const name = String(cells[i] === null || cells[i] === undefined ? "" : cells[i]).trim();
    if (name) index.set(name, i);
  }
  return index.has("matchName") ? index : null;
}

/** 一行 TSV → 规范化 item；非法返回 { ok:false, reason } */
function parseRow(cells, index, line, paths) {
  const get = (name) => {
    const column = index.get(name);
    if (column === undefined) return "";
    return String(cells[column] === null || cells[column] === undefined ? "" : cells[column]);
  };

  const matchName = get("matchName").trim();
  if (!matchName) return { ok: false, reason: "missing_match_name" };
  if (/[\t\r\n]/.test(matchName)) return { ok: false, reason: "bad_match_name" };

  const preset = normalizePreset(get("preset"));
  if (preset === null) return { ok: false, reason: "bad_preset_path" };

  const scene = get("scene").trim();
  if (scene && !SCENES.has(scene)) return { ok: false, reason: "bad_scene" };

  const enabled = parseEnabled(get("enabled"));
  if (enabled === undefined) return { ok: false, reason: "bad_enabled" };

  const paramIndex = get("paramIndex").trim();
  if (paramIndex && !/^\d+(?:\.\d+)*$/.test(paramIndex)) {
    return { ok: false, reason: "bad_param_index" };
  }
  if (!preset && !paramIndex) return { ok: false, reason: "empty_override" };

  const value = parseValue(get("valueType"), get("value"));
  if (!value.ok) return { ok: false, reason: value.reason };
  if (paramIndex && value.value === null) return { ok: false, reason: "missing_value" };

  const verified = parseVerified(get("verified"));
  if (verified === undefined) return { ok: false, reason: "bad_verified" };

  return {
    ok: true,
    item: {
      matchName,
      preset,
      scene,
      enabled,
      paramIndex,
      paramPath: sanitizeCell(get("paramPath")),
      value: value.value,
      valueType: value.valueType,
      verified,
      note: sanitizeCell(get("note")),
      presetExists: preset ? presetExists(paths, preset) : false,
      line,
    },
  };
}

/**
 * 读取覆盖表。
 * 缺失 → { ok:true, items:[], missing:true }；损坏 → ok:true + errors（不阻塞渲染）。
 * @param {ReturnType<import("./paths").createPaths>} paths
 */
function read(paths) {
  const file = overridesPath(paths);
  const base = { file, presetsDir: presetsDir(paths), items: [], errors: [] };

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return { ...base, ok: true, missing: true };
    return {
      ...base,
      ok: false,
      reason: "read_failed",
      errors: [{ line: 0, message: "read_failed" }],
    };
  }
  if (!stat.isFile()) {
    return {
      ...base,
      ok: false,
      reason: "not_file",
      errors: [{ line: 0, message: "not_file" }],
    };
  }

  const text = readText(file);
  if (text === null) {
    return {
      ...base,
      ok: false,
      reason: "read_failed",
      errors: [{ line: 0, message: "read_failed" }],
    };
  }
  if (!text.trim()) return { ...base, ok: true, missing: false };

  const lines = text.split(/\r?\n/);
  let headerLine = -1;
  let index = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith("#")) continue;
    index = headerIndex(line.split("\t"));
    headerLine = i;
    break;
  }
  if (!index || headerLine < 0) {
    return {
      ...base,
      ok: true,
      degraded: true,
      errors: [{ line: 1, message: "bad_header" }],
    };
  }

  const items = [];
  const errors = [];
  for (let i = headerLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith("#")) continue;
    let parsed;
    try {
      parsed = parseRow(line.split("\t"), index, i + 1, paths);
    } catch {
      parsed = { ok: false, reason: "row_exception" };
    }
    if (parsed.ok) items.push(parsed.item);
    else errors.push({ line: i + 1, message: parsed.reason });
  }

  return {
    ...base,
    ok: true,
    missing: false,
    degraded: errors.length > 0,
    items,
    errors,
  };
}

/** 写入前的完整校验；返回规范化 item 或错误 */
function normalizeItem(item, paths) {
  if (!item || typeof item !== "object") return { ok: false, reason: "bad_item" };

  const matchName = String(item.matchName === null || item.matchName === undefined ? "" : item.matchName).trim();
  if (!matchName) return { ok: false, reason: "missing_match_name" };
  if (/[\t\r\n]/.test(matchName)) return { ok: false, reason: "bad_match_name" };

  const preset = normalizePreset(item.preset);
  if (preset === null) return { ok: false, reason: "bad_preset_path" };

  const scene = String(item.scene === null || item.scene === undefined ? "" : item.scene).trim();
  if (scene && !SCENES.has(scene)) return { ok: false, reason: "bad_scene" };

  const enabled =
    typeof item.enabled === "boolean" ? item.enabled : parseEnabled(item.enabled);
  if (enabled === undefined) return { ok: false, reason: "bad_enabled" };

  const paramIndex = String(
    item.paramIndex === null || item.paramIndex === undefined ? "" : item.paramIndex,
  ).trim();
  if (paramIndex && !/^\d+(?:\.\d+)*$/.test(paramIndex)) {
    return { ok: false, reason: "bad_param_index" };
  }
  if (!preset && !paramIndex) return { ok: false, reason: "empty_override" };

  const value = normalizeValue(item.value, item.valueType);
  if (!value.ok) return { ok: false, reason: value.reason };
  if (paramIndex && value.value === null) return { ok: false, reason: "missing_value" };

  let verified;
  if (
    item.verified === null ||
    item.verified === undefined ||
    typeof item.verified === "boolean"
  ) {
    verified = item.verified === undefined ? null : item.verified;
  } else {
    verified = parseVerified(item.verified);
    if (verified === undefined) return { ok: false, reason: "bad_verified" };
  }

  return {
    ok: true,
    item: {
      matchName,
      preset,
      scene,
      enabled,
      paramIndex,
      paramPath: sanitizeCell(item.paramPath),
      value: value.value,
      valueType: value.valueType,
      verified,
      note: sanitizeCell(item.note),
      presetExists: preset ? presetExists(paths, preset) : false,
    },
  };
}

function serializeItem(item) {
  return [
    item.matchName,
    item.preset,
    item.scene,
    item.enabled ? "1" : "0",
    item.paramIndex,
    item.paramPath,
    serializeValue(item),
    item.valueType,
    item.verified === null ? "" : item.verified ? "1" : "0",
    item.note,
  ]
    .map((cell) => sanitizeCell(cell))
    .join("\t");
}

/**
 * 写入覆盖表：先校验全部行，失败不落盘；成功用临时文件替换，并留 .bak。
 * @param {ReturnType<import("./paths").createPaths>} paths
 * @param {Array<object>} items
 */
function write(paths, items) {
  const file = overridesPath(paths);
  const rows = Array.isArray(items) ? items : [];
  const normalized = [];
  const errors = [];

  rows.forEach((item, row) => {
    const result = normalizeItem(item, paths);
    if (!result.ok) errors.push({ row: row + 1, message: result.reason });
    else normalized.push(result.item);
  });
  if (errors.length) return { ok: false, reason: "invalid_items", file, items: normalized, errors };

  const text = [HEADER.join("\t"), ...normalized.map(serializeItem)].join("\r\n") + "\r\n";
  const dir = path.dirname(file);
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, text, "utf8");
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不影响结论 */
    }
    return { ok: false, reason: "write_failed", file, items: normalized, errors: [{ row: 0, message: String(error && error.message) }] };
  }

  /* 覆盖旧表前留 .bak；用户可从 Documents/DreamEngine 直接恢复 */
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, file + ".bak");
    } catch {
      /* 备份失败不阻止写；但旧表仍在，最坏情况只是没有 .bak */
    }
  }

  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.copyFileSync(tmp, file);
      fs.unlinkSync(tmp);
    } catch (copyError) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 同上 */
      }
      return {
        ok: false,
        reason: "write_failed",
        file,
        items: normalized,
        errors: [{ row: 0, message: String(copyError && copyError.message) }],
      };
    }
  }

  return { ok: true, file, items: normalized, errors: [] };
}

function sanitizeFileName(name) {
  const base = String(name === null || name === undefined ? "" : name)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return base;
}

/**
 * 导入一个 .ffx 到 effect_presets/，不覆盖同名文件（自动加 -1/-2）。
 * @returns {{ok: boolean, preset?: string, path?: string, reason?: string}}
 */
function importPreset(paths, source) {
  const sourcePath = String(source === null || source === undefined ? "" : source).trim();
  if (!sourcePath) return { ok: false, reason: "invalid_source" };

  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return { ok: false, reason: "source_missing" };
  }
  if (!stat.isFile()) return { ok: false, reason: "source_not_file" };
  if (!/\.ffx$/i.test(sourcePath)) return { ok: false, reason: "not_ffx" };

  const dir = presetsDir(paths);
  let base = sanitizeFileName(path.basename(sourcePath));
  if (!base || !/\.ffx$/i.test(base)) base = "preset.ffx";
  const stem = base.replace(/\.ffx$/i, "");
  let candidate = base;
  let suffix = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    while (fs.existsSync(path.join(dir, candidate))) {
      suffix++;
      candidate = stem + "-" + suffix + ".ffx";
    }
    const target = path.join(dir, candidate);
    fs.copyFileSync(sourcePath, target);
    return { ok: true, preset: "effect_presets/" + candidate, path: target };
  } catch (error) {
    return { ok: false, reason: "copy_failed", error: String(error && error.message) };
  }
}

/** 稳定的覆盖签名：供缓存键使用（不依赖行序，忽略 enabled=0） */
function signature(items) {
  const parts = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.enabled === false) continue;
    parts.push(
      [
        item.matchName || "",
        item.preset || "",
        item.scene || "",
        item.paramIndex || "",
        item.valueType || "",
        serializeValue(item),
        item.verified === true ? "1" : item.verified === false ? "0" : "",
      ].join("|"),
    );
  }
  parts.sort();
  return parts.join(";");
}

function forMatchName(items, matchName) {
  const name = String(matchName === null || matchName === undefined ? "" : matchName).trim();
  if (!name) return [];
  return (Array.isArray(items) ? items : []).filter((item) => item && item.matchName === name);
}

/** Hub 人工调参行 → 覆盖表 item；未提供的 verified 保持 null。 */
function manualEntry(matchName, record) {
  const row = record || {};
  const rawValue = row.value;
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue === "string" && !rawValue.trim()) return null;
  const paramIndex = String(row.indexPath || row.paramIndex || "").trim();
  if (!paramIndex) return null;
  return {
    matchName,
    preset: "",
    scene: "",
    enabled: true,
    paramIndex,
    paramPath: String(row.path || row.paramPath || ""),
    value: rawValue,
    valueType: String(row.valueType || ""),
    verified: row.verified === true ? true : row.verified === false ? false : null,
    note: String(row.note || "manual-tune"),
  };
}

/** 覆盖表 item → Hub 调参行；字段名转换只发生在 IPC 数据边界。 */
function manualRow(item) {
  const source = item || {};
  return {
    indexPath: String(source.paramIndex || ""),
    path: String(source.paramPath || ""),
    value: source.value,
    valueType: String(source.valueType || ""),
    verified: source.verified === true ? true : source.verified === false ? false : null,
    note: String(source.note || ""),
  };
}

module.exports = {
  VERSION,
  HEADER,
  SCENES,
  overridesPath,
  presetsDir,
  normalizePreset,
  presetAbsolute,
  presetExists,
  read,
  write,
  importPreset,
  signature,
  forMatchName,
  manualEntry,
  manualRow,
};
