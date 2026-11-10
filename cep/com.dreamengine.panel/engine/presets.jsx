// ============================================================
// presets.jsx —— 预设库（M3）：扫描 .ffx、安全应用、依赖检查
//
// 依据 T0.4 / T0.6 的实机结论：
//   · 目录扫描必须递归（单层 getFiles("*.ffx") 返回 0），
//     AE 自带 Presets 目录 622 个 .ffx，递归约 742ms
//   · applyPreset 对图层类型不匹配时**静默无效**（不报错、也没效果）
//   · 没有选中层时 applyPreset 会自己新建图层
//   → 所以应用预设必须：清空选区、只选目标层；调用后比较
//     「效果数 / 含关键帧属性数 / 图层数」；按 solid→text→footage→adjustment
//     重试；把自动新建的图层用 remove() 删掉（不依赖撤销）。
//
// 语法：ES3 only。
// ============================================================

var AEV_Presets = (function () {
    var MAX_FILES = 1200;
    var MAX_DEPTH = 5;
    /* 试用的图层类型顺序：先纯色层（大多数效果预设都能落上去） */
    var LAYER_ORDER = ["solid", "text", "footage", "adjustment"];

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

    function isPresetFile(name) {
        var lower = String(name || "").toLowerCase();
        return lower.length > 4 && lower.lastIndexOf(".ffx") === lower.length - 4;
    }

    /** 递归收集 .ffx（单层扫描拿不到，必须递归——T0.6 实测） */
    function collect(folder, depth, out) {
        if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
        var entries = [];
        try {
            entries = folder.getFiles();
        } catch (e) {
            return;
        }
        for (var i = 0; i < entries.length; i++) {
            if (out.length >= MAX_FILES) return;
            var entry = entries[i];
            if (entry instanceof Folder) {
                collect(entry, depth + 1, out);
                continue;
            }
            if (!isPresetFile(entry.name)) continue;
            out.push({
                path: entry.fsName,
                name: String(entry.name).replace(/\.ffx$/i, ""),
                size: 0,
                folder: folder.fsName
            });
        }
    }

    /**
     * 预设的分类：取所在目录名（AE 自带预设按目录分门别类）。
     * 传文件路径或目录路径都支持。
     */
    function categoryOf(pathText) {
        var text = String(pathText || "");
        // 传的是文件路径时，先去掉文件名
        if (isPresetFile(text)) {
            var cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
            if (cut < 0) return "";
            text = text.substring(0, cut);
        }
        var cut2 = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
        if (cut2 < 0) return "";
        return text.substring(cut2 + 1);
    }

    /**
     * 扫描目录下的 .ffx。
     * 返回 {status, count, items:[{path,name,category,size}]}
     */
    function scanJson(rootPath, limit) {
        var folder = new Folder(String(rootPath || ""));
        if (!folder.exists) {
            return result("error", [["reason", "no_folder"], ["path", String(rootPath || "")]]);
        }
        var found = [];
        collect(folder, 0, found);
        var max = limit > 0 ? limit : found.length;
        var items = [];
        var counts = {};
        for (var i = 0; i < found.length && items.length < max; i++) {
            var item = found[i];
            var category = categoryOf(item.folder);
            counts[category] = (counts[category] || 0) + 1;
            items.push(
                '{"path":' + jsonText(item.path) +
                ',"name":' + jsonText(item.name) +
                ',"category":' + jsonText(category) + "}"
            );
        }
        var cats = [];
        for (var key in counts) {
            if (counts.hasOwnProperty(key)) {
                cats.push('{"name":' + jsonText(key) + ',"count":' + counts[key] + "}");
            }
        }
        return '{"status":"ok","count":' + items.length +
               ',"total":' + found.length +
               ',"categories":[' + cats.join(",") + '],"items":[' +
               items.join(",") + "]}";
    }

    /* 追踪文件：applyPreset 有可能把 AE 搞崩，崩了进程就没了，
       只能靠「崩之前写下的最后一步」定位。所以每步都追加写文件。 */
    var TRACE_FILE = "";

    function trace(text) {
        if (!TRACE_FILE) return;
        try {
            var f = new File(TRACE_FILE);
            f.encoding = "UTF-8";
            if (f.open("a")) {
                f.write(String(text) + "\r\n");
                f.close();
            }
        } catch (e) {}
    }

    function setTrace(path) {
        TRACE_FILE = String(path || "");
        return TRACE_FILE;
    }

    /**
     * 判断 item 是不是合成。
     *
     * 踩过的坑：AE 2021 的 `item.typeName` 是**本地化的**（中文 AE 返回「合成」，
     * 不是 "Composition"），所以不能拿它做字符串比较。改成看有没有 numLayers。
     */
    function isComp(item) {
        if (!item) return false;
        try {
            if (typeof CompItem !== "undefined" && item instanceof CompItem) return true;
        } catch (e) {}
        try {
            return typeof item.numLayers === "number";
        } catch (e2) {
            return false;
        }
    }

    /**
     * 按名字找合成。
     *
     * 不能用「按名字取 item」的 API —— 实测 AE 2021 上它会抛异常，
     * 甚至直接把 AE 进程带崩。改成遍历 items 自己找。
     * 另外 item.name 可能是 URL 编码形式（中文预设名实测是 %E4%B8%8B 这种），
     * 所以比较时两种都试。
     */
    function findComp(name) {
        var items = null;
        try {
            items = app.project.items;
        } catch (e) {
            return null;
        }
        for (var i = 1; i <= items.length; i++) {
            var item = null;
            try {
                item = items[i];
            } catch (e2) {
                continue;
            }
            if (!item) continue;
            var itemName = "";
            try {
                itemName = String(item.name || "");
            } catch (e3) {}
            var decoded = itemName;
            try {
                decoded = decodeURI(itemName);
            } catch (e4) {}
            if (name && (itemName === name || decoded === name) && isComp(item)) {
                return item;
            }
        }
        return null;
    }

    /** 合成当前状态快照：图层数 / 效果数 / 含关键帧的属性数 */
    function snapshot(comp) {
        var layers = 0, effects = 0, keyProps = 0;
        try {
            layers = comp.numLayers;
        } catch (e) {
            return { layers: 0, effects: 0, keyProps: 0 };
        }
        for (var i = 1; i <= layers; i++) {
            var layer = null;
            try {
                layer = comp.layer(i);
            } catch (e2) {
                continue;
            }
            if (!layer) continue;
            var parade = null;
            try {
                parade = layer.property("ADBE Effect Parade");
            } catch (e3) {
                continue;
            }
            if (!parade) continue;
            var count = 0;
            try {
                count = parade.numProperties;
            } catch (e4) {
                continue;
            }
            for (var e = 1; e <= count; e++) {
                effects++;
                var group = null;
                try {
                    group = parade.property(e);
                } catch (e5) {
                    continue;
                }
                if (!group) continue;
                var sub = 0;
                try {
                    sub = group.numProperties;
                } catch (e6) {
                    sub = 0;
                }
                for (var p = 1; p <= sub; p++) {
                    try {
                        var prop = group.property(p);
                        if (prop.numKeys && prop.numKeys > 0) keyProps++;
                    } catch (e7) {}
                }
            }
        }
        return { layers: layers, effects: effects, keyProps: keyProps };
    }

    /** 找到指定类型的图层；layerIndex >= 0 时优先用指定层 */
    function findLayer(comp, kind, layerIndex) {
        var total = 0;
        try {
            total = comp.numLayers;
        } catch (e) {
            return null;
        }
        if (layerIndex >= 1 && layerIndex <= total) {
            try {
                return comp.layer(layerIndex);
            } catch (e2) {}
        }
        for (var i = 1; i <= total; i++) {
            var layer = null;
            try {
                layer = comp.layer(i);
            } catch (e3) {
                continue;
            }
            if (!layer) continue;
            if (matchesKind(layer, kind)) return layer;
        }
        return null;
    }

    function sourceTypeOf(layer) {
        try {
            var source = layer.source;
            if (!source) return null;
            var main = source.mainSource;
            if (!main) return null;
            return main.sourceType;
        } catch (e) {
            return null;
        }
    }

    /* AE 2021 的 sourceType 数值（Scripting Guide）：
       FOOTAGE=1、SOLID=2、PLACEHOLDER=3、TEXT=4。
       枚举 SourceType 在部分版本里不可用，所以数值兜底、枚举优先。 */
    var TYPE_FOOTAGE = 1;
    var TYPE_SOLID = 2;

    function typeIs(type, enumName, fallback) {
        try {
            if (typeof SourceType !== "undefined" && SourceType && SourceType[enumName] !== undefined) {
                if (type === SourceType[enumName]) return true;
            }
        } catch (e) {}
        return type === fallback;
    }

    function matchesKind(layer, kind) {
        if (kind === "adjustment") {
            try {
                return !!layer.adjustmentLayer;
            } catch (e) {
                return false;
            }
        }
        // 文本层靠「有没有文本属性」判断，比 sourceType 可靠
        if (kind === "text") {
            try {
                return !!layer.property("ADBE Text Properties");
            } catch (e2) {
                return false;
            }
        }
        var type = sourceTypeOf(layer);
        if (type === null) return false;
        if (kind === "solid") return typeIs(type, "SOLID", TYPE_SOLID);
        if (kind === "footage") return typeIs(type, "FOOTAGE", TYPE_FOOTAGE);
        return false;
    }

    /** 候选顺序：普通图层优先，文本层其次，调整层最后（稳定排序） */
    function orderCandidates(layers) {
        var scored = [];
        for (var i = 0; i < layers.length; i++) {
            var score = 0;
            try {
                if (layers[i].adjustmentLayer) score = 2;
            } catch (e) {}
            if (score === 0) {
                try {
                    if (layers[i].property("ADBE Text Properties")) score = 1;
                } catch (e2) {}
            }
            scored.push({ layer: layers[i], score: score, index: i });
        }
        scored.sort(function (a, b) {
            if (a.score !== b.score) return a.score - b.score;
            return a.index - b.index;
        });
        var out = [];
        for (var j = 0; j < scored.length; j++) out.push(scored[j].layer);
        return out;
    }

    function layerName(layer) {
        try {
            return String(layer.name || "图层");
        } catch (e) {
            return "图层";
        }
    }

    /** 单层效果组里的效果数。回滚必须按这一层的增量算，不能用整份合成的总数。 */
    function paradeCount(layer) {
        var count = 0;
        try {
            var parade = layer.property("ADBE Effect Parade");
            if (parade) count = parade.numProperties;
        } catch (e) {}
        return count;
    }

    /**
     * 撤销一次「试探性」应用：把期间新增的效果与图层都清掉。
     *
     * 试探的目的只是找出「哪个图层吃下了预设」，真正的应用只做一次，
     * 否则每个候选层都会留一份预设（实测会污染整条图层链）。
     */
    function rollback(comp, target, before, after) {
        cleanupLayers(comp, before.layers);
        try {
            var parade = target.property("ADBE Effect Parade");
            if (parade) {
                /* before/after.layerEffects 是目标层自己的效果数（多图层时与
                   before/after.effects 的全局总数不同）；旧调用没有这两个字段时
                   才退回全局值——那只在单图层合成上成立。 */
                var from = (after && typeof after.layerEffects === "number")
                    ? after.layerEffects
                    : after.effects;
                var to = (before && typeof before.layerEffects === "number")
                    ? before.layerEffects
                    : before.effects;
                for (var i = from; i > to; i--) {
                    try {
                        parade.property(i).remove();
                    } catch (e) {}
                }
            }
        } catch (e2) {}
    }

    /**
     * 删掉调用期间自动新建的图层（从末尾往前删，避免索引错位） */
    function cleanupLayers(comp, beforeCount) {
        var total = 0;
        try {
            total = comp.numLayers;
        } catch (e) {
            return;
        }
        for (var i = total; i > beforeCount; i--) {
            try {
                comp.layer(i).remove();
            } catch (e2) {}
        }
    }

    /**
     * 安全应用预设。
     * compName   目标合成名
     * presetPath .ffx 路径
     * layerIndex 指定图层序号（>=1 时优先用它），否则按类型顺序试
     * 返回 {status, best:{kind,effects,keys}, attempts:[...]}
     */
    function applyJson(compName, presetPath, layerIndex) {
        var comp = findComp(String(compName || ""));
        if (!comp) {
            // 兜底：当前活动合成（面板的应用目标本来就是它）
            try {
                var active = app.project.activeItem;
                if (isComp(active)) comp = active;
            } catch (eActive) {}
        }
        if (!comp) {
            return result("error", [
                ["reason", "no_comp"],
                ["comp", String(compName || "")]
            ]);
        }
        var file = new File(String(presetPath || ""));
        if (!file.exists) {
            return result("error", [["reason", "no_preset"], ["path", String(presetPath || "")]]);
        }

        var attempts = [];
        var best = null;

        /**
         * 候选图层：指定序号优先，否则遍历全部图层。
         *
         * 原来按「图层类型」筛（solid→text→footage→adjustment），实测在 AE 2021
         * 上一个都找不到——纯色层的 sourceType 取不到（undefined），
         * 枚举 SourceType 也不可用。改成逐层试，用「效果数 / 关键帧数有没有
         * 增加」判断哪个层真的吃下了预设，这比猜类型可靠。
         */
        var candidates = [];
        var total = 0;
        try {
            total = comp.numLayers;
        } catch (eT) {
            total = 0;
        }
        if (layerIndex >= 1 && layerIndex <= total) {
            try {
                candidates.push(comp.layer(layerIndex));
            } catch (eL) {}
        } else {
            for (var ci = 1; ci <= total; ci++) {
                try {
                    candidates.push(comp.layer(ci));
                } catch (eC) {}
            }
        }
        candidates = orderCandidates(candidates);

        for (var i = 0; i < candidates.length; i++) {
            var target = candidates[i];
            var label = layerName(target);
            trace("apply:try:" + label);
            var before = snapshot(comp);
            before.layerEffects = paradeCount(target);
            trace("apply:before:" + before.effects + "/" + before.keyProps + "/" + before.layers);
            try {
                // 用 layer.selected = true 选层，**不要**给合成写 selectedLayers 数组：
                // 实测 AE 2021 上那样做会直接把 AE 弄崩
                // （追踪日志停在 before 之后、selected 之前）。
                for (var sl = 1; sl <= comp.numLayers; sl++) {
                    try {
                        comp.layer(sl).selected = false;
                    } catch (eUn) {}
                }
                target.selected = true;
                trace("apply:selected");
                // 用 **图层** 的 applyPreset，不是 应用级 applyPreset：
                // 实测 AE 2021 上 应用级的 applyPreset 调用 会直接把 AE 弄崩
                // （追踪日志停在 selected 之后），而 T0.4 验证过的写法是
                // layer.applyPreset(preset)。
                target.applyPreset(file);
                trace("apply:called");
            } catch (e) {
                trace("apply:error:" + e);
                attempts.push(label + "|error|" + e);
                cleanupLayers(comp, before.layers);
                continue;
            }
            var after = snapshot(comp);
            after.layerEffects = paradeCount(target);
            trace("apply:after:" + after.effects + "/" + after.keyProps + "/" + after.layers);
            var addedEffects = after.effects - before.effects;
            var addedKeys = after.keyProps - before.keyProps;
            var addedLayers = after.layers - before.layers;
            attempts.push(
                label + "|effects+" + addedEffects + "|keys+" + addedKeys + "|layers+" + addedLayers
            );
            if (addedEffects > 0 || addedKeys > 0) {
                var score = addedEffects * 10 + addedKeys * 3;
                if (!best || score > best.score) {
                    best = {
                        kind: label,
                        score: score,
                        effects: addedEffects,
                        keys: addedKeys,
                        layer: target
                    };
                }
            }
            // 试探完就还原，等选出最佳层再正式应用一次
            rollback(comp, target, before, after);
        }

        if (!best) {
            return '{"status":"no_effect","attempts":[' +
                jsonText(attempts.join(" ;; ")) + "]}";
        }

        // 正式应用：只在最佳的那一层上做一次。
        // 必须重新选中它 —— applyPreset 在没有选中层时会自己新建图层
        // （实测正式应用时多出一个「纯色 2」图层，效果还落在它上面）。
        var finalBefore = snapshot(comp);
        try {
            for (var fl = 1; fl <= comp.numLayers; fl++) {
                try {
                    comp.layer(fl).selected = false;
                } catch (eUn2) {}
            }
            best.layer.selected = true;
            best.layer.applyPreset(file);
        } catch (eFinal) {
            return '{"status":"error","reason":"apply_failed","detail":' +
                jsonText(String(eFinal)) + ',"attempts":[' +
                jsonText(attempts.join(" ;; ")) + "]}";
        }
        var finalAfter = snapshot(comp);
        return '{"status":"ok","best":{"kind":' + jsonText(best.kind) +
            ',"effects":' + (finalAfter.effects - finalBefore.effects) +
            ',"keys":' + (finalAfter.keyProps - finalBefore.keyProps) +
            '},"attempts":[' + jsonText(attempts.join(" ;; ")) + "]}";
    }

    /**
     * 依赖检查：列出合成各图层用到的效果 matchName，
     * 并标出本机没装的效果（插件缺失）。
     */
    function dependenciesJson(compName) {
        var comp = findComp(String(compName || ""));
        if (!comp) {
            try {
                var active = app.project.activeItem;
                if (isComp(active)) comp = active;
            } catch (eActive) {}
        }
        if (!comp) {
            return result("error", [["reason", "no_comp"]]);
        }
        var hasEffect = null;
        if (typeof AEV_Catalog !== "undefined") {
            try {
                hasEffect = AEV_Catalog.hasEffect;
            } catch (e0) {
                hasEffect = null;
            }
        }
        var layers = [];
        var missing = {};
        var total = 0;
        try {
            total = comp.numLayers;
        } catch (e3) {
            total = 0;
        }
        for (var l = 1; l <= total; l++) {
            var layer = null;
            try {
                layer = comp.layer(l);
            } catch (e4) {
                continue;
            }
            if (!layer) continue;
            var names = [];
            var parade = null;
            try {
                parade = layer.property("ADBE Effect Parade");
            } catch (e5) {
                parade = null;
            }
            if (parade) {
                var count = 0;
                try {
                    count = parade.numProperties;
                } catch (e6) {
                    count = 0;
                }
                for (var e = 1; e <= count; e++) {
                    var matchName = "";
                    try {
                        matchName = String(parade.property(e).matchName || "");
                    } catch (e7) {}
                    if (!matchName) continue;
                    names.push(jsonText(matchName));
                    if (hasEffect && !hasEffect(matchName)) missing[matchName] = true;
                }
            }
            layers.push(
                '{"index":' + l + ',"name":' + jsonText(layer.name) +
                ',"effects":[' + names.join(",") + "]}"
            );
        }
        var missingList = [];
        for (var key in missing) {
            if (missing.hasOwnProperty(key)) missingList.push(jsonText(key));
        }
        return '{"status":"ok","layers":[' + layers.join(",") +
               '],"missing":[' + missingList.join(",") + "]}";
    }

    /**
     * AE 内置预设目录的候选路径。
     *
     * 实测 AE 2021 里 **app.path 是 undefined**（网上常见的写法在这版不成立），
     * 所以改为「扫 Program Files\Adobe 下的 Adobe After Effects * 目录」，
     * 取其中的 Support Files\Presets；app.path 作为兜底也一并列出。
     */
    function discoverRoots() {
        var found = [];
        var bases = ["C:/Program Files/Adobe", "D:/Program Files/Adobe", "C:/Program Files (x86)/Adobe"];
        for (var b = 0; b < bases.length; b++) {
            var base = new Folder(bases[b]);
            if (!base.exists) continue;
            var entries = [];
            try {
                entries = base.getFiles();
            } catch (e) {
                continue;
            }
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                if (!(entry instanceof Folder)) continue;
                // 目录名在 ExtendScript 里可能是 URL 编码形式
                // （实测 "Adobe After Effects 2021" 返回 "Adobe%20After%20Effects%202021"），
                // 所以不按名字挑，直接看有没有 Support Files/Presets —— 命中就是 AE 安装目录。
                var paths = [entry.fsName];
                try {
                    paths.push(decodeURI(entry.fsName));
                } catch (e2) {}
                for (var p = 0; p < paths.length; p++) {
                    var presets = new Folder(paths[p] + "/Support Files/Presets");
                    if (presets.exists) {
                        found.push(presets.fsName);
                        break;
                    }
                }
            }
        }
        try {
            if (app.path) {
                var byApp = new Folder(app.path + "/Presets");
                if (byApp.exists) found.push(byApp.fsName);
            }
        } catch (e2) {}
        return found;
    }

    function defaultRootJson() {
        var candidates = discoverRoots();
        var items = [];
        for (var i = 0; i < candidates.length; i++) {
            items.push('{"path":' + jsonText(candidates[i]) + ',"exists":true}');
        }
        return '{"status":"ok","candidates":[' + items.join(",") + "]}";
    }

    /**
     * 当前上下文：活动合成名 + 选中图层序号。
     * 应用预设必须知道往哪个合成的哪一层上加（T0.4：没有选中层时
     * applyPreset 会自己新建图层，把工程弄脏）。
     */
    function contextJson() {
        var compName = "";
        var layerIndex = 0;
        try {
            var comp = app.project.activeItem;
            // AE 2021 的 typeName 是本地化的（「合成」），不能做字符串比较
            if (isComp(comp)) {
                compName = String(comp.name);
                var selected = null;
                try {
                    selected = comp.selectedLayers;
                } catch (e) {
                    selected = null;
                }
                if (selected && selected.length > 0) {
                    try {
                        layerIndex = selected[0].index;
                    } catch (e2) {
                        layerIndex = 0;
                    }
                } else {
                    // 兜底：遍历找 selected === true 的图层
                    try {
                        for (var li = 1; li <= comp.numLayers; li++) {
                            if (comp.layer(li).selected) {
                                layerIndex = li;
                                break;
                            }
                        }
                    } catch (e3) {}
                }
            }
        } catch (e3) {}
        return result("ok", [["comp", compName], ["layer", String(layerIndex)]]);
    }

    /* ---------- 用户自建预设库 ---------- */

    /** 预设库目录：我的文档/DreamEngine/presets */
    function libraryDir() {
        if (typeof AEV_Store !== "undefined") {
            try {
                var dir = AEV_Store.folderAt("presets");
                if (dir) {
                    if (!dir.exists) dir.create();
                    return dir;
                }
            } catch (e) {}
        }
        var fallback = new Folder(Folder.myDocuments.fsName + "/DreamEngine/presets");
        if (!fallback.exists) fallback.create();
        return fallback;
    }

    /** 预设的显示名：AE 返回的文件名是 URL 编码的（"%E5%A4%9C%E8%A7%86"），
     *  不解码的话面板上就是一串百分号。 */
    function displayName(name) {
        var text = String(name || "");
        try {
            text = decodeURI(text);
        } catch (e) {}
        return text.replace(/\.ffx$/i, "");
    }

    function pathKey(pathText) {
        return String(pathText || "").replace(/\\/g, "/").toLowerCase();
    }

    /** 读取 Hub 生成的 AE 外部预设索引；文件不存在或损坏时按空索引处理。 */
    function readExternalCatalog() {
        var file = new File(Folder.myDocuments.fsName + "/DreamEngineProbe/preset_catalog.json");
        if (!file.exists) return null;
        var text = "";
        try {
            file.encoding = "UTF-8";
            if (!file.open("r")) return null;
            text = String(file.read() || "").replace(/^\uFEFF/, "");
            file.close();
            var doc = eval("(" + text + ")");
            if (doc && doc.items instanceof Array) return doc;
        } catch (e) {}
        return null;
    }

    function presetJson(filePath, name, category, source, sourceKind, external) {
        return '{"path":' + jsonText(filePath) +
            ',"name":' + jsonText(name) +
            ',"category":' + jsonText(category) +
            ',"source":' + jsonText(source) +
            ',"sourceKind":' + jsonText(sourceKind) +
            ',"external":' + (external ? "true" : "false") + "}";
    }

    /** 列出库内的预设：用户库 + Hub 索引的 AE 外部预设，路径去重。 */
    function libraryJson() {
        var dir = libraryDir();
        var found = [];
        collect(dir, 0, found);
        var items = [];
        var seen = {};
        var externalCount = 0;

        function add(pathText, name, category, source, sourceKind, external) {
            var key = pathKey(pathText);
            if (!key || seen[key]) return;
            var file = new File(pathText);
            if (!file.exists || !isPresetFile(file.name)) return;
            seen[key] = true;
            if (external) externalCount++;
            items.push(presetJson(file.fsName, displayName(name || file.name),
                category || "", source || "", sourceKind || "library", external));
        }

        for (var i = 0; i < found.length; i++) {
            var item = found[i];
            add(item.path, item.name, categoryOf(item.folder), "", "library", false);
        }

        var catalog = readExternalCatalog();
        if (catalog) {
            for (var j = 0; j < catalog.items.length; j++) {
                var external = catalog.items[j];
                if (!external || !external.path) continue;
                add(external.path, external.name, external.source || categoryOf(external.path),
                    external.source || "", external.sourceKind || "install", true);
            }
        }

        return '{"status":"ok","count":' + items.length +
               ',"externalCount":' + externalCount +
               ',"folder":' + jsonText(dir.fsName) +
               ',"items":[' + items.join(",") + "]}";
    }

    /**
     * 删除用户预设库内的一个 .ffx。
     * 只允许操作 libraryDir() 下的文件，避免面板误删任意磁盘路径。
     */
    function deleteJson(pathText) {
        var file = new File(String(pathText || ""));
        if (!file.exists) return result("error", [["reason", "file_missing"]]);
        if (!isPresetFile(file.name)) return result("error", [["reason", "not_ffx"]]);

        var root = String(libraryDir().fsName || "").replace(/\\/g, "/").toLowerCase();
        var target = String(file.fsName || "").replace(/\\/g, "/").toLowerCase();
        if (!root || target.indexOf(root + "/") !== 0) {
            return result("error", [["reason", "outside_library"]]);
        }

        try {
            if (!file.remove()) return result("error", [["reason", "remove_failed"]]);
            return result("ok", [["path", String(pathText || "")]]);
        } catch (e) {
            return result("error", [["reason", String(e.toString())]]);
        }
    }

    return {
        scanJson: scanJson,
        applyJson: applyJson,
        dependenciesJson: dependenciesJson,
        defaultRootJson: defaultRootJson,
        contextJson: contextJson,
        libraryJson: libraryJson,
        deleteJson: deleteJson,
        libraryDir: libraryDir,
        isPresetFile: isPresetFile,
        categoryOf: categoryOf,
        setTrace: setTrace,
        MAX_FILES: MAX_FILES,
        LAYER_ORDER: LAYER_ORDER
    };
})();
