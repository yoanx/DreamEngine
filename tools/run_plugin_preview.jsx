// ============================================================
// run_plugin_preview.jsx -- isolated offline plugin effect previews
//
// Plugin effects are rendered eight per contact sheet. Because a third-party
// crash can terminate AE before JavaScript can catch it, a failed batch falls
// back to isolated single-cell retries.
//
// Safety rules:
//   1. Eight effects share one contact sheet; a failed batch retries as singles.
//   2. A BEGIN heartbeat is written before every isolated retry.
//   3. Unpaired single BEGIN entries become crash-blacklist items next run.
//   4. Every successful item updates the independent plugin index immediately.
//   5. The L1 manifest is never modified.
//
// Input: Documents/DreamEngineProbe/next_plugin_batch.tsv (legacy CLI mode)
//        Task markers written by generate_plugin_effects.ps1 (Hub mode):
//          plugin_catalog_only.enabled  -> scan app.effects catalog and quit
//          plugin_selection.enabled     -> content = absolute path of chosen list
//          plugin_force.enabled         -> ignore rendered index / blacklist
// Output: plugin_manifest.json, plugin_previews.tsv, plugin_blacklist.json,
//         plugin_effect_catalog.tsv, and data/thumbs/batch_1XXX_*.png
// Log: Documents/DreamEngineProbe/plugin_run.log
//
// Run: AfterFX.exe -r tools/run_plugin_preview.jsx
// Syntax: ES3 only.
// ============================================================

