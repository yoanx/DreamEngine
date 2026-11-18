/* ============================================================
 * preview_paths.js —— 预览产物路径与迁移
 *
 * 逻辑路径固定写成 previews/effects/... 和 previews/presets/...，
 * 实际根目录由用户在 Hub 设置中选择；未设置时落在 data/previews。
 * 旧版 thumbs/... 仍按 dataDir/thumbs 解析，保证升级后旧图可见。
 * ============================================================ */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const previewNames = require("./preview_names");

const PREFIX = "previews/";
const EFFECTS = "effects";
const PRESETS = "presets";
const KINDS = [EFFECTS, PRESETS];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1), "utf8");
  fs.renameSync(temp, file);
}

function normalizedRoot(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.resolve(raw);
}

function readSettings(paths) {
  const doc = readJson(paths.previewSettings, null) ||
    readJson(path.join(paths.dataDir, "preview_settings.json"), null);
  const root = normalizedRoot(doc && doc.root);
  return { version: 1, root };
}

function defaultRoot(paths) {
  return path.join(paths.dataDir, "previews");
}

function currentRoot(paths) {
  return readSettings(paths).root || defaultRoot(paths);
}

function normalizeRelative(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw) return "";
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    return "";
  }
  return normalized;
}

function resolveFile(paths, value, rootOverride) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw) return "";
  if (path.isAbsolute(raw)) return path.normalize(raw);
  if (raw.indexOf(PREFIX) === 0) {
    const relative = normalizeRelative(raw.slice(PREFIX.length));
    if (!relative) return "";
    const root = path.resolve(rootOverride || currentRoot(paths));
    const full = path.resolve(root, relative.replace(/\//g, path.sep));
    return full.startsWith(root + path.sep) ? full : "";
  }
  const relative = normalizeRelative(raw);
  if (!relative) return "";
  const root = path.resolve(paths.dataDir);
  const full = path.resolve(root, relative.replace(/\//g, path.sep));
  return full.startsWith(root + path.sep) ? full : "";
}

function logicalValue(kind, relative) {
  const key = KINDS.includes(kind) ? kind : EFFECTS;
  let value = normalizeRelative(relative);
  if (value.indexOf("previews/") === 0) value = value.slice(PREFIX.length);
  if (value.indexOf("thumbs/") === 0) value = value.slice("thumbs/".length);
  if (value.indexOf(key + "/") === 0) value = value.slice(key.length + 1);
  return value ? PREFIX + key + "/" + value : "";
}

function writeSettings(paths, root) {
  const value = normalizedRoot(root);
  const doc = { version: 1, root: value };
  writeJsonAtomic(paths.previewSettings, doc);
  writeJsonAtomic(path.join(paths.dataDir, "preview_settings.json"), doc);
  return { ok: true, root: value };
}

function isInside(parent, child) {
  const a = path.resolve(parent).toLowerCase();
  const b = path.resolve(child).toLowerCase();
  return b === a || b.startsWith(a + path.sep);
}

/* 只清理指定的预览目录；rmdir 只会删除空目录，遇到任何文件都会停下。 */
function removeEmptyDirectoryTree(root) {
  let removed = 0;
  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let hasContent = false;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!visit(path.join(dir, entry.name))) hasContent = true;
      } else {
        hasContent = true;
      }
    }
    if (hasContent) return false;
    try {
      fs.rmdirSync(dir);
      removed++;
      return true;
    } catch {
      return false;
    }
  }
  visit(path.resolve(root));
  return removed;
}

function cleanupPreviewRoot(root) {
  let removed = 0;
  for (const kind of KINDS) {
    removed += removeEmptyDirectoryTree(path.join(root, kind));
  }
  try {
    if (fs.existsSync(root) && fs.readdirSync(root).length === 0) {
      fs.rmdirSync(root);
      removed++;
    }
  } catch { /* 根目录仍被占用时保留 */ }
  return removed;
}

