const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");
const yazl = require("yazl");
const { createPluginResolver } = require("./effects");

const SCHEMA = "dreamengine.effect-previews";
const VERSION = 1;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1), "utf8");
}

function relativePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw) return "";
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    return "";
  }
  return normalized;
}

function dataFile(paths, relative) {
  const rel = relativePath(relative);
  if (!rel) return "";
  const root = path.resolve(paths.dataDir);
  const full = path.resolve(root, rel.replace(/\//g, path.sep));
  return full.startsWith(root + path.sep) ? full : "";
}

function expandPattern(relative, frames) {
  const rel = relativePath(relative);
  if (!rel || !rel.includes("%04d")) return rel ? [rel] : [];
  const output = [];
  const count = Math.max(1, Number(frames) || 1);
  for (let index = 0; index < count; index++) {
    output.push(rel.replace("%04d", String(index).padStart(4, "0")));
  }
  return output;
}

function collectManifestFiles(paths, doc, output) {
  const sheets = new Map();
  for (const sheet of (doc && doc.sheets) || []) {
    if (sheet && sheet.index !== undefined) sheets.set(Number(sheet.index), sheet);
  }
  for (const item of (doc && doc.items) || []) {
    if (!item) continue;
    const webpSrc = relativePath(item.webpSrc);
    const stillSrc = relativePath(item.stillSrc);
    if (webpSrc) {
      output.add(webpSrc);
      if (stillSrc) output.add(stillSrc);
      continue;
    }
    for (const relative of expandPattern(item.frameSrc, item.frames)) output.add(relative);
    const src = relativePath(item.src);
    if (src) output.add(src);
    const sheet = sheets.get(Number(item.sheet));
    const sheetSrc = relativePath(sheet && sheet.src);
    if (sheetSrc) output.add(sheetSrc);
  }
}

function pluginNameFor(item, kind, resolvePlugin) {
  const value = String((item && item.plugin) || "").trim();
  const fallback = kind === "builtin" ? "内置" : "其它插件";
  return resolvePlugin ? resolvePlugin(item, fallback) : value || fallback;
}

function filterManifest(doc, kind, plugins, resolvePlugin) {
  if (!Array.isArray(plugins) || plugins.length === 0) return doc;
  const selected = new Set(plugins.map((value) => String(value).trim()).filter(Boolean));
  const output = JSON.parse(JSON.stringify(doc || {}));
  const items = (output.items || []).filter((item) =>
    selected.has(pluginNameFor(item, kind, resolvePlugin)),
  );
  const sheets = new Set(items.map((item) => Number(item.sheet)));
  output.items = items;
  output.sheets = (output.sheets || []).filter((sheet) => sheets.has(Number(sheet.index)));
  return output;
}

function writeZip(file, manifest, files, paths) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 1), "utf8"), "manifest.json");
    for (const relative of files) {
      const source = dataFile(paths, relative);
      if (!source || !fs.existsSync(source)) continue;
      zip.addFile(source, `files/${relativePath(relative)}`);
    }
    const output = fs.createWriteStream(file);
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

