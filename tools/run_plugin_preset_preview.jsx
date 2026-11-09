// ============================================================
// run_plugin_preset_preview.jsx —— 含第三方插件的预设预览（离线 / 逐条隔离）
//
// 为什么必须离线：实测 BCC / Sapphire / Universe 与内置效果混在同一张整网时
// AE 进程直接消失、脚本内 catch 不到。面板和 AE 是同一个进程，做成面板按钮
// 就等于把用户正在用的 AE 杀掉。所以沿用插件效果预览那套已验证的通道：
//   关闭 AE → AfterFX.exe -r 本脚本 → 一条预设一个隔离临时合成、逐条渲。
//
// 安全机制（与 run_plugin_preview.jsx 同构）：
//   1. 一条预设 = 一个临时合成，绝不和别的效果混渲
//   2. 渲前落盘 BEGIN；AE 被插件杀掉时日志就停在 BEGIN
//   3. 下次启动把未配对的 BEGIN 拉进黑名单，自动跳过元凶
//   4. 每条成功立刻追加 TSV，中途崩溃不丢已渲结果
//   5. 索引由 Node 驱动脚本从 TSV 生成 data/preset_plugin_manifest.json
//
// 输入：<我的文档>/DreamEngineProbe/next_preset_plugin_batch.tsv
//       （每行一个 .ffx 绝对路径；由 run_plugin_preset_batches.mjs 产出）
//       <我的文档>/DreamEngineProbe/preset_plugin_background.txt（背景 id 或图片路径）
// 输出：<我的文档>/DreamEngineProbe/preset_plugin_previews.tsv
//       data/thumbs/preset_1XXX_*.png
// 日志：<我的文档>/DreamEngineProbe/preset_plugin_run.log
//       <我的文档>/DreamEngineProbe/preset_plugin_blacklist.tsv
//
// 运行：AfterFX.exe -r tools/run_plugin_preset_preview.jsx（先关闭正在运行的 AE）
// 语法：ES3 only。
// ============================================================