function movePreviewFile(source, destination) {
  if (!source || !destination) return false;
  const sourceFull = path.resolve(source);
  const targetFull = path.resolve(destination);
  if (sourceFull.toLowerCase() === targetFull.toLowerCase()) return true;
  if (!fs.existsSync(sourceFull)) return false;
  fs.mkdirSync(path.dirname(targetFull), { recursive: true });
  try {
    fs.copyFileSync(sourceFull, targetFull, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") return false;
    try {
      if (fs.statSync(sourceFull).size !== fs.statSync(targetFull).size) return false;
    } catch {
      return false;
    }
  }
  try {
    fs.unlinkSync(sourceFull);
  } catch {
    return false;
  }
  return true;
}

function migratePresetLayout(paths) {
  const entries = [
    readDoc(path.join(paths.dataDir, "preset_manifest.json")),
    readDoc(path.join(paths.dataDir, "preset_plugin_manifest.json")),
  ];
  const all = [];
  for (const entry of entries) {
    for (const item of (entry.doc && entry.doc.items) || []) {
      if (item && item.path) all.push(item);
    }
  }
  if (!all.length) return 0;
  previewNames.assignPresetFolders(all);
  let moved = 0;
  for (const item of all) {
    const folder = String(item.folder || "preset");
    for (const field of ["src", "frameSrc", "webpSrc", "stillSrc"]) {
      const value = String(item[field] || "");
      if (!value) continue;
      const relative = relativeForKind(value, PRESETS);
      if (!relative) continue;
      const base = path.posix.basename(relative);
      const targetValue = logicalValue(PRESETS, `${folder}/${base}`);
      for (const sourceValue of expandPattern(value, item.frames)) {
        const source = resolveFile(paths, sourceValue);
        const frameIndex = path.posix.basename(sourceValue).match(/_(\d{4})\.(?:png|webp)$/i)?.[1] || "0000";
        const target = resolveFile(paths, targetValue.replace("%04d", frameIndex));
        if (source && target && movePreviewFile(source, target)) moved++;
      }
      item[field] = targetValue;
    }
  }
  for (const entry of entries) writeDoc(entry);

  const folderByPath = new Map(all.map((item) => [String(item.path).replace(/\\/g, "/").toLowerCase(), item.folder]));
  const tsv = paths.entries;
  if (fs.existsSync(tsv)) {
    const lines = fs.readFileSync(tsv, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    const output = lines.map((line) => {
      if (!line) return line;
      if (line.charAt(0) === "#") {
        return line.split("\t")[12] === "folder" ? line : line + "\tfolder";
      }
      const cells = line.split("\t");
      const folder = folderByPath.get(String(cells[1] || "").replace(/\\/g, "/").toLowerCase());
      if (folder) cells[12] = folder;
      return cells.join("\t");
    });
    fs.writeFileSync(tsv, output.join("\r\n"), "utf8");
  }
  return moved;
}

function migrateEffectLayout(paths) {
  const entries = [
    readDoc(path.join(paths.dataDir, "manifest.json")),
    readDoc(path.join(paths.dataDir, "plugin_manifest.json")),
  ];
  let moved = 0;
  for (const entry of entries) {
    for (const item of (entry.doc && entry.doc.items) || []) {
      for (const field of ["src", "frameSrc", "webpSrc", "stillSrc"]) {
        const value = String(item[field] || "");
        if (!value) continue;
        const relative = relativeForKind(value, EFFECTS);
        const match = /^webp\/([^/]+)\/(.+)$/i.exec(relative);
        if (!match) continue;
        const oldPlugin = match[1];
        const nextPlugin = previewNames.effectFolder(oldPlugin);
        if (oldPlugin === nextPlugin) continue;
        const targetValue = logicalValue(EFFECTS, `webp/${nextPlugin}/${match[2]}`);
        const source = resolveFile(paths, value);
        const target = resolveFile(paths, targetValue);
        if (source && target && movePreviewFile(source, target)) moved++;
        item[field] = targetValue;
      }
    }
  }
  for (const entry of entries) writeDoc(entry);
  return moved;
}

function migratePreviewLayout(paths) {
  try {
    const root = currentRoot(paths);
    const moved = migratePresetLayout(paths) + migrateEffectLayout(paths);
    removeEmptyDirectoryTree(path.join(root, "presets"));
    removeEmptyDirectoryTree(path.join(root, "effects", "webp"));
    return { ok: true, moved };
  } catch (error) {
    return { ok: false, reason: "layout_migration_failed", detail: String(error.message || error) };
  }
}

function expandPattern(value, frames) {
  const text = String(value || "");
  if (!text.includes("%04d")) return text ? [text] : [];
  const output = [];
  const count = Math.max(1, Number(frames) || 1);
  for (let index = 0; index < count; index++) {
    output.push(text.replace("%04d", String(index).padStart(4, "0")));
  }
  return output;
}

function collectDoc(doc, kind, fields, sheets, mappings, files) {
  if (!doc || typeof doc !== "object") return;
  const add = (value, frames) => {
    if (!value) return;
    const oldValue = String(value);
    const expanded = expandPattern(oldValue, frames);
    if (!expanded.length) return;
    const relativePattern = relativeForKind(oldValue, kind);
    if (!relativePattern) return;
    mappings.set(oldValue, logicalValue(kind, relativePattern));
    for (const item of expanded) {
      const source = resolveFileForMigration(item, kind);
      if (!source) continue;
      const relative = relativeForKind(item, kind);
      if (!relative) continue;
      files.set(source, resolveFileForMigration(logicalValue(kind, relative), kind, true));
    }
  };
  for (const item of Array.isArray(doc.items) ? doc.items : []) {
    for (const field of fields) add(item && item[field], item && item.frames);
  }
  for (const sheet of Array.isArray(doc.sheets) ? doc.sheets : []) {
    for (const field of sheets) add(sheet && sheet[field], 1);
  }
}

/* collectDoc 需要知道旧根和目标根；迁移时用闭包把两者传进来。 */
let migrationContext = null;
function resolveFileForMigration(value, kind, target) {
  const ctx = migrationContext;
  if (!ctx) return "";
  const root = target ? ctx.targetRoot : ctx.oldRoot;
  return resolveFile(ctx.paths, value, root);
}

function relativeForKind(value, kind) {
  let relative = normalizeRelative(value);
  if (relative.indexOf(PREFIX) === 0) relative = relative.slice(PREFIX.length);
  if (relative.indexOf("thumbs/") === 0) relative = relative.slice("thumbs/".length);
  if (relative.indexOf(kind + "/") === 0) relative = relative.slice(kind.length + 1);
  return relative;
}

function remapValue(value, mappings) {
  const text = String(value || "");
  if (!text) return value;
  if (mappings.has(text)) return mappings.get(text);
  if (text.includes("%04d")) {
    const first = text.replace("%04d", "0000");
    const mapped = mappings.get(first);
    if (mapped) return mapped.replace("0000", "%04d");
  }
  return value;
}

function remapDoc(doc, fields, sheets, mappings) {
  if (!doc || typeof doc !== "object") return;
  for (const item of Array.isArray(doc.items) ? doc.items : []) {
    for (const field of fields) item[field] = remapValue(item[field], mappings);
  }
  for (const sheet of Array.isArray(doc.sheets) ? doc.sheets : []) {
    for (const field of sheets) sheet[field] = remapValue(sheet[field], mappings);
  }
}

function readDoc(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { file, text, doc: text ? readJson(file, null) : null };
}

function writeDoc(entry) {
  if (!entry.doc) return;
  writeJsonAtomic(entry.file, entry.doc);
}

function resetPreviewRoot(paths) {
  const result = migratePreviewRoot(paths, defaultRoot(paths));
  if (result.ok) writeSettings(paths, "");
  return result;
}

function storageInfo(paths) {
  const roots = [...new Set([
    path.resolve(paths.dataDir, "thumbs"),
    path.resolve(currentRoot(paths), "effects"),
    path.resolve(currentRoot(paths), "presets"),
  ])];
  const seen = new Set();
  let bytes = 0;
  let files = 0;
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const key = path.resolve(file).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        bytes += fs.statSync(file).size;
        files++;
      } catch {
        /* 文件刚好被删除时不计入 */
      }
    }
  };
  for (const root of roots) visit(root);
  return { bytes, files };
}
function migratePreviewRoot(paths, targetRoot) {
  const target = normalizedRoot(targetRoot);
  if (!target) return { ok: false, reason: "empty_root" };
  const oldRoot = currentRoot(paths);
  if (path.resolve(oldRoot).toLowerCase() === target.toLowerCase()) {
    writeSettings(paths, target);
    return { ok: true, unchanged: true, root: target };
  }
  if (isInside(oldRoot, target) || isInside(target, oldRoot)) {
    return { ok: false, reason: "nested_root" };
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    if (!fs.statSync(target).isDirectory()) throw new Error("target is not a directory");
  } catch (error) {
    return { ok: false, reason: "target_unavailable", detail: String(error.message || error) };
  }

  const effectPlugin = readDoc(path.join(paths.dataDir, "plugin_manifest.json"));
  const builtin = readDoc(path.join(paths.dataDir, "manifest.json"));
  const presetPanel = readDoc(path.join(paths.dataDir, "preset_manifest.json"));
  const presetPlugin = readDoc(path.join(paths.dataDir, "preset_plugin_manifest.json"));
  const bundledPreset = readDoc(path.join(paths.dataDir, "bundled_preset_manifest.json"));
  const mappings = new Map();
  const files = new Map();
  migrationContext = { paths, oldRoot, targetRoot: target };
  try {
    collectDoc(effectPlugin.doc, EFFECTS, ["src", "frameSrc", "webpSrc", "stillSrc"], ["src"], mappings, files);
    collectDoc(builtin.doc, EFFECTS, ["src", "frameSrc", "webpSrc", "stillSrc"], ["src"], mappings, files);
    collectDoc(presetPanel.doc, PRESETS, ["src", "frameSrc", "webpSrc", "stillSrc"], [], mappings, files);
    collectDoc(presetPlugin.doc, PRESETS, ["src", "frameSrc", "webpSrc", "stillSrc"], [], mappings, files);
    collectDoc(bundledPreset.doc, PRESETS, ["src", "frameSrc", "webpSrc", "stillSrc"], [], mappings, files);
  } finally {
    migrationContext = null;
  }

  const entries = [effectPlugin, builtin, presetPanel, presetPlugin, bundledPreset];
  const tsvEntries = ["previews.tsv", "plugin_previews.tsv"].map((name) => {
    const file = path.join(paths.dataDir, name);
    return { file, text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" };
  });
  const copied = [];
  try {
    for (const [source, destination] of files) {
      if (!source || !destination || !fs.existsSync(source)) continue;
      if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      try {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        copied.push(destination);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const sourceSize = fs.statSync(source).size;
        const targetSize = fs.statSync(destination).size;
        if (sourceSize !== targetSize) {
          throw new Error("target_conflict:" + destination);
        }
      }
    }

    remapDoc(effectPlugin.doc, ["src", "frameSrc", "webpSrc", "stillSrc"], ["src"], mappings);
    remapDoc(builtin.doc, ["src", "frameSrc", "webpSrc", "stillSrc"], ["src"], mappings);
    remapDoc(presetPanel.doc, ["src", "frameSrc", "webpSrc", "stillSrc"], [], mappings);
    remapDoc(presetPlugin.doc, ["src", "frameSrc", "webpSrc", "stillSrc"], [], mappings);
    remapDoc(bundledPreset.doc, ["src", "frameSrc", "webpSrc", "stillSrc"], [], mappings);
    for (const entry of entries) writeDoc(entry);

    for (const tsv of tsvEntries) {
      if (!tsv.text) continue;
      const lines = tsv.text.split(/\r?\n/);
      const updated = lines.map((line) => {
        if (!line || line.startsWith("matchName")) return line;
        const cells = line.split("\t");
        if (cells.length > 4) cells[4] = remapValue(cells[4], mappings);
        return cells.join("\t");
      });
      fs.writeFileSync(tsv.file, updated.join("\r\n"), "utf8");
    }

    writeSettings(paths, target);
  } catch (error) {
    for (const entry of entries) {
      try {
        if (entry.text) fs.writeFileSync(entry.file, entry.text, "utf8");
      } catch { /* keep original error */ }
    }
    for (const tsv of tsvEntries) {
      try {
        if (tsv.text) fs.writeFileSync(tsv.file, tsv.text, "utf8");
      } catch { /* keep original error */ }
    }
    for (const file of copied) {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
    }
    return { ok: false, reason: "migration_failed", detail: String(error.message || error) };
  }

  for (const [source, destination] of files) {
    if (!source || !destination) continue;
    if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) continue;
    try {
      if (fs.existsSync(source)) fs.unlinkSync(source);
    } catch { /* leftover is harmless; indexes already point at the new copy */ }
  }
  let removedDirectories = cleanupPreviewRoot(oldRoot);
  removedDirectories += removeEmptyDirectoryTree(path.join(paths.dataDir, "thumbs"));
  const layout = migratePreviewLayout(paths);
  return { ok: true, root: target, files: copied.length, removedDirectories, layout };
}

module.exports = {
  PREFIX,
  EFFECTS,
  PRESETS,
  readSettings,
  defaultRoot,
  currentRoot,
  resolveFile,
  logicalValue,
  storageInfo,
  writeSettings,
  migratePreviewRoot,
  migratePreviewLayout,
  resetPreviewRoot,
};
