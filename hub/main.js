/* ============================================================
 * main.js —— DreamEngine Hub 主进程
 *
 * 职责边界（和 CEP 面板同样的分层）：
 *   主进程 = 文件系统 + 进程调度 + 系统对话框
 *   渲染进程 = 纯 UI，不碰 Node（contextIsolation 开着）
 *
 * 刻意不做的事：
 *   · 不自己实现渲染调度 —— 一律 spawn tools/generate_plugin_presets.ps1
 *   · 不自己实现安装 —— 一律调用 tools/install_dreamengine.ps1
 * ============================================================ */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const { createPaths } = require("./core/paths");
const { findAfterFX, bestAfterFX, isAERunning } = require("./core/ae");
const presets = require("./core/presets");
const presetSources = require("./core/preset_sources");
const presetCategories = require("./core/preset_categories");
const install = require("./core/install");
const { RenderJob } = require("./core/render");
const { PluginEffectJob } = require("./core/effect_render");
const { ManualEffectRunner } = require("./core/manual_effect");
const { EffectDumpJob } = require("./core/effect_dump");
const { AeGuardJob } = require("./core/ae_guard");
const { runningReason: aeRunningReason } = require("./core/ae_jobs");
const previewResults = require("./core/preview_results");
const effectOverrides = require("./core/effect_overrides");
const catalog = require("./core/catalog");
const effects = require("./core/effects");
const effectFavorites = require("./core/effect_favorites");
const {
  importImageAsPng,
  normalizeBackgroundDirectory,
  isPngFile,
} = require("./core/backgrounds");

let mainWindow = null;
let paths = null;
let job = null;
let pluginJob = null;
let manualRunner = null;
let dumpJob = null;
// AE 崩溃修复对话框看守：Hub 调起 AE 时启动，任务结束/退出时停掉
let guardJob = null;
// 本次属性获取的 AE 版本，合并缓存时写进每组 meta
let dumpContext = { ae: "", aeVersion: "", aeMajor: 0 };
// 属性缓存模块由数据面提交引入；未安装时 UI 会收到 not_wired，不崩
let paramCacheModule;
function paramCache() {
  if (paramCacheModule !== undefined) return paramCacheModule;
  try {
    paramCacheModule = require("./core/effect_param_cache");
  } catch {
    paramCacheModule = null;
  }
  return paramCacheModule;
}

/** 开发态用仓库里的 tools/；打包后随包走 resources/tools/ */
function toolsDir() {
  const packed = path.join(process.resourcesPath || "", "tools");
  if (
    fs.existsSync(path.join(packed, "generate_plugin_presets.ps1")) &&
    fs.existsSync(path.join(packed, "generate_plugin_effects.ps1"))
  ) {
    return packed;
  }
  return path.join(__dirname, "..", "tools");
}

function buildPaths() {
  // 必须用 Electron 的 documents 路径：Windows 上它可能被 OneDrive 重定向，
  // os.homedir()+"Documents" 在这种情况下会指向一个空目录。
  return createPaths({ docsDir: app.getPath("documents") });
}

/**
 * 记住当前 Hub 可执行文件位置，供 AE 面板“打开 Hub”直接启动。
 * 安装目录允许用户修改，所以不能把路径硬编码进 CEP 面板。
 */
function rememberHubPath(currentPaths) {
  try {
    if (path.basename(process.execPath).toLowerCase() !== "dreamengine hub.exe") return;
    const dir = path.join(currentPaths.docsDir, "DreamEngine");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hub-path.txt"), process.execPath + "\n", "utf8");
  } catch {
    /* 标记失败不影响 Hub 启动；面板仍会查开始菜单和默认路径 */
  }
}

/** 插件目录扫描时记录的 AE；目录/属性缓存都是这一版扫出来的，默认就用它。 */
function readCatalogMetaSafe() {
  try {
    return catalog.readCatalogMeta(paths) || {};
  } catch {
    return {};
  }
}

function preferredAe() {
  const meta = readCatalogMetaSafe();
  const exe = String(meta.aeExe || "");
  if (exe && fs.existsSync(exe)) return exe;
  return bestAfterFX();
}