(function runPluginPreview() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var LOG = OUT.fsName + "/plugin_run.log";
    var TODO = OUT.fsName + "/next_plugin_batch.tsv";
    var LIMIT_FILE = OUT.fsName + "/plugin_limit.txt";
    var AUTO_FILE = OUT.fsName + "/plugin_auto_catalog.enabled";
    var CATALOG_OUT = OUT.fsName + "/plugin_effect_catalog.tsv";
    var BACKGROUND_FILE = OUT.fsName + "/plugin_background.txt";
    var MAX_ITEMS_FILE = OUT.fsName + "/plugin_max_items.txt";
    var RETRY_ERRORS_FILE = OUT.fsName + "/plugin_retry_errors.enabled";
    var ACTIVE_BATCH_FILE = OUT.fsName + "/plugin_active_batch.tsv";
    var RENDER_TEMPLATE_FILE = OUT.fsName + "/plugin_render_template_path.txt";
    var BLACKLIST = OUT.fsName + "/plugin_blacklist.tsv";
    var PANEL_BLACKLIST = EXT + "/data/plugin_blacklist.json";
    var ENTRIES = EXT + "/data/plugin_previews.tsv";
    var MANIFEST = EXT + "/data/plugin_manifest.json";
    // Hub -> ps1 -> 本脚本 的任务标记（Hub 侧只写文件，不碰 AE）
    var SELECTION = OUT.fsName + "/plugin_selection.enabled";
    var FORCE = OUT.fsName + "/plugin_force.enabled";
    var CATALOG_ONLY = OUT.fsName + "/plugin_catalog_only.enabled";
    var BATCH_SIZE = 8;

    function readText(path) {
        var f = new File(path);
        if (!f.exists) return "";
        f.encoding = "UTF-8";
        if (!f.open("r")) return "";
        var text = f.read();
        f.close();
        return text;
    }

    function writeText(path, text) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("w")) return false;
        f.write(text);
        f.close();
        return true;
    }

    function pad3(value) {
        var s = String(value);
        while (s.length < 3) s = "0" + s;
        return s;
    }

    function pad4(value) {
      var s = String(value);
      while (s.length < 4) s = "0" + s;
      return s;
    }

    function quitAe() {
        try {
            if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        } catch (eClose) {}
        try {
            app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
        } catch (eQuit) {
            try { app.quit(); } catch (eQuit2) {}
        }
    }

    var MODULES = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/names.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/previewgen.jsx",
        "engine/plugin_state.jsx",
        "js/viewmodel.js"
    ];
    for (var m = 0; m < MODULES.length; m++) {
        try {
            $.evalFile(new File(EXT + "/" + MODULES[m]));
        } catch (eMod) {
            writeText(LOG, "MODULE_FAIL|" + MODULES[m] + "|" + eMod);
            quitAe();
            return;
        }
    }

    var PS = AEV_PluginState;
    if (typeof AEV_Recipe !== "undefined" && AEV_Recipe.setTrace) {
        AEV_Recipe.setTrace(OUT.fsName + "/plugin_trace.txt");
    }
    var parsed = PS.parseLog(readText(LOG));
    var logLines = parsed.lines;

    function openRenderTemplate() {
        var path = String(readText(RENDER_TEMPLATE_FILE) || "").replace(/[\r\n]+/g, "");
        if (!path) return null;
        var file = new File(path);
        if (!file.exists) return null;
        var opened = app.open(file);
        if (!opened) return null;
        var comp = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item.name === "DE_RENDER_TARGET") {
                comp = item;
                break;
            }
        }
        var queue = null;
        for (var q = 1; q <= app.project.renderQueue.numItems; q++) {
            var candidate = app.project.renderQueue.item(q);
            if (candidate.comp === comp) {
                queue = candidate;
                break;
            }
        }
        if (comp && queue) {
            try {
                var runtimeRoot = new Folder(Folder.temp.fsName + "/DreamEnginePluginRunner");
                if (!runtimeRoot.exists) runtimeRoot.create();
                // 中间帧单独放 template_out 子目录并清理残留；模板队列项本身不渲
                //（见 queue.render=false），否则第二次运行会弹「文件已存在，是否覆盖」。
                var templateOut = new Folder(runtimeRoot.fsName + "/template_out");
                if (!templateOut.exists) templateOut.create();
                var stale = [];
                try { stale = templateOut.getFiles("template_render_*.png"); } catch (eStale) {}
                for (var si = 0; si < stale.length; si++) {
                    try { if (stale[si] instanceof File) stale[si].remove(); } catch (eStale2) {}
                }
                try {
                    var legacy = runtimeRoot.getFiles("template_render_*.png");
                    for (var li = 0; li < legacy.length; li++) {
                        try { if (legacy[li] instanceof File) legacy[li].remove(); } catch (eLegacy) {}
                    }
                } catch (eLegacyOuter) {}
                queue.outputModule(1).file =
                    new File(templateOut.fsName + "/template_render_[####].png");
                queue.timeSpanStart = Number(comp.displayStartTime) || 0;
                queue.timeSpanDuration = Math.max(
                    1 / comp.frameRate,
                    Number(comp.duration) || (1 / comp.frameRate)
                );
                queue.render = false;
            } catch (eQueuePath) {}
        }
        return comp && queue ? { comp: comp, queue: queue } : null;
    }
    /** Persist each state transition so a crash leaves an unpaired BEGIN. */
    function appendLog(kind, name, extra) {
        logLines.push(PS.logLine(kind, name, extra));
        writeText(LOG, logLines.join("\r\n"));
    }

    /* ---------- 插件效果目录（Hub 的只读数据面） ---------- */

    var CATALOG_HEADER = "matchName\tdisplayName\tcategory\tplugin\texcluded\treason\tnoPreview";
    var CATALOG_PLUGIN_FALLBACK = "\u5176\u4ED6\u63D2\u4EF6";

    function cleanCell(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/\t/g, " ")
            .replace(/\r/g, " ")
            .replace(/\n/g, " ");
    }

    /** 解析无表头的 next_plugin_batch.tsv（matchName \t frames \t plugin） */
    function readTodoText(text) {
        var out = [];
        var rows = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
        for (var t = 0; t < rows.length; t++) {
            var row = rows[t];
            if (!row || row.charAt(0) === "#") continue;
            var p = row.split("\t");
            if (!p[0]) continue;
            out.push({
                matchName: p[0],
                frames: parseInt(p[1], 10) || 6,
                plugin: p[2] || CATALOG_PLUGIN_FALLBACK
            });
        }
        return out;
    }

    /**
     * 扫描 app.effects 并写完整目录：所有第三方效果都要出现（含被排除的），
     * 只有可渲且非 noPreview 的进 todo。Hub 用 excluded/reason/noPreview
     * 三列把不可选行禁用并显示原因。
     */
    function buildCatalog() {
        var result = { todo: [], count: 0 };
        var lines = [CATALOG_HEADER];
        var effects = app.effects;
        var frames = AEV_PreviewGen.config().animatedPreview.frameCount || 6;
        for (var i = 0; i < effects.length; i++) {
            var info = {
                matchName: String(effects[i].matchName || ""),
                displayName: String(effects[i].displayName || ""),
                category: String(effects[i].category || "")
            };
            if (!info.matchName) continue;
            if (AEV_ViewModel.isBuiltinEffect(info)) continue;
            var reason = "";
            if (typeof AEV_ViewModel.excludeReason === "function") {
                reason = AEV_ViewModel.excludeReason(info);
            } else if (typeof AEV_ViewModel.isExcludable === "function" &&
                       AEV_ViewModel.isExcludable(info)) {
                // 兼容旧扩展：没有 excludeReason 时退化成布尔判断。
                reason = "excluded";
            }
            var noPreview = AEV_ViewModel.isNoPreview(info.category) ? 1 : 0;
            var pluginName = AEV_ViewModel.inferPlugin(info);
            lines.push([
                cleanCell(info.matchName),
                cleanCell(info.displayName),
                cleanCell(info.category),
                cleanCell(pluginName),
                reason ? "1" : "0",
                cleanCell(reason),
                String(noPreview)
            ].join("\t"));
            if (!reason && !noPreview) {
                result.todo.push({
                    matchName: info.matchName,
                    frames: frames,
                    plugin: pluginName
                });
            }
        }
        writeText(CATALOG_OUT, lines.join("\r\n"));
        result.count = lines.length - 1;
        return result;
    }

    /*
     * 只扫描目录（Hub 的“扫描插件目录”）：写完目录立刻返回，
     * 不进渲染循环、不碰模板/索引/黑名单。ps1 靠 RESULT 收尾并写 meta。
     */
    var catalogOnlyFile = new File(CATALOG_ONLY);
    if (catalogOnlyFile.exists) {
        var catalogOnlyResult = buildCatalog();
        try { catalogOnlyFile.remove(); } catch (eCatalogRemove) {}
        appendLog("RESULT", "", "catalog_only cat=" + catalogOnlyResult.count + " pending=0");
        quitAe();
        return;
    }

    var renderTemplate = openRenderTemplate();
    var renderTemplateComp = renderTemplate && renderTemplate.comp;
    var renderTemplateQueue = renderTemplate && renderTemplate.queue;

    /*
     * If AE died during a mixed batch, retry every member as an isolated
     * single item. The real crash culprit is then identified by BEGIN/OK.
     */
    var forceSingles = {};
    var activeBatchFile = new File(ACTIVE_BATCH_FILE);
    if (activeBatchFile.exists) {
        var activeRows = String(readText(ACTIVE_BATCH_FILE) || "").split(/\r?\n/);
        var retryNames = [];
        for (var ab = 0; ab < activeRows.length; ab++) {
            var activeName = String(activeRows[ab] || "").replace(/^\s+|\s+$/g, "");
            if (!activeName) continue;
            forceSingles[activeName] = true;
            retryNames.push(activeName);
        }
        try { activeBatchFile.remove(); } catch (eActiveRemove) {}
        if (retryNames.length > 0) {
            appendLog("BATCH_RETRY", "", "names=" + retryNames.join(","));
        }
    }

    // Crash recovery: blacklist the previous unpaired BEGIN item.
    var blacklist = PS.readBlacklist(readText(BLACKLIST));
    var retryErrorsFile = new File(RETRY_ERRORS_FILE);
    if (retryErrorsFile.exists) {
        try { retryErrorsFile.remove(); } catch (eRetryFile) {}
        for (var key in blacklist) {
            if (blacklist.hasOwnProperty(key) && blacklist[key] === "render_error") {
                delete blacklist[key];
            }
        }
        writeText(BLACKLIST, PS.blacklistTsv(blacklist));
    }
    var crashed = parsed.crashed;
    if (crashed.length > 0) {
        blacklist = PS.mergeBlacklist(blacklist, crashed, "crash");
        writeText(BLACKLIST, PS.blacklistTsv(blacklist));
        for (var c = 0; c < crashed.length; c++) {
            appendLog("SKIP", crashed[c], "crash_blacklisted");
        }
    }
    // The panel reads JSON; always write it, even when the list is empty.
    writeText(PANEL_BLACKLIST, PS.blacklistJson(blacklist));

    /*
     * force 模式（Hub 勾选“强制重渲”）：忽略已生成索引与黑名单，
     * 只跳过本轮 processed 里的条目。processed 每条处理完（成功或失败）都写入，
     * 避免失败条目在本轮无限重试。
     */
    var forceMode = new File(FORCE).exists;
    var processed = {};
    // 旧版扩展的 plugin_state.jsx 没有 planRun/planStats 的 options 参数；
    // 这里按函数签名探测，旧扩展下退化为 JSX 内部过滤，force 仍然生效。
    var forceApi = forceMode &&
        typeof PS.planRun === "function" && PS.planRun.length >= 5 &&
        typeof PS.planStats === "function" && PS.planStats.length >= 4;

    // Candidate list.
    var todo = [];
    var autoCatalog = false;
    var selectionFile = new File(SELECTION);
    var selectionMode = selectionFile.exists;
    if (selectionMode) {
        // 标记文件内容 = Hub 写好的 next_plugin_batch.tsv 绝对路径。
        // 选择模式绝不自动重建目录/待办，todo 为空直接收尾。
        var selectionPath = String(readText(SELECTION) || "")
            .replace(/[\r\n]+/g, "");
        selectionPath = selectionPath.replace(/^\s+|\s+$/g, "");
        if (selectionPath) todo = readTodoText(readText(selectionPath));
    } else {
        todo = readTodoText(readText(TODO));
    }

    /*
     * Hub 全量模式仍然从当前 AE 的 app.effects 建列表；
     * legacy CLI 可以用 next_plugin_batch.tsv 直接给名单。
     * 选择模式必须保留 Hub 给的名单，不能被目录重建覆盖。
     */
    var autoFile = new File(AUTO_FILE);
    autoCatalog = autoFile.exists;
    if (autoCatalog) {
        try { autoFile.remove(); } catch (eAuto) {}
    }
    if (!selectionMode && (autoCatalog || todo.length === 0)) {
        autoCatalog = true;
        var builtCatalog = buildCatalog();
        todo = builtCatalog.todo;
    }
    if (todo.length === 0) {
        appendLog("RUN", "", "auto=" + (autoCatalog ? "1" : "0") +
                  " todo=0 pending=0 done=0 blacklisted=0 batch=0");
        appendLog("RESULT", "", selectionMode ? "no_todo pending=0" : "no_todo_file");
        quitAe();
        return;
    }

    var entries = PS.readEntries(readText(ENTRIES));
    var limit = BATCH_SIZE;
    var wanted = parseInt(readText(LIMIT_FILE), 10);
    if (wanted > 0) limit = wanted;
    var maxItems = parseInt(readText(MAX_ITEMS_FILE), 10) || 0;
    // Plugin sheets start at 1000 to avoid the L1 sheet range.
    var conf = AEV_PreviewGen.config();
    var size = {
        cellSize: conf.contactSheet.cellSize,
        columns: 1,
        width: conf.contactSheet.cellSize,
        height: conf.contactSheet.cellSize
    };
    var nextSheet = 1000;
    for (var e = 0; e < entries.length; e++) {
        if (entries[e].sheet >= nextSheet) nextSheet = entries[e].sheet + 1;
    }

    var okCount = 0;
    var failCount = 0;
    var fatalReason = "";
    function isInfrastructureFailure(raw) {
        return String(raw || "").indexOf("no_png_template") >= 0;
    }
    function backgroundValue() {
        return String(readText(BACKGROUND_FILE) || "").replace(/[\r\n]+/g, "");
    }
    function writeIndex() {
        writeText(ENTRIES, PS.entriesTsv(entries));
        writeText(MANIFEST, PS.buildManifest(entries, size));
    }
    function recordFailure(item, raw) {
        appendLog("FAIL", item.matchName, raw.substring(0, 180));
        failCount++;
        // 失败也算本轮已处理：force 模式下避免对同一条无限重试。
        processed[item.matchName] = true;
        if (isInfrastructureFailure(raw)) {
            fatalReason = "no_png_template";
            return;
        }
        blacklist = PS.mergeBlacklist(blacklist, [item.matchName], "render_error");
        writeText(BLACKLIST, PS.blacklistTsv(blacklist));
        writeText(PANEL_BLACKLIST, PS.blacklistJson(blacklist));
    }
    function recordSuccess(item, sheetIndex, layout) {
        var tmpl = "thumbs/batch_" + pad3(sheetIndex) + "_%04d.png";
        entries = PS.addEntry(entries, {
            matchName: item.matchName,
            sheet: sheetIndex,
            frames: item.frames,
            frameTemplate: tmpl,
            plugin: item.plugin,
            x: layout.x,
            y: layout.y,
            columns: layout.columns,
            width: layout.width,
            height: layout.height
        });
        writeIndex();
        appendLog("OK", item.matchName, "sheet=" + sheetIndex +
                  " x=" + layout.x + " y=" + layout.y);
        okCount++;
        processed[item.matchName] = true;
        if (forceMode) {
            // force 重渲成功：正式移出黑名单，两份黑名单文件同步刷新。
            if (PS.removeBlacklist) {
                blacklist = PS.removeBlacklist(blacklist, [item.matchName]);
            } else {
                // 旧版插件状态模块没有 removeBlacklist，直接删键后重写。
                delete blacklist[item.matchName];
            }
            writeText(BLACKLIST, PS.blacklistTsv(blacklist));
            writeText(PANEL_BLACKLIST, PS.blacklistJson(blacklist));
        }
    }

    function entryFramesExist(entry) {
        var template = String(entry && entry.frameTemplate || "");
        if (!template) return true;
        var frames = Math.max(1, parseInt(entry.frames, 10) || 1);
        for (var f = 0; f < frames; f++) {
            var relative = template.replace("%04d", pad4(f));
            var file = new File(EXT + "/data/" + relative);
            if (!file.exists) return false;
        }
        return true;
    }

    var validEntries = [];
    var removedIncomplete = 0;
    for (var ve = 0; ve < entries.length; ve++) {
        if (!entryFramesExist(entries[ve])) {
            removedIncomplete++;
            continue;
        }
        validEntries.push(entries[ve]);
    }
    if (removedIncomplete > 0) {
        entries = validEntries;
        writeIndex();
        appendLog("INDEX_CLEAN", "", "removed_incomplete=" + removedIncomplete);
    }
    function renderSingle(item) {
        var sheetIndex = nextSheet++;
        appendLog("BEGIN", item.matchName, "sheet=" + sheetIndex);
        var raw = "";
        try {
            raw = AEV_PreviewGen.renderBatch([item.matchName], sheetIndex, {
                outputRoot: "extension",
                extensionPath: EXT,
                singleCell: true,
                targetComp: renderTemplateComp,
                targetQueueItem: renderTemplateQueue,
                frames: item.frames,
                freshAssets: true,
                background: backgroundValue()
            });
        } catch (eRender) {
            raw = '{"status":"error","reason":"throw:' + eRender + '"}';
        }
        var ok = raw.indexOf('"status":"ok"') >= 0;
        if (ok && raw.indexOf(item.matchName + "|") >= 0) ok = false;
        if (ok) {
            recordSuccess(item, sheetIndex, {
                x: 0, y: 0, columns: 1, width: conf.contactSheet.cellSize,
                height: conf.contactSheet.cellSize
            });
        } else {
            recordFailure(item, raw);
        }
    }
    function renderGroup(group) {
        var sheetIndex = nextSheet++;
        var names = [];
        var maxFrames = 1;
        for (var g = 0; g < group.length; g++) {
            names.push(group[g].matchName);
            if (group[g].frames > maxFrames) maxFrames = group[g].frames;
        }
        writeText(ACTIVE_BATCH_FILE, names.join("\r\n"));
        appendLog("BATCH_BEGIN", "", "sheet=" + sheetIndex + " names=" + names.join(","));

        var raw = "";
        try {
            raw = AEV_PreviewGen.renderBatch(names, sheetIndex, {
                outputRoot: "extension",
                extensionPath: EXT,
                singleCell: false,
                targetComp: renderTemplateComp,
                targetQueueItem: renderTemplateQueue,
                gridColumns: 8,
                gridRows: Math.ceil(group.length / 8),
                frames: maxFrames,
                freshAssets: true,
                background: backgroundValue()
            });
        } catch (eRender) {
            raw = '{"status":"error","reason":"throw:' + eRender + '"}';
        }
        try { if (activeBatchFile.exists) activeBatchFile.remove(); } catch (eBatchRemove) {}

        var data = null;
        try { data = eval("(" + raw + ")"); } catch (eParse) { data = null; }
        var renderedNames = data && data.names ? String(data.names).split(",") : [];
        var batchOk = data && data.status === "ok" && renderedNames.length === group.length;
        if (batchOk) {
            var columns = 8;
            var cellSize = conf.contactSheet.cellSize;
            var width = columns * cellSize;
            var height = Math.ceil(group.length / columns) * cellSize;
            for (var okIndex = 0; okIndex < group.length; okIndex++) {
                recordSuccess(group[okIndex], sheetIndex, {
                    x: (okIndex % columns) * cellSize,
                    y: Math.floor(okIndex / columns) * cellSize,
                    columns: columns,
                    width: width,
                    height: height
                });
            }
            appendLog("BATCH_OK", "", "sheet=" + sheetIndex + " count=" + group.length);
            return;
        }

        appendLog("BATCH_FAIL", "", "sheet=" + sheetIndex + " " + raw.substring(0, 180));
        if (isInfrastructureFailure(raw)) {
            fatalReason = "no_png_template";
            return;
        }
        // A mixed plugin batch can fail before individual results are available.
        // Re-render each member as a single cell so only the real culprit is isolated.
        for (var singleIndex = 0; singleIndex < group.length; singleIndex++) {
            renderSingle(group[singleIndex]);
            if (fatalReason) break;
        }
    }

    /** force 模式下由 JSX 自己统计进度（兼容没有 options 的旧版 plugin_state） */
    function forcedProgress() {
        var doneCount = 0;
        for (var fp = 0; fp < todo.length; fp++) {
            var fpItem = todo[fp];
            if (fpItem && fpItem.matchName && processed[fpItem.matchName]) doneCount++;
        }
        return {
            total: todo.length,
            done: doneCount,
            blacklisted: 0,
            pending: Math.max(0, todo.length - doneCount)
        };
    }

    while (true) {
        var run = null;
        var progress = null;
        if (forceMode && !forceApi) {
            // 旧扩展：先把 processed 过滤掉，再把空 entries/blacklist 交给旧 planRun，
            // 达到“忽略已生成/黑名单”的效果。
            var remainingTodo = [];
            for (var rt = 0; rt < todo.length; rt++) {
                var rtItem = todo[rt];
                if (rtItem && rtItem.matchName && !processed[rtItem.matchName]) {
                    remainingTodo.push(rtItem);
                }
            }
            run = PS.planRun(remainingTodo, [], {}, limit);
            progress = forcedProgress();
        } else {
            var runOptions = forceMode ? { force: true, skip: processed } : null;
            run = forceMode
                ? PS.planRun(todo, entries, blacklist, limit, runOptions)
                : PS.planRun(todo, entries, blacklist, limit);
            progress = forceMode
                ? PS.planStats(todo, entries, blacklist, runOptions)
                : PS.planStats(todo, entries, blacklist);
        }
        appendLog("RUN", "", "auto=" + (autoCatalog ? "1" : "0") +
                  " todo=" + progress.total +
                  " pending=" + progress.pending +
                  " done=" + progress.done +
                  " blacklisted=" + progress.blacklisted +
                  " batch=" + run.length);

        if (run.length === 0) break;

        var cursor = 0;
        while (cursor < run.length && !fatalReason) {
            var item = run[cursor];
            var remaining = maxItems > 0 ? maxItems - okCount - failCount : BATCH_SIZE;
            if (remaining <= 0) break;
            if (forceSingles[item.matchName]) {
                renderSingle(item);
                cursor++;
                continue;
            }
            var group = [];
            while (cursor < run.length && group.length < BATCH_SIZE &&
                   group.length < remaining && !forceSingles[run[cursor].matchName]) {
                group.push(run[cursor]);
                cursor++;
            }
            if (group.length > 0) renderGroup(group);
        }
        if (fatalReason) break;
        if (maxItems > 0 && okCount + failCount >= maxItems) break;
    }

    var finalProgress = forceMode
        ? (forceApi ? PS.planStats(todo, entries, blacklist, { force: true, skip: processed }) : forcedProgress())
        : PS.planStats(todo, entries, blacklist);
    appendLog("RESULT", "", "ok=" + okCount + " fail=" + failCount +
              " total=" + entries.length +
              " pending=" + finalProgress.pending +
              (fatalReason ? " fatal=" + fatalReason : ""));

    // The dedicated AE instance exits after the batch finishes.
    quitAe();
})();
