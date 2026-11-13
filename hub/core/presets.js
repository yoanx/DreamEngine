/* ============================================================
 * presets.js —— 预设库的读写（唯一入口）
 *
 * 三个必须与现有代码对齐的点：
 *   1. 库目录 = <我的文档>/DreamEngine/presets（store.jsx 的 folderAt("presets")）
 *   2. 重名规则 = base_1.ffx、base_2.ffx
 *   3. 「是否已有预览」查两份索引：面板生成的 preset_manifest.json
 *      与离线通道的 preset_plugin_manifest.json
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const presetSources = require("./preset_sources");

/** 统一成小写正斜杠路径做比较：Windows 下大小写与分隔符都会变 */
function norm(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase();
}

function readIndex(file) {
  const map = new Map();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return map;
  }
  let json;
  try {
    json = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return map;
  }
  for (const item of json.items || []) {
    if (item && item.path) map.set(norm(item.path), item);
  }
  return map;
}

/** 两份索引合并：面板生成的在内置预设里，含插件的在离线索引里 */
function loadPreviewIndex(paths) {
  const merged = readIndex(paths.presetManifest);
  for (const [key, item] of readIndex(paths.presetPluginManifest)) {
    merged.set(key, item);
  }
  return merged;
}

/** AE 自带预设跨版本会改安装路径，但同名内容沿用同一预览。 */
function isDefaultAePresetPath(file) {
  return /\/adobe after effects \d{4}\/support files\/presets\//i.test(norm(file));
}

/**
 * 列出预设库（递归：与 tools/generate_plugin_presets.ps1 的 -Recurse 保持一致）。
 * @param {ReturnType<import("./paths").createPaths>} paths
 */