(function runPluginPresetPreview() {
    var EXT = Folder.userData.fsName + "/Adobe/CEP/extensions/com.dreamengine.panel";
    var OUT = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    if (!OUT.exists) OUT.create();

    var LOG = OUT.fsName + "/preset_plugin_run.log";
    var TODO = OUT.fsName + "/next_preset_plugin_batch.tsv";
    var BACKGROUND = OUT.fsName + "/preset_plugin_background.txt";
    var ENTRIES = OUT.fsName + "/preset_plugin_previews.tsv";
    var BLACKLIST = OUT.fsName + "/preset_plugin_blacklist.tsv";
    var FORCE = OUT.fsName + "/preset_plugin_force.txt";
    var PENDING = OUT.fsName + "/preset_plugin_pending_count.txt";
    var RENDER_TEMPLATE_FILE = OUT.fsName + "/preset_render_template_path.txt";
    var PANEL_BLACKLIST = EXT + "/data/preset_plugin_blacklist.json";
    var ENTRY_HEADER = "# name\tpath\tsheet\tframes\tanimated\tkeyStart\tkeyEnd\tbackground\tplugins\tduration\tfps";

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

    function appendText(path, text) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("a")) return false;
        f.write(text);
        f.close();
        return true;
    }

    function lines(text) {
        return String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
    }

    function displayName(path) {
        var base = String(path || "").replace(/\\/g, "/");
        var cut = base.lastIndexOf("/");
        if (cut >= 0) base = base.substring(cut + 1);
        base = base.replace(/\.ffx$/i, "");
        try { base = decodeURI(base); } catch (e) {}
        return base;
    }

    function quitCleanly() {
        // app.quit(SaveOptions...) 在部分 AE 2021 安装上仍会弹保存框，
        // 专用实例必须先把本次产生的临时工程以“不保存”关闭，再退出。
        try {
            if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        } catch (eClose) {}
        try {
            app.quit();
        } catch (eQuit) {
            try { app.quit(SaveOptions.DO_NOT_SAVE_CHANGES); } catch (eQuit2) {}
        }
    }

    var MODULES = [
        "engine/render_config.jsx",
        "engine/store.jsx",
        "engine/assets.jsx",
        "engine/recipe.jsx",
        "engine/preset_preview.jsx",
        "engine/plugin_state.jsx"
    ];
    for (var m = 0; m < MODULES.length; m++) {
        var mf = new File(EXT + "/" + MODULES[m]);
        if (!mf.exists) {
            writeText(LOG, "MODULE_FAIL|missing|" + MODULES[m]);
            quitCleanly();
            return;
        }
        try {
            $.evalFile(mf);
        } catch (eMod) {
            writeText(LOG, "MODULE_FAIL|" + MODULES[m] + "|" + eMod);
            quitCleanly();
            return;
        }
    }
    var PS = AEV_PluginState;
    var PP = AEV_PresetPreview;

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
                // 中间帧单独放 template_out 子目录，并先清掉残留：
                // 模板队列项只是给 duplicate 继承输出设置，它本身不渲（见下面
                // queue.render=false），否则每次运行都会往共享临时目录写一遍
                // template_render_*.png，第二次就弹「文件已存在，是否覆盖」。
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
    var renderTemplate = openRenderTemplate();
    var renderTemplateComp = renderTemplate && renderTemplate.comp;
    var renderTemplateQueue = renderTemplate && renderTemplate.queue;

    var parsed = PS.parseLog(readText(LOG));
    var logLines = parsed.lines;

    function appendLog(kind, name, extra) {
        logLines.push(PS.logLine(kind, name, extra));
        writeText(LOG, logLines.join("\r\n"));
    }

    // ---- 崩溃恢复：上次停在 BEGIN 的条目拉黑 ----
    var blacklist = PS.readBlacklist(readText(BLACKLIST));
    var crashed = parsed.crashed;
    if (crashed.length > 0) {
        blacklist = PS.mergeBlacklist(blacklist, crashed, "crash");
        writeText(BLACKLIST, PS.blacklistTsv(blacklist));
        for (var c = 0; c < crashed.length; c++) {
            appendLog("SKIP", crashed[c], "crash_blacklisted");
        }
    }
    writeText(PANEL_BLACKLIST, PS.blacklistJson(blacklist));

    // ---- 已完成的条目（按 path 去重）----
    var done = {};
    var maxSheet = 999;
    var entryRows = lines(readText(ENTRIES));
    for (var er = 0; er < entryRows.length; er++) {
        var erow = entryRows[er];
        if (!erow || erow.charAt(0) === "#") continue;
        var ep = erow.split("\t");
        if (ep.length < 3) continue;
        done[ep[1]] = true;
        var es = parseInt(ep[2], 10) || 0;
        if (es >= maxSheet) maxSheet = es;
    }

    // ---- 待渲名单：每行一个 .ffx 绝对路径 ----
    var todo = [];
    var forcedPath = String(readText(FORCE) || "").replace(/\\/g, "/");
    if (forcedPath) writeText(FORCE, "");
    var rawTodo = lines(readText(TODO));
    for (var t = 0; t < rawTodo.length; t++) {
        var row = rawTodo[t];
        if (!row || row.charAt(0) === "#") continue;
        var path = row.split("\t")[0];
        if (!path || (!forcedPath && (done[path] || blacklist[path]))) continue;
        todo.push(path);
    }
    var background = String(readText(BACKGROUND) || "photo").replace(/^\s+|\s+$/g, "");
    if (!background) background = "photo";
    var pendingAtStart = parseInt(readText(PENDING), 10);
    if (!(pendingAtStart >= 0)) pendingAtStart = todo.length;

    if (todo.length === 0) {
        appendLog("RESULT", "", "no_todo pending=0");
        quitCleanly();
        return;
    }
    appendLog("RUN", "", "todo=" + todo.length + " done=" + maxSheet +
              " blacklisted=" + crashed.length);

    // 首次建 TSV 时先写表头
    var existing = readText(ENTRIES);
    if (!existing) appendText(ENTRIES, ENTRY_HEADER + "\r\n");

    var okCount = 0;
    var failCount = 0;
    for (var r = 0; r < todo.length; r++) {
        var presetPath = todo[r];
        var sheet = ++maxSheet;
        var name = displayName(presetPath);
        appendLog("BEGIN", presetPath, "sheet=" + sheet);

        var raw = "";
        try {
            raw = PP.renderJson(presetPath, sheet, {
                extensionPath: EXT,
                background: background,
                cellSize: 128,
                // 专用 AE 实例 + 逐条隔离：插件预设照渲，不在面板进程里冒险
                allowPlugins: true,
                targetComp: renderTemplateComp,
                targetQueueItem: renderTemplateQueue
            });
        } catch (eRender) {
            raw = '{"status":"error","reason":"throw:' + eRender + '"}';
        }

        var data = null;
        try { data = eval("(" + raw + ")"); } catch (eParse) { data = null; }
        if (data && data.status === "ok") {
            var rowOut = [
                String(name).replace(/\t/g, " "),
                String(presetPath).replace(/\t/g, " "),
                String(sheet),
                String(data.frames || 1),
                String(data.animated),
                String(data.keyStart || 0),
                String(data.keyEnd || 0),
                // 文本类预设可能自动改用「文字」素材渲染，这里记实际用的背景
                String(data.background || background).replace(/\t/g, " "),
                String(data.plugins || "").replace(/\t/g, " "),
                String(data.duration || 0),
                String(data.fps || 0)
            ].join("\t");
            appendText(ENTRIES, rowOut + "\r\n");
            appendLog("OK", presetPath, "sheet=" + sheet + " frames=" + data.frames);
            okCount++;
        } else {
            // 预设类型落不上（no_effect）不是渲染错误：单独记原因，
            // 否则下一步的「重试失败项」会当成 render_error 处理，掩盖真实原因。
            var failReason = (data && data.status === "no_effect") ? "no_effect" : "render_error";
            appendLog("FAIL", presetPath, String(raw).substring(0, 180));
            // 渲染报错（非崩溃）也拉黑，避免每轮都在同一条上死循环；
            // -RetryFailed 会把 render_error / no_effect 一起清掉重试。
            blacklist = PS.mergeBlacklist(blacklist, [presetPath], failReason);
            writeText(BLACKLIST, PS.blacklistTsv(blacklist));
            writeText(PANEL_BLACKLIST, PS.blacklistJson(blacklist));
            failCount++;
        }
    }

    var finalPending = Math.max(0, pendingAtStart - okCount - failCount);
    appendLog("RESULT", "", "ok=" + okCount + " fail=" + failCount +
              " total_sheet=" + maxSheet +
              " pending=" + finalPending);

    // 专用实例：渲完无保存关闭临时工程再退出，避免保存弹窗卡住 Hub。
    quitCleanly();
})();