async function exportEffectPreviews(paths, zipFile, options = {}) {
  const builtinFile = path.join(paths.dataDir, "manifest.json");
  const pluginFile = paths.pluginManifest || path.join(paths.dataDir, "plugin_manifest.json");
  const resolvePlugin = createPluginResolver(paths);
  const builtin = filterManifest(
    readJson(builtinFile, { version: 2, items: [], sheets: [] }),
    "builtin",
    options.plugins,
    resolvePlugin,
  );
  const plugin = filterManifest(
    readJson(pluginFile, { version: 1, items: [], sheets: [] }),
    "plugin",
    options.plugins,
    resolvePlugin,
  );
  const files = new Set();
  collectManifestFiles(paths, builtin, files);
  collectManifestFiles(paths, plugin, files);

  const fileList = [...files].sort();
  const manifest = {
    schema: SCHEMA,
    version: VERSION,
    createdAt: new Date().toISOString(),
    effectConfig: {
      cellSize: Number(builtin.cellSize) || 720,
      columns: Number(builtin.columns) || 2,
      frameCount: 24,
      fps: 24,
      duration: 1,
    },
    builtin,
    plugin,
    files: fileList,
  };
  await writeZip(zipFile, manifest, fileList, paths);
  return {
    ok: true,
    path: zipFile,
    items: (builtin.items || []).length + (plugin.items || []).length,
    files: fileList.length,
  };
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function openEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function extractZip(zipFile, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const zip = await openZip(zipFile);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {
        /* already closed */
      }
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", async (entry) => {
      try {
        const name = relativePath(entry.fileName);
        if (!name || name.endsWith("/")) {
          zip.readEntry();
          return;
        }
        if (name !== "manifest.json" && !name.startsWith("files/")) {
          zip.readEntry();
          return;
        }
        const target = path.resolve(targetDir, name.replace(/\//g, path.sep));
        const root = path.resolve(targetDir);
        if (!target.startsWith(root + path.sep)) throw new Error("unsafe_zip_path");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const stream = await openEntry(zip, entry);
        await pipeline(stream, fs.createWriteStream(target));
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

function remapDoc(doc, fileMap) {
  const copy = JSON.parse(JSON.stringify(doc || {}));
  const remap = (value) => {
    const relative = relativePath(value);
    if (!relative) return value;
    if (relative.includes("%04d")) {
      const first = relative.replace("%04d", "0000");
      const mapped = fileMap.get(first);
      return mapped ? mapped.replace("0000", "%04d") : value;
    }
    return fileMap.has(relative) ? fileMap.get(relative) : value;
  };
  for (const item of copy.items || []) {
    if (item.src) item.src = remap(item.src);
    if (item.frameSrc) item.frameSrc = remap(item.frameSrc);
    if (item.webpSrc) item.webpSrc = remap(item.webpSrc);
    if (item.stillSrc) item.stillSrc = remap(item.stillSrc);
  }
  for (const sheet of copy.sheets || []) {
    if (sheet.src) sheet.src = remap(sheet.src);
  }
  return copy;
}

function nextSheetIndex(doc) {
  let maximum = -1;
  for (const item of (doc && doc.items) || []) {
    maximum = Math.max(maximum, Number(item.sheet) || 0);
  }
  for (const sheet of (doc && doc.sheets) || []) {
    maximum = Math.max(maximum, Number(sheet.index) || 0);
  }
  return maximum + 1;
}

function mergeDoc(target, incoming) {
  const output = JSON.parse(JSON.stringify(target || {}));
  if (!Array.isArray(output.items)) output.items = [];
  if (!Array.isArray(output.sheets)) output.sheets = [];

  const incomingItems = JSON.parse(JSON.stringify((incoming && incoming.items) || []));
  const incomingNames = new Set(incomingItems.map((item) => String(item.matchName || "")));
  const before = output.items.length;
  output.items = output.items.filter((item) => !incomingNames.has(String(item.matchName || "")));
  const replaced = before - output.items.length;

  let nextIndex = nextSheetIndex(output);
  const sheetMap = new Map();
  for (const item of incomingItems) {
    const oldIndex = Number(item.sheet);
    if (!Number.isFinite(oldIndex)) continue;
    if (!sheetMap.has(oldIndex)) sheetMap.set(oldIndex, nextIndex++);
    item.sheet = sheetMap.get(oldIndex);
  }

  const incomingSheets = JSON.parse(JSON.stringify((incoming && incoming.sheets) || []));
  for (const sheet of incomingSheets) {
    const oldIndex = Number(sheet.index);
    if (!sheetMap.has(oldIndex)) continue;
    sheet.index = sheetMap.get(oldIndex);
    output.sheets.push(sheet);
  }
  output.items.push(...incomingItems);
  return { doc: output, incoming: incomingItems.length, replaced };
}

function uniqueImportName(fileMap, base, used) {
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let name = base;
  let index = 1;
  while (used.has(name.toLowerCase())) {
    name = `${stem}_${index}${ext}`;
    index++;
  }
  used.add(name.toLowerCase());
  return name;
}

async function importEffectPreviews(paths, zipFile) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dreamengine-preview-"));
  try {
    await extractZip(zipFile, temp);
    const manifestFile = path.join(temp, "manifest.json");
    const manifest = readJson(manifestFile, null);
    if (!manifest || manifest.schema !== SCHEMA || Number(manifest.version) !== VERSION) {
      return { ok: false, reason: "invalid_package" };
    }

    const importId =
      new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) +
      "-" +
      crypto.randomBytes(3).toString("hex");
    const targetFolder = `thumbs/import_${importId}`;
    const fileMap = new Map();
    const usedNames = new Set();
    for (const value of Array.isArray(manifest.files) ? manifest.files : []) {
      const sourceRelative = relativePath(value);
      if (!sourceRelative) continue;
      const source = path.join(temp, "files", sourceRelative);
      if (!fs.existsSync(source)) continue;
      const name = uniqueImportName(fileMap, path.basename(sourceRelative), usedNames);
      const targetRelative = `${targetFolder}/${name}`;
      const target = dataFile(paths, targetRelative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      fileMap.set(sourceRelative, targetRelative);
    }

    const builtinFile = path.join(paths.dataDir, "manifest.json");
    const pluginFile = paths.pluginManifest || path.join(paths.dataDir, "plugin_manifest.json");
    const localBuiltin = readJson(builtinFile, { version: 2, items: [], sheets: [] });
    const localPlugin = readJson(pluginFile, { version: 1, items: [], sheets: [] });
    const builtinResult = mergeDoc(localBuiltin, remapDoc(manifest.builtin, fileMap));
    const pluginResult = mergeDoc(localPlugin, remapDoc(manifest.plugin, fileMap));

    writeJson(builtinFile, builtinResult.doc);
    writeJson(pluginFile, pluginResult.doc);
    return {
      ok: true,
      added: builtinResult.incoming + pluginResult.incoming,
      replaced: builtinResult.replaced + pluginResult.replaced,
      files: fileMap.size,
      folder: targetFolder,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = {
  SCHEMA,
  VERSION,
  exportEffectPreviews,
  importEffectPreviews,
};