function list(paths) {
  const index = loadPreviewIndex(paths);
  const defaultByName = new Map();
  for (const item of index.values()) {
    if (!item || !isDefaultAePresetPath(item.path)) continue;
    defaultByName.set(String(item.name || "").toLowerCase(), item);
  }
  let rootExists = false;
  try {
    rootExists = fs.statSync(paths.presets).isDirectory();
  } catch {
    rootExists = false;
  }

  const items = [];
  const seen = new Set();
  const addItem = (full, stat, extra) => {
    const key = norm(full);
    if (seen.has(key)) return;
    seen.add(key);
    const fileName = path.basename(full);
    const name = fileName.replace(/\.ffx$/i, "");
    const hit =
      index.get(key) ||
      (extra && extra.sourceKind === "install"
        ? defaultByName.get(name.toLowerCase())
        : undefined);
    const frameSrc = hit
      ? hit.frameSrc || String(hit.src || "").replace(/_0000\.png$/i, "_%04d.png")
      : "";
    let stillThumb = hit && hit.stillSrc ? path.join(paths.dataDir, hit.stillSrc) : "";
    if (!stillThumb && frameSrc && Number(hit && hit.frames) > 1) {
      const middle = Math.max(0, Math.floor((Number(hit.frames) || 1) / 2));
      stillThumb = path.join(
        paths.dataDir,
        frameSrc.replace("%04d", String(middle).padStart(4, "0")),
      );
    }
    items.push({
      path: full,
      fileName,
      name,
      size: stat.size,
      mtime: stat.mtimeMs,
      rendered: !!hit,
      frames: hit ? hit.frames || 1 : 0,
      animated: hit ? !!hit.animated : false,
      duration: hit ? Number(hit.duration) || 0 : 0,
      fps: hit ? Number(hit.fps) || 0 : 0,
      offline: hit ? !!hit.plugin : false,
      thumb: stillThumb || (hit && hit.src ? path.join(paths.dataDir, hit.src) : ""),
      framePattern: frameSrc ? path.join(paths.dataDir, frameSrc) : "",
      external: false,
      source: "",
      sourceKind: "library",
      ...extra,
    });
  };

  if (rootExists) {
    const files = [];
    walkPresetFiles(paths.presets, files, 0);
    for (const full of files) {
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      addItem(full, stat);
    }
  }

  // AE 外部预设（只索引，不复制）：路径来自 preset_catalog.json
  const catalog = presetSources.readCatalog(paths);
  if (catalog) {
    for (const item of catalog.items || []) {
      if (!item || !item.path) continue;
      let stat;
      try {
        stat = fs.statSync(item.path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      addItem(item.path, stat, {
        external: true,
        source: item.source || "",
        sourceKind: item.sourceKind || "install",
      });
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return {
    folder: paths.presets,
    exists: rootExists || items.length > 0,
    externalCount: items.filter((item) => item.external).length,
    items,
  };
}

function walkPresetFiles(dir, output, depth) {
  if ((depth || 0) > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkPresetFiles(full, output, (depth || 0) + 1);
    } else if (entry.isFile() && /\.ffx$/i.test(entry.name)) {
      output.push(full);
    }
  }
}

/** 目标是否在预设库根目录内（不含根目录本身；Windows 路径不区分大小写） */
function isInsideLibrary(paths, target) {
  const full = path.resolve(String(target || ""));
  const root = path.resolve(paths.presets);
  const prefix = root.toLowerCase() + path.sep;
  return full !== root && full.toLowerCase().startsWith(prefix);
}

/**
 * 过滤用户在 Hub 勾选的预设：必须在预设库内、是真实 .ffx 文件、去重。
 * @param {ReturnType<import("./paths").createPaths>} paths
 * @param {string[]} list
 */
function resolveSelection(paths, list) {
  const output = [];
  const seen = new Set();
  const catalog = presetSources.readCatalog(paths);
  const external = new Set(
    ((catalog && catalog.items) || []).map((item) => norm(item.path)),
  );
  for (const raw of Array.isArray(list) ? list : []) {
    const full = path.resolve(String(raw || ""));
    if (!/\.ffx$/i.test(full)) continue;
    const key = norm(full);
    if (!isInsideLibrary(paths, full) && !external.has(key)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(full);
  }
  return output;
}

/** 重名时按 base_1、base_2 递增 */
function uniqueTarget(dir, fileName) {
  const first = path.join(dir, fileName);
  if (!fs.existsSync(first)) return first;
  const base = fileName.replace(/\.ffx$/i, "");
  let n = 1;
  for (;;) {
    const candidate = path.join(dir, `${base}_${n}.ffx`);
    if (!fs.existsSync(candidate)) return candidate;
    n++;
  }
}

/**
 * 把若干 .ffx 复制进预设库。
 * @returns {{imported: string[], skipped: {path: string, reason: string}[]}}
 */
function importFiles(files, paths) {
  const imported = [];
  const skipped = [];

  if (!fs.existsSync(paths.presets)) {
    fs.mkdirSync(paths.presets, { recursive: true });
  }

  for (const file of files || []) {
    const from = String(file || "");
    if (!/\.ffx$/i.test(from)) {
      skipped.push({ path: from, reason: "not_ffx" });
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(from);
    } catch {
      skipped.push({ path: from, reason: "missing" });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: from, reason: "not_file" });
      continue;
    }

    const target = uniqueTarget(paths.presets, path.basename(from));
    try {
      fs.copyFileSync(from, target);
      imported.push(target);
    } catch (error) {
      skipped.push({ path: from, reason: String(error.message || error) });
    }
  }

  return { imported, skipped };
}

/** 删除预设库内的单个 .ffx，拒绝库目录之外的路径 */
function removePreset(target, paths) {
  const full = path.resolve(String(target || ""));
  if (!/\.ffx$/i.test(full)) return { ok: false, reason: "not_ffx" };
  if (!isInsideLibrary(paths, full)) return { ok: false, reason: "outside_library" };
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return { ok: false, reason: "file_missing" };
  }
  if (!stat.isFile()) return { ok: false, reason: "not_file" };
  try {
    fs.unlinkSync(full);
    return { ok: true, path: full };
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  }
}

function validBaseName(value) {
  const name = String(value || "").trim().replace(/\.ffx$/i, "");
  if (!name || name === "." || name === "..") return "";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return "";
  if (/[ .]$/.test(name)) return "";
  return name;
}

/** 重命名预设库内的 .ffx，不改预览图片文件本身 */
function renamePreset(target, name, paths) {
  const from = path.resolve(String(target || ""));
  if (!/\.ffx$/i.test(from)) return { ok: false, reason: "not_ffx" };
  if (!isInsideLibrary(paths, from)) return { ok: false, reason: "outside_library" };
  const base = validBaseName(name);
  if (!base) return { ok: false, reason: "invalid_name" };
  const to = path.join(path.dirname(from), base + ".ffx");
  if (norm(from) === norm(to)) return { ok: true, unchanged: true, path: from, name: base };
  if (fs.existsSync(to)) return { ok: false, reason: "name_exists" };
  try {
    const stat = fs.statSync(from);
    if (!stat.isFile()) return { ok: false, reason: "not_file" };
    fs.renameSync(from, to);
    return { ok: true, path: to, previousPath: from, name: base };
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  }
}

function remapIndex(file, fromKey, toPath, name) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return;
  }
  let changed = false;
  for (const item of doc.items || []) {
    if (!item || norm(item.path) !== fromKey) continue;
    item.path = toPath.replace(/\\/g, "/");
    item.name = name;
    changed = true;
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(doc, null, 1), "utf8");
}

