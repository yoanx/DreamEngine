// ============================================================
// preset_preview.jsx —— 预设预览渲染（M3 / T4.6）
//
// 用户要求：
//   · 静态预设 → 静态预览（1 帧）
//   · 含关键帧的预设 → 预览覆盖「第一个关键帧 → 最后一个关键帧」
//   · 生成背景由用户指定：内置几种，或自己上传图片
//
// 硬约束（都是实机踩过的）：
//   · 全程在**临时合成**里做，渲完 remove()，绝不碰用户工程
//   · 用 layer.applyPreset + layer.selected = true；应用级 applyPreset 与
//     给 comp.selectedLayers 赋值都会直接把 AE 弄崩
//   · 含第三方插件效果的预设在面板里**跳过**（面板与 AE 同进程），
//     改由 tools/run_plugin_preset_preview.jsx 在专用 AE 实例里逐条隔离渲染；
//     传 options.allowPlugins=true 即放行
//   · 文本 / 变换 / 蒙版类预设不产生效果，靠 Text Animator 或属性关键帧表达；
//     落在非文本层上 AE 会静默无效。先按 .ffx 内容识别纯文本预设直接落文本层；
//     其余情况应用前后没变化时再换文本层、退回「文字」素材重试一次
//     （2025 实测：Text 分类 300 条全被误判失败，360 度循环还会因蒙版误判成静态）
//   · 索引写独立的 data/preset_manifest.json，不碰 L1 的 manifest.json
//     （后者会被引擎 writeManifest 整份重写）
//
// 语法：ES3 only。
// ============================================================

