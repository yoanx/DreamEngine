/* ============================================================
 * effects.js —— 效果库（内置 + 插件）只读数据层
 *
 * 为 Hub 的「效果库」页合并四份数据：
 *   内置效果  <dataDir>/manifest.json          面板 L1 拼图索引（211 条）
 *   插件效果  <dataDir>/plugin_manifest.json   离线渲染产物（按实际生成）
 *   名字表    <dataDir>/names.json             nameEn/nameZh/categoryEn/categoryZh
 *   分类表    <Probe>/plugin_effect_catalog.tsv AE 本机扫描到的插件分类（优先于名字表）
 *
 * 规则：
 *   · 内置效果与已有预览的插件效果只收录首帧文件真实存在的条目，不在 UI 里留死图
 *   · 插件目录（catalog TSV）里可渲染但还没有预览的条目也会列出：hasPreview:false +
 *     status pending/blacklisted 的占位项，由 UI 显示「待渲染」，而不是整个效果库只剩内置
 *   · 归类以名字表和 AE 分类为准：名字表标了「内置」的目录条目，以及落在 AE 内置分类
 *     （沉浸式视频、生成等）里且插件未知的条目，都归回「AE 内置」分组 —— 扫描的
 *     matchName 前缀启发式会漏判 Keylight、VISINF 颗粒、Mettle VR 效果等 AE 自带效果
 *   · 内置严格按 manifest.items 顺序；插件按 catalog TSV 行序（manifest 独有项追加）
 *   · fps 固定 12，与 engine/render_config.jsx 的离线渲染帧率一致
 *   · 收藏按 matchName 存在 <userRoot>/effect_favorites.json（effect_favorites.js 读写）；
 *     条目的 renderable/generated 标记让 UI 知道「能不能渲染 / 能不能取消渲染」
 *   · clearPreview 删除一条插件效果的预览帧、索引、TSV 行与黑名单记录，让它回到待渲染
 *   · 任一数据文件缺失时返回 ok:true + 空 items，不抛异常（UI 自己决定怎么提示）
 *
 * 不依赖 electron：可脱离 GUI 用 Node 直接跑。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

const catalog = require("./catalog");
const effectFavorites = require("./effect_favorites");
const effectOverrides = require("./effect_overrides");

const FPS = 12;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 依次取第一个非空文本（0 与 false 不算空，便于 x/y 等数值字段复用） */
function firstText() {
  for (const value of arguments) {
    if (value !== null && value !== undefined && String(value).length > 0) {
      return String(value);
    }
  }
  return "";
}

