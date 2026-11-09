// ============================================================
// manual_probe.jsx -- Hub 手动调参的 AE 侧探针
//
// 复用真实预览路径 AEV_PreviewGen.renderBatch，并在 effect 创建后
// dump 参数树或按 effect_overrides.tsv 写入数值，再渲染一帧 PNG。
// 仅供 Hub 的“手动调参”任务使用；正常批量渲染仍走
// tools/run_plugin_preview.jsx。
//
// Modes:
//   dump      -- 只读取参数树，不渲染
//   fastdump  -- 单个效果，只读取参数树
//   multidump -- 批量读取参数树（目标列表来自 config.tsv 的 targetsFile）
//   verify    -- 应用 effect_overrides.tsv 后渲染一帧，用于和基线对比
//   baseline  -- 不写入，渲染一帧作为基线
//
// Output: <outDir>/probe.log, p0_dump.tsv, p0_status.txt, render_result.json
//         <outDir>/data/thumbs/batch_900_0000.png
//
// Config: %TEMP%/DreamEngineManual/config.tsv（由 manual_probe.ps1 写入）
// Syntax: ES3 only.
// ============================================================

(function manualProbe() {
    var BASE = Folder.temp.fsName + "/DreamEngineManual";
    var CONFIG_PATH = BASE + "/config.tsv";

    /* 本脚本的位置：<repo>/tools/manual_probe.jsx；用于 cfg 缺省时推导仓库根与模板 */
    var SCRIPT_DIR = "";
    var REPO_ROOT = "";
    try {
        var scriptFile = new File($.fileName);
        if (scriptFile && scriptFile.parent) {
            SCRIPT_DIR = scriptFile.parent.fsName;
            if (scriptFile.parent.parent) REPO_ROOT = scriptFile.parent.parent.fsName;
        }
    } catch (e) {
        SCRIPT_DIR = "";
        REPO_ROOT = "";
    }

    var status = {
        phase: "start",
        mode: "",
        target: "",
        leaves: 0,
        writes: 0,
        fails: 0,
        skips: 0,
        renderOk: 0,
        single: "",
        error: ""
    };

    function nowText() {
        var d = new Date();
        return String(d.getFullYear()) + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
            " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    }

    function pad2(n) {
        var s = String(n);
        return s.length < 2 ? "0" + s : s;
    }

    function readTextSafe(path) {
        var f = new File(path);
        if (!f.exists) return "";
        f.encoding = "UTF-8";
        if (!f.open("r")) return "";
        var text = f.read();
        f.close();
        return text;
    }

    function writeTextSafe(path, text) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("w")) return false;
        f.write(String(text));
        f.close();
        return true;
    }

    function appendLog(path, text) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("a")) return;
        f.write(String(text) + "\r\n");
        f.close();
    }

    function ensureFolder(path) {
        var folder = new Folder(path);
        if (!folder.exists) folder.create();
        return folder;
    }

    function clean(text) {
        return String(text === undefined || text === null ? "" : text)
            .replace(/\t/g, " ")
            .replace(/\r/g, " ")
            .replace(/\n/g, " ");
    }

    function parseConfig(text) {
        var out = {};
        var lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line || line.charAt(0) === "#") continue;
            var eq = line.indexOf("=");
            if (eq <= 0) continue;
            var key = line.substring(0, eq).replace(/^\s+|\s+$/g, "");
            var value = line.substring(eq + 1).replace(/^\s+|\s+$/g, "");
            if (key) out[key] = value;
        }
        return out;
    }

    var cfg = parseConfig(readTextSafe(CONFIG_PATH));
    var MODE = cfg.mode || "baseline";
    var TARGET = cfg.target || "";

    /* multidump 的目标列表由 PowerShell 侧决定：优先读 targetsFile（每行一个
       matchName），旧调用方仍可用 targets= 以 ; 或 | 分隔。 */
    function readTargetsFromConfig() {
        var out = [];
        var file = String(cfg.targetsFile || "").replace(/^\s+|\s+$/g, "");
        if (file) {
            var text = String(readTextSafe(file) || "").replace(/^\uFEFF/, "");
            var rows = text.split(/\r?\n/);
            for (var i = 0; i < rows.length; i++) {
                /* 目标行可能是 matchName<TAB>plugin<TAB>category，只取第一列 */
                var cells = rows[i].split("\t");
                var name = String(cells[0] || "").replace(/^\s+|\s+$/g, "");
                if (!name || name.charAt(0) === "#") continue;
                out.push(name);
            }
        }
        if (!out.length && cfg.targets) {
            var parts = String(cfg.targets).split(/[|;]/);
            for (var p = 0; p < parts.length; p++) {
                var fallback = parts[p].replace(/^\s+|\s+$/g, "");
                if (fallback) out.push(fallback);
            }
        }
        return out;
    }
    var MULTI_TARGETS = readTargetsFromConfig();
    var OUT = cfg.outDir || (BASE + "/results/_unknown");
    var MODULE_ROOT = cfg.moduleRoot || (REPO_ROOT ? REPO_ROOT + "/cep/com.dreamengine.panel" : "");

    ensureFolder(OUT);
    var LOG_PATH = OUT + "/probe.log";
    var DUMP_PATH = OUT + "/p0_dump.tsv";
    var STATUS_PATH = OUT + "/p0_status.txt";
    var RENDER_RESULT_PATH = OUT + "/render_result.json";

    status.mode = MODE;
    status.target = TARGET;

    function log(text) {
        appendLog(LOG_PATH, "[" + nowText() + "] " + text);
    }

    function writeStatus() {
        var lines = [
            "phase=" + status.phase,
            "mode=" + status.mode,
            "target=" + status.target,
            "leaves=" + status.leaves,
            "writes=" + status.writes,
            "fails=" + status.fails,
            "skips=" + status.skips,
            "renderOk=" + status.renderOk,
            "single=" + clean(status.single),
            "error=" + clean(status.error)
        ];
        writeTextSafe(STATUS_PATH, lines.join("\r\n"));
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

    function fatal(text) {
        status.phase = "fatal";
        status.error = String(text);
        writeStatus();
        log("FATAL|" + text);
        quitAe();
    }

    try {
        log("START|mode=" + MODE + "|target=" + TARGET + "|out=" + OUT);
        log("HOST|app.version=" + String(app.version) + "|project=" + String(app.project ? "yes" : "no"));
        writeStatus();

        if (MODE !== "multidump" && MODE !== "fastdump") {
            if (!MODULE_ROOT) {
                fatal("MODULE_ROOT_MISSING");
                return;
            }
            var MODULES = [
                "engine/render_config.jsx",
                "engine/store.jsx",
                "engine/assets.jsx",
                "engine/recipe.jsx",
                "engine/previewgen.jsx"
            ];
            for (var m = 0; m < MODULES.length; m++) {
                try {
                    $.evalFile(new File(MODULE_ROOT + "/" + MODULES[m]));
                } catch (eMod) {
                    fatal("MODULE_FAIL|" + MODULES[m] + "|" + eMod);
                    return;
                }
            }
            if (typeof AEV_PreviewGen === "undefined" || typeof AEV_Recipe === "undefined" ||
                typeof AEV_Assets === "undefined" || typeof AEV_Store === "undefined") {
                fatal("MODULE_MISSING");
                return;
            }

            var targetExists = false;
            try {
                for (var ei = 0; ei < app.effects.length; ei++) {
                    if (String(app.effects[ei].matchName || "") === TARGET) {
                        targetExists = true;
                        break;
                    }
                }
            } catch (eEffects) {}
            log("TARGET_EXISTS|" + (targetExists ? "1" : "0") + "|" + TARGET);
            if (!targetExists) {
                status.phase = "target_missing";
                writeStatus();
                quitAe();
                return;
            }

            /* Disable all automatic animation/writes so the only writes are ours. */
            AEV_Recipe.animate = function () { return false; };
            AEV_Recipe.animateAny = function () { return false; };
        }

        function typeName(prop) {
            var raw = "";
            try { raw = String(prop.propertyValueType); } catch (e0) {}
            try {
                if (raw === "OneD" || raw === "ONE_D" || raw === String(PropertyValueType.OneD)) return "OneD";
                if (raw === "TwoD" || raw === "TWO_D" || raw === String(PropertyValueType.TwoD)) return "TwoD";
                if (raw === "TwoD_Spatial" || raw === "TWO_D_SPATIAL" || raw === String(PropertyValueType.TwoD_SPATIAL)) return "TwoD_Spatial";
                if (raw === "ThreeD" || raw === "THREE_D" || raw === String(PropertyValueType.ThreeD)) return "ThreeD";
                if (raw === "ThreeD_Spatial" || raw === "THREE_D_SPATIAL" || raw === String(PropertyValueType.ThreeD_SPATIAL)) return "ThreeD_Spatial";
                if (raw === "Color" || raw === "COLOR" || raw === String(PropertyValueType.COLOR)) return "Color";
                if (raw === "Checkbox" || raw === "CHECKBOX" || raw === String(PropertyValueType.CHECKBOX)) return "Checkbox";
                if (raw === "LayerIndex" || raw === "LAYER_INDEX" || raw === String(PropertyValueType.LAYER_INDEX)) return "LayerIndex";
                if (raw === "MaskIndex" || raw === "MASK_INDEX" || raw === String(PropertyValueType.MASK_INDEX)) return "MaskIndex";
                if (raw === "Shape" || raw === "SHAPE" || raw === String(PropertyValueType.SHAPE)) return "Shape";
                if (raw === "TextDocument" || raw === "TEXT_DOCUMENT" || raw === String(PropertyValueType.TEXT_DOCUMENT)) return "TextDocument";
                if (raw === "Marker" || raw === "MARKER" || raw === String(PropertyValueType.MARKER)) return "Marker";
                if (raw === "Custom" || raw === "CUSTOM_VALUE" || raw === String(PropertyValueType.CUSTOM_VALUE)) return "Custom";
            } catch (e1) {}
            return "Other(" + raw + ")";
        }

        function valueToText(v) {
            if (v === null || v === undefined) return "";
            if (typeof v === "number" || typeof v === "boolean") return String(v);
            if (typeof v === "string") return v;
            if (v.length !== undefined) {
                var parts = [];
                for (var i = 0; i < v.length; i++) parts.push(String(v[i]));
                return "[" + parts.join(",") + "]";
            }
            return "[object]";
        }

        function cloneValue(v) {
            if (v === null || v === undefined) return v;
            if (typeof v !== "string" && v.length !== undefined) {
                var out = [];
                for (var i = 0; i < v.length; i++) out.push(v[i]);
                return out;
            }
            return v;
        }

        function sameValue(a, b) {
            if (a === b) return true;
            if (a === null || a === undefined || b === null || b === undefined) return false;
            if (typeof a === "number" && typeof b === "number") {
                if (isNaN(a) || isNaN(b)) return false;
                return Math.abs(a - b) <= 1e-6;
            }
            if (typeof a !== "string" && typeof b !== "string" &&
                a.length !== undefined && b.length !== undefined) {
                if (a.length !== b.length) return false;
                for (var i = 0; i < a.length; i++) {
                    if (!sameValue(a[i], b[i])) return false;
                }
                return true;
            }
            return false;
        }

        var AUX = [
            "mocha", "beat reactor", "audio", "face ml", "pixel chooser",
            "preset", "watch folder", "matte tool", "host", "help",
            "compare", "sampler", "project data", "docs"
        ];

        function isAux(names) {
            var text = String(names.join(" ")).toLowerCase();
            for (var i = 0; i < AUX.length; i++) {
                if (text.indexOf(AUX[i]) >= 0) return true;
            }
            return false;
        }

        function describeLeaf(prop, pathNames, pathIndices) {
            var leaf = {
                indexPath: pathIndices,
                path: pathNames,
                name: pathNames.length ? pathNames[pathNames.length - 1] : "",
                type: typeName(prop),
                typeRaw: "",
                canAnimate: false,
                hasMin: false,
                min: 0,
                hasMax: false,
                max: 0,
                value: null,
                valueText: "",
                aux: isAux(pathNames),
                safe: false,
                reason: ""
            };
            try { leaf.typeRaw = String(prop.propertyValueType); } catch (e0) {}
            try { leaf.canAnimate = !!prop.canVaryOverTime; } catch (e1) {}
            try {
                if (prop.hasMin) { leaf.hasMin = true; leaf.min = Number(prop.minValue); }
            } catch (e2) {}
            try {
                if (prop.hasMax) { leaf.hasMax = true; leaf.max = Number(prop.maxValue); }
            } catch (e3) {}
            try {
                leaf.value = prop.value;
                leaf.valueText = valueToText(leaf.value);
            } catch (e4) {
                leaf.reason = "value_read_fail";
                return leaf;
            }
            if (leaf.type === "OneD" && typeof leaf.value === "number" && isFinite(leaf.value)) {
                leaf.safe = true;
            } else if (leaf.type !== "OneD") {
                leaf.reason = "not_one_d";
            } else {
                leaf.reason = "non_numeric";
            }
            return leaf;
        }

        function collectLeaves(root) {
            var leaves = [];
            var budget = { count: 0 };
            function walk(group, pathNames, pathIndices, depth) {
                if (depth > 4 || budget.count >= 400) return;
                var total = 0;
                try { total = group.numProperties; } catch (eN) { return; }
                for (var i = 1; i <= total && budget.count < 400; i++) {
                    var prop = null;
                    try { prop = group.property(i); } catch (eP) { continue; }
                    if (!prop) continue;
                    var name = "";
                    try { name = String(prop.name || ""); } catch (eName) {}
                    var childCount = 0;
                    try { childCount = prop.numProperties || 0; } catch (eC) { childCount = 0; }
                    var nextNames = pathNames.concat([name]);
                    var nextIndices = pathIndices.concat([i]);
                    if (childCount > 0) {
                        walk(prop, nextNames, nextIndices, depth + 1);
                    } else {
                        budget.count++;
                        leaves.push(describeLeaf(prop, nextNames, nextIndices));
                    }
                }
            }
            walk(root, [], [], 0);
            return leaves;
        }

        function resolvePath(root, indexPath) {
            var node = root;
            for (var i = 0; i < indexPath.length; i++) {
                try {
                    node = node.property(indexPath[i]);
                } catch (e) {
                    return null;
                }
                if (!node) return null;
            }
            return node;
        }

        function safeLabel(text) {
            return String(text).replace(/[^A-Za-z0-9_.-]/g, "_");
        }

        function writeDump(leaves) {
            var lines = [
                "indexPath\tpath\tname\ttype\tvalue\tcanAnimate\thasMin\tmin\thasMax\tmax\taux\tsafe\treason"
            ];
            for (var i = 0; i < leaves.length; i++) {
                var l = leaves[i];
                lines.push([
                    l.indexPath.join("."),
                    clean(l.path.join(" / ")),
                    clean(l.name),
                    clean(l.type),
                    clean(l.valueText),
                    l.canAnimate ? "1" : "0",
                    l.hasMin ? "1" : "0",
                    String(l.min),
                    l.hasMax ? "1" : "0",
                    String(l.max),
                    l.aux ? "1" : "0",
                    l.safe ? "1" : "0",
                    clean(l.reason)
                ].join("\t"));
            }
            writeTextSafe(DUMP_PATH, lines.join("\r\n"));
            log("DUMP|leaves=" + leaves.length + "|path=" + DUMP_PATH);
        }

        if (MODE === "fastdump") {
            var fdComp = null;
            var fdLayer = null;
            var fdEffect = null;
            try {
                fdComp = app.project.items.addComp("P0_FASTDUMP_COMP", 128, 128, 1, 1, 30);
                fdLayer = fdComp.layers.addSolid([1, 1, 1], "P0_FASTDUMP", 128, 128, 1);
                fdEffect = fdLayer.property("ADBE Effect Parade").addProperty(TARGET);
                if (!fdEffect) throw new Error("addProperty returned null");
                var fdLeaves = collectLeaves(fdEffect);
                DUMP_PATH = OUT + "/p0_dump.tsv";
                writeDump(fdLeaves);
                status.leaves = fdLeaves.length;
                status.phase = "dump_done";
                writeStatus();
                log("FASTDUMP_DONE|target=" + TARGET + "|leaves=" + fdLeaves.length);
            } catch (eFd) {
                fatal("FASTDUMP|" + eFd);
                return;
            }
            if (fdEffect) { try { fdEffect.remove(); } catch (eFdEffect) {} }
            if (fdLayer) { try { fdLayer.remove(); } catch (eFdLayer) {} }
            if (fdComp) { try { fdComp.remove(); } catch (eFdComp) {} }
            quitAe();
            return;
        }

        if (MODE === "multidump") {
            if (!MULTI_TARGETS.length) {
                fatal("MULTIDUMP|no_targets");
                return;
            }
            var mdComp = null;
            var mdLayer = null;
            var mdLines = ["matchName\tleaves\tsafe\terror"];
            var mdTotal = 0;
            try {
                mdComp = app.project.items.addComp("P0_MULTI_COMP", 128, 128, 1, 1, 30);
                mdLayer = mdComp.layers.addSolid([1, 1, 1], "P0_MULTI", 128, 128, 1);
            } catch (eMdSetup) {
                fatal("MULTIDUMP|setup|" + eMdSetup);
                return;
            }
            for (var mt = 0; mt < MULTI_TARGETS.length; mt++) {
                var mdName = MULTI_TARGETS[mt];
                var mdSafe = safeLabel(mdName);
                var mdLeaves = 0;
                var mdError = "";
                var mdEffect = null;
                try {
                    mdEffect = mdLayer.property("ADBE Effect Parade").addProperty(mdName);
                    if (!mdEffect) throw new Error("addProperty returned null");
                    var mdLeavesList = collectLeaves(mdEffect);
                    mdLeaves = mdLeavesList.length;
                    mdTotal += mdLeaves;
                    var mdDir = new Folder(OUT + "/" + mdSafe);
                    ensureFolder(mdDir.fsName);
                    DUMP_PATH = mdDir.fsName + "/p0_dump.tsv";
                    writeDump(mdLeavesList);
                } catch (eMdDump) {
                    mdError = String(eMdDump).replace(/\t/g, " ");
                    log("MULTIDUMP_FAIL|" + mdName + "|" + mdError);
                }
                if (mdEffect) {
                    try { mdEffect.remove(); } catch (eMdRemove) {}
                }
                mdLines.push([
                    clean(mdName),
                    String(mdLeaves),
                    clean(mdSafe),
                    clean(mdError)
                ].join("\t"));
                log("MULTIDUMP|" + mdName + "|leaves=" + mdLeaves + "|error=" + mdError);
            }
            if (mdLayer) {
                try { mdLayer.remove(); } catch (eMdLayerRemove) {}
            }
            if (mdComp) {
                try { mdComp.remove(); } catch (eMdCompRemove) {}
            }
            writeTextSafe(OUT + "/multidump_summary.tsv", mdLines.join("\r\n"));
            status.leaves = mdTotal;
            status.phase = "render_done";
            status.renderOk = 1;
            writeStatus();
            log("MULTIDUMP_DONE|targets=" + MULTI_TARGETS.length +
                "|leaves=" + mdTotal + "|summary=" + OUT + "/multidump_summary.tsv");
            quitAe();
            return;
        }

        function writeLeaf(prop, leaf, isSingle) {
            var before = null;
            try { before = prop.value; } catch (eBefore) {}
            try {
                prop.setValue(cloneValue(leaf.value));
            } catch (eWrite) {
                log("WRITE_FAIL|" + leaf.indexPath.join(".") + "|" +
                    clean(leaf.path.join(" / ")) + "|" + clean(eWrite));
                return false;
            }
            var after = null;
            try { after = prop.value; } catch (eRead) {
                log("READBACK_FAIL|" + leaf.indexPath.join(".") + "|" + clean(eRead));
                return false;
            }
            if (!sameValue(after, leaf.value)) {
                log("VERIFY_FAIL|" + leaf.indexPath.join(".") + "|" +
                    clean(leaf.path.join(" / ")) + "|before=" + valueToText(before) +
                    "|after=" + valueToText(after) + "|want=" + leaf.valueText);
                try {
                    if (before !== null) prop.setValue(cloneValue(before));
                } catch (eRestore) {}
                return false;
            }
            log("WRITE_OK|" + leaf.indexPath.join(".") + "|" +
                clean(leaf.path.join(" / ")) + "|" + leaf.type + "|" + valueToText(leaf.value));
            if (isSingle) status.single = leaf.path.join(" / ") + "=" + valueToText(leaf.value);
            return true;
        }

        var SINGLE_NAME = cfg.singleName || "";
        var SINGLE_VALUE = (cfg.singleValue !== undefined && cfg.singleValue !== "")
            ? Number(cfg.singleValue) : null;

        function chooseSingle(leaves) {
            var best = null;
            var bestScore = -1;
            var fallback = null;
            var fallbackScore = -1;
            /* Most central parameters first. Ranges alone pick mask scale / frequency
               knobs that may not affect the visible result at frame 0. */
            var PRIORITY = [
                "强度", "发光强度", "辉光强度", "亮度", "发光半径",
                "中心半径", "半径", "不透明度", "应用强度",
                "glow", "intensity", "brightness", "radius", "width", "opacity", "strength", "amount"
            ];
            function priorityScore(name) {
                for (var p = 0; p < PRIORITY.length; p++) {
                    if (name.indexOf(PRIORITY[p]) >= 0) return 1000 - p * 10;
                }
                return 0;
            }
            for (var i = 0; i < leaves.length; i++) {
                var l = leaves[i];
                if (!l.safe || l.aux) continue;
                if (!l.hasMin || !l.hasMax) continue;
                var range = Number(l.max) - Number(l.min);
                if (!(range > 5) || !(range < 100000)) continue;
                var name = String(l.path.join(" ")).toLowerCase();
                var score = range + priorityScore(name) * 1000000000;
                if (score > fallbackScore) {
                    fallbackScore = score;
                    fallback = l;
                }
                if (SINGLE_NAME && name.indexOf(SINGLE_NAME.toLowerCase()) < 0) continue;
                if (score > bestScore) {
                    bestScore = score;
                    best = l;
                }
            }
            if (SINGLE_NAME && !best) {
                log("SINGLE_NAME_MISS|" + SINGLE_NAME);
            }
            return best || fallback;
        }

        /*
         * Twitch (Video Copilot) ships with every "Enable ..." option off, so a
         * default render is blank/no-op. Pick the first enable option and turn it
         * on; any one of them is enough to make the effect visible.
         */
        function chooseEnable(leaves) {
            var i;
            var l;
            var name;

            /* 1) Explicitly named enable leaves (some plugins expose a real group). */
            for (i = 0; i < leaves.length; i++) {
                l = leaves[i];
                name = String(l.path.join(" ")).toLowerCase();
                if (!/enable|enabled|启用|激活|使能|开启/.test(name)) continue;
                if (l.type === "OneD" && typeof l.value === "number" && isFinite(l.value)) {
                    return l;
                }
                if (l.type === "Checkbox" && typeof l.value === "boolean") {
                    return l;
                }
            }

            /*
             * 2) Twitch's custom "Enable" group header (Other(6412)) does not
             * expose its children via numProperties; the option toggles are the
             * following siblings: Blur / Color / Light / Scale / Slide / Time.
             */
            var enableAt = -1;
            for (i = 0; i < leaves.length; i++) {
                l = leaves[i];
                name = String(l.name || "").toLowerCase();
                if (name === "enable" || name === "enabled" || name === "启用") {
                    enableAt = i;
                    break;
                }
            }
            if (enableAt >= 0) {
                for (i = enableAt + 1; i < leaves.length; i++) {
                    l = leaves[i];
                    if (l.type === "Checkbox" && typeof l.value === "boolean") return l;
                    if (l.type === "OneD" && l.hasMin && l.hasMax &&
                        Number(l.min) === 0 && Number(l.max) === 1) {
                        return l;
                    }
                }
            }

            /* 3) Fallback: the first 0/1 toggle with a Twitch option name. */
            var preferred = ["blur", "color", "light", "scale", "slide", "time"];
            for (i = 0; i < leaves.length; i++) {
                l = leaves[i];
                if (!(l.type === "OneD" && l.hasMin && l.hasMax &&
                      Number(l.min) === 0 && Number(l.max) === 1)) continue;
                name = String(l.path.join(" ")).toLowerCase();
                for (var p = 0; p < preferred.length; p++) {
                    if (name === preferred[p] || name.indexOf(" " + preferred[p]) >= 0) {
                        return l;
                    }
                }
            }
            return null;
        }

        /* Intercept the shared recipe entry point. */
        var originalApply = AEV_Recipe.apply;
        AEV_Recipe.apply = function (effectGroup, matchName, cellSize) {
            if (MODE === "verify") {
                return originalApply(effectGroup, matchName, cellSize);
            }
            if (String(matchName) !== TARGET) {
                return originalApply(effectGroup, matchName, cellSize);
            }
            log("APPLY|" + matchName + "|mode=" + MODE);
            status.phase = "apply";
            writeStatus();

            if (MODE === "dump") {
                var dumpLeaves = collectLeaves(effectGroup);
                status.leaves = dumpLeaves.length;
                writeDump(dumpLeaves);
                status.phase = "dump_done";
                writeStatus();
                log("DUMP_ONLY|leaves=" + dumpLeaves.length);
                return { mode: "p0-dump", writes: 0 };
            }

            if (MODE === "baseline" || MODE === "baseline2") {
                status.phase = "baseline";
                writeStatus();
                return { mode: "p0-" + MODE, writes: 0 };
            }

            if (MODE === "keyframe") {
                /*
                 * AESweets Glitch 7in1: index 1 is an unnamed custom control
                 * (static write is a no-op and keyframing it breaks render).
                 * Use Position Random Seed (index 6) as the animatable
                 * Basic Blocks evolution stand-in for this diagnostic.
                 */
                var appliedProduct = originalApply(effectGroup, matchName, cellSize);
                var keyProp = resolvePath(effectGroup, [6]);
                if (!keyProp) {
                    log("KEYFRAME_NO_PROP|6");
                } else {
                    try {
                        keyProp.setValueAtTime(0, 1);
                        keyProp.setValueAtTime(0.5, 100);
                        log("KEYFRAME|6|0=1|0.5=100");
                    } catch (eKey) {
                        log("KEYFRAME_ERR|" + eKey);
                    }
                }
                return { mode: "override", writes: 2 };
            }

            var leaves = collectLeaves(effectGroup);
            status.leaves = leaves.length;
            writeDump(leaves);

            var writes = 0;
            var fails = 0;
            var skips = 0;

            if (MODE === "toggle") {
                var enableLeaf = chooseEnable(leaves);
                if (!enableLeaf) {
                    log("ENABLE_NONE");
                    skips = leaves.length;
                } else {
                    if (enableLeaf.type === "Checkbox") {
                        enableLeaf.value = true;
                        enableLeaf.valueText = "true";
                    } else {
                        enableLeaf.value = 1;
                        enableLeaf.valueText = "1";
                    }
                    log("ENABLE_TARGET|" + enableLeaf.indexPath.join(".") + "|" +
                        clean(enableLeaf.path.join(" / ")) + "|" + enableLeaf.type +
                        "|new=" + enableLeaf.valueText);
                    var enableProp = resolvePath(effectGroup, enableLeaf.indexPath);
                    if (!enableProp) {
                        fails++;
                        log("ENABLE_RESOLVE_FAIL|" + enableLeaf.indexPath.join("."));
                    } else if (writeLeaf(enableProp, enableLeaf, false)) {
                        writes++;
                    } else {
                        fails++;
                    }
                    skips = leaves.length - 1;
                }
            } else if (MODE === "single") {
                var chosen = chooseSingle(leaves);
                if (!chosen) {
                    log("SINGLE_NONE");
                    skips = leaves.length;
                } else {
                    var minValue = Number(chosen.min);
                    var maxValue = Number(chosen.max);
                    var oldValue = Number(chosen.value);
                    /* Move toward the far side of the range, never to 0/min/max:
                       an intensity set to 0 can legitimately produce an empty frame and
                       would look like a "write broke the effect" false positive. */
                    var newValue;
                    if (SINGLE_VALUE !== null && !isNaN(SINGLE_VALUE)) {
                        newValue = SINGLE_VALUE;
                        if (newValue < minValue) newValue = minValue;
                        if (newValue > maxValue) newValue = maxValue;
                    } else if (oldValue < maxValue) {
                        newValue = oldValue + (maxValue - oldValue) * 0.75;
                    } else {
                        newValue = oldValue - (oldValue - minValue) * 0.75;
                    }
                    if (Math.abs(oldValue - newValue) < (maxValue - minValue) * 0.05) {
                        newValue = oldValue + (maxValue - oldValue) * 0.5;
                    }
                    if (newValue === oldValue) {
                        newValue = minValue + (maxValue - minValue) * 0.75;
                    }
                    log("SINGLE_TARGET|" + chosen.indexPath.join(".") + "|" +
                        clean(chosen.path.join(" / ")) + "|old=" + oldValue +
                        "|new=" + newValue + "|min=" + minValue + "|max=" + maxValue);
                    chosen.value = newValue;
                    chosen.valueText = valueToText(newValue);
                    var singleProp = resolvePath(effectGroup, chosen.indexPath);
                    if (!singleProp) {
                        fails++;
                        log("SINGLE_RESOLVE_FAIL|" + chosen.indexPath.join("."));
                    } else if (writeLeaf(singleProp, chosen, true)) {
                        writes++;
                    } else {
                        fails++;
                    }
                    skips = leaves.length - 1;
                }
            } else {
                for (var i = 0; i < leaves.length; i++) {
                    var leaf = leaves[i];
                    if (!leaf.safe) { skips++; continue; }
                    if (MODE === "roundtrip_main" && leaf.aux) { skips++; continue; }
                    var prop = resolvePath(effectGroup, leaf.indexPath);
                    if (!prop) {
                        fails++;
                        log("RESOLVE_FAIL|" + leaf.indexPath.join("."));
                        continue;
                    }
                    if (writeLeaf(prop, leaf, false)) writes++;
                    else fails++;
                }
            }

            status.writes = writes;
            status.fails = fails;
            status.skips = skips;
            status.phase = "writes_done";
            writeStatus();
            log("WRITE_SUMMARY|writes=" + writes + "|fails=" + fails +
                "|skips=" + skips + "|leaves=" + leaves.length);
            return { mode: "p0-" + MODE, writes: writes };
        };

        /*
         * The project's plugin pipeline renders through the DreamEnginePNG.aep
         * template queue item (a PNG output module that exists even when AE's
         * visible output templates list is empty). Reuse the same path here.
         */
        var renderTemplateComp = null;
        var renderTemplateQueue = null;
        var TEMPLATE = cfg.template || (SCRIPT_DIR ? SCRIPT_DIR + "/DreamEnginePNG.aep" : "");
        try {
            var templateFile = new File(TEMPLATE);
            if (!templateFile.exists) {
                log("TEMPLATE_MISSING|" + TEMPLATE);
            } else {
                var opened = app.open(templateFile);
                if (!opened) {
                    log("TEMPLATE_OPEN_FAIL|" + TEMPLATE);
                } else {
                    for (var ti = 1; ti <= app.project.numItems; ti++) {
                        var tItem = null;
                        try { tItem = app.project.item(ti); } catch (eTi) { continue; }
                        if (tItem && String(tItem.name) === "DE_RENDER_TARGET") {
                            renderTemplateComp = tItem;
                            break;
                        }
                    }
                    if (renderTemplateComp) {
                        for (var tq = 1; tq <= app.project.renderQueue.numItems; tq++) {
                            var tQueue = null;
                            try { tQueue = app.project.renderQueue.item(tq); } catch (eTq) { continue; }
                            if (tQueue && tQueue.comp === renderTemplateComp) {
                                renderTemplateQueue = tQueue;
                                break;
                            }
                        }
                    }
                    log("TEMPLATE|" + TEMPLATE + "|comp=" + (renderTemplateComp ? "1" : "0") +
                        "|queue=" + (renderTemplateQueue ? "1" : "0"));
                    /*
                     * Critical: the template queue item itself must NOT render.
                     * Otherwise the first run writes C:\Windows\Temp\DreamEngine_template_0000.png
                     * and every later run blocks on "file exists, overwrite?".
                     * Mirror run_plugin_preview.jsx's openRenderTemplate().
                     */
                    if (renderTemplateQueue) {
                        try {
                            var runtimeRoot = new Folder(Folder.temp.fsName + "/DreamEnginePluginRunner");
                            if (!runtimeRoot.exists) runtimeRoot.create();
                            var templateOut = new Folder(runtimeRoot.fsName + "/template_out");
                            if (!templateOut.exists) templateOut.create();
                            var stale = templateOut.getFiles("template_render_*.png");
                            for (var si = 0; si < stale.length; si++) {
                                try { if (stale[si] instanceof File) stale[si].remove(); } catch (eStale) {}
                            }
                            var legacy = runtimeRoot.getFiles("template_render_*.png");
                            for (var li = 0; li < legacy.length; li++) {
                                try { if (legacy[li] instanceof File) legacy[li].remove(); } catch (eLegacy) {}
                            }
                            var templateOm = renderTemplateQueue.outputModule(1);
                            templateOm.file = new File(templateOut.fsName + "/template_render_[####].png");
                            renderTemplateQueue.timeSpanStart = 0;
                            renderTemplateQueue.timeSpanDuration = Math.max(
                                1 / renderTemplateComp.frameRate,
                                Number(renderTemplateComp.duration) || (1 / renderTemplateComp.frameRate)
                            );
                            renderTemplateQueue.render = false;
                            log("TEMPLATE_QUEUE|out=" + templateOut.fsName +
                                "/template_render_[####].png|render=0");
                        } catch (eTemplateQueue) {
                            log("TEMPLATE_QUEUE_ERR|" + eTemplateQueue);
                        }
                    }
                }
            }
        } catch (eTemplate) {
            log("TEMPLATE_ERR|" + eTemplate);
        }

        if (MODE === "multidump") {
            if (!MULTI_TARGETS.length) {
                fatal("MULTIDUMP|no_targets");
                return;
            }
            var mdComp = renderTemplateComp;
            if (!mdComp) {
                for (var mi = 1; mi <= app.project.numItems; mi++) {
                    var mdItem = null;
                    try { mdItem = app.project.item(mi); } catch (eMdItem) { continue; }
                    if (mdItem && String(mdItem.typeName) === "Composition") {
                        mdComp = mdItem;
                        break;
                    }
                }
            }
            if (!mdComp) {
                fatal("MULTIDUMP|no_composition");
                return;
            }
            var mdLayer = null;
            var mdLines = ["matchName\tleaves\tsafe\terror"];
            var mdTotal = 0;
            try {
                mdLayer = mdComp.layers.addSolid([1, 1, 1], "P0_MULTI", 128, 128, 1);
                for (var mt = 0; mt < MULTI_TARGETS.length; mt++) {
                    var mdName = MULTI_TARGETS[mt];
                    var mdSafe = safeLabel(mdName);
                    var mdLeaves = 0;
                    var mdError = "";
                    var mdEffect = null;
                    try {
                        mdEffect = mdLayer.property("ADBE Effect Parade").addProperty(mdName);
                        if (!mdEffect) throw new Error("addProperty returned null");
                        var mdLeavesList = collectLeaves(mdEffect);
                        mdLeaves = mdLeavesList.length;
                        mdTotal += mdLeaves;
                        var mdDir = new Folder(OUT + "/" + mdSafe);
                        ensureFolder(mdDir.fsName);
                        DUMP_PATH = mdDir.fsName + "/p0_dump.tsv";
                        writeDump(mdLeavesList);
                    } catch (eMdDump) {
                        mdError = String(eMdDump).replace(/\t/g, " ");
                        log("MULTIDUMP_FAIL|" + mdName + "|" + mdError);
                    }
                    if (mdEffect) {
                        try { mdEffect.remove(); } catch (eMdRemove) {}
                    }
                    mdLines.push([
                        clean(mdName),
                        String(mdLeaves),
                        clean(mdSafe),
                        clean(mdError)
                    ].join("\t"));
                    log("MULTIDUMP|" + mdName + "|leaves=" + mdLeaves +
                        "|error=" + mdError);
                }
            } finally {
                if (mdLayer) {
                    try { mdLayer.remove(); } catch (eMdLayerRemove) {}
                }
            }
            writeTextSafe(OUT + "/multidump_summary.tsv", mdLines.join("\r\n"));
            status.leaves = mdTotal;
            status.phase = "render_done";
            status.renderOk = 1;
            writeStatus();
            log("MULTIDUMP_DONE|targets=" + MULTI_TARGETS.length +
                "|leaves=" + mdTotal + "|summary=" + OUT + "/multidump_summary.tsv");
            quitAe();
            return;
        }

        status.phase = "render_start";
        writeStatus();

        var raw = "";
        try {
            raw = AEV_PreviewGen.renderBatch([TARGET], 900, {
                outputRoot: "extension",
                extensionPath: OUT,
                singleCell: true,
                frames: (MODE === "keyframe" ? 15 : 1),
                freshAssets: true,
                background: "",
                targetComp: renderTemplateComp,
                targetQueueItem: renderTemplateQueue
            });
        } catch (eRender) {
            raw = '{"status":"error","reason":"throw:' +
                String(eRender).replace(/"/g, "'") + '"}';
        }
        writeTextSafe(RENDER_RESULT_PATH, raw);
        log("RENDER|" + raw);
        status.renderOk = raw.indexOf('"status":"ok"') >= 0 ? 1 : 0;
        status.phase = "render_done";
        writeStatus();
        log("DONE|phase=" + status.phase + "|renderOk=" + status.renderOk);
        quitAe();
    } catch (eOuter) {
        fatal("OUTER|" + eOuter);
    }
})();