function remapPreviewReferences(paths, from, to, name) {
  const fromKey = norm(from);
  remapIndex(paths.presetManifest, fromKey, to, name);
  remapIndex(paths.presetPluginManifest, fromKey, to, name);
  try {
    const rows = fs.readFileSync(paths.entries, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    let changed = false;
    const output = rows.map((line) => {
      if (!line || line.charAt(0) === "#") return line;
      const row = line.split("\t");
      if (row.length < 2 || norm(row[1]) !== fromKey) return line;
      row[0] = name;
      row[1] = to.replace(/\\/g, "/");
      changed = true;
      return row.join("\t");
    });
    if (changed) fs.writeFileSync(paths.entries, output.join("\r\n"), "utf8");
  } catch {
    /* 没有离线预览记录时不需要迁移 */
  }
}

function dataFilePath(paths, relative) {
  const root = path.resolve(paths.dataDir);
  const full = path.resolve(root, String(relative || "").replace(/\//g, path.sep));
  if (full === root || !full.startsWith(root + path.sep)) return "";
  return full;
}

function collectPreviewFiles(paths, item, output) {
  if (!item || typeof item !== "object") return;
  const src = dataFilePath(paths, item.src);
  if (src) output.add(src);
  const pattern = dataFilePath(paths, item.frameSrc);
  if (!pattern) return;
  if (!pattern.includes("%04d")) {
    output.add(pattern);
    return;
  }
  const dir = path.dirname(pattern);
  const namePattern = path.basename(pattern);
  const escaped = namePattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("%04d", "\\d{4}");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const matcher = new RegExp("^" + escaped + "$", "i");
  for (const name of names) {
    if (matcher.test(name)) output.add(path.join(dir, name));
  }
}

function removeIndexEntry(file, targetKey) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  const removed = [];
  doc.items = (doc.items || []).filter((item) => {
    if (!item || norm(item.path) !== targetKey) return true;
    removed.push(item);
    return false;
  });
  if (removed.length) fs.writeFileSync(file, JSON.stringify(doc, null, 1), "utf8");
  return removed;
}

function removeRows(file, targetKey, pathColumn) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return 0;
  }
  let removed = 0;
  const output = text.split(/\r?\n/).filter((line) => {
    if (!line || line.charAt(0) === "#") return true;
    const row = line.split("\t");
    if (norm(row[pathColumn]) !== targetKey) return true;
    removed++;
    return false;
  });
  if (removed) fs.writeFileSync(file, output.join("\r\n"), "utf8");
  return removed;
}

function removeBlacklistJson(file, targetKey) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return false;
  }
  const before = (doc.items || []).length;
  doc.items = (doc.items || []).filter((item) => norm(item && item.matchName) !== targetKey);
  if (doc.items.length === before) return false;
  fs.writeFileSync(file, JSON.stringify({ version: doc.version || 1, items: doc.items }, null, 1), "utf8");
  return true;
}

/** 清空一条预设的预览结果，让它重新回到待渲染队列 */
function clearPreview(target, paths) {
  const full = path.resolve(String(target || ""));
  if (!/\.ffx$/i.test(full)) return { ok: false, reason: "not_ffx" };
  const external = presetSources.isExternalPreset(paths, full);
  if (!isInsideLibrary(paths, full) && !external) {
    return { ok: false, reason: "outside_library" };
  }
  const key = norm(full);
  const removedItems = [
    ...removeIndexEntry(paths.presetManifest, key),
    ...removeIndexEntry(paths.presetPluginManifest, key),
  ];
  const files = new Set();
  for (const item of removedItems) collectPreviewFiles(paths, item, files);
  let deleted = 0;
  for (const file of files) {
    try {
      fs.unlinkSync(file);
      deleted++;
    } catch {
      /* 索引可能共享已清理的帧，忽略缺失文件 */
    }
  }
  removeRows(paths.entries, key, 1);
  removeRows(path.join(paths.probe, "preset_plugin_blacklist.tsv"), key, 0);
  removeBlacklistJson(path.join(paths.dataDir, "preset_plugin_blacklist.json"), key);
  return { ok: true, removed: removedItems.length, deleted };
}

module.exports = {
  list,
  importFiles,
  removePreset,
  renamePreset,
  remapPreviewReferences,
  clearPreview,
  loadPreviewIndex,
  uniqueTarget,
  isInsideLibrary,
  resolveSelection,
  norm,
};