function snapshot() {
  const versions = findAfterFX();
  return {
    ae: {
      running: isAERunning(),
      installed: versions.map((v) => ({ name: v.name, version: v.version, exe: v.exe })),
      exe: bestAfterFX(),
    },
    catalogMeta: readCatalogMetaSafe(),
    ext: install.status(paths),
    paths: {
      presets: paths.presets,
      backgrounds: paths.backgrounds,
      extDir: paths.extDir,
      probe: paths.probe,
      docs: paths.docsDir,
      effectParams: paths.effectParamsRoot,
    },
    render: job ? { running: job.isRunning(), state: job.snapshot() } : { running: false, state: null },
    pluginEffects: pluginJob
      ? { running: pluginJob.isRunning(), mode: pluginJob.getMode(), state: pluginJob.snapshot() }
      : { running: false, mode: "", state: null },
    aeGuard: guardJob ? guardJob.snapshot() : { running: false },
  };
}

/* ---------------------------------------------------------------
 * AE 崩溃修复对话框看守
 *
 * AE 上次异常退出后，下次启动有概率停在「崩溃修复选项」对话框上，把脚本化启动卡死。
 * 只要 Hub 要调起 AE（渲染 / 取参 / 扫目录）就启动看守脚本，任务结束再停。
 * 检测与按键逻辑全在 tools/ae_crash_guard.ps1，主进程不重复实现。
 * --------------------------------------------------------------- */

function aeJobBusy() {
  return !!aeBusyReason();
}

function aeBusyReason() {
  return aeRunningReason({
    preset: job,
    effects: pluginJob,
    dump: dumpJob,
    manual: manualRunner,
  });
}

function startAeGuard(reason, enabled) {
  if (enabled === false) {
    console.log("[ae-guard] disabled by user, skip for " + reason);
    return { ok: false, reason: "disabled" };
  }
  if (!guardJob) return { ok: false, reason: "no_job" };
  const result = guardJob.start({ timeoutSec: 7200, intervalSec: 1.2 });
  if (result.ok && !result.alreadyRunning) {
    console.log("[ae-guard] started for " + reason + " pid=" + result.pid);
  }
  return result;
}

/** 任务收尾统一走这里：还有别的 AE 任务在跑就留着看守，全空了才停 */
function stopAeGuard(reason) {
  if (!guardJob) return { ok: false, reason: "no_job" };
  if (guardJob.isRunning() && !aeJobBusy()) {
    const result = guardJob.stop();
    console.log("[ae-guard] stopped after " + reason);
    return result;
  }
  return { ok: true, kept: guardJob.isRunning() };
}

/** 上一轮任务异常退出后可能留下选择/扫描标记，启动新任务前统一清掉。 */
function cleanupJobMarkers(paths) {
  for (const key of ["pluginSelectionMarker", "pluginForceMarker", "pluginCatalogOnlyMarker"]) {
    try {
      fs.rmSync(paths[key], { force: true });
    } catch {
      /* 标记清理失败不影响任务 */
    }
  }
}