var AEV_PresetPreview = (function () {
    var VERSION = 1;
    var DEFAULT_FPS = 24;
    var MAX_SPAN_SECONDS = 6;     // 关键帧跨度上限，避免渲出几百帧
    var MAX_PROPS = 900;          // 属性遍历上限，防止深树拖慢 AE

    function frameLimit(fps) {
        return Math.max(1, Math.ceil(MAX_SPAN_SECONDS * Math.max(1, Number(fps) || DEFAULT_FPS)));
    }

    var BUILTIN_BACKGROUNDS = [
        { id: "photo", name: "DreamEngine 默认图" },
        { id: "text", name: "文字（Dream / Engine）" },
        { id: "solid", name: "纯色" },
        { id: "shape", name: "形状（圆形）" }
    ];

    function config() {
        if (typeof DREAM_ENGINE_RENDER_CONFIG !== "undefined" && DREAM_ENGINE_RENDER_CONFIG) {
            return DREAM_ENGINE_RENDER_CONFIG;
        }
        return { contactSheet: { cellSize: 720 }, animatedPreview: { frameCount: 36, fps: 24 } };
    }

    function pad(value, width) {
        var text = String(value);
        while (text.length < width) text = "0" + text;
        return text;
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

    /** AE 返回的文件名是 URL 编码的（"%E8%83%8C%E6%99%AF"），不解码面板会显示乱码 */
    function displayName(name) {
        var text = String(name || "");
        try { text = decodeURI(text); } catch (e) {}
        return text;
    }

    function backgroundDir() {
        var dir = new Folder(Folder.myDocuments.fsName + "/DreamEngine/backgrounds");
        if (!dir.exists) dir.create();
        return dir;
    }

    function thumbDir(extensionPath) {
        var dir = new Folder(String(extensionPath || "") + "/data/thumbs");
        if (!dir.exists) dir.create();
        return dir;
    }

    /** 面板的背景下拉：内置 4 种 + 用户上传的图片 */
    function backgroundsJson() {
        var items = [];
        for (var i = 0; i < BUILTIN_BACKGROUNDS.length; i++) {
            items.push('{"id":' + jsonText(BUILTIN_BACKGROUNDS[i].id) +
                       ',"name":' + jsonText(BUILTIN_BACKGROUNDS[i].name) +
                       ',"builtin":true}');
        }
        var dir = backgroundDir();
        var files = [];
        try {
            files = dir.getFiles();
        } catch (e) {}
        for (var f = 0; f < files.length; f++) {
            var file = files[f];
            if (!(file instanceof File)) continue;
            var lower = String(file.name).toLowerCase();
            if (!/\.(png|jpg|jpeg|tif|tiff|bmp|psd|ai)$/.test(lower)) continue;
            items.push('{"id":' + jsonText(file.fsName) +
                       ',"name":' + jsonText(displayName(file.name)) + ',"builtin":false}');
        }
        return '{"status":"ok","items":[' + items.join(",") + "]}";
    }

    /** 把用户选的图片复制进背景目录（重名自动加序号） */
    function importBackgroundJson(path) {
        var src = new File(String(path || ""));
        if (!src.exists) return result("error", [["reason", "no_file"]]);
        var dir = backgroundDir();
        var target = new File(dir.fsName + "/" + src.name);
        var n = 1;
        while (target.exists) {
            var cut = String(src.name).lastIndexOf(".");
            var base = cut > 0 ? String(src.name).substring(0, cut) : String(src.name);
            var ext = cut > 0 ? String(src.name).substring(cut) : "";
            target = new File(dir.fsName + "/" + base + "_" + n + ext);
            n++;
        }
        try {
            src.copy(target);
        } catch (e) {
            return result("error", [["reason", "copy_failed"], ["detail", String(e)]]);
        }
        return '{"status":"ok","id":' + jsonText(target.fsName) +
               ',"name":' + jsonText(displayName(target.name)) + "}";
    }

    /** 面板把整份索引文本写盘（引擎侧不解析 JSON，避免 ES3 没有 JSON.parse） */
    function writeIndexJson(text, extensionPath) {
        var file = new File(String(extensionPath || "") + "/data/preset_manifest.json");
        try {
            file.encoding = "UTF-8";
            if (!file.open("w")) return result("error", [["reason", "open_failed"]]);
            file.write(String(text || ""));
            file.close();
        } catch (e) {
            try { file.close(); } catch (e2) {}
            return result("error", [["reason", "write_failed"], ["detail", String(e)]]);
        }
        return '{"status":"ok"}';
    }

    /** 新首选项没有可见 PNG 模板时，回退到 AE 自带的 Hidden Legacy 模板。 */
    function applyPngTemplate(outputModule) {
        var candidates = ["_HIDDEN Legacy PNG Sequence"];
        var templates = outputModule.templates || [];
        for (var i = 0; i < templates.length; i++) {
            var name = String(templates[i]);
            if (name.toLowerCase().indexOf("png") >= 0) candidates.push(name);
        }
        candidates.push("DreamEngine PNG Sequence");
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

    /**
     * 遍历合成里的真实图层，并递归进入预合成。
     * 预设现在作用在内置背景自身的文字/纯色/形状层上，
     * 顶层快照必须能看到这些子层产生的效果和关键帧。
     */
    function walkLayerTree(comp, callback, depth, seen) {
        if (!comp || (depth || 0) > 5) return;
        seen = seen || [];
        for (var s = 0; s < seen.length; s++) {
            if (seen[s] === comp) return;
        }
        seen.push(comp);
        var total = 0;
        try { total = comp.numLayers; } catch (e) { total = 0; }
        for (var i = 1; i <= total; i++) {
            var layer = null;
            try { layer = comp.layer(i); } catch (e2) { continue; }
            if (!layer) continue;
            callback(layer);
            var source = null;
            try { source = layer.source; } catch (e3) {}
            if (source && source instanceof CompItem) {
                walkLayerTree(source, callback, (depth || 0) + 1, seen);
            }
        }
    }

    /**
     * 预设落点快照：效果数 / 效果参数关键帧 / 整棵属性树关键帧 /
     * 文本动画器组数 / 蒙版数 / 图层数。
     *
     * 为什么不能只数效果：AE 自带的文本、变换、蒙版类预设**不新增效果**，
     * 而是新增 Text Animator 或直接给属性打关键帧；只数效果会把它们
     * 误判成「没应用」。整树关键帧用 walkKeys 统计（只读 numKeys/keyTime）。
     */
    function snapshot(comp) {
        var effects = 0, keyProps = 0;
        var textAnimators = 0, masks = 0, layers = 0;
        var keys = { min: 1e9, max: -1e9, keys: 0, count: 0 };
        walkLayerTree(comp, function (layer) {
            layers++;
            var parade = null;
            try { parade = layer.property("ADBE Effect Parade"); } catch (e3) { parade = null; }
            if (parade) {
                var count = 0;
                try { count = parade.numProperties; } catch (e4) { count = 0; }
                for (var e = 1; e <= count; e++) {
                    effects++;
                    var group = null;
                    try { group = parade.property(e); } catch (e5) { continue; }
                    if (!group) continue;
                    var sub = 0;
                    try { sub = group.numProperties; } catch (e6) { sub = 0; }
                    for (var p = 1; p <= sub; p++) {
                        try {
                            var prop = group.property(p);
                            if (prop.numKeys && prop.numKeys > 0) keyProps++;
                        } catch (e7) {}
                    }
                }
            }
            // 文本动画器：文本预设的真正落点，不产生任何效果
            try {
                var textProps = layer.property("ADBE Text Properties");
                if (textProps) {
                    var animators = textProps.property("ADBE Text Animators");
                    if (animators) textAnimators += Number(animators.numProperties) || 0;
                }
            } catch (e8) {}
            // 蒙版：Paths / 形状类预设会加路径
            try {
                var maskParade = layer.property("ADBE Mask Parade");
                if (maskParade) masks += Number(maskParade.numProperties) || 0;
            } catch (e9) {}
            // 整棵属性树的关键帧（含变换 / 文本 / 蒙版）
            walkKeys(layer, 0, keys);
        });
        return {
            effects: effects,
            keyProps: keyProps,
            allKeys: keys.keys,
            textAnimators: textAnimators,
            masks: masks,
            layers: layers
        };
    }

    /** 应用前后任意一项增加，就认为预设真的落上去了 */
    function grew(before, after) {
        return after.effects > before.effects ||
            after.keyProps > before.keyProps ||
            after.allKeys > before.allKeys ||
            after.textAnimators > before.textAnimators ||
            after.masks > before.masks ||
            after.layers > before.layers;
    }

    /** 合成树里的全部文本层；返回时带上它真正的宿主合成 */
    function textTargets(comp) {
        var out = [];
        walkLayerTree(comp, function (layer) {
            var isText = false;
            try { isText = (layer instanceof TextLayer); } catch (e) {}
            if (!isText) return;
            var owner = comp;
            try { if (layer.containingComp) owner = layer.containingComp; } catch (e2) {}
            out.push({ comp: owner, layer: layer });
        });
        return out;
    }

    /** 清空合成里的图层（换素材重试时用） */
    function clearCompLayers(comp) {
        var guard = 0;
        try {
            while (comp.numLayers > 0 && guard < 500) {
                try { comp.layer(1).remove(); } catch (e) { break; }
                guard++;
            }
        } catch (eOuter) {}
    }

    /**
     * 从 .ffx（RIFX 二进制）判断预设类型。
     *
     * 只读 ASCII 片段、不解析 RIFX 结构；读不到文件时按「未知」处理，走旧的试探逻辑。
     * textOnly = 有文本属性、没有效果参数组：这类预设不产生效果，落在合成层上
     * 只会在蒙版上留下半套结果（实机：360 度循环 masks+1、keys 不变）。
     */
    function presetInfo(presetPath) {
        var info = { textOnly: false, known: false };
        try {
            var file = new File(String(presetPath || ""));
            file.encoding = "BINARY";
            if (!file.open("r")) return info;
            var data = file.read();
            file.close();
            if (!data) return info;
            info.known = true;
            var hasText = data.indexOf("ADBE Text Properties") >= 0;
            var hasEffects = data.indexOf("ADBE Effect Parade") >= 0;
            info.textOnly = hasText && !hasEffects;
        } catch (e) {}
        return info;
    }

    /**
     * 遍历属性树收集关键帧时间。
     *
     * 只读 numKeys / keyTime —— 绝不读 hasMin / maxValue / value：
     * 实机验证过遍历时读插件参数值会让 AE 直接崩掉。
     */
    function walkKeys(group, depth, out) {
        if (depth > 5 || out.count > MAX_PROPS) return;
        var n = 0;
        try { n = group.numProperties; } catch (e) { return; }
        for (var i = 1; i <= n; i++) {
            var p = null;
            try { p = group.property(i); } catch (e2) { continue; }
            if (!p) continue;
            out.count++;
            if (out.count > MAX_PROPS) return;
            var keys = 0;
            try { keys = p.numKeys; } catch (e3) { keys = 0; }
            if (keys > 0) {
                try {
                    var t1 = Number(p.keyTime(1));
                    var t2 = Number(p.keyTime(keys));
                    if (!isNaN(t1) && !isNaN(t2)) {
                        if (t1 < out.min) out.min = t1;
                        if (t2 > out.max) out.max = t2;
                        out.keys++;
                    }
                } catch (e4) {}
            }
            var sub = 0;
            try { sub = p.numProperties; } catch (e5) { sub = 0; }
            if (sub > 0) walkKeys(p, depth + 1, out);
        }
    }

    function keyRange(comp) {
        var out = { min: 1e9, max: -1e9, keys: 0, count: 0 };
        walkLayerTree(comp, function (layer) {
            walkKeys(layer, 0, out);
        });
        return out;
    }

    /** 收集预设用到的第三方插件效果 matchName（只读名字，不碰参数值） */
    function pluginMatchNames(comp) {
        var found = [];
        walkLayerTree(comp, function (layer) {
            var parade = null;
            try { parade = layer.property("ADBE Effect Parade"); } catch (e3) { return; }
            if (!parade) return;
            var count = 0;
            try { count = parade.numProperties; } catch (e4) { return; }
            for (var e = 1; e <= count; e++) {
                var group = null;
                try { group = parade.property(e); } catch (e5) { continue; }
                if (!group) continue;
                var mn = "";
                try { mn = String(group.matchName || ""); } catch (e6) {}
                if (!mn) continue;
                if (typeof AEV_Recipe !== "undefined" && AEV_Recipe.isBuiltinMatch) {
                    if (!AEV_Recipe.isBuiltinMatch(mn)) found.push(mn);
                }
            }
        });
        return found;
    }

    function selectOnly(comp, layer) {
        var total = 0;
        try { total = comp.numLayers; } catch (e) { total = 0; }
        for (var i = 1; i <= total; i++) {
            try { comp.layer(i).selected = false; } catch (e2) {}
        }
        try { layer.selected = true; } catch (e3) {}
    }

    function targetLayersForAsset(kind, asset, fallbackLayer) {
        var targets = [];
        if (kind === "text") {
            walkLayerTree(asset, function (layer) {
                if (layer instanceof TextLayer) {
                    targets.push({ comp: asset, layer: layer });
                }
            });
        } else if (kind === "solid" || kind === "shape") {
            var wanted = kind === "solid" ? "base" : "body";
            walkLayerTree(asset, function (layer) {
                var name = "";
                try { name = String(layer.name || ""); } catch (e) {}
                if (name === wanted) {
                    targets.push({ comp: asset, layer: layer });
                }
            });
        }
        if (targets.length === 0) {
            targets.push({ comp: fallbackLayer.comp, layer: fallbackLayer.layer });
        }
        return targets;
    }

    function applyToTargets(targets, file) {
        for (var i = 0; i < targets.length; i++) {
            selectOnly(targets[i].comp, targets[i].layer);
            targets[i].layer.applyPreset(file);
        }
    }

    /** 搭背景层：内置素材 comp 或用户上传的图片 */
    function addBackground(comp, background, size, trash, extensionPath) {
        var id = String(background || "photo");
        var isCustom = id.indexOf("/") >= 0 || id.indexOf("\\") >= 0;
        if (!isCustom) {
            var asset = null;
            try {
                var resolvedBackground = id === "photo" &&
                    typeof AEV_Assets !== "undefined" &&
                    AEV_Assets.resolveBackground
                    ? AEV_Assets.resolveBackground(id, extensionPath)
                    : "";
                asset = (typeof AEV_Assets !== "undefined")
                    ? AEV_Assets.getFresh(id, size, resolvedBackground)
                    : null;
            } catch (e) {}
            if (!asset) return null;
            trash.comps.push(asset);
            // 内置素材合成默认只有 1 秒；文本 / 动画类预设的关键帧常到 2~6 秒，
            // 不延长的话嵌套层第 1 秒后整帧消失（实机：3D 向上翻转反射只剩前 6 帧）。
            try {
                var need = MAX_SPAN_SECONDS + 2;
                if (Number(asset.duration) < need) {
                    asset.duration = need;
                    for (var ai = 1; ai <= asset.numLayers; ai++) {
                        try { asset.layer(ai).outPoint = need; } catch (eOut) {}
                    }
                }
            } catch (eDur) {}
            if (id === "text") {
                var textBg = comp.layers.addSolid([0.07, 0.08, 0.09], "textBg", size, size, 1);
                textBg.moveToEnd();
            }
            var nested = comp.layers.add(asset);
            if (id !== "text") nested.moveToEnd();
            if (id === "text" && AEV_Assets.centerTextAsset) {
                AEV_Assets.centerTextAsset(asset, nested, size);
            }
            return {
                layer: nested,
                targets: targetLayersForAsset(id, asset, { comp: comp, layer: nested })
            };
        }
        var file = new File(id);
        if (!file.exists) return null;
        var imported = null;
        try {
            var importOptions = new ImportOptions(file);
            importOptions.sequence = false;
            imported = app.project.importFile(importOptions);
        } catch (e2) {
            return null;
        }
        if (!imported) return null;
        trash.items.push(imported);
        var layer = comp.layers.add(imported);
        layer.moveToEnd();
        // 等比铺满，多余部分裁掉（预览是方形）
        try {
            var w = Number(imported.width) || size;
            var h = Number(imported.height) || size;
            var scale = Math.max(size / w, size / h) * 100;
            layer.property("ADBE Transform Group").property("ADBE Scale").setValue([scale, scale]);
        } catch (e3) {}
        return {
            layer: layer,
            targets: [{ comp: comp, layer: layer }]
        };
    }

    /**
     * 渲染一个预设的预览。
     *
     * presetPath  .ffx 路径
     * sheetIndex  稳定编号（决定输出文件名 preset_<n>_####.png）
     * options     { extensionPath, background, cellSize }
     */
    function renderJson(presetPath, sheetIndex, options) {
        var opts = options || {};
        var conf = config();
        var size = Number(opts.cellSize) || conf.contactSheet.cellSize || 720;
        var fps = Math.max(1, Number(opts.fps) || DEFAULT_FPS);
        var background = String(opts.background || "photo");
        var allowPlugins = !!opts.allowPlugins;
        var extensionPath = String(opts.extensionPath || "");
        var file = new File(String(presetPath || ""));
        if (!file.exists) return result("error", [["reason", "no_preset"]]);
        if (!extensionPath) return result("error", [["reason", "no_extension_path"]]);

        var folder = thumbDir(extensionPath);
        if (!folder || !folder.exists) return result("error", [["reason", "no_output_folder"]]);
        if (typeof AEV_Store !== "undefined" && AEV_Store.writePermission() === 0) {
            return result("error", [["reason", "script_write_disabled"]]);
        }

        var baseName = "preset_" + pad(sheetIndex, 3);
        var rawBase = baseName + "_raw";
        var trash = { comps: [], items: [] };
        var comp = null;
        var queueItem = null;
        var ownsComp = !opts.targetComp;
        var ownsQueueItem = true;
        var rawFiles = [];
        var kept = [];

        /** 清掉上一次的成品帧与残留中间帧：
         *  帧数变少时残留高位帧会被面板误当有效帧；崩溃留下的 raw_####.png
         *  会让下一次渲染弹「文件已存在，是否覆盖」。 */
        function clearKeptFrames() {
            var all = folder.getFiles();
            if (!all) return;
            var re = new RegExp("^" + baseName + "_\\d{4}\\.png$");
            var reRaw = new RegExp("^" + baseName + "_raw_\\d{4}\\.png$");
            for (var i = 0; i < all.length; i++) {
                if (!(all[i] instanceof File)) continue;
                var pngName = String(all[i].name);
                if (!re.test(pngName) && !reRaw.test(pngName)) continue;
                try { all[i].remove(); } catch (e) {}
            }
        }

        clearKeptFrames();
        try {
            // 时长先给足，后面按关键帧范围调整
            if (opts.targetComp) {
                comp = opts.targetComp;
                while (comp.numLayers > 0) {
                    try { comp.layer(1).remove(); } catch (eClearLayer) {}
                }
                comp.width = size;
                comp.height = size;
                comp.frameRate = fps;
                comp.duration = 2;
            } else {
                comp = app.project.items.addComp(
                    "DE_preset_cell_" + pad(sheetIndex, 3),
                    size, size, 1, 2, fps
                );
            }
            comp.time = 0; // applyPreset 会把关键帧放在当前时间指示器上

            var backgroundInfo = addBackground(comp, background, size, trash, extensionPath);
            var bgLayer = backgroundInfo && backgroundInfo.layer;
            if (!bgLayer) return result("error", [["reason", "bad_background"]]);

            var effectiveBackground = background;
            var attempts = [];
            var lastError = "";

            /** 在指定图层上应用一次，并对比应用前后的快照 */
            function tryApply(targets, label) {
                var before = snapshot(comp);
                try {
                    applyToTargets(targets, file);
                } catch (eApply) {
                    lastError = String(eApply);
                    attempts.push(label + "|error|" + lastError);
                    return false;
                }
                var after = snapshot(comp);
                attempts.push(label +
                    "|effects+" + (after.effects - before.effects) +
                    "|keys+" + (after.allKeys - before.allKeys) +
                    "|animators+" + (after.textAnimators - before.textAnimators) +
                    "|masks+" + (after.masks - before.masks) +
                    "|layers+" + (after.layers - before.layers));
                return grew(before, after);
            }

            var applied = false;

            /**
             * 凑到文本层上：场景里已有文本层就复用（保留用户选的背景），
             * 没有就换「文字」专用素材。返回 true / false；null 表示没有可用的文本底。
             */
            function applyOnTextStage() {
                var stageText = textTargets(comp);
                if (stageText.length > 0) {
                    return tryApply(stageText, "textLayers:" + effectiveBackground);
                }
                if (String(background) === "text" || effectiveBackground === "text") return null;
                clearCompLayers(comp);
                var textAsset = addBackground(comp, "text", size, trash, extensionPath);
                if (!textAsset || !textAsset.targets || textAsset.targets.length === 0) return null;
                effectiveBackground = "text";
                return tryApply(textAsset.targets, "textAsset");
            }

            // 纯文本预设不产生效果，而且落在合成层上只会在蒙版上留半套结果
            //（实机：360 度循环落到合成层后 masks+1、keys 不变，被误判成「已应用」，
            //  最后只出一张静态图）。按 ffx 内容先把它直接落到文本层。
            var preset = presetInfo(presetPath);
            if (preset.textOnly) {
                applied = applyOnTextStage() === true;
            } else {
                applied = tryApply(backgroundInfo.targets, "targets:" + effectiveBackground);
                // 文本 / 变换 / 蒙版类预设不新增效果，落在错层上 AE 会静默无效
                //（assets.jsx / presets.jsx 的实机结论）：再换文本层、文字素材重试一次。
                if (!applied) {
                    applied = applyOnTextStage() === true;
                }
            }
            if (!applied) {
                if (lastError) {
                    return result("error", [
                        ["reason", "apply_failed"],
                        ["detail", lastError],
                        ["attempts", attempts.join(" ;; ")]
                    ]);
                }
                return result("no_effect", [
                    ["reason", "preset_did_not_apply"],
                    ["attempts", attempts.join(" ;; ")]
                ]);
            }

            // 面板里默认不渲插件预设（面板和 AE 同进程，混渲会杀宿主）；
            // 离线专用 AE 实例传 allowPlugins=true，逐条隔离渲染就安全。
            var plugins = pluginMatchNames(comp);
            if (plugins.length > 0 && !allowPlugins) {
                return result("plugin_preset", [
                    ["reason", "third_party_plugin"],
                    ["matchName", plugins.join(",")]
                ]);
            }

            var range = keyRange(comp);
            var animated = range.keys > 0 && (range.max - range.min) > 1 / fps;
            var start = 0;
            var span = 1 / fps;
            var truncated = false;
            var keyStart = 0;
            var keyEnd = 0;
            if (animated) {
                start = range.min;
                keyStart = range.min;
                keyEnd = range.max;
                var end = Math.min(range.max, range.min + MAX_SPAN_SECONDS);
                truncated = range.max > end;
                span = Math.max(1 / fps, end - start);
            } else {
                keyStart = 0;
                keyEnd = 0;
            }

            // comp 必须覆盖到最后一个关键帧，否则超出的部分渲不出来
            try {
                comp.duration = Math.max(1 / fps, start + span + 1 / fps);
            } catch (eDur) {}

            queueItem = opts.targetQueueItem
                ? opts.targetQueueItem.duplicate()
                : app.project.renderQueue.items.add(comp);
            var outputModule = queueItem.outputModule(1);
            if (!opts.targetQueueItem) {
                var template = applyPngTemplate(outputModule);
                if (!template) return result("error", [["reason", "no_png_template"]]);
            }
            // 模板队列可能处于 DONE；必须先 requeue，DONE 状态禁止改 file。
            queueItem.render = true;
            outputModule.file = new File(folder.fsName + "/" + rawBase + "_[####].png");
            queueItem.timeSpanStart = start;
            queueItem.timeSpanDuration = span;
            app.project.renderQueue.render();

            // 渲染队列按 6 fps 输出；6 秒最多保留 36 帧，避免被压缩成快放
            rawFiles = folder.getFiles(rawBase + "_*.png");
            if (!rawFiles || rawFiles.length === 0) {
                return result("error", [["reason", "no_frames"]]);
            }
            rawFiles.sort(function (a, b) {
                return String(a.name) < String(b.name) ? -1 : 1;
            });
            var wanted = animated ? Math.min(frameLimit(fps), rawFiles.length) : 1;
            for (var k = 0; k < wanted; k++) {
                var idx = wanted === 1
                    ? Math.floor(rawFiles.length / 2)
                    : Math.round(k * (rawFiles.length - 1) / (wanted - 1));
                var srcFile = rawFiles[idx];
                var dest = new File(folder.fsName + "/" + baseName + "_" + pad(k, 4) + ".png");
                try {
                    srcFile.copy(dest);
                    kept.push(dest.name);
                } catch (eCopy) {}
            }
            if (kept.length === 0) return result("error", [["reason", "copy_frames_failed"]]);

            return result("ok", [
                ["sheet", String(sheetIndex)],
                ["frames", String(kept.length)],
                ["animated", animated ? "true" : "false"],
                ["keyStart", String(Math.round(keyStart * 1000) / 1000)],
                ["keyEnd", String(Math.round(keyEnd * 1000) / 1000)],
                ["duration", String(Math.round(span * 1000) / 1000)],
                ["fps", String(fps)],
                ["truncated", truncated ? "true" : "false"],
                ["background", effectiveBackground],
                ["plugins", plugins.join(",")],
                ["files", kept.join(",")]
            ]);
        } catch (e) {
            return result("error", [
                ["reason", "render_failed:" + (e && e.message ? String(e.message) : String(e))]
            ]);
        } finally {
            // 只清 raw 与临时对象；成品帧已在渲染前清过、本次刚生成，不能删
            try { if (queueItem && ownsQueueItem) queueItem.remove(); } catch (eQ) {}
            try { if (comp && ownsComp) comp.remove(); } catch (eC) {}
            var i;
            for (i = 0; i < trash.comps.length; i++) {
                try { trash.comps[i].remove(); } catch (eT1) {}
            }
            for (i = 0; i < trash.items.length; i++) {
                try { trash.items[i].remove(); } catch (eT2) {}
            }
            for (i = 0; i < rawFiles.length; i++) {
                try { if (rawFiles[i].exists) rawFiles[i].remove(); } catch (eT3) {}
            }
        }
    }

    return {
        VERSION: VERSION,
        backgroundsJson: backgroundsJson,
        importBackgroundJson: importBackgroundJson,
        writeIndexJson: writeIndexJson,
        renderJson: renderJson,
        BUILTIN_BACKGROUNDS: BUILTIN_BACKGROUNDS,
        DEFAULT_FPS: DEFAULT_FPS,
        frameLimit: frameLimit
    };
})();
