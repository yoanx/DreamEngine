// ============================================================
// previewgen.jsx —— 运行时预览生成
//
// 核心策略（来自 M0 实测）：
//   · 逐效果各调一次 renderQueue.render() 的成本主要是队列启动开销
//     （T0.2 实测 16 次 ≈ 16.55 秒，单帧渲染本身只占很小一部分）
//     因此批量一律走 contact sheet：一张 8×8 网一次渲染出 N 帧
//   · OutputModule 的 Format 只读，必须通过 applyTemplate 切到
//     "DreamEngine PNG Sequence"，找不到 PNG 模板时直接失败，不兜底到其它格式
//   · 临时合成清理只用 remove()，不依赖 Ctrl+Z（copyToComp 的 undo 崩溃警告）
//
// 依赖：render_config.jsx、store.jsx、recipe.jsx
// 语法：ES3 only。
// ============================================================

var AEV_PreviewGen = (function () {
    var FALLBACK_CONFIG = {
        contactSheet: { columns: 8, cellSize: 256, width: 2048, height: 2048, effectsPerSheet: 64 },
        animatedPreview: { frameCount: 6, fps: 12 },
        render: { pngOutputTemplate: "DreamEngine PNG Sequence" }
    };

    function config() {
        if (typeof DREAM_ENGINE_RENDER_CONFIG !== "undefined" && DREAM_ENGINE_RENDER_CONFIG) {
            return DREAM_ENGINE_RENDER_CONFIG;
        }
        return FALLBACK_CONFIG;
    }

    function pad(value, width) {
        var text = String(value);
        while (text.length < width) text = "0" + text;
        return text;
    }

    /** 计算需要几张网、多少帧、多少格 —— 纯计算，便于测试与 UI 预估 */
    function plan(effectCount) {
        var conf = config();
        var perSheet = conf.contactSheet.effectsPerSheet;
        var frames = conf.animatedPreview.frameCount;
        var sheets = Math.ceil(effectCount / perSheet);
        return {
            effects: effectCount,
            perSheet: perSheet,
            sheets: sheets,
            frames: frames,
            cells: effectCount,
            totalRenders: sheets * frames
        };
    }

    function pngTemplate(outputModule) {
        var templates = outputModule.templates;
        for (var i = 0; i < templates.length; i++) {
            var name = String(templates[i]);
            if (name.toLowerCase().indexOf("png") >= 0) return name;
        }
        return null;
    }

    /**
     * 新账户或损坏的首选项可能让 templates 列表里没有可见 PNG 模板。
     * Hidden Legacy 模板随 AE 安装，不依赖用户保存过输出模板。
     */
    function applyPngTemplate(outputModule) {
        var candidates = ["_HIDDEN Legacy PNG Sequence"];
        var templates = outputModule.templates || [];
        for (var i = 0; i < templates.length; i++) {
            var name = String(templates[i]);
            if (name.toLowerCase().indexOf("png") >= 0) candidates.push(name);
        }
        candidates.push(config().render.pngOutputTemplate);
        candidates.push("PNG Sequence");
        candidates.push("PNG 序列");

        var seen = {};
        for (var c = 0; c < candidates.length; c++) {
            var candidate = String(candidates[c] || "");
            if (!candidate || seen[candidate]) continue;
            seen[candidate] = true;
            try {
                outputModule.applyTemplate(candidate);
                if (outputModule.getSettings) {
                    var settings = outputModule.getSettings();
                    var appliedFormat = String(settings && settings.Format || "");
                    if (appliedFormat && appliedFormat.toLowerCase().indexOf("png") < 0) continue;
                }
                return candidate;
            } catch (eApply) {}
        }
        return null;
    }

    /** 标准素材场景：深色底 + 青色块 + 暖色块 + 文字，能同时体现模糊、发光、变形、调色。
     *  注意：addSolid 的 width/height 必须是整数，AE 2021 会以
     *  "151.04 不是整数" 直接抛错，所以比例尺寸一律 Math.round。
     */
    function buildScene(size) {
        var scene = app.project.items.addComp("DE_scene_" + size, size, size, 1, 1, 30);

        var bg = scene.layers.addSolid([0.055, 0.065, 0.075], "bg", size, size, 1);
        bg.moveToEnd();

        var accentW = Math.round(size * 0.59);
        var accentH = Math.round(size * 0.35);
        var accent = scene.layers.addSolid([0.18, 0.68, 0.76], "accent", accentW, accentH, 1);
        accent.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.52)]);

        var warmSide = Math.round(size * 0.23);
        var warm = scene.layers.addSolid([0.86, 0.32, 0.18], "warm", warmSide, warmSide, 1);
        warm.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.28), Math.round(size * 0.3)]);

        var text = scene.layers.addText("AE");
        var textProp = text.property("ADBE Text Properties").property("ADBE Text Document");
        var doc = textProp.value;
        doc.fontSize = Math.round(size * 0.25);
        doc.fillColor = [0.94, 0.94, 0.92];
        textProp.setValue(doc);
        text.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.57)]);

        return scene;
    }

    function placeCell(grid, cellLayer, index, columns, cellSize) {
        var col = index % columns;
        var row = Math.floor(index / columns);
        try {
            cellLayer.property("ADBE Transform Group").property("ADBE Position")
                .setValue([col * cellSize + cellSize / 2, row * cellSize + cellSize / 2]);
        } catch (e) {
            return "ERR:定位失败";
        }
        return "OK";
    }

    /** 输出目录：默认写用户目录 cache/thumbs；dev 模式写扩展 data/thumbs */
    function outputFolder(options) {
        var mode = options && options.outputRoot ? options.outputRoot : "user";
        if (mode === "extension" && options && options.extensionPath) {
            return new Folder(options.extensionPath + "/data/thumbs");
        }
        if (typeof AEV_Store === "undefined") return null;
        var folder = AEV_Store.folderAt("cache/thumbs");
        if (folder && !folder.exists) folder.create();
        return folder;
    }

    function jsonText(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        return '"' + out + '"';
    }

    function result(status, fields) {
        var parts = ['"status":' + jsonText(status)];
        for (var i = 0; i < fields.length; i++) {
            parts.push('"' + fields[i][0] + '":' + jsonText(fields[i][1]));
        }
        return "{" + parts.join(",") + "}";
    }

    function currentMajor() {
        try {
            return parseInt(String(app.version || ""), 10) || 0;
        } catch (e) {
            return 0;
        }
    }

    function usableBackground(path) {
        var text = String(path || "");
        if (!text) return "";
        try {
            var file = new File(text);
            return file.exists ? file.fsName : "";
        } catch (e) {
            return "";
        }
    }

    function backgroundFingerprint(path) {
        if (typeof AEV_Assets !== "undefined" && AEV_Assets.backgroundFingerprint) {
            return AEV_Assets.backgroundFingerprint(path);
        }
        return path ? String(path).toLowerCase() : "default";
    }

    /** 选择一张本地图片，复制到 DreamEngine 管理的背景目录后返回绝对路径。 */
    function pickBackground() {
        var source = File.openDialog("选择效果预览背景");
        if (!source) return '{"status":"cancelled"}';
        var name = String(source.name || "");
        if (!/\.(png|jpe?g|bmp|tiff?)$/i.test(name)) {
            return result("error", [["reason", "unsupported_image"]]);
        }

        var dir = new Folder(Folder.myDocuments.fsName + "/DreamEngine/backgrounds");
        if (!dir.exists && !dir.create()) {
            return result("error", [["reason", "cannot_create_background_folder"]]);
        }
        var target = new File(dir.fsName + "/" + name);
        var dot = name.lastIndexOf(".");
        var base = dot > 0 ? name.substring(0, dot) : name;
        var ext = dot > 0 ? name.substring(dot) : "";
        var n = 1;
        while (target.exists) {
            target = new File(dir.fsName + "/" + base + "_" + n + ext);
            n++;
        }
        try {
            if (!source.copy(target)) {
                return result("error", [["reason", "copy_failed"]]);
            }
        } catch (e) {
            return result("error", [["reason", "copy_failed"], ["detail", String(e)]]);
        }
        return result("ok", [["path", target.fsName], ["name", target.name]]);
    }

    /**
     * 清理渲染留在 AE 工程里的内部对象，但绝不删除磁盘上的预览 PNG。
     *
     * 某些 AE 版本会把 Render Queue 输出的 PNG 序列放进工程面板。
     * 这里只清 DreamEngine 约定命名的对象，不碰用户素材。
     */
    function cleanupArtifacts(dedicatedTemplate) {
        var removed = 0;
        var failed = 0;
        try {
            if (typeof AEV_Assets !== "undefined" && AEV_Assets.dispose) {
                AEV_Assets.dispose();
            }
        } catch (eAssets) {}

        var total = 0;
        try {
            total = app.project.numItems;
        } catch (eTotal) {
            return '{"removed":0,"failed":1}';
        }

        for (var i = total; i >= 1; i--) {
            var item = null;
            try {
                item = app.project.item(i);
            } catch (eItem) {
                failed++;
                continue;
            }
            if (!item) continue;

            var internal = false;
            var name = String(item.name || "");
            if (dedicatedTemplate) {
                // 专用模板工程里没有用户数据；只保留固定渲染目标合成。
                internal = !(item instanceof CompItem && name === "DE_RENDER_TARGET");
            } else if (item instanceof CompItem &&
                    /^DE_(asset|scene|cell|sheet|preset_cell)_/.test(name)) {
                internal = true;
            } else if (item instanceof FootageItem) {
                try {
                    var source = item.mainSource;
                    var sourceFile = source && source.file;
                    var sourceName = sourceFile ? String(sourceFile.name || "") : "";
                    var sourcePath = sourceFile
                        ? String(sourceFile.fsName || "").replace(/\\/g, "/").toLowerCase()
                        : "";
                    internal = /^batch_\d+(?:_\d{4})?\.png$/i.test(sourceName) &&
                        sourcePath.indexOf("/thumbs/") >= 0;
                } catch (eSource) {}
            }
            if (!internal) continue;
            try {
                item.remove();
                removed++;
            } catch (eRemove) {
                failed++;
            }
        }
        // 模板工程可能留下额外的 DE_RENDER_TARGET 队列副本。保留第 1 项
        //（模板原件），删除后续 DreamEngine 内部队列项。
        try {
            var rq = app.project.renderQueue;
            for (var q = rq.numItems; q >= 2; q--) {
                var rqItem = rq.item(q);
                var compName = "";
                try { compName = String(rqItem.comp && rqItem.comp.name || ""); } catch (eComp) {}
                if (!/^DE_(RENDER_TARGET|sheet|cell|preset_cell)/.test(compName)) continue;
                try {
                    rqItem.remove();
                    removed++;
                } catch (eRqRemove) {
                    failed++;
                }
            }
        } catch (eRq) {}
        return '{"removed":' + removed + ',"failed":' + failed + "}";
    }

    function traceOverride(text) {
        try {
            if (typeof AEV_Recipe !== "undefined" && AEV_Recipe.trace) {
                AEV_Recipe.trace(text);
            }
        } catch (e) {}
    }

    function findEffectByMatchName(layer, matchName) {
        var target = matchName;
        try {
            if (typeof AEV_Recipe !== "undefined" && AEV_Recipe.effectNameFor) {
                target = AEV_Recipe.effectNameFor(matchName);
            }
        } catch (eName) {}

        var parade = null;
        try { parade = layer.property("ADBE Effect Parade"); } catch (eParade) { return null; }
        var count = 0;
        try { count = parade.numProperties; } catch (eCount) { return null; }
        for (var i = 1; i <= count; i++) {
            var effect = null;
            try { effect = parade.property(i); } catch (eProp) { continue; }
            if (!effect) continue;
            var mn = "";
            try { mn = String(effect.matchName); } catch (eMatch) { mn = ""; }
            if (mn === matchName || mn === target) return effect;
        }
        return null;
    }

    function removeEffectsFrom(layer, countBefore) {
        var parade = null;
        try { parade = layer.property("ADBE Effect Parade"); } catch (e) { return; }
        var count = 0;
        try { count = parade.numProperties; } catch (e2) { return; }
        while (count > countBefore) {
            try { parade.property(count).remove(); } catch (e3) {}
            count--;
        }
    }

    /**
     * 把 .ffx 预设套到临时层，并确认目标效果确实出现了。
     * applyPreset 在图层类型不匹配时会静默无效，所以不能只看有没有报错。
     */
    function applyPresetToLayer(layer, cell, matchName, presetPath) {
        var before = 0;
        try {
            before = layer.property("ADBE Effect Parade").numProperties;
        } catch (eCount) {
            before = 0;
        }
        if (!presetPath) return { effect: null, before: before, reason: "empty_path" };

        var file = new File(presetPath);
        if (!file.exists) return { effect: null, before: before, reason: "preset_missing" };

        // applyPreset 会把关键帧落在当前时间；临时合成从 0 开始最稳。
        try { cell.time = 0; } catch (eTime) {}
        try { layer.selected = true; } catch (eSel) {}
        try {
            layer.applyPreset(file);
        } catch (eApply) {
            removeEffectsFrom(layer, before);
            traceOverride("preset|apply_failed|" + matchName + "|" + eApply);
            return { effect: null, before: before, reason: "apply_failed" };
        }

        var found = findEffectByMatchName(layer, matchName);
        if (found) return { effect: found, before: before, reason: "ok" };

        removeEffectsFrom(layer, before);
        traceOverride("preset|no_target_effect|" + matchName);
        return { effect: null, before: before, reason: "no_target_effect" };
    }

    /**
     * 批量渲染一张 contact sheet。
     * matchNames：本次要渲的 matchName 数组（不超过每网格数）
     * sheetIndex：第几张网，决定输出文件名
     * options：{ extensionPath, outputRoot, startTime, cellOffset, singleCell,
     *            gridColumns, gridRows }
     *   cellOffset —— 本批从网格第几格开始摆。整张新网传 0；
     *   往已有网里补空位时才用得上（要与 manifest 里的 cell 编号一致）。
     *   singleCell —— 插件隔离重试通道：1×1 单格网，输出 128×128 帧序列。
     */
    function renderBatch(matchNames, sheetIndex, options) {
        if (!matchNames || matchNames.length === 0) {
            return result("error", [["reason", "empty_batch"]]);
        }

        // 每批开始时重读覆盖表，Hub 改完参数后下一次批量渲染立即生效。
        if (typeof AEV_Recipe !== "undefined" && AEV_Recipe.resetOverrides) {
            AEV_Recipe.resetOverrides();
        }

        var conf = config();
        var cellSize = conf.contactSheet.cellSize;
        // 插件 L2 预览走 singleCell：一张图只渲一个格子（128×128），
        // 不必为一条效果生成一整张 1024×1024 的网。默认路径完全不变。
        var singleCell = !!(options && options.singleCell);
        var background = usableBackground(options && options.background);
        var requestedColumns = options && parseInt(options.gridColumns, 10);
        var requestedRows = options && parseInt(options.gridRows, 10);
        var columns = singleCell ? 1 : (requestedColumns > 0 ? requestedColumns : conf.contactSheet.columns);
        var width = singleCell ? cellSize : (requestedColumns > 0 ? columns * cellSize : conf.contactSheet.width);
        var height = singleCell ? cellSize : (requestedRows > 0 ? requestedRows * cellSize : conf.contactSheet.height);
        var frames = conf.animatedPreview.frameCount;
        // 帧数可覆盖：插件 L2 预览不打关键帧（参数是保守启发式拨的，动起来失真），
        // 6 帧内容完全相同 —— 只渲 1 帧，省 5/6 的磁盘与加载开销。
        if (options && options.frames) {
            frames = Math.max(1, parseInt(options.frames, 10) || frames);
        }

        // 合成帧率固定 30，而 config 里的 fps(12) 只是面板播放帧率。
        // 两者混用会把"6 帧"算成 0.5 秒 → 30fps 下实际渲出 15 帧（实测踩过）。
        var CELL_FPS = 30;
        var durationSeconds = frames / CELL_FPS;
        var requestedStart = options && options.startTime !== undefined
            ? Number(options.startTime) : 0;
        if (!isFinite(requestedStart) || requestedStart < 0) requestedStart = 0;
        var cellOffset = singleCell ? 0 : ((options && options.cellOffset) || 0);

        if (typeof AEV_Store !== "undefined") {
            var permission = AEV_Store.writePermission();
            if (permission === 0) {
                return result("error", [["reason", "script_write_disabled"]]);
            }
        }

        var targetFolder = outputFolder(options);
        if (!targetFolder) return result("error", [["reason", "no_output_folder"]]);
        if (!targetFolder.exists && !targetFolder.create()) {
            return result("error", [["reason", "cannot_create_output_folder"]]);
        }

        var scenes = {};
        var freshComps = [];
        var cells = [];
        var cellNames = [];
        var cellErrors = [];
        var grid = null;
        var queueItem = null;
        var targetComp = options && options.targetComp;
        var targetQueueItem = options && options.targetQueueItem;
        var ownsGrid = !targetComp;
        var ownsQueueItem = true;
        var started = new Date().getTime();
        // 面板整轮批量生成需要跨批次复用素材；结束时由 cleanupArtifacts 统一清理。
        var keepAssets = !!(options && options.keepAssets);

        // freshAssets：每批用一份全新的素材 comp，不复用会话缓存。
        // AE 会缓存嵌套 comp 的渲染帧，复用同一素材时后一次渲染可能直接吃缓存，
        // 表现为「效果加上了、画面却没变」。逐条渲染插件效果必须每条独立。
        var freshAssets = !!(options && options.freshAssets);

        /** 按素材类型取（必要时生成）标准素材；同一批内复用同一个 comp */
        function sceneOf(kind) {
            if (!scenes[kind]) {
                if (freshAssets && typeof AEV_Assets !== "undefined") {
                    var built = AEV_Assets.getFresh(kind, cellSize, background);
                    freshComps.push(built);
                    scenes[kind] = built;
                } else {
                    scenes[kind] = (typeof AEV_Assets !== "undefined")
                        ? AEV_Assets.get(kind, cellSize, background)
                        : buildScene(cellSize);
                }
            }
            return scenes[kind];
        }

        try {
            if (targetComp) {
                grid = targetComp;
                while (grid.numLayers > 0) {
                    try { grid.layer(1).remove(); } catch (eClearLayer) {}
                }
                grid.width = width;
                grid.height = height;
                grid.frameRate = CELL_FPS;
            } else {
                grid = app.project.items.addComp(
                    "DE_sheet_" + pad(sheetIndex, 3),
                    width, height, 1, durationSeconds, CELL_FPS
                );
            }
            var displayStart = Number(grid.displayStartTime) || 0;
            if (requestedStart < displayStart) requestedStart = displayStart;
            var neededEnd = requestedStart + durationSeconds + 1 / CELL_FPS;
            grid.duration = Math.max(Number(grid.duration) || 0, neededEnd, 1 / CELL_FPS);

            for (var i = 0; i < matchNames.length; i++) {
                var cellIndex = cellOffset + i;
                if (cellIndex >= columns * Math.max(1, Math.ceil(height / cellSize))) break;
                var matchName = matchNames[i];
                var cell = app.project.items.addComp(
                    "DE_cell_" + pad(sheetIndex, 3) + "_" + pad(cellIndex, 2),
                    cellSize, cellSize, 1, durationSeconds, CELL_FPS
                );

                // 场景决定临时合成怎么搭（设计文档 §4.3 的八类枚举）：
                //   文本类必须落在文本层，否则文本效果静默失效；
                //   两层输入类必须在下面垫背景 + 高对比图案，否则效果加上了但画面不变。
                // AE 里图层 1 在最上面，后 add 的盖在前面，所以按「背景 → 图案 → 效果层」
                // 的顺序添加，就得到 [effect, pattern, bg] 这个目标叠层。
                var layout = { base: "photo", needBg: false, needSource: false };
                if (typeof AEV_Recipe !== "undefined") {
                    layout = AEV_Recipe.layoutFor(AEV_Recipe.sceneFor(matchName));
                }
                if (layout.needBg) {
                    // 背景层刻意用「纯色」而不是 photo：遮罩/填充把上层吃掉一部分时，
                    // 露出来的必须是明显不同的颜色，否则下面垫着同样的画面，
                    // 透明和透明+相同背景看起来一模一样，等于白垫。
                    cell.layers.add(sceneOf("solid"));
                }
                if (layout.needSource) {
                    var sourceLayer = cell.layers.add(sceneOf("pattern"));
                    // 第二输入层必须关掉可见性——这是 AE 里用置换/遮罩图层的标准做法：
                    // 它只作为输入参与运算，不该出现在画面上。留着可见会把效果结果盖住。
                    try {
                        sourceLayer.enabled = false;
                    } catch (eSrc) {}
                }
                var layer = cell.layers.add(sceneOf(layout.base));

                // 逐格独立保护：addProperty 与配方各自捕获。
                // 这样"效果加不上"或"参数设不上"能定位到具体 matchName，
                // 而不是整批失败只回一条 AE 错误。
                var effectGroup = null;
                var overrideInfo = (typeof AEV_Recipe !== "undefined" && AEV_Recipe.overrideFor)
                    ? AEV_Recipe.overrideFor(matchName)
                    : null;
                var presetApplied = false;
                // noEffect：只放素材、不加效果，渲出「素材原样」当对照图。
                // 插件预览首轮就栽在这里——渲出来的图与素材逐像素相同，
                // 必须能区分「效果没生效」和「效果生效但看不出差别」。
                var bareScene = !!(options && options.noEffect);
                if (!bareScene) {
                    // 有 .ffx 的手动覆盖优先：先把预设套到临时层上。
                    if (overrideInfo && overrideInfo.preset && overrideInfo.presetExists &&
                        (overrideInfo.verified === false || !overrideInfo.params.length)) {
                        var presetResult = applyPresetToLayer(
                            layer, cell, matchName,
                            (typeof AEV_Recipe.presetPathFor === "function")
                                ? AEV_Recipe.presetPathFor(matchName) : ""
                        );
                        if (presetResult.effect) {
                            effectGroup = presetResult.effect;
                            presetApplied = true;
                        } else {
                            traceOverride("preset|fallback_default|" + matchName + "|" + presetResult.reason);
                        }
                    }
                    if (!effectGroup) {
                        try {
                            // 有替代方案时挂替代效果（Lumetri 渲染会挂死，用饱和度调整代表）
                            var effectName = (typeof AEV_Recipe !== "undefined")
                                ? AEV_Recipe.effectNameFor(matchName)
                                : matchName;
                            effectGroup = layer.property("ADBE Effect Parade").addProperty(effectName);
                        } catch (eAdd) {
                            cellErrors.push(matchName + "|addProperty|" + eAdd);
                            try { cell.remove(); } catch (eRm) {}
                            continue;
                        }
                    }
                }
                try {
                    if (effectGroup && typeof AEV_Recipe !== "undefined") {
                        var applied = presetApplied
                            ? { mode: "override-preset", writes: 0 }
                            : AEV_Recipe.apply(effectGroup, matchName, cellSize);

                        // 覆盖参数写入失败：先按同效果的重渲规则回退到 .ffx，
                        // 没有 .ffx 就回退到效果默认参数，避免留下半写坏的效果。
                        if (!presetApplied && applied && applied.failed) {
                            traceOverride("override|fallback|" + matchName + "|" +
                                (applied.errors ? applied.errors.join(",") : "failed"));
                            try { effectGroup.remove(); } catch (eRemove) {}
                            removeEffectsFrom(layer, 0);
                            effectGroup = null;

                            if (overrideInfo && overrideInfo.preset && overrideInfo.presetExists) {
                                var fallbackPreset = applyPresetToLayer(
                                    layer, cell, matchName,
                                    (typeof AEV_Recipe.presetPathFor === "function")
                                        ? AEV_Recipe.presetPathFor(matchName) : ""
                                );
                                if (fallbackPreset.effect) {
                                    effectGroup = fallbackPreset.effect;
                                    presetApplied = true;
                                    applied = { mode: "override-preset", writes: 0 };
                                }
                            }
                            if (!effectGroup) {
                                try {
                                    effectGroup = layer.property("ADBE Effect Parade")
                                        .addProperty(effectName || matchName);
                                    applied = { mode: "default-fallback", writes: 0 };
                                } catch (eFallbackAdd) {
                                    cellErrors.push(matchName + "|fallback|" + eFallbackAdd);
                                }
                            }
                        }

                        if (effectGroup) {
                            // 两层输入类：把「图层」选择器接到第 2 层（图案层），
                            // 默认值是「无」，不接的话效果等于没加。
                            if (layout.needSource) {
                                AEV_Recipe.bindLayers(effectGroup, 2);
                            }
                            // 手动覆盖/预设保持静态；只有显式配方才做自动关键帧。
                            if (applied && applied.mode === "recipe") {
                                AEV_Recipe.animate(effectGroup, matchName, durationSeconds);
                            } else if (!applied || (applied.mode !== "override" &&
                                       applied.mode !== "recipe+override" &&
                                       applied.mode !== "override-preset" &&
                                       applied.mode !== "default-fallback" &&
                                       applied.mode !== "override-blocked")) {
                                // 走启发式的效果同样要动起来，否则大半缩略图是静止的；
                                // 插件效果不打关键帧（animateAny 内部会自己跳过）
                                AEV_Recipe.animateAny(effectGroup, durationSeconds, matchName);
                            }
                        }
                    }
                } catch (eRecipe) {
                    cellErrors.push(matchName + "|recipe|" + eRecipe);
                }

                var placedLayer = grid.layers.add(cell);
                placedLayer.moveToEnd();
                placeCell(grid, placedLayer, cellIndex, columns, cellSize);
                cells.push(cell);
                cellNames.push(matchName);
            }

            queueItem = targetQueueItem
                ? targetQueueItem.duplicate()
                : app.project.renderQueue.items.add(grid);
            var outputModule = queueItem.outputModule(1);
            var template = "reuse_project";
            if (!targetQueueItem) {
                template = applyPngTemplate(outputModule);
                if (!template) {
                    throw new Error("no_png_template");
                }
            }
            // 模板队列可能处于 DONE；必须先 requeue，DONE 状态禁止改 file。
            queueItem.render = true;

            var baseName = "batch_" + pad(sheetIndex, 3);

            // 清掉同名历史帧：上一次渲染帧数与本次不同时（比如改过 frameCount），
            // 残留的高位帧会被面板误当成有效帧轮播。
            var stale = targetFolder.getFiles(baseName + "_*.png");
            for (var s = 0; s < stale.length; s++) {
                if (stale[s] instanceof File) {
                    try { stale[s].remove(); } catch (eStale) {}
                }
            }

            outputModule.file = new File(targetFolder.fsName + "/" + baseName + "_[####].png");

            var availableDuration = Math.max(
                1 / CELL_FPS,
                (Number(grid.displayStartTime) || 0) + Number(grid.duration) - requestedStart
            );
            durationSeconds = Math.min(durationSeconds, availableDuration);
            queueItem.timeSpanStart = requestedStart;
            queueItem.timeSpanDuration = durationSeconds;

            app.project.renderQueue.render();

            var files = [];
            for (var f = 0; f < frames; f++) {
                var frameFile = new File(targetFolder.fsName + "/" + baseName + "_" + pad(f, 4) + ".png");
                if (frameFile.exists) files.push(frameFile.name);
            }

            var elapsed = (new Date().getTime() - started) / 1000;
            /* 单格 addProperty 失败时 cellNames 会比 matchNames 少；这时不能报 ok，
               否则队列会把整批（包括没出图的那格）都标成 cached，索引里留下空条目。 */
            var missingCells = matchNames.length - cellNames.length;
            var status = files.length === frames && missingCells === 0 ? "ok" : "error";
            var reason = status === "ok"
                ? ""
                : (missingCells > 0 ? "cell_add_failed"
                    : (files.length === 0 ? "no_frames" : "incomplete_frames"));
            var detail = [
                ["reason", reason],
                ["sheet", baseName],
                ["folder", targetFolder.fsName],
                ["cells", String(cellNames.length)],
                ["frames", String(files.length)],
                ["seconds", String(Math.round(elapsed * 100) / 100)],
                ["template", template],
                ["names", cellNames.join(",")],
                ["cellErrors", cellErrors.join(" ;; ")],
                ["files", files.join(",")]
            ];
            return result(status, detail);
        } catch (e) {
            var message = e && e.message ? String(e.message) : String(e);
            return result("error", [
                ["reason", "render_failed:" + message],
                ["cellErrors", cellErrors.join(" ;; ")]
            ]);
        } finally {
            try {
                if (queueItem && ownsQueueItem) queueItem.remove();
            } catch (e1) {}
            for (var c = 0; c < cells.length; c++) {
                try { cells[c].remove(); } catch (e2) {}
            }
            try {
                if (grid && ownsGrid) grid.remove();
            } catch (e3) {}
            // fresh 素材是本次临时新建的，渲完必须删掉，否则工程里越堆越多
            for (var f = 0; f < freshComps.length; f++) {
                try { freshComps[f].remove(); } catch (eFresh) {}
            }
            // 单批/离线渲染立即清理；面板批量生成延迟到整轮结束。
            if (!keepAssets) cleanupArtifacts(!!targetComp);
        }
    }

    /** 单效果单帧渲染，用于调试；正常批量不要走这条路径 */
    function renderOne(matchName, options) {
        return renderBatch([matchName], 999, options);
    }

    /**
     * 单条预览的缓存指纹（设计文档 §4.5）。
     * 参与因子：matchName + 配方版本 + 素材类型与素材版本 + 格子尺寸 + 帧数。
     * AE 版本号刻意不参与——否则每次升级 AE 都要全量重渲。
     *
     * 素材指纹带上 kind：photo 与 pattern 用同一张网时，换素材不会误判命中。
     */
    function itemKey(matchName, cellSize, frames, background) {
        if (typeof AEV_Recipe === "undefined") return "";
        var kind = AEV_Recipe.assetKindFor(AEV_Recipe.sceneFor(matchName));
        var assetVersion = (typeof AEV_Assets !== "undefined") ? AEV_Assets.fingerprint() : "na";
        var bg = usableBackground(background);
        var source = kind + "@" + assetVersion;
        if (kind === "photo" && bg) {
            source += "@background-" + backgroundFingerprint(bg);
        }
        var overrideSignature = AEV_Recipe.overrideSignatureFor
            ? AEV_Recipe.overrideSignatureFor(matchName)
            : "";
        return AEV_Recipe.cacheKey(matchName, source, cellSize, frames, overrideSignature);
    }

    /**
     * 重写 manifest.json。
     *
     * 为什么由 jsx 来写：CEP 侧没有文件写能力（只有 XHR 读），而 manifest 必须
     * 落在扩展目录里才能被相对路径加载。jsx 侧手工拼 JSON 是本项目既定做法
     * （catalog.jsx 同样如此），不引入 JSON 库。
     *
     * entriesTsv 每行 7 列：
     *   matchName \t sheet \t cell \t frames \t frameTemplate \t aeMajor \t key
     * key 是已有预览的指纹；只有新渲染条目才留空并由当前背景重新计算。
     * frameTemplate 为空表示单文件预览（src = thumbs/batch_XXX.png）
     *
     * 同时把同样的条目写一份 data/previews.tsv（多带 cacheKey、aeMajor 两列）：
     * json 给 CEF 读，tsv 给 ExtendScript 读——ExtendScript 没有 JSON.parse，
     * 校验缓存是否过期必须在 AE 侧做，所以需要这份可被 split 的副本。
     */
    function writeManifest(entriesTsv, extensionPath, background) {
        var conf = config();
        var columns = conf.contactSheet.columns;
        var cellSize = conf.contactSheet.cellSize;
        var width = conf.contactSheet.width;
        var height = conf.contactSheet.height;

        var rows = [];
        var lines = String(entriesTsv || "").split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            var parts = lines[i].split("\t");
            if (parts.length < 4) continue;
            rows.push({
                matchName: parts[0],
                sheet: parseInt(parts[1], 10) || 0,
                cell: parseInt(parts[2], 10) || 0,
                frames: parseInt(parts[3], 10) || 1,
                frameTemplate: parts.length > 4 ? parts[4] : "",
                aeMajor: parts.length > 5 ? (parseInt(parts[5], 10) || 0) : 0,
                key: parts.length > 6 ? parts[6] : ""
            });
        }
        if (rows.length === 0) return result("error", [["reason", "empty_manifest"]]);

        // 按 sheet、cell 稳定排序（插入排序足够：量级是几十到几百条）
        for (var a = 1; a < rows.length; a++) {
            var current = rows[a];
            var b = a - 1;
            while (b >= 0 && (rows[b].sheet > current.sheet ||
                   (rows[b].sheet === current.sheet && rows[b].cell > current.cell))) {
                rows[b + 1] = rows[b];
                b--;
            }
            rows[b + 1] = current;
        }

        var items = [];
        var sheetsSeen = {};
        var sheets = [];
        var manifestMajor = 0;
        var mixedMajors = false;
        var indexRows = ["matchName\tsheet\tcell\tframes\tframeTemplate\tkey\taeMajor"];
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            if (row.aeMajor) {
                if (manifestMajor && row.aeMajor !== manifestMajor) mixedMajors = true;
                else manifestMajor = row.aeMajor;
            }
            var fileName = "batch_" + pad(row.sheet, 3) + ".png";
            var src = row.frameTemplate ? "" : ("thumbs/" + fileName);
            var frameSrc = row.frameTemplate || "";
            var key = row.key || itemKey(row.matchName, cellSize, row.frames, background);
            var parts2 = ['"matchName":' + jsonText(row.matchName)];
            parts2.push('"sheet":' + row.sheet);
            parts2.push('"x":' + ((row.cell % columns) * cellSize));
            parts2.push('"y":' + (Math.floor(row.cell / columns) * cellSize));
            parts2.push('"width":' + cellSize + ',"height":' + cellSize);
            parts2.push('"frames":' + row.frames);
            parts2.push('"aeMajor":' + row.aeMajor);
            if (key) parts2.push('"key":' + jsonText(key));
            if (src) parts2.push('"src":' + jsonText(src));
            if (frameSrc) parts2.push('"frameSrc":' + jsonText(frameSrc));
            items.push("{" + parts2.join(",") + "}");
            indexRows.push([
                row.matchName.replace(/\t/g, " "),
                String(row.sheet),
                String(row.cell),
                String(row.frames),
                row.frameTemplate,
                key,
                String(row.aeMajor)
            ].join("\t"));

            if (!sheetsSeen[String(row.sheet)]) {
                sheetsSeen[String(row.sheet)] = true;
                // 帧序列网的实体文件是 batch_XXX_0000.png，不是 batch_XXX.png；
                // sheets.src 必须指向真实存在的文件，否则按 sheet 取图会 404。
                var sheetFile = row.frames > 1
                    ? ("batch_" + pad(row.sheet, 3) + "_0000.png")
                    : ("batch_" + pad(row.sheet, 3) + ".png");
                sheets.push("{\"index\":" + row.sheet + ",\"src\":" +
                            jsonText("thumbs/" + sheetFile) + ",\"width\":" + width +
                            ",\"height\":" + height + "}");
            }
        }

        var manifest = '{"version":2,"aeMajor":' + (mixedMajors ? 0 : manifestMajor) +
            ',"cellSize":' + cellSize +
            ',"columns":' + columns + ',"width":' + width + ',"height":' + height +
            ',"sheets":[' + sheets.join(",") + '],"items":[' + items.join(",") + "]}";

        var target = new File(String(extensionPath) + "/data/manifest.json");
        target.encoding = "UTF-8";
        if (!target.open("w")) {
            return result("error", [["reason", "manifest_open_failed:" + target.fsName]]);
        }
        target.write(manifest);
        target.close();

        var indexFile = new File(String(extensionPath) + "/data/previews.tsv");
        indexFile.encoding = "UTF-8";
        if (indexFile.open("w")) {
            indexFile.write(indexRows.join("\r\n"));
            indexFile.close();
        }

        return result("ok", [["items", String(items.length)], ["path", target.fsName]]);
    }

    /**
     * 校验缓存：把 previews.tsv 里每条的指纹与当前配方/素材/尺寸重算的结果对比。
     * 返回 {"checked":N,"stale":["matchName",...]}。
     *
     * 这是「改了配方或换素材后旧图自动失效」的实现点。没有指纹的旧条目
     * （key 列为空）视为有效——它们是在引入指纹之前渲的，不该被一次性清空。
     */
    function staleList(extensionPath, background) {
        var conf = config();
        var cellSize = conf.contactSheet.cellSize;
        var file = new File(String(extensionPath) + "/data/previews.tsv");
        var stale = [];
        var checked = 0;
        if (!file.exists) {
            return "{\"checked\":0,\"stale\":[]}";
        }
        file.encoding = "UTF-8";
        if (!file.open("r")) {
            return "{\"checked\":0,\"stale\":[]}";
        }
        var first = true;
        while (!file.eof) {
            var line = file.readln();
            if (first) { first = false; continue; }   // 表头
            if (!line || line.length === 0) continue;
            var parts = line.split("\t");
            if (parts.length < 6) continue;
            var matchName = parts[0];
            var frames = parseInt(parts[3], 10) || 1;
            var storedKey = parts[5];
            var rowMajor = parts.length > 6 ? (parseInt(parts[6], 10) || 0) : 0;
            checked++;
            if (!storedKey) continue;
            // 旧版本预览继续作为回退图使用，不参与当前版本的配方失效判断。
            if (!rowMajor || rowMajor !== currentMajor()) continue;
            var currentKey = itemKey(matchName, cellSize, frames, background);
            if (currentKey && currentKey !== storedKey) stale.push(matchName);
        }
        file.close();

        var quoted = [];
        for (var i = 0; i < stale.length; i++) quoted.push(jsonText(stale[i]));
        return "{\"checked\":" + checked + ",\"stale\":[" + quoted.join(",") + "]}";
    }

    return {
        config: config,
        plan: plan,
        pngTemplate: pngTemplate,
        applyPngTemplate: applyPngTemplate,
        buildScene: buildScene,
        itemKey: itemKey,
        renderBatch: renderBatch,
        renderOne: renderOne,
        pickBackground: pickBackground,
        cleanupArtifacts: cleanupArtifacts,
        writeManifest: writeManifest,
        staleList: staleList
    };
})();
