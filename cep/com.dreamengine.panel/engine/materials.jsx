/* ============================================================
 * materials.jsx —— 素材目录索引与导入
 *
 * 职责：
 *   · 分类视频 / 图片 / 音频 / 工程 / 脚本
 *   · 扫描唯一素材根目录，生成 TSV（ExtendScript 权威）和 JSON（CEP）
 *   · 生成不兼容媒体的一次性预览（音频波形由 CEP 面板用 Web Audio 生成）
 *   · 双击卡片时导入素材，并把媒体添加到当前合成的时间指示器位置
 *
 * 语法：ES3 only。
 * ============================================================ */

var AEV_Materials = (function () {
    var VERSION = 1;
    var HEADER = "path\tname\ttype\textension\tsize\tmodifiedAt\texists";

    var VIDEO_EXT = ".mp4 .mov .avi .mkv .webm .m4v .mxf";
    var IMAGE_EXT = ".png .jpg .jpeg .webp .gif .bmp .tif .tiff";
    var AUDIO_EXT = ".wav .mp3 .aac .m4a .flac .ogg";
    var SCRIPT_EXT = ".jsx .jsxbin";

    function extensionOf(name) {
        var value = String(name || "").toLowerCase();
        var at = value.lastIndexOf(".");
        return at >= 0 ? value.substring(at) : "";
    }

    /** ExtendScript may return File.name as a URL-encoded string. */
    function displayName(name) {
        var text = String(name || "");
        try {
            return decodeURI(text);
        } catch (e) {
            return text;
        }
    }

    function classify(name) {
        var ext = extensionOf(name);
        if ((" " + VIDEO_EXT + " ").indexOf(" " + ext + " ") >= 0) return "video";
        if ((" " + IMAGE_EXT + " ").indexOf(" " + ext + " ") >= 0) return "image";
        if ((" " + AUDIO_EXT + " ").indexOf(" " + ext + " ") >= 0) return "audio";
        if (ext === ".aep") return "project";
        if ((" " + SCRIPT_EXT + " ").indexOf(" " + ext + " ") >= 0) return "script";
        return "";
    }

    function jsonString(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        return '"' + out + '"';
    }

    function parseTsv(text) {
        var rows = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
        var out = [];
        for (var i = 1; i < rows.length; i++) {
            if (!rows[i]) continue;
            var cells = rows[i].split("\t");
            if (cells.length < 7) continue;
            out.push({
                path: cells[0],
                name: cells[1],
                type: cells[2],
                extension: cells[3],
                size: Number(cells[4]) || 0,
                modifiedAt: Number(cells[5]) || 0,
                exists: cells[6] === "true"
            });
        }
        return out;
    }

    function parseRoot(text) {
        var rows = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
        for (var i = 0; i < rows.length; i++) {
            var cells = rows[i].split("\t");
            if (cells[0] === "#ROOT" && cells[1]) {
                return cells[1].replace(/\\/g, "/").replace(/\/+$/, "");
            }
        }
        return "";
    }

    function sameRoot(a, b) {
        return String(a || "").toLowerCase() === String(b || "").toLowerCase();
    }

    function mergeMissing(oldItems, currentItems) {
        var seen = {};
        for (var i = 0; i < currentItems.length; i++) {
            seen[String(currentItems[i].path).toLowerCase()] = true;
        }
        for (var j = 0; j < oldItems.length; j++) {
            var key = String(oldItems[j].path).toLowerCase();
            if (seen[key]) continue;
            oldItems[j].exists = false;
            currentItems.push(oldItems[j]);
            seen[key] = true;
        }
    }

    function rowToJson(row) {
        var out = "{" +
            '"path":' + jsonString(row.path) + "," +
            '"name":' + jsonString(row.name) + "," +
            '"type":' + jsonString(row.type) + "," +
            '"extension":' + jsonString(row.extension) + "," +
            '"size":' + Number(row.size || 0) + "," +
            '"modifiedAt":' + Number(row.modifiedAt || 0) + "," +
            '"exists":' + (row.exists ? "true" : "false") +
            "";
        if (row.waveform) out += ',"waveform":' + jsonString(row.waveform);
        if (row.videoPreview) out += ',"videoPreview":' + jsonString(row.videoPreview);
        if (row.imageThumb) out += ',"imageThumb":' + jsonString(row.imageThumb);
        if (row.previewKey) out += ',"previewKey":' + jsonString(row.previewKey);
        return out + "}";
    }

    function cacheKey(path, size, modifiedAt, kind) {
        var text = String(path) + "|" + Number(size || 0) + "|" +
            Number(modifiedAt || 0) + "|" + String(kind);
        var hash = 5381;
        for (var i = 0; i < text.length; i++) {
            hash = ((hash << 5) + hash) + text.charCodeAt(i);
            hash = hash & 0x7fffffff;
        }
        return hash.toString(16);
    }

    function quoteArg(value) {
        return '"' + String(value).replace(/"/g, '\\"') + '"';
    }

    function ensureParent(absPath) {
        var at = String(absPath).lastIndexOf("/");
        if (at < 0) return true;
        var folder = new Folder(String(absPath).substring(0, at));
        if (folder.exists) return true;
        return folder.create();
    }

    function commandOutput(command) {
        try {
            if (typeof system !== "undefined" && system.callSystem) return system.callSystem(command);
        } catch (e) {}
        return "";
    }

    function findFfmpeg() {
        var configured = "";
        try {
            if (typeof AEV_Store !== "undefined") {
                configured = AEV_Store.readText("materials/ffmpeg.txt").replace(/^\s+|\s+$/g, "");
            }
        } catch (e0) {}
        if (configured && new File(configured).exists) return configured;

        var fromPath = commandOutput("where ffmpeg");
        var lines = String(fromPath || "").split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var candidate = lines[i].replace(/^\s+|\s+$/g, "");
            if (candidate && new File(candidate).exists) return candidate;
        }
        var candidates = [
            "C:/Users/31371/tools/ffmpeg/bin/ffmpeg.exe",
            "C:/ffmpeg/bin/ffmpeg.exe",
            "D:/ffmpeg/bin/ffmpeg.exe",
            "C:/Program Files/ffmpeg/bin/ffmpeg.exe"
        ];
        for (var j = 0; j < candidates.length; j++) {
            if (new File(candidates[j]).exists) return candidates[j];
        }
        return "";
    }

    function makePreview(item, kind, extension, filter, ffmpeg) {
        if (!ffmpeg) return "";
        var key = cacheKey(item.path, item.size, item.modifiedAt, kind);
        var rel = "materials/" + kind + "/" + key + extension;
        var abs = AEV_Store.resolve(rel);
        if (!abs) return "";
        abs = String(abs).replace(/\\/g, "/");
        if (new File(abs).exists) return abs;
        if (!ensureParent(abs)) return "";
        var command = quoteArg(ffmpeg) + " -y -i " + quoteArg(item.path) + " " + filter + " " + quoteArg(abs);
        commandOutput(command);
        return new File(abs).exists ? abs : "";
    }

    function enrichPreview(item, ffmpeg) {
        var ext = item.extension;
        if (item.type === "video" &&
                   (" .mp4 .webm .m4v ").indexOf(" " + ext + " ") < 0) {
            item.videoPreview = makePreview(item, "video-previews", ".mp4",
                '-t 2 -vf "scale=480:-2" -an -c:v libx264 -pix_fmt yuv420p', ffmpeg);
        } else if (item.type === "image" &&
                   (" .tif .tiff .bmp ").indexOf(" " + ext + " ") >= 0) {
            item.imageThumb = makePreview(item, "image-thumbs", ".png",
                '-vf "scale=480:-1" -frames:v 1', ffmpeg);
        }
        if (item.videoPreview || item.imageThumb) {
            item.previewKey = cacheKey(item.path, item.size, item.modifiedAt, "preview");
        }
    }

    function pad2(value) {
        return value < 10 ? "0" + value : String(value);
    }

    function isoNow() {
        var d = new Date();
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
            "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    }

    function scanFolder(folder, items, errors, visited) {
        var key = folder.fsName.toLowerCase();
        if (visited[key]) return;
        visited[key] = true;

        var entries;
        try {
            entries = folder.getFiles("*");
        } catch (eList) {
            errors.push("READ_FAIL:" + folder.fsName + ":" + eList.toString());
            return;
        }
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry instanceof Folder) {
                scanFolder(entry, items, errors, visited);
                continue;
            }
            var entryName = displayName(entry.name);
            var type = classify(entryName);
            if (!type) continue;
            try {
                items.push({
                    path: String(entry.fsName).replace(/\\/g, "/"),
                    name: entryName,
                    type: type,
                    extension: extensionOf(entryName),
                    size: Number(entry.length) || 0,
                    modifiedAt: entry.modified ? entry.modified.getTime() : 0,
                    exists: !!entry.exists
                });
            } catch (eFile) {
                errors.push("READ_FAIL:" + entry.fsName + ":" + eFile.toString());
            }
        }
    }

    function tsvText(rootPath, items) {
        var rows = [HEADER, "#ROOT\t" + rootPath.replace(/\\/g, "/")];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            rows.push([
                item.path,
                item.name,
                item.type,
                item.extension,
                item.size,
                item.modifiedAt,
                item.exists ? "true" : "false"
            ].join("\t"));
        }
        return rows.join("\r\n");
    }

    function indexJsonText(rootPath, scannedAt, items) {
        var jsonItems = [];
        for (var i = 0; i < items.length; i++) jsonItems.push(rowToJson(items[i]));
        return "{" +
            '"version":' + VERSION + "," +
            '"root":' + jsonString(rootPath.replace(/\\/g, "/")) + "," +
            '"scannedAt":' + jsonString(scannedAt) + "," +
            '"count":' + items.length + "," +
            '"items":[' + jsonItems.join(",") + "]}";
    }

    function scanJson(rootPath) {
        var normalized = String(rootPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
        if (!normalized) return '{"status":"error","reason":"root_missing"}';
        var root = new Folder(normalized);
        if (!root.exists) return '{"status":"error","reason":"root_missing"}';

        var oldText = AEV_Store.readText("materials/index.tsv");
        var oldRoot = parseRoot(oldText);
        var items = [];
        var errors = [];
        scanFolder(root, items, errors, {});
        if (sameRoot(oldRoot, normalized)) mergeMissing(parseTsv(oldText), items);
        var ffmpeg = findFfmpeg();
        for (var ei = 0; ei < items.length; ei++) {
            if (items[ei].exists) enrichPreview(items[ei], ffmpeg);
        }
        items.sort(function (a, b) {
            return a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1;
        });
        var scannedAt = isoNow();
        var tsv = tsvText(normalized, items);
        var json = indexJsonText(normalized, scannedAt, items);
        AEV_Store.writeText("materials/index.tsv", tsv);
        AEV_Store.writeText("materials/index.json", json);

        return "{" +
            '"status":"ok",' +
            '"root":' + jsonString(normalized) + "," +
            '"scannedAt":' + jsonString(scannedAt) + "," +
            '"count":' + items.length + "," +
            '"errors":' + jsonString(errors.join("\n")) + "," +
            '"items":[' + (function () {
                var out = [];
                for (var i = 0; i < items.length; i++) out.push(rowToJson(items[i]));
                return out.join(",");
            })() + "]}";
    }

    function indexJson() {
        var text = AEV_Store.readText("materials/index.json");
        if (text) return text;
        return '{"version":1,"root":"","scannedAt":"","count":0,"items":[]}';
    }

    function pickRootJson() {
        var selected = Folder.selectDialog("选择 DreamEngine 素材根目录");
        if (!selected) return '{"status":"cancelled"}';
        return scanJson(selected.fsName);
    }

    function samePath(a, b) {
        return String(a || "").replace(/\\/g, "/").toLowerCase() ===
            String(b || "").replace(/\\/g, "/").toLowerCase();
    }

    function findProjectItem(path) {
        if (!app || !app.project || !app.project.items) return null;
        var items = app.project.items;
        for (var i = 1; i <= items.length; i++) {
            var item = items[i];
            try {
                if (item && item.file && samePath(item.file.fsName, path)) return item;
            } catch (e) {}
        }
        return null;
    }

    function selectOnlyLayer(comp, target) {
        try {
            for (var i = 1; i <= comp.layers.length; i++) {
                var layer = comp.layer(i);
                if (layer) layer.selected = false;
            }
        } catch (eClear) {}
        try {
            target.selected = true;
        } catch (eSelect) {}
    }

    /**
     * 双击素材：先保证项目里只有一份，再把视频/图片/音频放到当前合成
     * 的时间指示器位置。.aep 没有可添加的素材内容，只导入项目。
     */
    function importJson(path, type) {
        if (!app || !app.project) return '{"status":"error","reason":"no_project"}';
        var file = new File(path);
        if (!file.exists) return '{"status":"error","reason":"file_missing"}';
        try {
            var item = findProjectItem(path);
            if (!item) item = app.project.importFile(new ImportOptions(file));
            if (item) {
                try { item.selected = true; } catch (eSelect) {}
            }
            if (!item) return '{"status":"error","reason":"import_failed"}';

            var kind = String(type || "");
            if (!kind) {
                if (extensionOf(file.name) === ".aep") kind = "project";
                else if (classify(file.name)) kind = classify(file.name);
            }
            if (kind === "project" || extensionOf(file.name) === ".aep") {
                return '{"status":"ok","kind":"project"}';
            }

            var comp = app.project.activeItem;
            if (!comp || !(comp instanceof CompItem)) {
                return '{"status":"error","reason":"no_comp"}';
            }
            var layer = comp.layers.add(item);
            if (!layer) return '{"status":"error","reason":"add_layer_failed"}';
            var at = Number(comp.time) || 0;
            layer.startTime = at;
            try {
                if (layer.outPoint > comp.duration) layer.outPoint = comp.duration;
            } catch (eOut) {}
            selectOnlyLayer(comp, layer);
            return '{"status":"ok","kind":"layer","time":' + at + '}';
        } catch (eImport) {
            return '{"status":"error","reason":' + jsonString(eImport.toString()) + "}";
        }
    }

    return {
        VERSION: VERSION,
        classify: classify,
        extensionOf: extensionOf,
        indexHeader: function () { return HEADER; },
        parseTsv: parseTsv,
        rowToJson: rowToJson,
        jsonString: jsonString,
        cacheKey: cacheKey,
        findFfmpeg: findFfmpeg,
        scanJson: scanJson,
        indexJson: indexJson,
        pickRootJson: pickRootJson,
        importJson: importJson
    };
})();