/** 过滤用户在 Hub 勾选的预设（实现放在 core/presets.js，便于单测） */
function selectedPresetPaths(list) {
  return presets.resolveSelection(paths, list);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0f1113",
    show: false,
    title: "DreamEngine Hub",
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  // 开发排查用：`electron . --console` 把渲染进程的 console / 报错打到终端
  if (process.argv.includes("--console")) {
    mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${sourceId}:${line} ${message}`);
    });
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      console.error("[renderer gone] " + JSON.stringify(details));
    });
  }
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle("hub:snapshot", () => snapshot());
  ipcMain.handle("shell:openExternal", (_event, url) => {
    const allowed = new Set([
      "https://v.douyin.com/-9l_jE72QY4/",
      "https://github.com/yoanx/DreamEngine",
    ]);
    if (!allowed.has(url)) return false;
    return shell.openExternal(url).then(() => true).catch(() => false);
  });
  ipcMain.handle("clipboard:writeText", (_event, text) => {
    if (text !== "972561311") return false;
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle("presets:list", () => presets.list(paths));

  // 扫描所选 AE 的安装 Presets + User Presets，只写外部索引，不复制文件
  ipcMain.handle("presets:sync", (_event, options) => {
    const opts = options || {};
    const aeExe = String(opts.ae || "").trim() || bestAfterFX();
    if (!aeExe) return { ok: false, reason: "no_ae" };
    const result = presetSources.scanAePresets(paths, {
      aeExe,
      force: !!opts.force,
    });
    if (!result.ok) return result;
    // items 由 presets:list 从 preset_catalog.json 读取，IPC 只回摘要
    const { items, ...summary } = result;
    return summary;
  });

  ipcMain.handle("presets:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 After Effects 预设",
      buttonLabel: "导入",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "After Effects 预设", extensions: ["ffx"] }],
    });
    if (result.canceled || !result.filePaths.length) return { imported: [], skipped: [] };
    const done = presets.importFiles(result.filePaths, paths);
    return done;
  });

  // 拖拽进来的路径：文件对话框之外的第二种入口（面板里也保留了这条）
  ipcMain.handle("presets:importPaths", (_event, files) => presets.importFiles(files || [], paths));
  ipcMain.handle("presets:delete", (_event, target) => presets.removePreset(target, paths));
  ipcMain.handle("presets:rename", (_event, target, name) => {
    const renamed = presets.renamePreset(target, name, paths);
    if (!renamed.ok || renamed.unchanged) return renamed;
    presetCategories.movePath(paths, renamed.previousPath, renamed.path);
    presets.remapPreviewReferences(paths, renamed.previousPath, renamed.path, renamed.name);
    return renamed;
  });
  ipcMain.handle("presets:clearRender", (_event, target) => presets.clearPreview(target, paths));
  ipcMain.handle("categories:load", () => presetCategories.read(paths));
  ipcMain.handle("categories:create", (_event, name) => presetCategories.create(paths, name));
  ipcMain.handle("categories:rename", (_event, id, name) => presetCategories.rename(paths, id, name));
  ipcMain.handle("categories:delete", (_event, id) => presetCategories.remove(paths, id));
  ipcMain.handle("categories:assign", (_event, target, id) =>
    presetCategories.assign(paths, target, id),
  );
  ipcMain.handle("categories:toggleFavorite", (_event, target) =>
    presetCategories.toggleFavorite(paths, target),
  );

  ipcMain.handle("backgrounds:list", () => {
    // 与面板的 preset_preview.backgroundsJson 保持同一组内置 id
    const builtin = [
      { id: "photo", label: "标准素材" },
      { id: "text", label: "文字" },
      { id: "solid", label: "纯色" },
      { id: "shape", label: "形状" },
      { id: "pattern", label: "条纹" },
    ];
    const extra = [];
    try {
      normalizeBackgroundDirectory({ dir: paths.backgrounds, nativeImage });
      for (const name of fs.readdirSync(paths.backgrounds)) {
        const fullPath = path.join(paths.backgrounds, name);
        if (!/\.png$/i.test(name) || !isPngFile(fullPath)) continue;
        extra.push({
          id: fullPath,
          label: name.replace(/\.[^.]+$/, "") + "（自定义）",
        });
      }
    } catch {
      /* 目录还没建 */
    }
    return [...builtin, ...extra];
  });

  ipcMain.handle("backgrounds:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "添加预览背景",
      buttonLabel: "添加",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"] }],
    });
    if (result.canceled || !result.filePaths.length) return { added: [] };

    fs.mkdirSync(paths.backgrounds, { recursive: true });
    const added = [];
    const errors = [];
    for (const source of result.filePaths) {
      if (!/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(source)) continue;
      const imported = importImageAsPng({
        source,
        targetDir: paths.backgrounds,
        nativeImage,
      });
      if (imported.ok) added.push(imported.path);
      else errors.push({ source, reason: imported.reason || "convert_failed" });
    }
    return { added, errors };
  });

  ipcMain.handle("shell:reveal", (_event, target) => {
    if (!target) return false;
    const dir = fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? target
      : path.dirname(target);
    if (!fs.existsSync(dir)) return false;
    shell.openPath(dir);
    return true;
  });

  /* 属性缓存目录：第一次打开时还没有任何缓存，直接建出来免得用户看到「路径不存在」 */
  ipcMain.handle("settings:openEffectParams", () => {
    try {
      fs.mkdirSync(paths.effectParamsRoot, { recursive: true });
    } catch {
      return false;
    }
    shell.openPath(paths.effectParamsRoot);
    return true;
  });

  ipcMain.handle("render:start", (_event, options) => {
    if (!job) return { ok: false, reason: "no_job" };
    const busy = aeBusyReason();
    if (busy) return { ok: false, reason: busy };
    let opts = options || {};
    let selectedPaths = null;
    if (Array.isArray(opts.presetPaths)) {
      selectedPaths = selectedPresetPaths(opts.presetPaths);
      if (selectedPaths.length === 0) return { ok: false, reason: "nothing_to_render" };
      try {
        fs.mkdirSync(paths.probe, { recursive: true });
        fs.writeFileSync(paths.presetSelection, selectedPaths.join("\r\n") + "\r\n", "utf8");
      } catch (error) {
        return { ok: false, reason: "write_failed", detail: String(error.message || error) };
      }
      opts = {
        ...opts,
        presetList: paths.presetSelection,
        force: !!opts.force,
        limit: Math.max(selectedPaths.length, 1),
      };
    }
    // 外部 AE 预设需要靠 -AE 推导允许的 Presets 根目录；没选版本时用
    // 最近一次外部索引里的 AE，避免 ps1 把外部路径当成非法路径。
    if (!opts.ae && (opts.presetList || opts.onlyPreset)) {
      const externalCatalog = presetSources.readCatalog(paths);
      if (externalCatalog && externalCatalog.aeExe) opts.ae = externalCatalog.aeExe;
    }
    if (!opts.ae) opts.ae = preferredAe();
    const statePath = paths.hubState;
    // 上一轮残留的 done/failed 状态会让 UI 一上来就显示「已完成」，先清掉
    try {
      fs.rmSync(statePath, { force: true });
    } catch {
      /* 无所谓 */
    }
    // 逐条结果账本：本次运行开始时清空，Hub 侧过滤掉的条目先记成 skip，
    // 之后脚本会按条追加 ok / fail（见 core/preview_results.js）。
    previewResults.beginRun(paths, {
      kind: "preset",
      skips: Array.isArray(opts.skips) ? opts.skips : [],
    });
    const result = job.start(opts);
    if (result.ok) startAeGuard("preset render", opts.aeGuard !== false);
    if (result.ok && selectedPaths) {
      return { ...result, selectedCount: selectedPaths.length };
    }
    return result;
  });

  ipcMain.handle("render:stop", () => {
    if (!job) return { ok: false };
    const result = job.stop();
    stopAeGuard("render stop");
    return result;
  });

  ipcMain.handle("render:snapshot", () => (job ? job.snapshot() : null));

  ipcMain.handle("plugin-effects:start", (_event, options) => {
    if (!pluginJob) return { ok: false, reason: "no_job" };
    const busy = aeBusyReason();
    if (busy) return { ok: false, reason: busy };

    const opts = options || {};
    if (!opts.ae) opts.ae = preferredAe();
    cleanupJobMarkers(paths);

    const cat = Array.isArray(opts.matchNames) ? catalog.readCatalog(paths) : null;
    if (cat && !cat.ok) return { ok: false, reason: "no_catalog" };
    const plan = cat ? catalog.planSelection(cat, opts.matchNames, !!opts.force) : null;
    if (plan && plan.mode === "selection") {
      const { selected, skipped } = plan;
      if (selected.length === 0) {
        return { ok: false, reason: "nothing_to_render", skipped };
      }
      try {
        catalog.writeSelection(paths, selected);
      } catch (error) {
        return { ok: false, reason: "write_failed", detail: String(error.message || error) };
      }
      // 跳过项来自两处：目录里已经不可渲的，以及运行计划里本次不渲的
      const skipRows = previewResults.skipsFromCatalog("effect", skipped);
      const knownSkips = new Set(skipRows.map((row) => row.key));
      for (const row of Array.isArray(opts.skips) ? opts.skips : []) {
        const key = String((row && row.key) || "");
        if (!key || knownSkips.has(key)) continue;
        knownSkips.add(key);
        skipRows.push({
          kind: "effect",
          key,
          name: String((row && row.name) || key),
          status: "skip",
          reason: String((row && row.reason) || ""),
        });
      }
      previewResults.beginRun(paths, { kind: "effect", skips: skipRows });
      const result = pluginJob.start({
        ...opts,
        todoPath: paths.pluginSelection,
        force: !!opts.force,
      });
      if (!result.ok) return result;
      startAeGuard("plugin effects", opts.aeGuard !== false);
      return {
        ...result,
        selectedCount: selected.length,
        skippedCount: skipped.length,
        skipped,
      };
    }

    previewResults.beginRun(paths, { kind: "effect" });
    const started = pluginJob.start(opts);
    if (started.ok) startAeGuard("plugin effects (all)", opts.aeGuard !== false);
    return started;
  });


  ipcMain.handle("plugin-effects:scan", (_event, options) => {
    if (!pluginJob) return { ok: false, reason: "no_job" };
    const busy = aeBusyReason();
    if (busy) return { ok: false, reason: busy };
    cleanupJobMarkers(paths);
    const scanned = pluginJob.start({
      catalogOnly: true,
      ae: (options && options.ae) || preferredAe(),
    });
    if (scanned.ok) startAeGuard("catalog scan", !options || options.aeGuard !== false);
    return scanned;
  });

  ipcMain.handle("plugin-effects:catalog", () => catalog.readCatalog(paths));

  /* 预览渲染的逐条结果账本（第 5 步统计的唯一数据源） */
  ipcMain.handle("preview:results", () => previewResults.read(paths));
  ipcMain.handle("preview:clearResults", () => previewResults.clear(paths));

  /* 人工调参 · 属性获取：批量脚本只负责跑 AE 和写原始 dump */
  ipcMain.handle("dump:start", (_event, options) => {
    if (!dumpJob) return { ok: false, reason: "no_job" };
    const busy = aeBusyReason();
    if (busy) return { ok: false, reason: busy };

    const opts = options || {};
    const targets = Array.isArray(opts.targets)
      ? opts.targets
      : Array.isArray(opts.matchNames)
        ? opts.matchNames
        : [];
    if (!targets.length) return { ok: false, reason: "nothing_to_dump" };

    const meta = catalog.readCatalogMeta(paths) || {};
    dumpContext = {
      ae: String(opts.ae || preferredAe()),
      aeVersion: String(meta.aeVersion || ""),
      aeMajor: Number(meta.aeMajor) || 0,
    };
    const written = dumpJob.writeTargets(targets);
    if (!written.ok || !written.count) return { ok: false, reason: "write_failed" };
    const result = dumpJob.start({
      ae: opts.ae || preferredAe(),
      limit: opts.limit,
      rounds: opts.rounds,
      force: !!opts.force,
    });
    if (!result.ok) return result;
    startAeGuard("param dump", opts.aeGuard !== false);
    return { ...result, count: written.count };
  });

  ipcMain.handle("dump:stop", () => {
    if (!dumpJob) return { ok: false, reason: "no_job" };
    const result = dumpJob.stop();
    stopAeGuard("dump stop");
    return result;
  });
  ipcMain.handle("dump:snapshot", () => (dumpJob ? dumpJob.snapshot() : null));
  ipcMain.handle("dump:logTail", (_event, lines = 40) => {
    const n = lines === undefined ? 40 : Math.floor(Number(lines));
    if (!Number.isFinite(n) || n <= 0) return "";
    try {
      return fs
        .readFileSync(paths.effectDumpLog, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-n)
        .join("\n");
    } catch {
      return "";
    }
  });

  /* 人工调参 · 属性缓存（只读） */
  ipcMain.handle("params:index", () => {
    const cache = paramCache();
    if (!cache) return { ok: false, reason: "not_wired" };
    return cache.readIndex(paths);
  });

  ipcMain.handle("params:effect", (_event, matchName) => {
    const cache = paramCache();
    if (!cache) return { ok: false, reason: "not_wired" };
    return cache.readEffect(paths, String(matchName || "").trim());
  });

  /* 人工调参 · 覆盖表增量写：只替换该 matchName 的行，其余原样保留 */
  ipcMain.handle("overrides:write", (_event, payload) => {
    const data = payload || {};
    const matchName = String(data.matchName || "").trim();
    if (!matchName) return { ok: false, reason: "missing_match_name" };
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const current = effectOverrides.read(paths);
    if (!current.ok) return { ok: false, reason: current.reason || "read_failed" };

    const items = (current.items || []).filter((item) => item.matchName !== matchName);
    let added = 0;
    for (const entry of entries) {
      const item = effectOverrides.manualEntry(matchName, entry);
      if (!item) continue;
      items.push(item);
      added += 1;
    }
    const result = effectOverrides.write(paths, items);
    if (!result.ok) return result;
    return { ...result, matchName, count: added, total: items.length };
  });

  /* 效果库：内置 + 插件的合并只读视图（数据层在 core/effects.js） */
  ipcMain.handle("effects:list", () => effects.list(paths));
  ipcMain.handle("effects:toggleFavorite", (_event, matchName) =>
    effectFavorites.toggle(paths, matchName),
  );
  ipcMain.handle("effects:clearPreview", (_event, matchName) =>
    effects.clearPreview(paths, matchName),
  );

  ipcMain.handle("plugin-effects:stop", () => {
    if (!pluginJob) return { ok: false, reason: "no_job" };
    const result = pluginJob.stop();
    stopAeGuard("plugin effects stop");
    return result;
  });
  ipcMain.handle("plugin-effects:snapshot", () =>
    pluginJob ? pluginJob.snapshot() : null,
  );
  ipcMain.handle("plugin-effects:logTail", (_event, lines = 40) => {
    const n = lines === undefined ? 40 : Math.floor(Number(lines));
    if (!Number.isFinite(n) || n <= 0) return "";
    try {
      return fs.readFileSync(paths.pluginEffectLog, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-n)
        .join("\n");
    } catch {
      return "";
    }
  });

  ipcMain.handle("log:tail", (_event, lines = 40) => {
    const n = lines === undefined ? 40 : Math.floor(Number(lines));
    if (!Number.isFinite(n) || n <= 0) return "";
    try {
      const text = fs.readFileSync(paths.runLog, "utf8");
      return text.split(/\r?\n/).filter(Boolean).slice(-n).join("\n");
    } catch {
      return "";
    }
  });

  /* ---------- 手动调参：dump / baseline / verify / save ---------- */

  function manualBusy() {
    if (!manualRunner) return { busy: true, reason: "no_runner" };
    const reason = aeBusyReason();
    if (reason) return { busy: true, reason };
    return null;
  }

  function validMatchName(value) {
    const name = String(value === null || value === undefined ? "" : value).trim();
    return name && !/[\t\r\n]/.test(name) ? name : "";
  }

  function comparePngFiles(baselineFile, verifyFile) {
    const baseline = nativeImage.createFromPath(baselineFile);
    const verify = nativeImage.createFromPath(verifyFile);
    if (baseline.isEmpty() || verify.isEmpty()) {
      return { ok: false, reason: "image_read_failed" };
    }
    const sizeA = baseline.getSize();
    const sizeB = verify.getSize();
    if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) {
      return { ok: false, reason: "size_mismatch", sizeA, sizeB };
    }
    const a = baseline.getBitmap();
    const b = verify.getBitmap();
    const totalPixels = sizeA.width * sizeA.height;
    let diffPixels = 0;
    let maxChannelDiff = 0;
    for (let i = 0; i < totalPixels; i++) {
      const off = i * 4;
      const dr = Math.abs(a[off] - b[off]);
      const dg = Math.abs(a[off + 1] - b[off + 1]);
      const db = Math.abs(a[off + 2] - b[off + 2]);
      const da = Math.abs(a[off + 3] - b[off + 3]);
      const diff = Math.max(dr, dg, db, da);
      if (diff > 0) diffPixels++;
      if (diff > maxChannelDiff) maxChannelDiff = diff;
    }
    return {
      ok: true,
      identical: diffPixels === 0,
      diffPixels,
      totalPixels,
      maxChannelDiff,
      baselineDataUrl: baseline.toDataURL(),
      verifyDataUrl: verify.toDataURL(),
    };
  }

  async function withManualAe(reason, aeGuard, task) {
    startAeGuard(reason, aeGuard);
    try {
      return await task();
    } finally {
      stopAeGuard(reason + " exit");
    }
  }

  async function runManualBaseline(matchName, ae) {
    /* 基线必须不带手动覆盖；临时移走覆盖表，结束后恢复。 */
    const file = effectOverrides.overridesPath(paths);
    const backup = file + ".manual-baseline-backup";
    let moved = false;
    try {
      if (fs.existsSync(file)) {
        fs.renameSync(file, backup);
        moved = true;
      }
      return await manualRunner.run({ matchName, mode: "baseline", ae });
    } finally {
      if (moved) {
        try { fs.renameSync(backup, file); } catch { /* 恢复失败时保留备份 */ }
      }
    }
  }

  ipcMain.handle("manual:dump", async (_event, options) => {
    const busy = manualBusy();
    if (busy) return { ok: false, reason: busy.reason };
    const matchName = validMatchName(options && options.matchName);
    if (!matchName) return { ok: false, reason: "bad_match_name" };
    const ae = (options && options.ae) || bestAfterFX();
    return withManualAe("manual dump", options && options.aeGuard, () =>
      manualRunner.run({ matchName, mode: "fastdump", ae }),
    );
  });

  ipcMain.handle("manual:baseline", async (_event, options) => {
    const busy = manualBusy();
    if (busy) return { ok: false, reason: busy.reason };
    const matchName = validMatchName(options && options.matchName);
    if (!matchName) return { ok: false, reason: "bad_match_name" };
    const ae = (options && options.ae) || bestAfterFX();
    return withManualAe("manual baseline", options && options.aeGuard, () =>
      runManualBaseline(matchName, ae),
    );
  });

  ipcMain.handle("manual:overrides", (_event, matchName) => {
    const name = validMatchName(matchName);
    if (!name) return { ok: false, reason: "bad_match_name", items: [] };
    const doc = effectOverrides.read(paths);
    const items = effectOverrides.forMatchName(doc.items, name).map(effectOverrides.manualRow);
    return { ok: doc.ok, items, errors: doc.errors };
  });

  ipcMain.handle("manual:verify", async (_event, options) => {
    const busy = manualBusy();
    if (busy) return { ok: false, reason: busy.reason };
    const matchName = validMatchName(options && options.matchName);
    if (!matchName) return { ok: false, reason: "bad_match_name" };
    const rows = Array.isArray(options && options.params) ? options.params : [];
    const baselinePath = String((options && options.baselinePath) || "");
    const candidate = rows
      .filter((row) => row && row.enabled !== false)
      .map((row) => effectOverrides.manualEntry(matchName, row))
      .filter(Boolean)
      .map((row) => ({ ...row, verified: null }));
    if (candidate.length === 0) return { ok: false, reason: "no_params" };

    const ae = (options && options.ae) || bestAfterFX();
    return withManualAe("manual verify", options && options.aeGuard, async () => {
      let baselineFile = baselinePath;
      if (!baselineFile || !fs.existsSync(baselineFile)) {
        const baseline = await runManualBaseline(matchName, ae);
        if (!baseline.ok || !baseline.png) return { ...baseline, compare: null };
        baselineFile = baseline.png;
      }

      const base = effectOverrides.read(paths);
      const kept = (base.items || []).filter((item) => item && item.matchName !== matchName);
      const wrote = effectOverrides.write(paths, kept.concat(candidate));
      if (!wrote.ok) return wrote;
      try {
        const run = await manualRunner.run({ matchName, mode: "verify", ae });
        if (!run.ok || !run.png) return { ...run, compare: null, baselinePath: baselineFile };
        const compare = comparePngFiles(baselineFile, run.png);
        return { ...run, compare, baselinePath: baselineFile };
      } finally {
        /* 验证只是临时写表；恢复用户原有覆盖（可能是缺失表）。 */
        if (base.missing) {
          try { fs.rmSync(effectOverrides.overridesPath(paths), { force: true }); } catch { /* ignore */ }
        } else {
          effectOverrides.write(paths, base.items || []);
        }
      }
    });
  });

  ipcMain.handle("manual:save", (_event, options) => {
    const matchName = validMatchName(options && options.matchName);
    if (!matchName) return { ok: false, reason: "bad_match_name" };
    const rows = Array.isArray(options && options.params) ? options.params : [];
    const preset = String((options && options.preset) || "").trim();
    const base = effectOverrides.read(paths);
    const kept = (base.items || []).filter((item) => item && item.matchName !== matchName);
    const candidate = rows
      .filter((row) => row && row.enabled !== false)
      .map((row) => effectOverrides.manualEntry(matchName, row))
      .filter(Boolean);
    /* .ffx 只在没有逐参数覆盖时作为兜底；两者同时存在时参数优先。 */
    if (preset && candidate.length === 0) {
      candidate.push({
        matchName,
        preset,
        scene: "",
        enabled: true,
        paramIndex: "",
        paramPath: "",
        value: null,
        valueType: "",
        verified: null,
        note: "",
      });
    }
    if (candidate.length === 0) return { ok: false, reason: "no_params" };
    const wrote = effectOverrides.write(paths, kept.concat(candidate));
    if (!wrote.ok) return wrote;
    /* 旧预览可能还带着旧参数；先清掉，UI 随后启动强制重渲。 */
    effects.clearPreview(paths, matchName);
    return wrote;
  });

  ipcMain.handle("manual:pickPreset", async () => {
    if (!mainWindow) return { ok: false, reason: "no_window" };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 .ffx 兜底预设",
      properties: ["openFile"],
      filters: [{ name: "After Effects 预设", extensions: ["ffx"] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, reason: "cancelled" };
    return effectOverrides.importPreset(paths, result.filePaths[0]);
  });

  ipcMain.handle("manual:stop", () => {
    if (!manualRunner) return { ok: false, reason: "no_runner" };
    const result = manualRunner.stop();
    stopAeGuard("manual stop");
    return result;
  });
}

/* ---------- 无头自检：验证路径解析、AE 检测、索引读取是否正常 ---------- */
/* 用法：npx electron . --selftest
   GUI 不好断言，但「主进程能不能拿到正确数据」是可以直接断言的。 */
const isSelftest = process.argv.includes("--selftest");
const screenshotArg = process.argv.find((arg) => arg.startsWith("--screenshot="));
const viewArg = (process.argv.find((arg) => arg.startsWith("--view=")) || "").split("=")[1];
const evalFileArg = process.argv.find((arg) => arg.startsWith("--eval-file="));

/* ---------- 生命周期 ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    paths = buildPaths();
    rememberHubPath(paths);
    cleanupJobMarkers(paths);

    job = new RenderJob({
      paths,
      script: path.join(toolsDir(), "generate_plugin_presets.ps1"),
      onState: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("render:state", state);
        }
      },
      onExit: (info) => {
        stopAeGuard("render exit");
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("render:exit", info);
        }
      },
    });

    pluginJob = new PluginEffectJob({
      paths,
      script: path.join(toolsDir(), "generate_plugin_effects.ps1"),
      onState: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("plugin-effects:state", state);
        }
      },
      onExit: (info) => {
        stopAeGuard("plugin effects exit");
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("plugin-effects:exit", info);
          // 扫描任务结束后把新目录直接推给 UI，避免 UI 再等一次 IPC 往返
          if (pluginJob && pluginJob.getMode() === "catalog") {
            mainWindow.webContents.send("plugin-effects:catalog", catalog.readCatalog(paths));
          }
        }
      },
    });

    manualRunner = new ManualEffectRunner({
      paths,
      script: path.join(toolsDir(), "manual_probe.ps1"),
      jsx: path.join(toolsDir(), "manual_probe.jsx"),
      template: path.join(toolsDir(), "DreamEnginePNG.aep"),
      timeoutMs: 300000,
    });

    dumpJob = new EffectDumpJob({
      paths,
      script: path.join(toolsDir(), "dump_plugin_effect_params.ps1"),
      rawDir: paths.effectParamsRaw,
      onRound: () => {
        const cache = paramCache();
        if (!cache || !cache.mergeRound) return;
        try {
          cache.mergeRound(paths, {
            aeVersion: dumpContext.aeVersion,
            aeMajor: dumpContext.aeMajor,
          });
        } catch {
          /* 合并失败不打断获取 */
        }
      },
      onState: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("dump:state", state);
        }
      },
      onExit: (info) => {
        stopAeGuard("param dump exit");
        const cache = paramCache();
        if (cache && cache.mergeRound) {
          try {
            cache.mergeRound(paths, {
              aeVersion: dumpContext.aeVersion,
              aeMajor: dumpContext.aeMajor,
            });
          } catch {
            /* ignore */
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("dump:exit", info);
        }
      },
    });

    guardJob = new AeGuardJob({
      paths,
      script: path.join(toolsDir(), "ae_crash_guard.ps1"),
      logPath: paths.aeGuardLog,
    });

    Menu.setApplicationMenu(null);
    registerIpc();

    if (isSelftest) {
      console.log(JSON.stringify(snapshot(), null, 2));
      app.quit();
      return;
    }

    createWindow();

    if (screenshotArg) {
      mainWindow.webContents.once("did-finish-load", () => {
        setTimeout(async () => {
          try {
            if (viewArg) {
              const tab = viewArg === "pluginEffects" ? "render" : viewArg;
              await mainWindow.webContents.executeJavaScript(
                `document.querySelector('.tab[data-view="${tab}"]').click()`,
              );
              if (viewArg === "pluginEffects") {
                await mainWindow.webContents.executeJavaScript(
                  `document.querySelector('.render-mode-button[data-render-mode="plugin"]').click()`,
                );
              }
              await new Promise((r) => setTimeout(r, 1200));
            }
            // 开发排查用：--eval-file=<js> 在截图前把一段脚本注入渲染进程
            if (evalFileArg) {
              const file = evalFileArg.slice("--eval-file=".length);
              const code = fs.readFileSync(file, "utf8");
              const result = await mainWindow.webContents.executeJavaScript(code, true);
              console.log("eval result: " + JSON.stringify(result));
              await new Promise((r) => setTimeout(r, 1200));
            }
            const image = await mainWindow.webContents.capturePage();
            fs.writeFileSync(screenshotArg.slice("--screenshot=".length), image.toPNG());
            console.log("screenshot saved");
          } catch (error) {
            console.error("screenshot failed: " + error.message);
          }
          app.quit();
        }, 2600);
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // 渲染中途关窗口：把专用 AE 实例一起收掉，别留孤儿进程
    if (guardJob && guardJob.isRunning()) guardJob.stop();
    if (job && job.isRunning()) job.stop();
    if (pluginJob && pluginJob.isRunning()) pluginJob.stop();
    if (dumpJob && dumpJob.isRunning()) dumpJob.stop();
    if (manualRunner && manualRunner.isRunning()) manualRunner.stop();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (guardJob && guardJob.isRunning()) guardJob.stop();
    if (job && job.isRunning()) job.stop();
    if (pluginJob && pluginJob.isRunning()) pluginJob.stop();
    if (dumpJob && dumpJob.isRunning()) dumpJob.stop();
    if (manualRunner && manualRunner.isRunning()) manualRunner.stop();
  });
}
