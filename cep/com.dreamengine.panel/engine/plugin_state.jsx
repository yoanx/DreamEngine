// ============================================================
// plugin_state.jsx —— 插件 L2 预览的纯状态逻辑（ES3，无 app 依赖）
//
// 为什么要单独一层：插件效果与内置效果混在同一张整网渲染会让 AE 进程
// 直接消失，脚本里 catch 不到。因此插件预览采用「每批 8 个、失败后逐条重试
// + 渲前写心跳 + 崩溃后拉黑 + 每条成功立即落索引」。这些规则如果只写在离线脚本里就没法
// 自动测；抽成不碰 AE 对象的纯函数后，Node 侧可以用 vm 直接跑断言。
//
// 本文件只处理字符串与数组，不读写文件、不调用 app：
//   · 心跳日志的「BEGIN 未配对 = 崩溃」判定
//   · 崩溃黑名单（TSV 给 ExtendScript 读 / JSON 给面板读）
//   · 独立 L2 索引（plugin_previews.tsv / plugin_manifest.json）
//
// 语法：ES3 only（ExtendScript 没有 JSON.parse、let/const、箭头函数）。
// ============================================================

var AEV_PluginState = (function () {
    var VERSION = 1;
    var ENTRY_HEADER = "matchName\tsheet\tframes\tframeTemplate\tplugin\tx\ty\tcolumns\twidth\theight\tduration\tfps\tpreviewVersion\tdisplayName\tpreviewKey";
    var BLACKLIST_HEADER = "matchName\treason";

    function jsonText(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        return '"' + out + '"';
    }

    function splitLines(text) {
        var raw = String(text === undefined || text === null ? "" : text);
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.substring(1);
        var parts = raw.split(/\r?\n/);
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            if (parts[i]) out.push(parts[i]);
        }
        return out;
    }

    function cells(line) {
        return String(line).split("\t");
    }

    /* ---------- 心跳日志 ---------- */

    function logLine(kind, name, extra) {
        return kind + "|" + name + "|" + String(extra === undefined ? "" : extra);
    }

    /**
     * 扫一遍历史日志，找出「写了 BEGIN 却没有 OK / FAIL / SKIP」的效果。
     * AE 进程被插件杀掉时，日志正好停在最后一条 BEGIN 上——那些就是元凶。
     */
    function parseLog(text) {
        var lines = splitLines(text);
        var pending = {};
        var order = [];
        for (var i = 0; i < lines.length; i++) {
            var p = String(lines[i]).split("|");
            var kind = p[0];
            var name = p[1] || "";
            if (!name) continue;
            if (kind === "BEGIN") {
                if (!pending[name]) order.push(name);
                pending[name] = true;
            } else if (kind === "OK" || kind === "FAIL" || kind === "SKIP") {
                delete pending[name];
            }
        }
        var crashed = [];
        for (var k = 0; k < order.length; k++) {
            if (pending[order[k]]) crashed.push(order[k]);
        }
        return { lines: lines, crashed: crashed };
    }

    /* ---------- 崩溃黑名单 ---------- */

    function readBlacklist(tsvText) {
        var map = {};
        var lines = splitLines(tsvText);
        for (var i = 0; i < lines.length; i++) {
            if (lines[i] === BLACKLIST_HEADER) continue;
            var p = cells(lines[i]);
            if (p[0]) map[p[0]] = p[1] || "crash";
        }
        return map;
    }

    function mergeBlacklist(map, names, reason) {
        var out = {};
        for (var key in map) {
            if (map.hasOwnProperty(key)) out[key] = map[key];
        }
        for (var i = 0; i < names.length; i++) {
            if (names[i]) out[names[i]] = reason || "crash";
        }
        return out;
    }

    /**
     * 从黑名单里移除若干 matchName，返回新对象（不修改入参）。
     * force 渲染成功后离线脚本用它把已渲好的条目移出黑名单。
     */
    function removeBlacklist(map, names) {
        var drop = {};
        for (var i = 0; i < names.length; i++) {
            if (names[i]) drop[names[i]] = true;
        }
        var out = {};
        for (var key in map) {
            if (map.hasOwnProperty(key) && !drop[key]) out[key] = map[key];
        }
        return out;
    }

    function blacklistTsv(map) {
        var lines = [BLACKLIST_HEADER];
        for (var key in map) {
            if (map.hasOwnProperty(key)) lines.push(key + "\t" + map[key]);
        }
        return lines.join("\r\n");
    }

    /** 面板读不了 TSV，另写一份 JSON；字段保持最小，方便 CEP 侧直接用 */
    function blacklistJson(map) {
        var items = [];
        for (var key in map) {
            if (map.hasOwnProperty(key)) {
                items.push('{"matchName":' + jsonText(key) +
                           ',"reason":' + jsonText(map[key]) + "}");
            }
        }
        return '{"version":' + VERSION + ',"items":[' + items.join(",") + "]}";
    }

    /* ---------- L2 独立索引 ---------- */

    function readEntries(tsvText) {
        var out = [];
        var lines = splitLines(tsvText);
        for (var i = 0; i < lines.length; i++) {
            if (lines[i] === ENTRY_HEADER) continue;
            var p = cells(lines[i]);
            if (p.length < 3 || !p[0]) continue;
            out.push({
                matchName: p[0],
                sheet: parseInt(p[1], 10) || 0,
                frames: parseInt(p[2], 10) || 1,
                frameTemplate: p[3] || "",
                plugin: p[4] || "其它插件",
                x: parseInt(p[5], 10) || 0,
                y: parseInt(p[6], 10) || 0,
                columns: parseInt(p[7], 10) || 1,
                width: parseInt(p[8], 10) || 0,
                height: parseInt(p[9], 10) || 0,
                duration: parseFloat(p[10]) || 0,
                fps: parseInt(p[11], 10) || 0,
                previewVersion: parseInt(p[12], 10) || 0,
                displayName: p[13] || "",
                previewKey: p[14] || ""
            });
        }
        return out;
    }

    function entriesTsv(entries) {
        var lines = [ENTRY_HEADER];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            lines.push([
                String(e.matchName).replace(/\t/g, " "),
                String(e.sheet),
                String(e.frames),
                e.frameTemplate || "",
                e.plugin || "其它插件",
                String(e.x || 0),
                String(e.y || 0),
                String(e.columns || 1),
                String(e.width || 0),
                String(e.height || 0),
                String(e.duration || 0),
                String(e.fps || 0),
                String(e.previewVersion || 0),
                String(e.displayName || "").replace(/\t/g, " "),
                String(e.previewKey || "").replace(/\t/g, " ")
            ].join("\t"));
        }
        return lines.join("\r\n");
    }

    /** 同名条目只允许有一条；重渲时替换而不是追加 */
    function addEntry(entries, item) {
        var out = [];
        var replaced = false;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].matchName === item.matchName ||
                    (item.previewKey && entries[i].previewKey === item.previewKey)) {
                out.push(item);
                replaced = true;
            } else {
                out.push(entries[i]);
            }
        }
        if (!replaced) out.push(item);
        out.sort(function (a, b) { return a.sheet - b.sheet; });
        return out;
    }

    /** 把 Node 生成器写进 manifest 的 WebP 字段带回下一轮索引。 */
    function mergePreviewFields(entries, previewItems) {
        var byName = {};
        for (var i = 0; i < (previewItems || []).length; i++) {
            var item = previewItems[i];
            if (item && item.matchName) byName[item.matchName] = item;
        }
        var out = [];
        for (var e = 0; e < entries.length; e++) {
            var entry = entries[e];
            var next = {};
            for (var key in entry) {
                if (entry.hasOwnProperty(key)) next[key] = entry[key];
            }
            var preview = byName[entry.matchName];
            if (preview) {
                if (preview.webpSrc) next.webpSrc = preview.webpSrc;
                if (preview.stillSrc) next.stillSrc = preview.stillSrc;
                if (preview.stillFrame !== undefined) next.stillFrame = preview.stillFrame;
            }
            out.push(next);
        }
        return out;
    }

    /**
     * 本次要渲的名单：跳过已有预览、黑名单，并限流。
     *
     * options（可选，旧调用不传时行为完全不变）：
     *   · force: true  —— 强制重渲：忽略 entries / blacklist，只跳过 skip
     *   · skip: {}     —— 本轮已处理过的 matchName（无论成功失败），避免无限重试
     */
    function planRun(todo, entries, blacklist, limit, options) {
        var opts = options || {};
        var force = !!(opts.force);
        var skip = opts.skip || {};
        var done = {};
        var doneKeys = {};
        for (var i = 0; i < entries.length; i++) {
            done[entries[i].matchName] = true;
            if (entries[i].previewKey) doneKeys[entries[i].previewKey] = true;
        }
        var out = [];
        var max = limit > 0 ? limit : todo.length;
        for (var t = 0; t < todo.length && out.length < max; t++) {
            var item = todo[t];
            if (!item || !item.matchName) continue;
            if (skip[item.matchName]) continue;
            if (!force) {
                if (done[item.matchName] ||
                        (item.previewKey && doneKeys[item.previewKey])) continue;
                if (blacklist && blacklist[item.matchName]) continue;
            }
            out.push({
                matchName: item.matchName,
                frames: item.frames || 6,
                plugin: item.plugin || "其它插件",
                displayName: item.displayName || item.matchName,
                previewKey: item.previewKey || ""
            });
        }
        return out;
    }

    /**
     * 当前插件清单相对已有索引/黑名单的总体进度。
     *
     * options.force 为 true 时改用「本轮强制渲染」的语义：
     * 忽略 entries / blacklist，total = todo.length，
     * done = skip 中属于 todo 的数量，pending = total - done。
     */
    function planStats(todo, entries, blacklist, options) {
        var opts = options || {};
        if (opts.force) {
            var skip = opts.skip || {};
            var forceTotal = 0;
            var forceDone = 0;
            for (var ft = 0; ft < todo.length; ft++) {
                var forceItem = todo[ft];
                var forceName = forceItem && forceItem.matchName ? forceItem.matchName : "";
                forceTotal++;
                if (forceName && skip[forceName]) forceDone++;
            }
            return {
                total: forceTotal,
                done: forceDone,
                blacklisted: 0,
                pending: Math.max(0, forceTotal - forceDone)
            };
        }
        var done = {};
        var doneKeys = {};
        var blocked = blacklist || {};
        var total = 0;
        var finished = 0;
        var blacklisted = 0;
        for (var i = 0; i < entries.length; i++) {
            done[entries[i].matchName] = true;
            if (entries[i].previewKey) doneKeys[entries[i].previewKey] = true;
        }
        for (var t = 0; t < todo.length; t++) {
            var item = todo[t];
            if (!item || !item.matchName) continue;
            total++;
            if (done[item.matchName] ||
                    (item.previewKey && doneKeys[item.previewKey])) finished++;
            else if (blocked[item.matchName]) blacklisted++;
        }
        return {
            total: total,
            done: finished,
            blacklisted: blacklisted,
            pending: Math.max(0, total - finished - blacklisted)
        };
    }

    /**
     * 拼面板用的独立索引。
     *
     * 插件图是 1×1 单格（720×720），不是 L1 的整网；每个条目都带上
     * slice* 布局字段，spriteSlice 才不会按整网参数切片。
     * 不能复用 item 的 width/height：L1 里那是「格子尺寸」，不是整图尺寸，
     * 拿它当整图会让 rows 算成 1，所有格位都被压到 (0,0)。
     */
    function buildManifest(entries, size) {
        var conf = size || {};
        var cellSize = conf.cellSize || 720;
        var columns = conf.columns || 1;
        var width = conf.width || cellSize * columns;
        var height = conf.height || cellSize * columns;

        var items = [];
        var seenSheets = {};
        var sheets = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var tmpl = e.frameTemplate || "";
            var firstFrame = tmpl ? tmpl.replace("%04d", "0000") : "";
            var itemColumns = e.columns || columns;
            var itemWidth = e.width || width;
            var itemHeight = e.height || height;
            var parts = ['"matchName":' + jsonText(e.matchName)];
            parts.push('"sheet":' + e.sheet);
            parts.push('"x":' + (e.x || 0) + ',"y":' + (e.y || 0));
            parts.push('"width":' + cellSize + ',"height":' + cellSize);
            parts.push('"frames":' + e.frames);
            parts.push('"duration":' + (Number(e.duration) || 1));
            parts.push('"fps":' + (parseInt(e.fps, 10) || 24));
            parts.push('"effectPreviewVersion":' + (parseInt(e.previewVersion, 10) || 0));
            parts.push('"sliceColumns":' + itemColumns + ',"sliceCellSize":' + cellSize);
            parts.push('"sliceWidth":' + itemWidth + ',"sliceHeight":' + itemHeight);
            parts.push('"plugin":' + jsonText(e.plugin || "其它插件"));
            if (e.displayName) parts.push('"displayName":' + jsonText(e.displayName));
            if (e.previewKey) parts.push('"previewKey":' + jsonText(e.previewKey));
            if (tmpl) parts.push('"frameSrc":' + jsonText(tmpl));
            if (firstFrame) parts.push('"src":' + jsonText(firstFrame));
            if (e.webpSrc) parts.push('"webpSrc":' + jsonText(e.webpSrc));
            if (e.stillSrc) parts.push('"stillSrc":' + jsonText(e.stillSrc));
            if (e.stillFrame !== undefined) parts.push('"stillFrame":' + parseInt(e.stillFrame, 10));
            items.push("{" + parts.join(",") + "}");

            if (!seenSheets[String(e.sheet)] && firstFrame) {
                seenSheets[String(e.sheet)] = true;
                sheets.push('{"index":' + e.sheet + ',"src":' +
                            jsonText(firstFrame) + ',"width":' + itemWidth +
                            ',"height":' + itemHeight + "}");
            }
        }
        // sheets 顺序无所谓：面板按 index 字段取，不按数组位置取
        return '{"version":' + VERSION + ',"cellSize":' + cellSize +
            ',"columns":' + columns + ',"width":' + width +
            ',"height":' + height + ',"sheets":[' + sheets.join(",") +
            '],"items":[' + items.join(",") + "]}";
    }

    return {
        VERSION: VERSION,
        jsonText: jsonText,
        logLine: logLine,
        parseLog: parseLog,
        readBlacklist: readBlacklist,
        mergeBlacklist: mergeBlacklist,
        removeBlacklist: removeBlacklist,
        blacklistTsv: blacklistTsv,
        blacklistJson: blacklistJson,
        readEntries: readEntries,
        entriesTsv: entriesTsv,
        addEntry: addEntry,
        mergePreviewFields: mergePreviewFields,
        planRun: planRun,
        planStats: planStats,
        buildManifest: buildManifest
    };
})();