/** TSV 里为了对齐留了尾部空格，分类/显示名比较前必须去掉 */
function trimmed(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

/**
 * 计算拼图切片参数。
 * slice* 优先（插件单格图写在自己条目里），否则用 manifest 的整网参数；
 * 注意不能拿条目自己的 width/height 当整图尺寸 —— 那是格子尺寸。
 */
function sliceGeometry(entry, manifest) {
  const cellSize = Number(entry.sliceCellSize) || Number(manifest.cellSize) || 128;
  const columns = Number(entry.sliceColumns) || Number(manifest.columns) || 1;
  const width = Number(entry.sliceWidth) || Number(manifest.width) || cellSize * columns;
  const height = Number(entry.sliceHeight) || Number(manifest.height) || cellSize * columns;
  return {
    cellSize,
    columns,
    rows: Math.max(1, Math.round(height / cellSize)),
    x: Number(entry.x) || 0,
    y: Number(entry.y) || 0,
  };
}

/** 内置效果：L1 整网上的一个格子（多数是 6 帧动图，部分是单帧静图） */
function builtinItem(entry, manifest, sheetByIndex, names, dataDir) {
  const matchName = String((entry && entry.matchName) || "");
  if (!matchName) return null;

  const sheet = sheetByIndex.get(Number(entry.sheet)) || null;
  const frameSrc = String(entry.frameSrc || (sheet && sheet.src) || "");
  if (!frameSrc) return null;

  const framePattern = path.join(dataDir, frameSrc);
  if (!isFile(framePattern.replace("%04d", "0000"))) return null;

  const record = names.get(matchName) || {};
  const frames = Math.max(1, Number(entry.frames) || 1);
  const geometry = sliceGeometry(entry, manifest);
  const nameZh = String(record.nameZh || "");
  const nameEn = String(record.nameEn || "");
  const displayName = firstText(nameZh, nameEn, matchName);

  return {
    matchName,
    name: displayName,
    nameZh,
    nameEn,
    displayName,
    category: String(record.categoryZh || record.categoryEn || ""),
    categoryZh: String(record.categoryZh || ""),
    categoryEn: String(record.categoryEn || ""),
    plugin: "内置",
    source: "builtin",
    frames,
    fps: FPS,
    framePattern,
    cellSize: geometry.cellSize,
    columns: geometry.columns,
    rows: geometry.rows,
    x: geometry.x,
    y: geometry.y,
    stillFrame: frames - 1,
    animated: frames > 1,
    hasPreview: true,
    status: "rendered",
    reason: "",
  };
}

/** 插件条目的名字/分类/插件名：catalog 行优先，名字表兜底 */
function pluginMeta(row, entry, names) {
  const matchName = String((row && row.matchName) || (entry && entry.matchName) || "");
  const record = names.get(matchName) || {};
  const nameZh = String(record.nameZh || "");
  const nameEn = String(record.nameEn || "");
  const catalogDisplayName = trimmed(row && row.displayName);
  const category =
    trimmed(row && row.category) || String(record.categoryZh || record.categoryEn || "");
  const plugin =
    trimmed(row && row.plugin) ||
    String(record.pluginHint || "") ||
    trimmed(entry && entry.plugin) ||
    "其它插件";

  return {
    matchName,
    /* 名字表里的中文/英文名；displayName 再叠一层 AE 扫描显示名 */
    name: firstText(nameZh, nameEn, matchName),
    nameZh,
    nameEn,
    displayName: firstText(nameZh, catalogDisplayName, nameEn, matchName),
    category,
    categoryZh: String(record.categoryZh || ""),
    categoryEn: String(record.categoryEn || ""),
    plugin,
  };
}

/** 预览首帧存在时返回绝对路径（含 %04d），否则返回空串 */
function previewPattern(entry, dataDir) {
  if (!entry || !entry.matchName) return "";
  const frames = Math.max(1, Number(entry.frames) || 1);
  let frameSrc = String(entry.frameSrc || "");
  if (!frameSrc && entry.src) {
    frameSrc = String(entry.src);
    // 历史清单只写了首帧路径：动图按离线渲染的命名约定还原成帧序列
    if (frames > 1) frameSrc = frameSrc.replace(/_0000\.png$/i, "_%04d.png");
  }
  if (!frameSrc) return "";
  const framePattern = path.join(dataDir, frameSrc);
  return isFile(framePattern.replace("%04d", "0000")) ? framePattern : "";
}

/** 有预览的插件条目：沿用效果库渲染条目的形状（1×N 单行拼图） */
function renderedPluginItem(meta, entry, manifest, dataDir) {
  const frames = Math.max(1, Number(entry.frames) || 1);
  const geometry = sliceGeometry(entry, manifest);
  return {
    ...meta,
    source: "plugin",
    frames,
    fps: FPS,
    framePattern: previewPattern(entry, dataDir),
    cellSize: geometry.cellSize,
    columns: geometry.columns,
    rows: geometry.rows,
    x: geometry.x,
    y: geometry.y,
    stillFrame: frames - 1,
    animated: frames > 1,
    hasPreview: true,
    status: "rendered",
    reason: "",
  };
}

/** 没有可用预览的占位条目：帧参数全 0，UI 显示「待渲染」/「黑名单」 */
function placeholderPluginItem(meta, status, reason) {
  return {
    ...meta,
    source: "plugin",
    frames: 0,
    fps: 0,
    framePattern: "",
    cellSize: 0,
    columns: 0,
    rows: 0,
    x: 0,
    y: 0,
    stillFrame: 0,
    animated: false,
    hasPreview: false,
    status,
    reason,
  };
}

/** 名字表标注为「内置」的目录条目：AE 自带效果，扫描的 matchName 前缀启发式会漏判 */
function isBuiltinCatalogRecord(record) {
  return String((record && record.pluginHint) || "") === "内置";
}

/**
 * AE 内置效果的分类名（中英）：名字表里内置条目的 categoryZh/categoryEn。
 * 另外补上「沉浸式视频」——AE 随附的 VR 效果（Mettle SkyBox），名字表没收录。
 * 用于把第三方目录里落进内置分类的条目（沉浸式视频、生成等）归回 AE 内置。
 */
function builtinCategoryNames(names) {
  const set = new Set(["沉浸式视频", "Immersive Video"]);
  for (const record of names.values()) {
    if (!isBuiltinCatalogRecord(record)) continue;
    const zh = trimmed(record.categoryZh);
    const en = trimmed(record.categoryEn);
    if (zh) set.add(zh);
    if (en) set.add(en);
  }
  return set;
}

/** 目录行 → 渲染条目（有预览）或占位条目（待渲染/黑名单），source 由调用方决定 */
function catalogItemFor(meta, entry, manifest, dataDir, blacklist) {
  if (entry && previewPattern(entry, dataDir)) {
    return renderedPluginItem(meta, entry, manifest, dataDir);
  }
  if (blacklist.has(meta.matchName)) {
    return placeholderPluginItem(meta, "blacklisted", blacklist.get(meta.matchName) || "");
  }
  return placeholderPluginItem(meta, "pending", "");
}

/**
 * 列出效果库（内置 + 插件）。
 * @param {ReturnType<import("./paths").createPaths>} paths
 */
function list(paths) {
  const dataDir = paths.dataDir;
  const builtinManifest = paths.builtinManifest || path.join(dataDir, "manifest.json");
  const builtinDoc = readJson(builtinManifest);
  const pluginDoc = readJson(paths.pluginManifest);
  const names = catalog.readNames(paths);
  const catalogRows = catalog.readCatalogRows(paths);
  const favorites = effectFavorites.read(paths);
  const favoriteSet = new Set(favorites.items);

  /** 统一追加访问标记：收藏 / 插件管线可渲染 / 预览由插件管线生成 */
  const decorate = (item, renderable, generated) => {
    item.favorite = favoriteSet.has(item.matchName);
    item.renderable = renderable;
    item.generated = generated;
    return item;
  };

  const builtinItems = [];

  /* 内置：严格按 manifest.items 顺序 */
  const sheetByIndex = new Map();
  for (const sheet of (builtinDoc && builtinDoc.sheets) || []) {
    if (sheet && sheet.index !== undefined) sheetByIndex.set(Number(sheet.index), sheet);
  }
  for (const entry of (builtinDoc && builtinDoc.items) || []) {
    const item = builtinItem(entry, builtinDoc, sheetByIndex, names, dataDir);
    if (item) builtinItems.push(decorate(item, false, false));
  }

  /* 插件：遍历 catalog TSV 全部行（跳过 excluded / no_preview），
     有预览的给渲染条目，没预览的给占位条目；manifest 独有项按清单顺序追加。
     名字表标了「内置」的目录条目（Keylight、VISINF 颗粒等）归回 AE 内置分组，
     不受扫描启发式漏判影响。 */
  const pluginEntries = (pluginDoc && pluginDoc.items) || [];
  const entryByMatchName = new Map();
  for (const entry of pluginEntries) {
    if (entry && entry.matchName && !entryByMatchName.has(entry.matchName)) {
      entryByMatchName.set(entry.matchName, entry);
    }
  }
  const blacklist = catalog.readBlacklist(paths);
  const builtinCats = builtinCategoryNames(names);
  const builtinExtra = [];
  const pluginItems = [];
  const seen = new Set();
  const addCatalogRow = (row, fromCatalog) => {
    const matchName = String((row && row.matchName) || "");
    if (!matchName) return;
    const entry = entryByMatchName.get(matchName) || null;
    const record = names.get(matchName) || {};
    const meta = pluginMeta(row, entry, names);
    const item = catalogItemFor(meta, entry, pluginDoc, dataDir, blacklist);
    /* renderable 只认 catalog TSV 行（可交给现有插件渲染管线）；manifest 独有项不可渲染 */
    const renderable = !!fromCatalog;
    /* generated 只认 plugin_manifest 命中；L1 内置预览是面板渲染的，不算生成 */
    const generated = !!entry;
    /* 第三方目录里混进来的 AE 自带效果：
       · 名字表明确标了「内置」；或
       · 插件无法识别（其它插件）但分类是 AE 内置分类（沉浸式视频、生成等） */
    const unknownPlugin = trimmed(row && row.plugin) === "其它插件";
    const builtinCategory =
      unknownPlugin && !!trimmed(row && row.category) && builtinCats.has(trimmed(row && row.category));
    decorate(item, renderable, generated);
    if (isBuiltinCatalogRecord(record) || builtinCategory) {
      item.source = "builtin";
      item.plugin = "内置";
      builtinExtra.push(item);
    } else {
      pluginItems.push(item);
    }
  };

  for (const row of catalogRows.rows) {
    if (!row || !row.matchName || seen.has(row.matchName)) continue;
    seen.add(row.matchName);
    if (row.excluded || row.noPreview) continue;
    addCatalogRow(row, true);
  }
  for (const entry of pluginEntries) {
    if (!entry || !entry.matchName || seen.has(entry.matchName)) continue;
    seen.add(entry.matchName);
    addCatalogRow({ matchName: entry.matchName }, false);
  }

  const items = [...builtinItems, ...builtinExtra, ...pluginItems];

  /* 手动调参标记：有覆盖行 = “手动”，全部验证过 = 已验证。 */
  const overrideDoc = effectOverrides.read(paths);
  const overridesByMatch = new Map();
  for (const override of overrideDoc.items || []) {
    if (!override || !override.matchName) continue;
    if (!overridesByMatch.has(override.matchName)) overridesByMatch.set(override.matchName, []);
    overridesByMatch.get(override.matchName).push(override);
  }
  for (const item of items) {
    const rows = overridesByMatch.get(item.matchName) || [];
    item.manual = rows.length > 0;
    item.manualVerified = rows.length > 0 && rows.every((row) => row.verified === true);
    item.manualUnverified = rows.some((row) => row.verified === false);
    item.manualPreset = rows.find((row) => row.preset)?.preset || "";
  }

  const categorySet = new Set();
  const pluginSet = new Set();
  let builtinCount = 0;
  let pluginCount = 0;
  let renderedCount = 0;
  let pendingCount = 0;
  for (const item of items) {
    if (item.source === "builtin") builtinCount++;
    else pluginCount++;
    if (item.hasPreview) renderedCount++;
    if (!item.hasPreview) pendingCount++;
    if (item.category) categorySet.add(item.category);
    pluginSet.add(item.plugin || "其它插件");
  }

  return {
    ok: true,
    dataDir,
    favorites: favorites.items,
    counts: {
      total: items.length,
      builtin: builtinCount,
      plugin: pluginCount,
      rendered: renderedCount,
      pending: pendingCount,
      categories: categorySet.size,
      plugins: pluginSet.size,
    },
    sources: {
      builtinPreview: builtinManifest,
      pluginPreview: paths.pluginManifest,
      names: path.join(dataDir, "names.json"),
      catalog: paths.pluginCatalog,
      aeMajor: catalogRows.aeMajor,
      aeVersion: catalogRows.aeVersion,
      scannedAt: catalogRows.scannedAt,
    },
    items,
  };
}

/* ---------- 取消渲染 ---------- */

/** dataDir 内的相对路径 → 绝对路径；越界（../）或空值返回 "" */
function dataFilePath(paths, relative) {
  const root = path.resolve(paths.dataDir);
  const full = path.resolve(root, String(relative || "").replace(/\//g, path.sep));
  if (full === root || !full.startsWith(root + path.sep)) return "";
  return full;
}

/** frameSrc 通配（%04d）→ { dir, matcher }，匹配 0000-9999 帧文件 */
function framePatternMatcher(pattern) {
  if (!pattern.includes("%04d")) return null;
  const dir = path.dirname(pattern);
  const base = path
    .basename(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("%04d", "\\d{4}");
  return { dir, matcher: new RegExp("^" + base + "$", "i") };
}

/** 一条 manifest 条目在 dataDir 内引用的所有图片 */
function collectEntryFiles(paths, entry, output) {
  const src = dataFilePath(paths, entry && entry.src);
  if (src) output.add(src);
  const pattern = dataFilePath(paths, entry && entry.frameSrc);
  if (!pattern) return;
  const match = framePatternMatcher(pattern);
  if (!match) {
    output.add(pattern);
    return;
  }
  let names = [];
  try {
    names = fs.readdirSync(match.dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (match.matcher.test(name)) output.add(path.join(match.dir, name));
  }
}

/** 删除 TSV 里 matchName 对应的行（按第一列精确匹配，保留表头/空行） */
function removeTsvRows(file, matchName) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return 0;
  }
  let removed = 0;
  const output = text.split(/\r?\n/).filter((line) => {
    if (!line) return true;
    if (line.split("\t")[0] !== matchName) return true;
    removed++;
    return false;
  });
  if (removed) fs.writeFileSync(file, output.join("\r\n"), "utf8");
  return removed;
}

/** 删除 plugin_blacklist.json 里的黑名单记录，让效果可以重新渲染 */
function removeBlacklistRecord(file, matchName) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return false;
  }
  const items = Array.isArray(doc.items) ? doc.items : [];
  const next = items.filter((item) => !(item && String(item.matchName || "").trim() === matchName));
  if (next.length === items.length) return false;
  try {
    fs.writeFileSync(file, JSON.stringify({ ...doc, items: next }, null, 1), "utf8");
  } catch {
    return false;
  }
  return true;
}

/**
 * 取消一条插件效果的渲染结果：删索引条目、专属帧文件、previews TSV 行与黑名单记录。
 * 仍被其它条目或 sheet 引用的文件（共用拼图）不会被删。
 * @param {ReturnType<import("./paths").createPaths>} paths
 * @param {string} matchName
 * @returns {{ok: boolean, removed: number, deleted: number, reason?: string}}
 */
function clearPreview(paths, matchName) {
  const name = typeof matchName === "string" ? matchName.trim() : "";
  if (!name) return { ok: false, reason: "invalid_match_name", removed: 0, deleted: 0 };

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(paths.pluginManifest, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, reason: "no_manifest", removed: 0, deleted: 0 };
  }
  const items = Array.isArray(doc.items) ? doc.items : [];
  const removedItems = items.filter((item) => item && item.matchName === name);
  if (!removedItems.length) return { ok: false, reason: "not_found", removed: 0, deleted: 0 };
  const remaining = items.filter((item) => !(item && item.matchName === name));

  /* 候选文件 = 被删条目引用的图片；仍被剩余条目 / sheet 引用的跳过（共用拼图） */
  const candidates = new Set();
  for (const item of removedItems) collectEntryFiles(paths, item, candidates);

  const protectedExact = new Set();
  const protectedMatchers = [];
  for (const item of remaining) {
    const src = dataFilePath(paths, item.src);
    if (src) protectedExact.add(path.resolve(src).toLowerCase());
    const pattern = dataFilePath(paths, item.frameSrc);
    if (!pattern) continue;
    const match = framePatternMatcher(pattern);
    if (match) protectedMatchers.push(match);
    else protectedExact.add(path.resolve(pattern).toLowerCase());
  }
  for (const sheet of Array.isArray(doc.sheets) ? doc.sheets : []) {
    const src = dataFilePath(paths, sheet && sheet.src);
    if (src) protectedExact.add(path.resolve(src).toLowerCase());
  }
  const isProtected = (file) => {
    const key = path.resolve(file).toLowerCase();
    if (protectedExact.has(key)) return true;
    const dir = path.dirname(key);
    for (const match of protectedMatchers) {
      if (path.resolve(match.dir).toLowerCase() !== dir) continue;
      if (match.matcher.test(path.basename(key))) return true;
    }
    return false;
  };

  /* 先写索引：写盘失败时不动图片，避免「图没了、索引还在」 */
  doc.items = remaining;
  try {
    fs.writeFileSync(paths.pluginManifest, JSON.stringify(doc, null, 1), "utf8");
  } catch {
    return { ok: false, reason: "write_failed", removed: 0, deleted: 0 };
  }

  let deleted = 0;
  for (const file of candidates) {
    if (isProtected(file)) continue;
    try {
      fs.unlinkSync(file);
      deleted++;
    } catch {
      /* 文件缺失或被占用：不影响索引清理 */
    }
  }

  /* plugin_previews.tsv 实际落在 dataDir（部分版本在 probe），两处都清一次 */
  removeTsvRows(path.join(paths.dataDir, "plugin_previews.tsv"), name);
  removeTsvRows(path.join(paths.probe, "plugin_previews.tsv"), name);
  removeTsvRows(path.join(paths.probe, "plugin_blacklist.tsv"), name);
  removeBlacklistRecord(path.join(paths.dataDir, "plugin_blacklist.json"), name);

  return { ok: true, removed: removedItems.length, deleted };
}

module.exports = { list, clearPreview, FPS };
