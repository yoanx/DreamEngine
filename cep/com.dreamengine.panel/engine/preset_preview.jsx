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
    var TEXT_STAGE_WIDTH = 1920;  // AE 自带文字预设的原始设计画布
    var TEXT_STAGE_HEIGHT = 1080;
    var EXPRESSION_SPAN_SECONDS = 3;

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

    function safeFolderName(value) {
        var text = String(value || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        return text || "preset";
    }

    function thumbDir(extensionPath, previewRoot, folderName) {
        var root = String(previewRoot || "");
        var base = root
            ? new Folder(root + "/presets")
            : new Folder(String(extensionPath || "") + "/data/thumbs");
        if (!base.exists) base.create();
        var dir = new Folder(base.fsName + "/" + safeFolderName(folderName));
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
    /** 统计属性树里启用的非空表达式；只读 expression，不读插件参数值。 */
    function walkExpressions(group, depth, state) {
        if (depth > 5 || state.count > MAX_PROPS) return;
        var n = 0;
        try { n = group.numProperties; } catch (e) { return; }
        for (var i = 1; i <= n; i++) {
            var p = null;
            try { p = group.property(i); } catch (e2) { continue; }
            if (!p) continue;
            state.count++;
            if (state.count > MAX_PROPS) return;
            try {
                if (p.canSetExpression && p.expressionEnabled && String(p.expression || "")) {
                    state.found++;
                }
            } catch (eExpr) {}
            var sub = 0;
            try { sub = p.numProperties; } catch (eSub) { sub = 0; }
            if (sub > 0) walkExpressions(p, depth + 1, state);
        }
    }
    function snapshot(comp) {
        var effects = 0, keyProps = 0, expressions = 0;
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
            // Expressions 分类的预设只写表达式，不新增效果、关键帧或动画器。
            var expressionState = { count: 0, found: 0 };
            walkExpressions(layer, 0, expressionState);
            expressions += expressionState.found;
        });
        return {
            effects: effects,
            keyProps: keyProps,
            expressions: expressions,
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
            after.expressions > before.expressions ||
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

    /**
     * applyPreset 会替换示例文字，应用前的居中偏移随即失效。
     * 在预设真正落地后按动画全程的实际文字边界重新居中；若位置有关键帧，
     * 整条位移轨迹一起平移，不破坏预设本身的相对运动。
     */
    function recenterTextLayer(comp, layer, centerX, centerY, endTime) {
        var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        var transform = null, position = null, anchor = null;
        try {
            transform = layer.property("ADBE Transform Group");
            position = transform.property("ADBE Position");
            anchor = transform.property("ADBE Anchor Point");
        } catch (eProps) {
            return false;
        }
        for (var i = 0; i <= 12; i++) {
            var t = Math.max(0, Number(endTime) || 0) * i / 12;
            try {
                comp.time = t;
                var p = position.value;
                var a = anchor.value;
                var rect = layer.sourceRectAtTime(t, false);
                minX = Math.min(minX, p[0] + rect.left - a[0]);
                maxX = Math.max(maxX, p[0] + rect.left + rect.width - a[0]);
                minY = Math.min(minY, p[1] + rect.top - a[1]);
                maxY = Math.max(maxY, p[1] + rect.top + rect.height - a[1]);
            } catch (eBounds) {}
        }
        if (minX === 1e9 || maxX === -1e9 || minY === 1e9 || maxY === -1e9) return false;
        var dx = Number(centerX) - (minX + maxX) / 2;
        var dy = Number(centerY) - (minY + maxY) / 2;
        var keys = 0;
        try { keys = Number(position.numKeys) || 0; } catch (eKeys) { keys = 0; }
        try {
            if (keys > 0) {
                for (var k = 1; k <= keys; k++) {
                    var keyValue = position.keyValue(k);
                    keyValue[0] = Number(keyValue[0]) + dx;
                    keyValue[1] = Number(keyValue[1]) + dy;
                    position.setValueAtTime(position.keyTime(k), keyValue);
                }
            } else {
                var value = position.value;
                value[0] = Number(value[0]) + dx;
                value[1] = Number(value[1]) + dy;
                position.setValue(value);
            }
        } catch (eShift) {
            return false;
        } finally {
            try { comp.time = 0; } catch (eTime) {}
        }
        return true;
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
    function presetCategory(presetPath) {
        var text = String(presetPath || "").replace(/\\/g, "/");
        var parts = text.split("/");
        for (var i = 1; i < parts.length - 1; i++) {
            if (String(parts[i]).toLowerCase() === "presets") return String(parts[i + 1]);
        }
        return "";
    }

    function presetStageKind(category, textOnly, presetPath) {
        var name = String(category || "");
        var lower = name.toLowerCase();
        var parts = String(presetPath || "").replace(/\\/g, "/").split("/");
        var presetName = String(parts[parts.length - 1] || "");
        var dot = presetName.lastIndexOf(".");
        if (dot > 0) presetName = presetName.substring(0, dot);
        // 这个内置预设只在文字层上能得到有效画面。
        if (presetName === "浮雕状多次曝光") return "text";
        if (textOnly || lower === "text") return "text";
        if (lower === "shapes") return "shape";
        if (lower.indexOf("transitions - ") === 0) return "transition";
        if (lower === "image - creative" || lower === "image - special effects" || lower === "image - utilities") return "creative";
        if (lower === "sound effects") return "audio";
        return "visual";
    }

    function presetInfo(presetPath) {
        var category = presetCategory(presetPath);
        var info = { textOnly: false, known: false, category: category, stageKind: presetStageKind(category, false, presetPath) };
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
            info.stageKind = presetStageKind(info.category, info.textOnly, presetPath);
        } catch (e) {}
        return info;
    }

    /**
     * 遍历属性树收集关键帧时间。
     *
     * 只读 numKeys / keyTime —— 绝不读 hasMin / maxValue / value：
     * 实机验证过遍历时读插件参数值会让 AE 直接崩掉。
     */
    function isShapeLayer(value) {
        try { return value instanceof ShapeLayer; } catch (e) { return false; }
    }

    function walkKeys(group, depth, out) {
        // 真实 Shape Layer 的矢量属性树在部分 AE 版本上会返回 Error 对象，
        // 读取 numKeys 会直接打断脚本；形状类按固定短动画渲染，跳过这棵树。
        if (isShapeLayer(group)) return;
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
    function addBackground(comp, background, size, trash, extensionPath, textOnly) {
        var id = String(background || "photo");
        var isCustom = id.indexOf("/") >= 0 || id.indexOf("\\") >= 0;
        if (!isCustom) {
            if (id === "text" && textOnly) {
                var solidBg = comp.layers.addSolid([0.07, 0.08, 0.09], "textBg", size, size, 1);
                solidBg.moveToEnd();
                return { layer: solidBg, targets: [] };
            }
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

    function addStageToOutput(comp, stage, size) {
        var nested = comp.layers.add(stage);
        try {
            var transform = nested.property("ADBE Transform Group");
            transform.property("ADBE Position").setValue([size / 2, size / 2]);
            var scale = size / TEXT_STAGE_HEIGHT * 100;
            transform.property("ADBE Scale").setValue([scale, scale]);
        } catch (e) {}
        return nested;
    }

    /** 转场 / Image 舞台使用随包默认渲染图，不能退回 assets.jsx 的形状组合。 */
    function defaultPhotoPath(extensionPath) {
        try {
            if (typeof AEV_Assets !== "undefined" && AEV_Assets.resolveBackground) {
                return AEV_Assets.resolveBackground("photo", extensionPath);
            }
        } catch (e) {}
        return "";
    }

    /** Shapes 预设优先使用真实 Shape Layer；旧版 AE 失败时退回可见纯色层。 */
    function addShapeStage(comp, size, trash, fps, sheetIndex) {
        var stage = app.project.items.addComp(
            "DE_preset_shape_stage_" + pad(sheetIndex, 3),
            TEXT_STAGE_WIDTH, TEXT_STAGE_HEIGHT, 1, MAX_SPAN_SECONDS + 2, fps
        );
        trash.comps.push(stage);
        var bg = stage.layers.addSolid([0.06, 0.07, 0.08], "bg", TEXT_STAGE_WIDTH, TEXT_STAGE_HEIGHT, 1);
        bg.moveToEnd();
        var body = null;
        try {
            body = stage.layers.addShape();
            body.name = "body";
            var root = body.property("ADBE Root Vectors Group");
            var group = root.addProperty("ADBE Vector Group");
            var contents = group.property("ADBE Vectors Group");
            var rect = contents.addProperty("ADBE Vector Shape - Rect");
            rect.property("ADBE Vector Rect Size").setValue([600, 600]);
            var fill = contents.addProperty("ADBE Vector Graphic - Fill");
            fill.property("ADBE Vector Fill Color").setValue([0.18, 0.68, 0.76, 1]);
            body.property("ADBE Transform Group").property("ADBE Position")
                .setValue([TEXT_STAGE_WIDTH / 2, TEXT_STAGE_HEIGHT / 2]);
        } catch (eShape) {
            try {
                body = stage.layers.addSolid([0.18, 0.68, 0.76], "body", TEXT_STAGE_WIDTH, TEXT_STAGE_HEIGHT, 1);
                body.property("ADBE Transform Group").property("ADBE Position")
                    .setValue([TEXT_STAGE_WIDTH / 2, TEXT_STAGE_HEIGHT / 2]);
            } catch (eSolid) {
                return null;
            }
        }
        var nested = addStageToOutput(comp, stage, size);
        return { layer: nested, targets: [{ comp: stage, layer: body }] };
    }

    /** 转场直接落在输出合成里：前景默认图，后景形状层，预设只作用前景。 */
    function addTransitionStage(comp, size, trash, fps, sheetIndex, extensionPath) {
        var bg = comp.layers.addSolid([0.06, 0.07, 0.08], "transitionBg", size, size, 1);
        bg.moveToEnd();
        var bottom = null;
        try {
            bottom = comp.layers.addShape();
            bottom.name = "transitionShape";
            var root = bottom.property("ADBE Root Vectors Group");
            var group = root.addProperty("ADBE Vector Group");
            var contents = group.property("ADBE Vectors Group");
            var rect = contents.addProperty("ADBE Vector Shape - Rect");
            rect.property("ADBE Vector Rect Size").setValue([size * 0.78, size * 0.78]);
            var fill = contents.addProperty("ADBE Vector Graphic - Fill");
            fill.property("ADBE Vector Fill Color").setValue([0.18, 0.68, 0.76, 1]);
            bottom.property("ADBE Transform Group").property("ADBE Position")
                .setValue([size / 2, size / 2]);
        } catch (eBottom) {}
        if (!bottom) {
            bottom = comp.layers.addSolid([0.18, 0.68, 0.76], "transitionBottom", size, size, 1);
            bottom.moveToEnd();
        }
        var top = null;
        try {
            var topAsset = AEV_Assets.getFresh("photo", TEXT_STAGE_HEIGHT, defaultPhotoPath(extensionPath));
            if (topAsset) {
                trash.comps.push(topAsset);
                topAsset.duration = MAX_SPAN_SECONDS + 2;
                for (var ti = 1; ti <= topAsset.numLayers; ti++) {
                    try { topAsset.layer(ti).outPoint = MAX_SPAN_SECONDS + 2; } catch (eTopOut) {}
                }
                top = comp.layers.add(topAsset);
                top.property("ADBE Transform Group").property("ADBE Position")
                    .setValue([size / 2, size / 2]);
                var topScale = size / TEXT_STAGE_HEIGHT * 100;
                top.property("ADBE Transform Group").property("ADBE Scale")
                    .setValue([topScale, topScale]);
            }
        } catch (eTop) {}
        if (!top) top = comp.layers.addSolid([0.82, 0.24, 0.16], "transitionTop", size, size, 1);
        return {
            layer: top,
            // 转场只作用在前景；背景形状层负责被擦除后透出的画面。
            targets: [{ comp: comp, layer: top }]
        };
    }

    /** Image 系列需要一个独立目标层，避免把边框/阴影效果直接盖到背景上。 */
    function addCreativeStage(comp, size, trash, fps, sheetIndex, extensionPath) {
        var stage = app.project.items.addComp(
            "DE_preset_creative_stage_" + pad(sheetIndex, 3),
            TEXT_STAGE_WIDTH, TEXT_STAGE_HEIGHT, 1, MAX_SPAN_SECONDS + 2, fps
        );
        trash.comps.push(stage);
        function addPhoto(name) {
            var asset = null;
            try {
                asset = AEV_Assets.getFresh("photo", TEXT_STAGE_HEIGHT, defaultPhotoPath(extensionPath));
                if (!asset) return null;
                trash.comps.push(asset);
                asset.duration = MAX_SPAN_SECONDS + 2;
                for (var ai = 1; ai <= asset.numLayers; ai++) {
                    try { asset.layer(ai).outPoint = MAX_SPAN_SECONDS + 2; } catch (eOut) {}
                }
                var layer = stage.layers.add(asset);
                layer.name = name;
                layer.property("ADBE Transform Group").property("ADBE Position")
                    .setValue([TEXT_STAGE_WIDTH / 2, TEXT_STAGE_HEIGHT / 2]);
                layer.property("ADBE Transform Group").property("ADBE Scale")
                    .setValue([TEXT_STAGE_WIDTH / TEXT_STAGE_HEIGHT * 100, TEXT_STAGE_WIDTH / TEXT_STAGE_HEIGHT * 100]);
                return layer;
            } catch (ePhoto) {
                return null;
            }
        }
        var bottom = addPhoto("creativeBase");
        if (bottom) bottom.moveToEnd();
        if (!bottom) {
            bottom = stage.layers.addSolid([0.12, 0.18, 0.22], "creativeBase", TEXT_STAGE_WIDTH, TEXT_STAGE_HEIGHT, 1);
            bottom.moveToEnd();
        }
        var top = addPhoto("creativeTarget");
        if (!top) top = stage.layers.addSolid([0.82, 0.24, 0.16], "creativeTarget", TEXT_STAGE_WIDTH, TEXT_STAGE_HEIGHT, 1);
        var nested = addStageToOutput(comp, stage, size);
        return {
            layer: nested,
            targets: [{ comp: stage, layer: top }],
            fallbackTargets: [{ comp: stage, layer: bottom }]
        };
    }

    /** 音频类预设没有视觉画面，生成稳定的波形占位图。 */
    function addWaveformStage(comp, size) {
        var bg = comp.layers.addSolid([0.04, 0.05, 0.06], "waveBg", size, size, 1);
        bg.moveToEnd();
        for (var i = 0; i < 24; i++) {
            var height = Math.max(4, Math.round(size * (0.12 + 0.58 * Math.abs(Math.sin(i * 1.37)))));
            var bar = comp.layers.addSolid(
                [0.34, 0.78, 0.64], "wave" + i,
                Math.max(2, Math.round(size * 0.022)), height, 1
            );
            bar.property("ADBE Transform Group").property("ADBE Position")
                .setValue([Math.round(size * (0.12 + i * 0.76 / 23)), Math.round(size * 0.5)]);
        }
        return bg;
    }

    /**
     * 渲染一个预设的预览。
     *
     * presetPath  .ffx 路径
     * sheetIndex  稳定编号（决定输出文件名 preset_<n>_####.png）
     * options     { extensionPath, previewRoot, background, cellSize, folder }
     */
    function renderJson(presetPath, sheetIndex, options) {
        var opts = options || {};
        var conf = config();
        var size = Number(opts.cellSize) || conf.contactSheet.cellSize || 720;
        var fps = Math.max(1, Number(opts.fps) || DEFAULT_FPS);
        var background = String(opts.background || "photo");
        var allowPlugins = !!opts.allowPlugins;
        var extensionPath = String(opts.extensionPath || "");
        var previewRoot = String(opts.previewRoot || "");
        var presetFolder = safeFolderName(opts.folder || ("preset_" + pad(sheetIndex, 3)));
        var file = new File(String(presetPath || ""));
        if (!file.exists) return result("error", [["reason", "no_preset"]]);
        if (!extensionPath) return result("error", [["reason", "no_extension_path"]]);
        var preset = presetInfo(presetPath);

        var folder = thumbDir(extensionPath, previewRoot, presetFolder);
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
            var re = new RegExp("^" + baseName + "_\\d{4}\\.(?:png|webp)$");
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

            var stageKind = preset.stageKind || "visual";
            var backgroundInfo = null;
            var effectiveBackground = background;
            if (stageKind === "text") background = "text";
            if (stageKind === "audio") {
                backgroundInfo = { layer: addWaveformStage(comp, size), targets: [] };
                effectiveBackground = "audio";
            } else if (stageKind === "shape") {
                backgroundInfo = addShapeStage(comp, size, trash, fps, sheetIndex);
                effectiveBackground = "shape";
            } else if (stageKind === "transition") {
                backgroundInfo = addTransitionStage(comp, size, trash, fps, sheetIndex, extensionPath);
                effectiveBackground = "transition";
            } else if (stageKind === "creative") {
                backgroundInfo = addCreativeStage(comp, size, trash, fps, sheetIndex, extensionPath);
                effectiveBackground = "creative";
            } else {
                // 非文本视觉预设默认使用高细节图片，不让用户残留的“文字”背景把效果挡掉。
                if (stageKind === "visual" && background === "text") background = "photo";
                backgroundInfo = addBackground(comp, background, size, trash, extensionPath, preset.textOnly);
            }
            var bgLayer = backgroundInfo && backgroundInfo.layer;
            if (!bgLayer) return result("error", [["reason", "bad_background"]]);
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
             * AE 自带文字预设按 1920x1080 设计。先在全尺寸透明舞台应用，
             * 再缩放到 360/720 方画布中央裁切；直接落到小画布会让路径和位移动出画面。
             */
            function applyOnTextStage() {
                var stage = app.project.items.addComp(
                    "DE_preset_text_stage_" + pad(sheetIndex, 3),
                    TEXT_STAGE_WIDTH, TEXT_STAGE_HEIGHT, 1, MAX_SPAN_SECONDS + 2, fps
                );
                trash.comps.push(stage);
                var layer = stage.layers.addText("Dream\rEngine");
                try {
                    var titleProp = layer.property("ADBE Text Properties").property("ADBE Text Document");
                    var titleDoc = titleProp.value;
                    titleDoc.fontSize = 300;
                    titleDoc.fillColor = [0.93, 0.94, 0.9];
                    titleProp.setValue(titleDoc);
                } catch (eStyle) {}
                stage.time = 0;
                selectOnly(stage, layer);
                var before = snapshot(stage);
                try {
                    layer.applyPreset(file);
                } catch (eApply) {
                    lastError = String(eApply);
                    attempts.push("textStage1920x1080|error|" + lastError);
                    return false;
                }
                var after = snapshot(stage);
                attempts.push("textStage1920x1080" +
                    "|effects+" + (after.effects - before.effects) +
                    "|expr+" + (after.expressions - before.expressions) +
                    "|keys+" + (after.allKeys - before.allKeys) +
                    "|animators+" + (after.textAnimators - before.textAnimators) +
                    "|masks+" + (after.masks - before.masks));
                if (!grew(before, after)) return false;
                recenterTextLayer(
                    stage, layer,
                    TEXT_STAGE_WIDTH / 2, TEXT_STAGE_HEIGHT / 2,
                    MAX_SPAN_SECONDS
                );
                var nested = comp.layers.add(stage);
                try {
                    var nestedTransform = nested.property("ADBE Transform Group");
                    nestedTransform.property("ADBE Position").setValue([size / 2, size / 2]);
                    var stageScale = size / TEXT_STAGE_HEIGHT * 100;
                    nestedTransform.property("ADBE Scale").setValue([stageScale, stageScale]);
                } catch (eNested) {}
                return true;
            }
            // 纯文本预设不产生效果，而且落在合成层上只会在蒙版上留半套结果
            //（实机：360 度循环落到合成层后 masks+1、keys 不变，被误判成「已应用」，
            //  最后只出一张静态图）。按 ffx 内容先把它直接落到文本层。

            if (stageKind === "audio") {
                applied = true;
            } else if (stageKind === "shape") {
                try {
                    applyToTargets(backgroundInfo.targets, file);
                    attempts.push("shapeStage|applied");
                    applied = true;
                } catch (eShapeApply) {
                    lastError = String(eShapeApply);
                    attempts.push("shapeStage|error|" + lastError);
                }
            } else if (stageKind === "text" || preset.textOnly) {
                applied = applyOnTextStage() === true;
            } else {
                applied = tryApply(backgroundInfo.targets, "targets:" + effectiveBackground);
                if (!applied && backgroundInfo.fallbackTargets && backgroundInfo.fallbackTargets.length) {
                    applied = tryApply(backgroundInfo.fallbackTargets, "fallback:" + effectiveBackground);
                }
                // 只有普通视觉类才回退到文字舞台；Shapes / 转场不能套文字目标。
                if (!applied && stageKind === "visual") {
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
            var expressionCount = snapshot(comp).expressions;
            var keyAnimated = range.keys > 0 && (range.max - range.min) > 1 / fps;
            // 表达式也会随时间变化，不能因为没有关键帧就只渲一帧。
            var expressionAnimated = expressionCount > 0;
            var shapeAnimated = stageKind === "shape";
            var animated = keyAnimated || expressionAnimated || shapeAnimated;
            var start = 0;
            var span = 1 / fps;
            var truncated = false;
            var keyStart = 0;
            var keyEnd = 0;
            if (shapeAnimated) {
                start = 0;
                keyStart = 0;
                keyEnd = Math.min(EXPRESSION_SPAN_SECONDS, MAX_SPAN_SECONDS);
                span = Math.max(1 / fps, keyEnd - start);
            } else if (keyAnimated) {
                start = range.min;
                keyStart = range.min;
                keyEnd = range.max;
                var end = Math.min(range.max, range.min + MAX_SPAN_SECONDS);
                truncated = range.max > end;
                span = Math.max(1 / fps, end - start);
            } else if (expressionAnimated) {
                start = 0;
                keyStart = 0;
                keyEnd = Math.min(EXPRESSION_SPAN_SECONDS, MAX_SPAN_SECONDS);
                span = Math.max(1 / fps, keyEnd - start);
            } else {
                keyStart = 0;
                keyEnd = 0;
            }

            // comp 必须覆盖到最后一个关键帧，否则超出的部分渲不出来
            try {
                comp.duration = Math.max(1 / fps, start + span + 1 / fps);
            } catch (eDur) {}

            var renderStart = Math.max(0, start);
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
            queueItem.timeSpanStart = renderStart;
            queueItem.timeSpanDuration = span;
            queueItem.render = false;
            queueItem.render = true;
            app.project.renderQueue.render();

            // 渲染队列按 6 fps 输出；6 秒最多保留 36 帧，避免被压缩成快放
            rawFiles = folder.getFiles(rawBase + "_*.png") || [];
            if (rawFiles.length === 0) {
                // AE 2023 偶尔会在模板队列第一次入队时不落文件；重建队列项重试一次。
                try { if (queueItem && ownsQueueItem) queueItem.remove(); } catch (eRetryRemove) {}
                queueItem = null;
                clearKeptFrames();
                queueItem = opts.targetQueueItem
                    ? opts.targetQueueItem.duplicate()
                    : app.project.renderQueue.items.add(comp);
                var retryOutputModule = queueItem.outputModule(1);
                if (!opts.targetQueueItem) {
                    var retryTemplate = applyPngTemplate(retryOutputModule);
                    if (!retryTemplate) return result("error", [["reason", "no_png_template"]]);
                }
                queueItem.render = true;
                retryOutputModule.file = new File(folder.fsName + "/" + rawBase + "_[####].png");
                queueItem.timeSpanStart = renderStart;
                queueItem.timeSpanDuration = span;
                queueItem.render = false;
                queueItem.render = true;
                app.project.renderQueue.render();
                rawFiles = folder.getFiles(rawBase + "_*.png") || [];
                if (rawFiles.length === 0) {
                    return result("error", [["reason", "no_frames"], ["retried", "true"]]);
                }
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
                ["folder", presetFolder],
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
