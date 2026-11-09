// ============================================================
// recipe.jsx —— 演示配方与启发式兜底
//
// 分两层：
//   1. 显式配方（RECIPES）：已经目视确认过"看得出名堂"的效果，按 matchName 写死参数
//   2. 启发式兜底（applyHeuristics）：没有配方的效果，按 propertyValueType 生成演示值
//
// 启发式的设计原则是「保守」而不是「激进」：
//   AE 的参数名与语义千差万别，把每个数值属性都拉到中值会让大量效果变糊、
//   变黑或直接看不出原貌。因此只处理四类语义明确的属性，并且每个效果
//   最多写 MAX_WRITES 次，宁可看着"变化不明显"也不要把效果改坏。
//
// 语法：ES3 only。
// ============================================================

var AEV_Recipe = (function () {
    var MAX_WRITES = 6;
    var MAX_DEPTH = 3;
    var PRESENTATION_TIME_RATIO = 0.5;
    /** 配方版本：改配方语义时 +1，所有缓存随之失效 */
    var RECIPE_VERSION = 5;

    /** 表达式控件族与音频族的分类名（中英文都要认，汉化版分类名是中文） */
    var NO_PREVIEW_CATEGORIES = [
        "expression controls", "表达式控制",
        "audio", "音频"
    ];

    /** 显式配方：matchName -> [{names:[...], value:...}]
     *  参数名以 tools/dump_param_trees.jsx 从本机导出的真实名字为准（中文界面下是中文），
     *  同时并列英文名以兼容英文版 AE。不是猜的。
     */
    var RECIPES = {
        "ADBE Gaussian Blur 2": [{ names: ["模糊度", "Blurriness"], value: 12 }],
        "ADBE Box Blur2": [
            { names: ["模糊半径", "Blur Radius"], value: 12 },
            { names: ["迭代", "Iterations"], value: 3 }
        ],
        "ADBE Radial Blur": [
            { names: ["数量", "Amount"], value: 60 },
            { names: ["类型", "Type"], value: 2 }
        ],
        "ADBE Sharpen": [{ names: ["锐化量", "Sharpen Amount"], value: 60 }],
        "ADBE Unsharp Mask2": [
            { names: ["数量", "Amount"], value: 150 },
            { names: ["半径", "Radius"], value: 8 }
        ],
        "ADBE Brightness & Contrast 2": [
            { names: ["亮度", "Brightness"], value: 10 },
            { names: ["对比度", "Contrast"], value: 30 }
        ],
        "ADBE HUE SATURATION": [{ names: ["主饱和度", "Master Saturation"], value: 60 }],
        "ADBE Tint": [{ names: ["着色数量", "Amount to Tint"], value: 100 }],
        "ADBE Easy Levels2": [{ names: ["灰度系数", "Gamma"], value: 1.6 }],
        "ADBE Mosaic": [
            { names: ["水平块", "Horizontal Blocks"], value: 18 },
            { names: ["垂直块", "Vertical Blocks"], value: 18 }
        ],
        "ADBE Glo2": [
            { names: ["发光半径", "Glow Radius"], value: 30 },
            { names: ["发光强度", "Glow Intensity"], value: 1.5 }
        ],
        "ADBE Turbulent Displace": [
            { names: ["数量", "Amount"], value: 60 },
            { names: ["大小", "Size"], value: 40 }
        ],
        "ADBE Wave Warp": [
            { names: ["波形高度", "Wave Height"], value: 40 },
            { names: ["波形宽度", "Wave Width"], value: 60 }
        ],
        "ADBE Ripple": [
            { names: ["半径", "Radius"], value: 60 },
            { names: ["波形高度", "Wave Height"], value: 30 }
        ],
        "ADBE Bulge": [{ names: ["凸出高度", "Bulge Height"], value: 1.5 }],
        "ADBE Twirl": [{ names: ["角度", "Angle"], value: 90 }],
        "ADBE Drop Shadow": [
            { names: ["距离", "Distance"], value: 12 },
            { names: ["柔和度", "Softness"], value: 20 },
            { names: ["不透明度", "Opacity"], value: 200 }
        ],
        "ADBE Bevel Alpha": [
            { names: ["边缘厚度", "Edge Thickness"], value: 8 },
            { names: ["灯光强度", "Light Intensity"], value: 0.6 }
        ],
        "CC Radial Fast Blur": [{ names: ["Amount", "数量"], value: 60 }],
        "CC Lens": [{ names: ["Size", "大小"], value: 145 }],
        "CC Bender": [{ names: ["Amount", "数量"], value: 60 }],
        "CC Burn Film": [{ names: ["Burn", "燃烧"], value: 50 }],

        // ---- 第二批：CC 系列（参数名由 dump_param_trees 第二批实测导出）----
        // 注意：CC 是第三方插件风格，即使中文界面，参数名仍是英文。
        "CC Radial Blur": [
            { names: ["Amount"], value: 45 },
            { names: ["Type"], value: 2 }
        ],
        "CC Vector Blur": [{ names: ["Amount"], value: 160 }],
        "CC Color Offset": [
            { names: ["Red Phase"], value: 80 },
            { names: ["Blue Phase"], value: -60 }
        ],
        "CC Toner": [{ names: ["Blend w. Original"], value: 0 }],
        "CC Overbrights": [{ names: ["Channel"], value: 1 }],
        "CC Threshold": [
            { names: ["Blend w. Original"], value: 0 },
            { names: ["Threshold"], value: 0.45 }
        ],
        "CC Threshold RGB": [
            { names: ["Red Threshold"], value: 0.55 },
            { names: ["Green Threshold"], value: 0.42 },
            { names: ["Blue Threshold"], value: 0.3 }
        ],
        "CC Kaleida": [
            { names: ["Size"], value: 130 },
            { names: ["Mirroring"], value: 3 }
        ],
        "CC Glass": [
            { names: ["Height"], value: 60 },
            { names: ["Displacement"], value: 60 }
        ],
        "CC Plastic": [{ names: ["Height"], value: 60 }],
        "CC RepeTile": [
            { names: ["Expand Right"], value: 140 },
            { names: ["Expand Down"], value: 140 }
        ],
        "CC Bend It": [{ names: ["Bend"], value: 90 }],
        "CC Blobbylize": [{ names: ["Softness"], value: 60 }],
        "CC Flo Motion": [{ names: ["Amount 1"], value: 320 }],
        "CC Griddler": [
            { names: ["Horizontal Scale"], value: 700 },
            { names: ["Vertical Scale"], value: 700 },
            { names: ["Tile Size"], value: 30 }
        ],
        "CC Slant": [{ names: ["Slant"], value: 70 }],
        "CC Split": [{ names: ["Split"], value: 90 }],
        "CC Tiler": [{ names: ["Scale"], value: 0.35 }],
        "CC Light Burst 2.5": [
            { names: ["Intensity"], value: 140 },
            { names: ["Ray Length"], value: 160 }
        ],
        "CC Light Rays": [
            { names: ["Intensity"], value: 130 },
            { names: ["Radius"], value: 240 }
        ],
        "CC Light Sweep": [
            { names: ["Width"], value: 280 },
            { names: ["Sweep Intensity"], value: 130 }
        ],
        "CC Scale Wipe": [{ names: ["Stretch"], value: 70 }],
        "CC Grid Wipe": [
            { names: ["Completion"], value: 0.5 },
            { names: ["Tiles"], value: 6 }
        ],
        "CC Star Burst": [{ names: ["Scatter"], value: 180 }],
        "CC Scatterize": [{ names: ["Scatter"], value: 120 }],
        "CC Cylinder": [{ names: ["Radius (%)"], value: 70 }],
        "CC Sphere": [{ names: ["Radius"], value: 140 }],
        "CC Glue Gun": [
            { names: ["Stroke Width"], value: 40 },
            { names: ["Density"], value: 60 }
        ],
        "CC Page Turn": [{ names: ["Fold Radius"], value: 60 }],

        // ---- 两层输入 / 调整层（新场景）----
        "ADBE Displacement Map": [
            { names: ["最大水平置换"], value: 90 },
            { names: ["最大垂直置换"], value: 90 }
        ],
        "ADBE Compound Blur": [{ names: ["最大模糊"], value: 45 }],
        "ADBE Set Matte3": [{ names: ["用于遮罩"], value: 4 }],
        "ADBE Fill": [
            { names: ["颜色"], value: [0.16, 0.52, 0.82] },
            { names: ["不透明度"], value: 0.55 }
        ],
        "ADBE Ramp": [
            { names: ["起始颜色"], value: [0.08, 0.18, 0.42] },
            { names: ["结束颜色"], value: [0.95, 0.55, 0.2] }
        ],
        "ADBE Gradient Wipe": [
            { names: ["过渡完成"], value: 0.5 },
            { names: ["过渡柔和度"], value: 0.3 }
        ],
        "ADBE 4ColorGradient": [
            { names: ["不透明度"], value: 70 },
            { names: ["颜色 1"], value: [0.1, 0.3, 0.6] },
            { names: ["颜色 2"], value: [0.9, 0.4, 0.2] }
        ],

        // ---- 第三方：P0 实机验证 ----
        // Twitch 默认所有 Enable 开关都是 0，预览就是空素材；Blur 是 Enable
        // 组后的第一个 0/1 开关，置 1 后画面才有 Twitch 效果（P0: 66.86% 像素变化）。
        // 只做静态写入，不打关键帧（见 STATIC_RECIPES）。
        "Videocopilot Twitch": [{ names: ["Blur"], value: 1 }]
    };

    /**
     * 只写值、不打关键帧的配方。
     * Twitch 的 Enable 开关是 0/1，P0 只验证了静态写入；给它打关键帧
     * 没有实机验证过，保持静态最稳，也避免 6 帧里开关反复闪。
     */
    var STATIC_RECIPES = {
        "Videocopilot Twitch": true
    };

    function isStaticRecipe(matchName) {
        return STATIC_RECIPES[matchName] === true;
    }

    /**
     * 替代方案：某些效果不能真渲（AE 会挂死），但用户仍希望预览墙上有一张
     * 能代表它的卡片。用一个观感相近的安全效果代替。
     *
     * ADBE Lumetri（Lumetri 颜色）实测一渲染就挂死，AE 直接未响应。
     * 它的视觉本质是「色彩科学 + 饱和度」，所以用饱和度调整来代表。
     */
    var SURROGATES = {
        "ADBE Lumetri": {
            effect: "ADBE HUE SATURATION",
            steps: [{ names: ["主饱和度", "Master Saturation"], value: 60 }],
            reason: "Lumetri 渲染挂死，用饱和度调整代表"
        }
    };

    /** 实际要挂到合成上的效果名（有替代方案就用替代的） */
    function effectNameFor(matchName) {
        var s = SURROGATES[matchName];
        return s ? s.effect : matchName;
    }

    /** 实际要写的参数步骤（有替代方案就用替代的） */
    function stepsFor(matchName) {
        var s = SURROGATES[matchName];
        if (s) return s.steps;
        return RECIPES[matchName] || null;
    }

    function isSurrogate(matchName) {
        return SURROGATES[matchName] ? true : false;
    }

    function lower(value) {
        return String(value === undefined || value === null ? "" : value).toLowerCase();
    }

    /** 表达式控件 / 音频族不渲图（设计文档 §4.3 的 no-preview 场景） */
    function isNoPreview(category) {
        var cat = lower(category);
        for (var i = 0; i < NO_PREVIEW_CATEGORIES.length; i++) {
            if (cat === NO_PREVIEW_CATEGORIES[i]) return true;
        }
        return false;
    }

    /** 必须有第二图层才成立的效果（置换图 / 复合模糊 / 设置遮罩 / 图层输入类）。
     *  名单来自本机实测：这些效果在单层合成里"加上了但画面不变"。
     */
    var TWO_LAYER_PATTERNS = [
        "displacement map", "compound blur", "set matte",
        "calculations", "compound arithmetic", "arithmetic",
        "time displacement", "gradient wipe",
        "cc composite", "cc vector blur", "cc mr. smoothie",
        "cc image wipe", "cc warpomatic"
    ];

    /** 需要下层背景的效果：自身只生成部分内容，留白处要露出下面的画面 */
    var ADJUSTMENT_PATTERNS = [
        "adbe fill", "adbe ramp", "4colorgradient", "scribble fill", "eyedropper fill"
    ];

    /**
     * 推断场景类型（设计文档 §4.3 的八类枚举）。
     * 只靠 matchName 与可选 category 判断——previewgen 手里只有 matchName，
     * 所以判断规则必须能在没有分类信息时也站得住。
     */
    function sceneFor(matchName, category) {
        // 手动覆盖表里的 scene 优先（用户明确指定了场景搭法）
        var override = overrideFor(matchName);
        if (override && override.scene) return override.scene;
        if (isNoPreview(category)) return "no-preview";
        var cat = lower(category);
        var mn = lower(matchName);

        if (cat === "text" || cat === "文本") return "text";
        if (/(^|\W)(text|numbers|typewriter|word)/.test(mn)) return "text";
        if (cat === "3d channel" || cat === "3d 通道") return "3d-camera";

        // 两层输入要排在别的规则前面：这些效果单层时完全看不出变化
        for (var i = 0; i < TWO_LAYER_PATTERNS.length; i++) {
            if (mn.indexOf(TWO_LAYER_PATTERNS[i]) >= 0) return "two-layer-input";
        }
        for (var j = 0; j < ADJUSTMENT_PATTERNS.length; j++) {
            if (mn.indexOf(ADJUSTMENT_PATTERNS[j]) >= 0) return "adjustment";
        }

        if (/stroke|trace|outline|wireframe/.test(mn)) return "shape-mask";
        if (/solid|background/.test(mn)) return "solid-2d";
        return "footage-2d";
    }

    /**
     * 场景 → 临时合成的搭法。
     *   base       效果作用的那一层用哪种素材
     *   needBg     下面垫一层背景（调整层类：留白处要露出下面的画面）
     *   needSource 再插一层高对比图案当第二输入（两层输入类）
     *
     * 图层顺序（AE 里 1 是最上）：[effect(base), pattern, bg]
     * 所以第二输入一律绑定到第 2 层。
     */
    var LAYOUTS = {
        "footage-2d": { base: "photo", needBg: false, needSource: false },
        "solid-2d": { base: "solid", needBg: false, needSource: false },
        "text": { base: "text", needBg: false, needSource: false },
        "shape-mask": { base: "shape", needBg: false, needSource: false },
        "adjustment": { base: "photo", needBg: true, needSource: false },
        "two-layer-input": { base: "photo", needBg: true, needSource: true },
        "3d-camera": { base: "photo", needBg: false, needSource: false }
    };

    function layoutFor(scene) {
        var layout = LAYOUTS[scene];
        if (!layout) return { base: "photo", needBg: false, needSource: false };
        return { base: layout.base, needBg: layout.needBg, needSource: layout.needSource };
    }

    /** 场景类型 → 标准素材类型（assets.jsx 的 kind），保留给只需要素材类型的调用方 */
    function assetKindFor(scene) {
        return layoutFor(scene).base;
    }

    /** djb2 短哈希，用于缓存键 */
    function hashString(text) {
        var hash = 5381;
        var value = String(text);
        for (var i = 0; i < value.length; i++) {
            hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0x7fffffff;
        }
        return hash.toString(36);
    }

    /**
     * 缓存指纹（设计文档 §4.5）：
     *   hash(matchName + recipeVersion + assetFingerprint + tileSize + frameCount)
     * AE 版本号刻意不参与——否则每次升级都会触发全量重渲。
     */
    function cacheKey(matchName, assetFingerprint, tileSize, frameCount, overrideSignature) {
        var parts = [
            matchName,
            RECIPE_VERSION,
            assetFingerprint || "na",
            tileSize || 0,
            frameCount || 0
        ];
        // 无覆盖时不追加任何字段，保证旧缓存键完全不变；
        // 有覆盖时把来源/参数签名并进哈希，改覆盖会自动失效。
        if (overrideSignature) parts.push(overrideSignature);
        return hashString(parts.join("|"));
    }

    /** 展示时点：取合成中点，避开首帧尚未成形的效果 */
    function presentationTime(comp) {
        try {
            return comp.duration * PRESENTATION_TIME_RATIO;
        } catch (e) {
            return 0;
        }
    }

    /** 纯函数：给定属性类型与取值范围，返回启发式演示值。
     *  返回 undefined 表示"这个属性不动"，调用方必须跳过。
     *  kind: "color" | "checkbox" | "oneD" | "other"
     *
     *  ⚠️ TwoD 一律不碰（设计文档 §4.3 原本要求给"中心+偏移"，已按实测推翻）：
     *  AE 2021 上 CC 系列的 Center 等 Point 控件是 0–1 归一化坐标，赋像素值
     *  [128,128] 会触发 AE 内部脚本异常
     *    "After Effects错误: Line 1849: var center = cs.convertPoint([0.5, 0.5"
     *  而整网批量渲染是一损俱损的——一个格子报错会让整张网失败。
     *  位置类参数保持效果默认值，视觉上可能"看不出偏移"，但不会崩。
     */
    function heuristicValue(kind, minValue, maxValue, cellSize) {
        if (kind === "color") return [0.9, 0.35, 0.2];
        if (kind === "checkbox") return true;
        if (kind === "oneD") {
            if (minValue === null || minValue === undefined) return undefined;
            if (maxValue === null || maxValue === undefined) return undefined;
            return (Number(minValue) + Number(maxValue)) / 2;
        }
        return undefined;
    }

    /** 把 AE 属性的 propertyValueType 归一成上面四种 kind 之一 */
    function kindOf(prop) {
        var type = null;
        try {
            type = String(prop.propertyValueType);
        } catch (e) {
            return "other";
        }
        // PropertyValueType 的字符串化结果在不同版本可能是数字或枚举名
        if (type === "COLOR" || type === String(PropertyValueType.COLOR)) return "color";
        if (type === "CHECKBOX" || type === String(PropertyValueType.CHECKBOX)) return "checkbox";
        // TWO_D / TWO_D_SPATIAL 故意归为 other：位置类参数的单位在不同效果里
        // 可能是像素也可能是 0–1 归一化，统一赋值会踩到 AE 内部脚本异常。
        if (type === "OneD" || type === "ONE_D" || type === String(PropertyValueType.OneD)) return "oneD";
        return "other";
    }

    function setIfWritable(prop, value) {
        if (value === undefined) return false;
        try {
            prop.setValue(value);
            return true;
        } catch (e) {
            return false;
        }
    }

    function findByName(group, names) {
        var count = 0;
        try {
            count = group.numProperties;
        } catch (e) {
            return null;
        }
        for (var i = 1; i <= count; i++) {
            var prop = null;
            try {
                prop = group.property(i);
            } catch (e2) {
                continue;
            }
            if (!prop || !prop.name) continue;
            var name = String(prop.name);
            for (var n = 0; n < names.length; n++) {
                if (name === names[n]) return prop;
            }
        }
        return null;
    }

    /* ---------- 手动覆盖表：effect_overrides.tsv ---------- */
    // 文件在 <我的文档>/DreamEngine/effect_overrides.tsv，由 Hub 写入。
    // 读不到 / 坏行 / 坏值一律跳过，不让覆盖表阻塞自动渲染。
    var OVERRIDE_ROOT_NAME = "DreamEngine";
    var OVERRIDE_FILE_NAME = "effect_overrides.tsv";
    var OVERRIDE_PRESET_DIR = "effect_presets";
    var OVERRIDE_SCENES = [
        "footage-2d", "solid-2d", "text", "shape-mask",
        "adjustment", "two-layer-input", "3d-camera"
    ];
    var overrideCache = null;

    function trimOverrideText(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/^\s+|\s+$/g, "");
    }

    function isAllowedOverrideScene(scene) {
        for (var i = 0; i < OVERRIDE_SCENES.length; i++) {
            if (scene === OVERRIDE_SCENES[i]) return true;
        }
        return false;
    }

    function overrideRootPath() {
        try {
            if (typeof Folder === "undefined" || !Folder.myDocuments) return "";
            return String(Folder.myDocuments.fsName) + "/" + OVERRIDE_ROOT_NAME;
        } catch (e) {
            return "";
        }
    }

    function readOverrideText(path) {
        try {
            if (typeof File === "undefined") return "";
            var f = new File(path);
            if (!f.exists) return "";
            f.encoding = "UTF-8";
            if (!f.open("r")) return "";
            var text = String(f.read());
            f.close();
            return text.replace(/^\uFEFF/, "");
        } catch (e2) {
            return "";
        }
    }

    function overrideFileExists(path) {
        try {
            if (typeof File === "undefined") return false;
            var f = new File(path);
            return !!f.exists;
        } catch (e) {
            return false;
        }
    }

    function normalizePresetPath(value) {
        var raw = String(value === undefined || value === null ? "" : value)
            .replace(/\\/g, "/")
            .replace(/^\s+|\s+$/g, "");
        if (!raw) return "";
        if (raw.charAt(0) === "/" || /^[A-Za-z]:/.test(raw)) return null;
        var parts = raw.split("/");
        for (var i = 0; i < parts.length; i++) {
            if (!parts[i] || parts[i] === "." || parts[i] === "..") return null;
        }
        var prefixed = lower(raw).indexOf(OVERRIDE_PRESET_DIR + "/") === 0
            ? raw
            : OVERRIDE_PRESET_DIR + "/" + raw;
        if (!/\.ffx$/i.test(prefixed)) return null;
        return prefixed;
    }

    function parseOverrideArray(raw) {
        var text = trimOverrideText(raw);
        if (text.charAt(0) === "[") text = text.substring(1);
        if (text.length && text.charAt(text.length - 1) === "]") {
            text = text.substring(0, text.length - 1);
        }
        if (!trimOverrideText(text)) return null;
        var parts = text.split(",");
        var values = [];
        for (var i = 0; i < parts.length; i++) {
            var number = Number(trimOverrideText(parts[i]));
            if (isNaN(number)) return null;
            values.push(number);
        }
        return values.length ? values : null;
    }

    function parseOverrideValue(valueType, raw) {
        var type = lower(trimOverrideText(valueType));
        var text = trimOverrideText(raw);
        if (!text) return null;
        if (!type) {
            if (/^(true|false)$/i.test(text)) return lower(text) === "true";
            if (text.charAt(0) === "[") return parseOverrideArray(text);
            var inferred = Number(text);
            return isNaN(inferred) ? null : inferred;
        }
        if (type === "number") {
            var number = Number(text);
            return isNaN(number) ? null : number;
        }
        if (type === "boolean") {
            if (/^(true|1)$/i.test(text)) return true;
            if (/^(false|0)$/i.test(text)) return false;
            return null;
        }
        if (type === "array") return parseOverrideArray(text);
        return null;
    }

    function parseOverrideEnabled(value) {
        var text = lower(trimOverrideText(value));
        if (!text) return true;
        if (text === "1" || text === "true" || text === "yes" || text === "on") return true;
        if (text === "0" || text === "false" || text === "no" || text === "off") return false;
        return null;
    }

    function parseOverrideVerified(value) {
        var text = lower(trimOverrideText(value));
        if (!text) return null;
        if (text === "1" || text === "true") return true;
        if (text === "0" || text === "false") return false;
        return undefined;
    }

    function overrideHeaderIndex(cells) {
        var index = {};
        for (var i = 0; i < cells.length; i++) {
            var name = trimOverrideText(cells[i]);
            if (name) index[name] = i;
        }
        return index["matchName"] === undefined ? null : index;
    }

    function parseOverrideRow(cells, index) {
        function get(name) {
            var column = index[name];
            return column === undefined
                ? ""
                : String(cells[column] === undefined || cells[column] === null ? "" : cells[column]);
        }

        var matchName = trimOverrideText(get("matchName"));
        if (!matchName) return null;

        var preset = normalizePresetPath(get("preset"));
        if (preset === null) return null;

        var scene = trimOverrideText(get("scene"));
        if (scene && !isAllowedOverrideScene(scene)) return null;

        var enabled = parseOverrideEnabled(get("enabled"));
        if (enabled === null || !enabled) return null;

        var paramIndex = trimOverrideText(get("paramIndex"));
        if (paramIndex && !/^\d+(?:\.\d+)*$/.test(paramIndex)) return null;
        if (!preset && !paramIndex) return null;

        var valueType = lower(trimOverrideText(get("valueType")));
        var value = parseOverrideValue(valueType, get("value"));
        if (paramIndex && value === null) return null;

        var verified = parseOverrideVerified(get("verified"));
        if (verified === undefined) return null;

        return {
            matchName: matchName,
            preset: preset,
            scene: scene,
            paramIndex: paramIndex,
            paramPath: trimOverrideText(get("paramPath")),
            value: value,
            valueType: valueType,
            verified: verified,
            note: trimOverrideText(get("note"))
        };
    }

    function parseOverrideText(text) {
        var lines = String(text === undefined || text === null ? "" : text).split(/\r\n|\r|\n/);
        var headerLine = -1;
        var index = null;
        for (var i = 0; i < lines.length; i++) {
            if (!lines[i] || lines[i].charAt(0) === "#") continue;
            index = overrideHeaderIndex(lines[i].split("\t"));
            headerLine = i;
            break;
        }
        if (!index || headerLine < 0) return { items: [], errors: ["bad_header"] };

        var items = [];
        var errors = [];
        for (var j = headerLine + 1; j < lines.length; j++) {
            if (!lines[j] || lines[j].charAt(0) === "#") continue;
            var row = null;
            try {
                row = parseOverrideRow(lines[j].split("\t"), index);
            } catch (e) {
                row = null;
            }
            if (row) items.push(row);
            else errors.push("bad_row:" + (j + 1));
        }
        return { items: items, errors: errors };
    }

    function loadOverrides() {
        if (overrideCache) return overrideCache;
        overrideCache = { items: [], byMatch: {}, errors: [] };

        var root = overrideRootPath();
        if (!root) return overrideCache;
        var text = readOverrideText(root + "/" + OVERRIDE_FILE_NAME);
        if (!text) return overrideCache;

        var parsed = parseOverrideText(text);
        overrideCache.errors = parsed.errors;
        for (var i = 0; i < parsed.items.length; i++) {
            var row = parsed.items[i];
            var group = overrideCache.byMatch[row.matchName];
            if (!group) {
                group = {
                    matchName: row.matchName,
                    scene: "",
                    preset: "",
                    presetExists: false,
                    params: [],
                    verified: null
                };
                overrideCache.byMatch[row.matchName] = group;
            }
            if (row.scene && !group.scene) group.scene = row.scene;
            if (row.preset && !group.preset) {
                group.preset = row.preset;
                group.presetExists = overrideFileExists(root + "/" + row.preset);
            }
            if (row.paramIndex) {
                group.params.push({
                    paramIndex: row.paramIndex,
                    value: row.value,
                    valueType: row.valueType,
                    verified: row.verified,
                    paramPath: row.paramPath
                });
                if (row.verified === false) group.verified = false;
                else if (row.verified === true && group.verified !== false) group.verified = true;
            }
        }
        overrideCache.items = parsed.items;
        return overrideCache;
    }

    function overrideFor(matchName) {
        var cache = loadOverrides();
        return cache.byMatch[matchName] || null;
    }

    function resetOverrides() {
        overrideCache = null;
        return true;
    }

    function overrideSignatureFor(matchName) {
        var ov = overrideFor(matchName);
        if (!ov) return "";
        var parts = [];
        if (ov.scene) parts.push("scene=" + ov.scene);
        if (ov.preset) parts.push("preset=" + ov.preset);
        for (var i = 0; i < ov.params.length; i++) {
            var p = ov.params[i];
            parts.push(
                p.paramIndex + "=" + p.valueType + ":" + String(p.value) +
                ":" + (p.verified === null ? "" : p.verified ? "1" : "0")
            );
        }
        if (!parts.length) return "";
        return "ov:" + hashString(parts.join("|"));
    }

    function presetPathFor(matchName) {
        var ov = overrideFor(matchName);
        if (!ov || !ov.preset) return "";
        var root = overrideRootPath();
        return root ? root + "/" + ov.preset : "";
    }

    function resolveIndexPath(effectGroup, indexPath) {
        var parts = String(indexPath).split(".");
        var current = effectGroup;
        for (var i = 0; i < parts.length; i++) {
            var index = parseInt(parts[i], 10);
            if (isNaN(index) || index < 1) return null;
            try {
                current = current.property(index);
            } catch (e) {
                return null;
            }
            if (!current) return null;
        }
        return current;
    }

    function readPropertyValue(prop) {
        try {
            return prop.value;
        } catch (e) {
            return undefined;
        }
    }

    function sameArrayValue(a, b) {
        if (!a || !b || typeof a.length !== "number" || typeof b.length !== "number") return false;
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) {
            if (Math.abs(Number(a[i]) - Number(b[i])) > 1e-6) return false;
        }
        return true;
    }

    function setOverrideValue(prop, value, valueType) {
        var type = lower(valueType);
        if (!type) {
            if (typeof value === "boolean") type = "boolean";
            else if (value && typeof value.length === "number") type = "array";
            else type = "number";
        }

        if (type === "number") {
            return setNumberSafely(prop, Number(value));
        }

        var oldValue = readPropertyValue(prop);
        if (!setIfWritable(prop, value)) return false;
        var now = readPropertyValue(prop);

        if (type === "boolean") {
            var wanted = value ? true : false;
            var ok = false;
            if (typeof now === "boolean") ok = now === wanted;
            else if (typeof now === "number") ok = (now !== 0) === wanted;
            else if (now !== undefined && now !== null) ok = String(now) === String(wanted);
            if (!ok) {
                try { setIfWritable(prop, oldValue); } catch (e) {}
            }
            return ok;
        }

        if (type === "array") {
            if (sameArrayValue(now, value)) return true;
            try { setIfWritable(prop, oldValue); } catch (e2) {}
            return false;
        }

        return now === value;
    }

    function applyParamOverrides(effectGroup, matchName) {
        var ov = overrideFor(matchName);
        if (!ov || !ov.params.length) {
            return { ok: true, applied: 0, failed: false, errors: [] };
        }

        var applied = 0;
        var failed = false;
        var errors = [];
        for (var i = 0; i < ov.params.length; i++) {
            var p = ov.params[i];
            var prop = resolveIndexPath(effectGroup, p.paramIndex);
            if (!prop) {
                failed = true;
                errors.push(p.paramIndex + ":missing");
                trace("override|" + matchName + "|" + p.paramIndex + "|missing");
                continue;
            }
            var ok = false;
            try {
                ok = setOverrideValue(prop, p.value, p.valueType);
            } catch (e) {
                ok = false;
            }
            if (ok) applied++;
            else {
                failed = true;
                errors.push(p.paramIndex + ":write_failed");
            }
            trace("override|" + matchName + "|" + p.paramIndex + "|" + (ok ? "ok" : "fail") + "|" + String(p.value));
        }
        return { ok: !failed, applied: applied, failed: failed, errors: errors };
    }

    /** 套显式配方；返回写入次数，0 表示该效果没有配方 */
    function applyRecipe(effectGroup, matchName) {
        var steps = stepsFor(matchName);
        if (!steps) return 0;
        var writes = 0;
        for (var i = 0; i < steps.length; i++) {
            var prop = findByName(effectGroup, steps[i].names);
            if (prop && setIfWritable(prop, steps[i].value)) writes++;
        }
        return writes;
    }

    /** 启发式兜底；返回写入次数 */
    function applyHeuristics(effectGroup, cellSize) {
        var budget = MAX_WRITES;
        var writes = 0;

        function walk(group, depth) {
            if (depth > MAX_DEPTH || writes >= budget) return;
            var count = 0;
            try {
                count = group.numProperties;
            } catch (e) {
                return;
            }
            for (var i = 1; i <= count && writes < budget; i++) {
                var prop = null;
                try {
                    prop = group.property(i);
                } catch (e2) {
                    continue;
                }
                if (!prop) continue;

                var childCount = 0;
                try {
                    childCount = prop.numProperties;
                } catch (e3) {
                    childCount = 0;
                }
                if (childCount && childCount > 0) {
                    walk(prop, depth + 1);
                    continue;
                }

                var kind = kindOf(prop);
                if (kind === "other") continue;

                var minValue = null;
                var maxValue = null;
                try {
                    if (prop.hasMin) minValue = prop.minValue;
                    if (prop.hasMax) maxValue = prop.maxValue;
                } catch (e4) {}

                var value = heuristicValue(kind, minValue, maxValue, cellSize);
                if (setIfWritable(prop, value)) writes++;
            }
        }

        walk(effectGroup, 0);
        return writes;
    }

    /**
     * 给配方的主参数打关键帧，让预览「动起来」。
     *
     * 为什么需要：AE 效果默认不随时间变化——不设关键帧的话，
     * 6 帧渲染出来逐像素相同，缩略图轮播等于静止画面（实测 60 条里 59 条如此）。
     * 这里把主参数从 0 渐变到配方值，于是缩略图展示的是「效果逐渐起作用」，
     * 既能看出动，也能看出这个效果到底改变了什么。
     *
     * 只对数值型参数生效；颜色、位置类不参与（颜色渐变会变成黑场，位置类单位不统一）。
     * 返回是否成功打上关键帧。
     */
    function animate(effectGroup, matchName, durationSeconds) {
        if (isStaticRecipe(matchName)) return false;
        var steps = stepsFor(matchName);
        if (!steps || !steps.length) return false;

        var prop = null;
        var target = null;
        for (var i = 0; i < steps.length; i++) {
            var candidate = findByName(effectGroup, steps[i].names);
            if (!candidate) continue;
            var type = kindOf(candidate);
            // 只处理一维数值：颜色渐变到 0 会变成黑场，位置类语义不统一
            if (type !== "oneD") continue;
            prop = candidate;
            target = steps[i].value;
            break;
        }
        if (!prop) return false;

        var start = 0;
        try {
            if (target === 0) {
                // 目标值是 0（常见于「与原始图像混合」这类 0=满效果的参数）时，
                // 0→0 等于没动画。此时从一个小非零值起步，动画方向是「效果退场」。
                var maxValue = prop.hasMax ? Number(prop.maxValue) : 1;
                start = maxValue > 0 ? Math.min(maxValue, 10) : 1;
            } else if (prop.hasMin) {
                var minValue = Number(prop.minValue);
                // 有些参数 0 不合法（最小值是 1 之类），那就从最小值起步
                if (minValue > 0 && minValue < Number(target)) start = minValue;
            }
        } catch (e) {}

        var end = Number(durationSeconds);
        if (!end || end <= 0) return false;
        try {
            prop.setValueAtTime(0, start);
            prop.setValueAtTime(end, target);
            return true;
        } catch (e2) {
            return false;
        }
    }

    /**
     * 内置效果判定：按 matchName 前缀。
     *
     * 第三方插件的参数结构千差万别——实测 S_ChannelSwitcher 有 38 个属性，
     * BCC_AMBIENTLIGHT 有 257 个，里面大量是 Mocha 遮罩、Beat Reactor 音频、
     * Face ML、Pixel Chooser 之类的附属模块。通用启发式对它们只会「乱改一串
     * 无关参数」（实测把 Blur Mocha 改成 16383、Mocha Opacity 改成 0.5），
     * 既让预览失真，也有触发插件内部异常的风险。
     * 所以插件一律保持默认参数，只挂效果本身。
     */
    function isBuiltinMatch(matchName) {
        var mn = String(matchName || "");
        return mn.indexOf("ADBE") === 0 ||
               mn.indexOf("APC") === 0 ||
               mn.indexOf("CC ") === 0 ||
               mn.indexOf("CS") === 0;
    }

    /**
     * 给任意效果的主数值参数打关键帧（不依赖显式配方）。
     *
     * 背景：六成以上的效果没有显式配方，走的是启发式赋值。
     * 它们同样需要动起来——否则缩略图是静止的，看不出效果在做什么。
     * 这里取启发式写过的第一个一维数值参数，从 0 渐变到它当前的取值。
     *
     * 颜色与位置类一律跳过：颜色渐变到 0 会变成黑场，位置类单位不统一。
     * 插件效果不打关键帧：默认参数保持原样更真实，动起来的参数多半是附属模块。
     */
    function animateAny(effectGroup, durationSeconds, matchName) {
        // 插件：动画但不碰最终值（保持插件默认表现）
        if (!isBuiltinMatch(matchName)) {
            return animatePlugin(effectGroup, durationSeconds);
        }
        var end = Number(durationSeconds);
        if (!end || end <= 0) return false;

        // 选参数：取「范围最大」的一维数值属性。
        // 直觉上第一个数值参数最好，但实测里第一个常常是下拉项
        // （通道、场景检测、运算类型），改了画面没反应。
        // 范围最大的那个才是真正有表现力的滑杆。
        var best = null;
        var bestMax = -1;
        function walk(group, depth) {
            if (depth > MAX_DEPTH) return;
            var count = 0;
            try {
                count = group.numProperties;
            } catch (e) {
                return;
            }
            for (var i = 1; i <= count; i++) {
                var prop = null;
                try {
                    prop = group.property(i);
                } catch (e2) {
                    continue;
                }
                if (!prop) continue;
                var childCount = 0;
                try {
                    childCount = prop.numProperties;
                } catch (e3) {
                    childCount = 0;
                }
                if (childCount && childCount > 0) {
                    walk(prop, depth + 1);
                    continue;
                }
                if (kindOf(prop) !== "oneD") continue;
                var maxValue = 0;
                try {
                    if (prop.hasMax) maxValue = Number(prop.maxValue);
                } catch (e4) {}
                // 范围小于 5 的是下拉/枚举，改了也没画面变化
                if (maxValue < 5) continue;
                if (maxValue > bestMax) {
                    bestMax = maxValue;
                    best = prop;
                }
            }
        }
        walk(effectGroup, 0);
        if (!best) return false;

        var target = null;
        try {
            target = Number(best.value);
        } catch (e5) {
            return false;
        }
        if (isNaN(target)) return false;

        var start = 0;
        if (target === 0) {
            start = bestMax > 0 ? Math.min(bestMax, 10) : 1;
        } else {
            try {
                if (best.hasMin) {
                    var minValue = Number(best.minValue);
                    if (minValue > 0 && minValue < target) start = minValue;
                }
            } catch (e6) {}
            if (target === start) return false;
        }

        try {
            best.setValueAtTime(0, start);
            best.setValueAtTime(end, target);
            return true;
        } catch (e7) {
            return false;
        }
    }

    /**
     * 插件参数里的「附属模块」关键词。
     *
     * 第三方插件的一个效果往往带一堆子模块：Mocha 遮罩、Beat Reactor 音频、
     * Face ML、Pixel Chooser、预设存取、通道映射……这些参数一动就可能触发
     * 插件内部异常，而且与效果本身的视觉表现无关。改参数时必须绕开。
     */
    var PLUGIN_AUX_WORDS = [
        "mocha", "audio", "beat reactor", "preset", "help", "compare", "host",
        "graph", "sampler", "watch folder", "matte tool", "depth", "project data",
        "docs", "face ml", "pixel chooser", "load", "save", "edit", "mask from",
        "mix with", "blend", "alpha", "channel"
    ];

    function isPluginAuxiliary(name) {
        var lower = String(name === undefined || name === null ? "" : name).toLowerCase();
        for (var i = 0; i < PLUGIN_AUX_WORDS.length; i++) {
            if (lower.indexOf(PLUGIN_AUX_WORDS[i]) >= 0) return true;
        }
        return false;
    }

    /**
     * 参数「作用」分类（只按名字判断，够用且可解释）。
     *
     * intensity —— 强度 / 占比 / 混合类：值越大效果越强
     *              → 拨到 15%，预览是「轻微生效」的样子，最接近真实观感
     * opacity   —— AE 内置的「效果不透明度」（0-100），整条效果的强度
     *              → 效果本身没有强度参数时用它，拨到 70%，保证看得出来
     * 其它（形态类：Radius / Size / Frequency / Octaves / Seed…）**一律不动**：
     *   Sapphire 这类是 log 尺度（实测 Frequency 范围 0.01–32767），
     *   线性取 70% 会把云变成一片噪点——这正是之前翻车的地方。
     */
    var INTENSITY_WORDS = [
        "intensity", "amount", "contribution", "strength", "visibility",
        "weight", "density", "mix", "blend", "mixing"
    ];

    function isIntensityName(name) {
        var lower = String(name || "").toLowerCase();
        for (var i = 0; i < INTENSITY_WORDS.length; i++) {
            if (lower.indexOf(INTENSITY_WORDS[i]) >= 0) return true;
        }
        return false;
    }

    /**
     * 找出插件的主强度参数（最多一个）。
     * 优先级：效果自带的强度/占比参数（15%）→ AE 内置「效果不透明度」（70%）。
     * 返回 {prop, ratio} 或 null（不动任何参数）。
     */
    function pluginMainParam(effectGroup) {
        var candidate = null;

        // 第一步：只读参数**名字**（读名字是安全的）。
        // 实测在遍历过程中读 prop.hasMin / prop.maxValue / prop.value 会让 AE
        // 直接崩掉——所以取值一律延后到「已经锁定唯一候选」之后。
        function walk(group, depth) {
            if (depth > 2 || candidate) return;
            var count = 0;
            try {
                count = group.numProperties;
            } catch (e) {
                return;
            }
            for (var i = 1; i <= count; i++) {
                var prop = null;
                try {
                    prop = group.property(i);
                } catch (e2) {
                    continue;
                }
                if (!prop) continue;
                var childCount = 0;
                try {
                    childCount = prop.numProperties;
                } catch (e3) {
                    childCount = 0;
                }
                if (childCount > 0) {
                    walk(prop, depth + 1);
                    continue;
                }
                var name = "";
                try {
                    name = String(prop.name || "");
                } catch (e4) {}
                if (!name || isPluginAuxiliary(name)) continue;
                // 必须是**一维数值**参数。下拉项（名字里常带 blend / mix）不能碰：
                // 往它上面写值会把整条效果写坏，渲染直接报「需要数字、数组或属性
                // 的位置找到类型为 Error 的对象」。
                if (kindOf(prop) !== "oneD") continue;
                // 只认「强度/占比」类参数。
                // AE 内置的「效果不透明度」绝不碰：实测对它 setValue 或打关键帧，
                // 整条效果都会报同样的错，直接渲不出来。
                if (isIntensityName(name)) {
                    candidate = prop;
                    return;
                }
            }
        }

        walk(effectGroup, 0);
        if (!candidate) return null;

        // 第二步：锁定候选后才取值（每个读取都单独兜住）
        var minValue = 0;
        var maxValue = 0;
        var current = 0;
        try {
            if (candidate.hasMin) minValue = Number(candidate.minValue);
            if (candidate.hasMax) maxValue = Number(candidate.maxValue);
        } catch (e5) {
            return null;
        }
        // 枚举/开关（0-1、1-3）与 log 尺度的形态参数都不碰
        if (!(maxValue > minValue) || maxValue < 5 || maxValue > 1000) return null;
        try {
            current = Number(candidate.value);
        } catch (e6) {
            return null;
        }
        // 取不到有效数值就放弃这个参数（有些属性读出来是 Error 对象）
        if (typeof current !== "number" || isNaN(current)) return null;

        // 分档：按参数**当前值**决定用小值还是大值
        //   · 当前值已经不小（默认就是满效果）→ 拨到 15%，预览是「轻微生效」的样子
        //   · 当前值几乎为 0（这类参数 0=满效果或本来就没生效）→ 15% 几乎看不出，
        //     改用 70%，保证效果看得见
        var ratio = 0.15;
        if (maxValue > 0 && current / maxValue <= 0.2) ratio = 0.7;
        trace("main|candidate=" + candidate.name + "|current=" + current +
              "|min=" + minValue + "|max=" + maxValue + "|ratio=" + ratio);
        return { prop: candidate, ratio: ratio, kind: "intensity" };
    }

    /** 按范围比例算出目标值 */
    function paramTarget(prop, ratio) {
        var minValue = 0;
        var maxValue = 0;
        try {
            if (prop.hasMin) minValue = Number(prop.minValue);
            if (prop.hasMax) maxValue = Number(prop.maxValue);
        } catch (e) {}
        if (!(maxValue > minValue)) return null;
        return minValue + (maxValue - minValue) * ratio;
    }

    /**
     * 安全写数值：只写「本来就是数字」的属性，写完立刻读回校验，
     * 写坏了（AE 返回 Error 对象）就还原原值。
     *
     * 为什么需要：插件属性的 min/max 有时取不到、或参数其实是别的类型，
     * 硬写会让 AE 在渲染阶段报「需要数字、数组或属性的位置找到类型为 Error
     * 的对象」——整个效果直接渲不出来（实测 S_BrightnessContrast）。
     */
    function setNumberSafely(prop, value) {
        var oldValue = null;
        try {
            oldValue = prop.value;
        } catch (e) {
            return false;
        }
        if (typeof oldValue !== "number" || isNaN(oldValue)) return false;
        if (typeof value !== "number" || isNaN(value)) return false;
        if (!setIfWritable(prop, value)) return false;
        try {
            var now = prop.value;
            if (typeof now !== "number" || isNaN(now)) {
                setIfWritable(prop, oldValue);
                return false;
            }
        } catch (e2) {
            try {
                setIfWritable(prop, oldValue);
            } catch (e3) {}
            return false;
        }
        return true;
    }

    /* 追踪文件：调参一旦把效果写坏，AE 只会报一句「Error 对象」，
       靠日志猜不出是哪一步。 */
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

    /* 插件调参总开关（诊断用：关掉就能对比「不调参数」的表现） */
    var TUNING_ENABLED = true;

    function setTuning(enabled) {
        TUNING_ENABLED = !!enabled;
        return TUNING_ENABLED;
    }

    function tuningEnabled() {
        return TUNING_ENABLED;
    }
    /**
     * 插件的强度微调：**不动任何参数**。
     *
     * 结论来自实机（AE 2021 / Sapphire / BCC）：
     *   用脚本给插件效果写参数（哪怕是它自己的数值滑杆），整条效果就会变成
     *   「在需要数字、数组或属性的位置找到类型为 Error 的对象」直接渲不出来，
     *   严重时 AE 进程直接消失。逐项验证过：写内置「效果不透明度」→ 坏；
     *   写强度滑杆 → 坏；写形态滑杆（Octaves）→ 同样坏。
     *   所以插件预览一律**保持默认参数**，忠实地反映效果本来的样子。
     *
     * 内置效果不受影响（AE 自带参数可以安全地写与打关键帧）。
     *
     * 「按作用分档（强度类 15% / 尺寸类 70%）」的判断逻辑保留在
     * pluginMainParam 里，等将来有办法安全写参数时直接启用。
     */
    function tunePlugin(effectGroup) {
        if (!TUNING_ENABLED) return 0;
        var main = pluginMainParam(effectGroup);
        if (!main) return 0;
        trace("tune|skip|" + main.prop.name + "|ratio=" + main.ratio);
        return 0;
    }
    /**
     * 找「可以做动画」的线性形态参数。
     *
     * 为什么要另找：AE 内置的「效果不透明度」**不能打关键帧** —— 实测一打，
     * 渲染就报「需要数字、数组或属性的位置找到类型为 Error 的对象」，
     * 整条效果直接废掉（setValue 本身是安全的，只有关键帧会坏）。
     * 所以动画只能打在插件自己的普通数值参数上。
     *
     * 候选：细节层数 / 数量类（Octaves、Detail、Count、Segments…），
     * 它们是线性尺度（log 尺度的 Frequency / Radius 之类不能碰）。
     */
    var ANIM_WORDS = ["octave", "detail", "count", "segment", "level", "iterations", "samples"];

    function pluginAnimParam(effectGroup) {
        var found = null;
        function walk(group, depth) {
            if (depth > 2 || found) return;
            var count = 0;
            try {
                count = group.numProperties;
            } catch (e) {
                return;
            }
            for (var i = 1; i <= count; i++) {
                var prop = null;
                try {
                    prop = group.property(i);
                } catch (e2) {
                    continue;
                }
                if (!prop) continue;
                var childCount = 0;
                try {
                    childCount = prop.numProperties;
                } catch (e3) {
                    childCount = 0;
                }
                if (childCount > 0) {
                    walk(prop, depth + 1);
                    continue;
                }
                if (kindOf(prop) !== "oneD") continue;
                var name = "";
                try {
                    name = String(prop.name || "");
                } catch (e4) {}
                if (!name || isPluginAuxiliary(name)) continue;
                var lower = name.toLowerCase();
                var matched = false;
                for (var w = 0; w < ANIM_WORDS.length; w++) {
                    if (lower.indexOf(ANIM_WORDS[w]) >= 0) {
                        matched = true;
                        break;
                    }
                }
                if (!matched) continue;
                // 锁定候选后再读范围（读属性值必须最后做）
                var minValue = 0;
                var maxValue = 0;
                try {
                    if (prop.hasMin) minValue = Number(prop.minValue);
                    if (prop.hasMax) maxValue = Number(prop.maxValue);
                } catch (e5) {
                    continue;
                }
                // 线性尺度的普通数值（枚举与 log 尺度都排除）
                if (!(maxValue > minValue) || maxValue > 1000) continue;
                found = prop;
                return;
            }
        }
        walk(effectGroup, 0);
        return found;
    }
    /**
     * 插件动画：当前**不做**人为动画。
     *
     * 打关键帧同样属于「写参数」——实测在 AE 2021 上给插件效果写任何参数，
     * 整条效果都会变成「在需要数字、数组或属性的位置找到类型为 Error 的对象」
     * 直接渲不出来。所以插件预览保持默认参数；6 帧里若有变化，那来自效果
     * 自带的动画（如 Saber 类），不是我们加的。
     */
    function animatePlugin(effectGroup, durationSeconds) {
        if (!TUNING_ENABLED) return false;
        trace("animate|skip_for_plugin");
        return false;
    }

    /** 统一入口：有覆盖走覆盖；有配方走配方；内置无配方走启发式；插件只微调一个强度参数 */
    function apply(effectGroup, matchName, cellSize) {
        var ov = overrideFor(matchName);

        // 明确标记「写入无效」且没有 .ffx：保持效果默认参数，不要再让启发式乱写。
        if (ov && ov.params.length && ov.verified === false) {
            if (ov.preset && ov.presetExists) {
                return { mode: "override-preset", writes: 0, override: true, preset: ov.preset };
            }
            trace("override|blocked|" + matchName);
            return { mode: "override-blocked", writes: 0, override: true };
        }

        // 只有 .ffx、没有逐参数覆盖 → 由 previewgen 应用预设。
        if (ov && ov.preset && ov.presetExists && !ov.params.length) {
            return { mode: "override-preset", writes: 0, override: true, preset: ov.preset };
        }

        var explicitWrites = applyRecipe(effectGroup, matchName);
        if (ov && ov.params.length) {
            var overrideResult = applyParamOverrides(effectGroup, matchName);
            if (overrideResult.failed) {
                trace("override|failed|" + matchName + "|" + overrideResult.errors.join(","));
                return {
                    mode: "override-failed",
                    writes: explicitWrites + overrideResult.applied,
                    failed: true,
                    override: true,
                    errors: overrideResult.errors
                };
            }
            if (overrideResult.applied > 0) {
                return {
                    mode: explicitWrites > 0 ? "recipe+override" : "override",
                    writes: explicitWrites + overrideResult.applied,
                    override: true
                };
            }
        }

        if (explicitWrites > 0) {
            return { mode: "recipe", writes: explicitWrites };
        }
        if (!isBuiltinMatch(matchName)) {
            // 插件：形态参数一律不动（log 尺度，拨了会失真），
            // 只把「强度/占比」类参数拨到 15%；没有这类参数时，
            // 用 AE 内置的「效果不透明度」拨到 70%，保证效果看得见。
            var writes = tunePlugin(effectGroup);
            return {
                mode: writes > 0 ? "plugin-tuned" : "plugin-default",
                writes: writes
            };
        }
        var heuristicWrites = applyHeuristics(effectGroup, cellSize);
        return { mode: heuristicWrites > 0 ? "heuristic" : "none", writes: heuristicWrites };
    }

    function isLayerIndexProp(prop) {
        try {
            return String(prop.propertyValueType) === String(PropertyValueType.LAYER_INDEX);
        } catch (e) {
            return false;
        }
    }

    /**
     * 把效果里的「图层」选择器绑到指定图层序号。
     *
     * 为什么需要：置换图、复合模糊、设置遮罩这类两层输入效果，图层选择器默认是
     * 「无」，即使临时合成里摆了两层也不会自己接上，画面就完全没有变化。
     * 这一步在配方之后执行，只碰 LAYER_INDEX 类型的属性，其它一概不理。
     *
     * 返回实际绑定的属性个数。
     */
    function bindLayers(effectGroup, layerIndex) {
        var bound = 0;
        var index = layerIndex || 2;

        function walk(group, depth) {
            if (depth > 2) return;
            var count = 0;
            try {
                count = group.numProperties;
            } catch (e) {
                return;
            }
            for (var i = 1; i <= count; i++) {
                var prop = null;
                try {
                    prop = group.property(i);
                } catch (e2) {
                    continue;
                }
                if (!prop) continue;

                var childCount = 0;
                try {
                    childCount = prop.numProperties;
                } catch (e3) {
                    childCount = 0;
                }
                if (childCount && childCount > 0) {
                    walk(prop, depth + 1);
                    continue;
                }
                if (!isLayerIndexProp(prop)) continue;
                try {
                    prop.setValue(index);
                    bound++;
                } catch (e4) {}
            }
        }

        walk(effectGroup, 0);
        return bound;
    }

    return {
        RECIPE_VERSION: RECIPE_VERSION,
        isNoPreview: isNoPreview,
        sceneFor: sceneFor,
        layoutFor: layoutFor,
        assetKindFor: assetKindFor,
        bindLayers: bindLayers,
        cacheKey: cacheKey,
        hashString: hashString,
        presentationTime: presentationTime,
        heuristicValue: heuristicValue,
        applyRecipe: applyRecipe,
        applyHeuristics: applyHeuristics,
        animate: animate,
        animateAny: animateAny,
        apply: apply,
        applyParamOverrides: applyParamOverrides,
        overrideFor: overrideFor,
        resetOverrides: resetOverrides,
        overrideSignatureFor: overrideSignatureFor,
        presetPathFor: presetPathFor,
        parseOverrideText: parseOverrideText,
        trace: trace,
        setTuning: setTuning,
        tuningEnabled: tuningEnabled,
        setTrace: setTrace,
        pluginMainParam: pluginMainParam,
        isIntensityName: isIntensityName,
        isBuiltinMatch: isBuiltinMatch,
        recipes: RECIPES,
        staticRecipes: STATIC_RECIPES,
        isStaticRecipe: isStaticRecipe,
        effectNameFor: effectNameFor,
        stepsFor: stepsFor,
        isSurrogate: isSurrogate
    };
})();
