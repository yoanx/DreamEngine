// ============================================================
// curvelib.jsx —— 关键帧曲线读写（M4）
//
// 纯数学在 engine/curve_math.js（浏览器与 ExtendScript 共用同一份），
// 本文件只负责 AE 侧的读与写：
//   读：选中属性/图层 → 关键帧快照（时间、值、插值类型、ease、空间切线、标志位）
//   写：把手拖拽结果 → setTemporalEaseAtKey / setSpatialTangentsAtKey
//
// 换算模型（设计文档 §7.2）：
//   AE 的 temporal ease 由 (speed, influence) 描述：
//     · influence = 把手水平长度占「该区间时长」的百分比（0.1 ~ 100）
//     · speed     = 把手的垂直速度（属性单位/秒）
//   值图上的三次贝塞尔控制点因此是：
//     P0 = (tA, vA)
//     P1 = (tA + infOut%·dt, vA + speedOut·infOut%·dt)
//     P2 = (tB - infIn%·dt,  vB - speedIn·infIn%·dt)
//     P3 = (tB, vB)
//   线性关键帧（speed = 弦斜率、influence = 33.33）落在弦上，看起来就是直线。
//
// 为什么内部用「斜率倍率 m」而不是直接存 speed：
//   多维属性（位置/缩放）每个维度有自己的弦斜率，但 temporal ease 本质是
//   **一条统一的时间重映射**。用 m = speed / 弦斜率 表示，就能让「同一条缓动
//   曲线作用于所有维度」在数学上自洽，写回时再按各维弦斜率还原 speed。
//   这条假设由 T5.1 标定夹具验证（tools/curve_fixture.jsx）。
//
// 语法：ES3 only。不依赖 JSON（手工拼字符串），不用 Array.prototype 扩展方法。
// ============================================================

var AEV_Curve = (function () {
    if (typeof AEV_CurveMath === "undefined") {
        throw new Error("curvelib.jsx 需要先加载 engine/curve_math.js");
    }
    if (typeof AEV_CurveGraph === "undefined") {
        throw new Error("curvelib.jsx 需要先加载 engine/curve_graph.js");
    }

    var M = AEV_CurveMath;
    var G = AEV_CurveGraph;
    var VERSION = "1.0.0";

    var TYPE_LINEAR = M.TYPE_LINEAR;
    var TYPE_BEZIER = M.TYPE_BEZIER;
    var TYPE_HOLD = M.TYPE_HOLD;
    var MIN_INFLUENCE = M.MIN_INFLUENCE;
    var MAX_INFLUENCE = M.MAX_INFLUENCE;
    var CALIBRATION = M.CALIBRATION;

    // 纯函数别名：对外仍挂在 AEV_Curve 上，node 测试与面板不必知道文件拆分
    var num = M.num;
    var clamp = M.clamp;
    var isArr = M.isArr;
    var at = M.at;
    var segmentOf = M.segmentOf;
    var sampleValue = M.sampleValue;
    var speedAt = M.speedAt;
    var pathPoint = M.pathPoint;
    var easeFromHandle = M.easeFromHandle;

    /* ============================================================
     * 一、JSON 输出（手工拼，ExtendScript 无 JSON.stringify）
     * ============================================================ */

    function jstr(value) {
        var out = String(value === undefined || value === null ? "" : value);
        out = out.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        out = out.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        return '"' + out + '"';
    }

    function jnum(value) {
        var n = num(value);
        var r = Math.round(n * 1000000) / 1000000;
        return String(r);
    }

    function jbool(value) {
        return value ? "true" : "false";
    }

    function jnumArr(list) {
        var parts = [];
        if (isArr(list)) {
            for (var i = 0; i < list.length; i++) parts.push(jnum(list[i]));
        } else {
            parts.push(jnum(list));
        }
        return "[" + parts.join(",") + "]";
    }

    function jfield(key, jsonText) {
        return jstr(key) + ":" + jsonText;
    }

    /** djb2 → base36，用作「面板快照 vs AE 现值」的乐观并发指纹 */
    function hash32(text) {
        var h = 5381;
        var s = String(text);
        for (var i = 0; i < s.length; i++) {
            h = ((h << 5) + h + s.charCodeAt(i)) % 4294967296;
        }
        return h.toString(36);
    }

    /* ============================================================
     * 二、AE 侧读
     * ============================================================ */

    /** 找当前合成。与 apply.jsx 同一套逻辑，只读不写。 */
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

    function activeComp() {
        var active = null;
        try {
            active = app.project.activeItem;
        } catch (e) {}
        if (isComp(active)) return active;

        try {
            var items = app.project.items;
            for (var i = 1; i <= items.length; i++) {
                var item = items[i];
                if (!isComp(item)) continue;
                try {
                    if (item.selectedLayers && item.selectedLayers.length > 0) return item;
                } catch (e2) {}
            }
        } catch (e3) {}
        return null;
    }

    function valueDims(value) {
        if (isArr(value)) return value.length;
        return 1;
    }

    /**
     * 这个属性的值是不是数字 / 数字数组。
     *
     * 为什么要判：蒙版路径、形状路径、源文本、标记这些属性的关键帧**没有
     * 时间缓动**，把 ease 写进去 AE 直接抛异常（面板上表现为
     * 「写入被拒：write_failed」）。它们的 value 是 Shape / TextDocument
     * 之类对象，既不是 number 也不是数组。
     */
    function isNumericValue(prop) {
        var v;
        try {
            v = prop.value;
        } catch (e) {
            return false;   // 有表达式或读不到值，一律不碰
        }
        if (typeof v === "number") return true;
        if (isArr(v)) return true;
        return false;
    }

    /** 快照里的值一律输出成数组：一维属性 AE 返回的是裸数字，
     *  模型侧按 v[dim] 取会全部变成 0（实机踩过：曲线全平、误差 1e8）。 */
    function valueArr(value) {
        if (isArr(value)) return value;
        return [value];
    }

    function valueText(value) {
        var i;
        if (isArr(value)) {
            var parts = [];
            for (i = 0; i < value.length; i++) parts.push(jnum(value[i]));
            return "[" + parts.join(",") + "]";
        }
        if (typeof value === "number") return String(value);
        if (typeof value === "boolean") return value ? "1" : "0";
        return "0";
    }

    function easeArrayText(eases) {
        var parts = [];
        if (isArr(eases)) {
            for (var i = 0; i < eases.length; i++) {
                var e = eases[i] || {};
                parts.push("[[" + jnum(e.speed) + "],[" + jnum(e.influence) + "]]");
            }
        }
        return "[" + parts.join(",") + "]";
    }

    /** 关键帧指纹：时间 / 值 / 插值类型 / 两侧 ease 全都进哈希。
     *  面板拿着它判断「我读到之后，AE 里的这段曲线有没有被别人改过」。 */
    function propSignature(prop) {
        var n = 0;
        try {
            n = prop.numKeys;
        } catch (e) {
            return "0";
        }
        var s = "";
        for (var k = 1; k <= n; k++) {
            s += jnum(prop.keyTime(k)) + ",";
            s += valueText(prop.keyValue(k)) + ",";
            s += prop.keyInInterpolationType(k) + "/" + prop.keyOutInterpolationType(k) + ",";
            s += easeArrayText(prop.keyInTemporalEase(k));
            s += easeArrayText(prop.keyOutTemporalEase(k));
        }
        return hash32(s);
    }

    function locOf(prop, comp) {
        var segs = [];
        var depth = 0;
        try {
            depth = prop.propertyDepth;
        } catch (e) {}
        try {
            if (comp && comp.name) segs.push(String(comp.name));
        } catch (e0) {}
        for (var i = 1; i <= depth; i++) {
            try {
                var group = prop.propertyGroup(i);
                if (group && group.name) segs.push(String(group.name));
            } catch (e2) {}
        }
        segs.push(String(prop.name));
        /* 只在真拿到分组名时才加段：早期写法固定拼了 groups.join("|")，
           没有分组时会产出 "Comp||Opacity" 这种带空段的 loc，面板按
           正常 loc 反查就对不上了。 */
        return segs.join("|");
    }

    function tangentOf(raw, dim, dims) {
        // AE 两种返回形态都见过：一维数组（每维一个偏移）或二维数组
        if (!isArr(raw)) return 0;
        var first = raw[0];
        if (isArr(first)) return num(at(at(raw, dim, 0), 0, 0));
        if (raw.length === dims) return num(raw[dim]);
        return num(raw[0]);
    }

    function easeField(eases, dim, field) {
        var e = at(eases, dim, null);
        if (!e && isArr(eases) && eases.length > 0) e = eases[0];
        if (!e) return 0;
        return num(e[field]);
    }

    function boolOf(value, dim) {
        if (isArr(value)) return !!at(value, dim, false);
        return !!value;
    }

    function keyJson(prop, k, dims) {
        var value = prop.keyValue(k);
        var inEase = null;
        var outEase = null;
        try {
            inEase = prop.keyInTemporalEase(k);
        } catch (e) {}
        try {
            outEase = prop.keyOutTemporalEase(k);
        } catch (e2) {}

        var inSpeeds = [];
        var inInfs = [];
        var outSpeeds = [];
        var outInfs = [];
        var d;
        for (d = 0; d < dims; d++) {
            inSpeeds.push(easeField(inEase, d, "speed"));
            inInfs.push(easeField(inEase, d, "influence"));
            outSpeeds.push(easeField(outEase, d, "speed"));
            outInfs.push(easeField(outEase, d, "influence"));
        }

        var inTans = [];
        var outTans = [];
        var inTanRaw = null;
        var outTanRaw = null;
        try {
            inTanRaw = prop.keyInSpatialTangent(k);
        } catch (e3) {}
        try {
            outTanRaw = prop.keyOutSpatialTangent(k);
        } catch (e4) {}
        for (d = 0; d < dims; d++) {
            inTans.push(tangentOf(inTanRaw, d, dims));
            outTans.push(tangentOf(outTanRaw, d, dims));
        }

        var auto = false, cont = false, roving = false;
        try {
            auto = boolOf(prop.keyTemporalAutoBezier(k), 0);
        } catch (e5) {}
        try {
            cont = boolOf(prop.keyTemporalContinuous(k), 0);
        } catch (e6) {}
        try {
            roving = boolOf(prop.keyRoving(k), 0);
        } catch (e7) {}

        return "{" + [
            jfield("i", String(k - 1)),
            jfield("t", jnum(prop.keyTime(k))),
            jfield("v", jnumArr(valueArr(value))),
            jfield("sp", jbool(!!prop.isSpatial)),
            // AE 侧 ease 数组的真实长度：实测多维属性也只有 1 个（诊断用）
            jfield("ne", String(isArr(inEase) ? inEase.length : (inEase ? 1 : 0))),
            jfield("tin", String(typeCode(prop.keyInInterpolationType(k)))),
            jfield("tout", String(typeCode(prop.keyOutInterpolationType(k)))),
            jfield("is", jnumArr(inSpeeds)),
            jfield("ii", jnumArr(inInfs)),
            jfield("os", jnumArr(outSpeeds)),
            jfield("oi", jnumArr(outInfs)),
            jfield("it", jnumArr(inTans)),
            jfield("ot", jnumArr(outTans)),
            jfield("ab", jbool(auto)),
            jfield("co", jbool(cont)),
            jfield("rv", jbool(roving))
        ].join(",") + "}";
    }

    function propJson(prop, loc, index, comp) {
        var numKeys = 0;
        try {
            numKeys = prop.numKeys;
        } catch (e) {}

        var dims = 1;
        try {
            dims = valueDims(prop.value);
        } catch (e2) {}

        var keys = [];
        var n = Math.max(0, numKeys);
        for (var k = 1; k <= n; k++) {
            try {
                keys.push(keyJson(prop, k, dims));
            } catch (ek) {
                keys.push("{" + jfield("i", String(k - 1)) + "," + jfield("t", "0") +
                          "," + jfield("v", "[0]") + "," + jfield("in", "3") +
                          "," + jfield("out", "3") + "}");
            }
        }

        var spatial = false;
        var separated = false;
        var vt = 0;
        try {
            spatial = !!prop.isSpatial;
        } catch (e3) {}
        try {
            separated = !!prop.dimensionsSeparated;
        } catch (e4) {}
        try {
            vt = num(prop.propertyValueType);
        } catch (e5) {}

        var groupName = "";
        try {
            var depth = prop.propertyDepth;
            if (depth > 1) groupName = String(prop.propertyGroup(depth - 1).name);
        } catch (e6) {}

        /* 用户在 AE 里选中的关键帧范围（1 基、闭区间）。
           面板据此只改选中的那几段，与「读取」和多点图模式保持同一语义；
           拿不到选中态时留 null，由面板决定兜底行为。 */
        var selRange = null;
        try {
            var selKeys = prop.selectedKeys;
            if (selKeys && typeof selKeys.length === "number" && selKeys.length >= 2) {
                var lo = 0;
                var hi = 0;
                for (var sk = 0; sk < selKeys.length; sk++) {
                    var kv = Number(selKeys[sk]);
                    if (!(kv >= 1) || kv > numKeys) continue;
                    if (!lo || kv < lo) lo = kv;
                    if (kv > hi) hi = kv;
                }
                if (lo && hi && hi > lo) selRange = [lo, hi];
            }
        } catch (eSel) {}

        return "{" + [
            jfield("i", String(index)),
            jfield("loc", jstr(loc)),
            jfield("name", jstr(prop.name)),
            jfield("group", jstr(groupName)),
            jfield("matchName", jstr(safeMatchName(prop))),
            jfield("vt", String(vt)),
            jfield("dims", String(dims)),
            jfield("spatial", jbool(spatial)),
            jfield("sep", jbool(separated)),
            jfield("n", String(numKeys)),
            jfield("sig", jstr(propSignature(prop))),
            jfield("sel", selRange ? ("[" + selRange[0] + "," + selRange[1] + "]") : "null"),
            jfield("keys", "[" + keys.join(",") + "]")
        ].join(",") + "}";
    }

    function safeMatchName(prop) {
        try {
            return String(prop.matchName || "");
        } catch (e) {
            return "";
        }
    }

    /** 递归收图层下的动画属性（用户只选图层、没选属性时的兜底） */
    function walkGroup(group, depth, push) {
        if (!group || depth > 4) return;
        var count = 0;
        try {
            count = group.numProperties;
        } catch (e) {
            return;
        }
        for (var i = 1; i <= count; i++) {
            var child = null;
            try {
                child = group.property(i);
            } catch (e2) {
                continue;
            }
            if (!child) continue;
            var mn = safeMatchName(child);
            // 标记点不是动画属性，收进来只会干扰列表
            if (mn === "ADBE Marker") continue;
            var isGroup = false;
            try {
                isGroup = typeof child.numProperties === "number" && typeof child.numKeys !== "number";
            } catch (e3) {}
            if (isGroup) {
                walkGroup(child, depth + 1, push);
            } else {
                push(child);
            }
        }
    }

    /**
     * 收集「当前选中」的候选属性。
     *
     * 优先 comp.selectedProperties（用户在时间轴里直接点属性）；
     * 没有就看选中图层的 selectedProperties；
     * 再没有就把选中图层下所有带动画的属性递归收进来。
     * 三种路径都只读，绝不写选中态（AE 2021 给 selectedLayers 赋值会崩）。
     */
    /** 上一轮 collect 里因为「不支持时间缓动」被丢掉的属性数（面板据此给提示） */
    var lastFiltered = 0;

    /** 最近一次 ease 写入的原始异常。不记下来，面板只能报一个 "failed" 代号，
     *  用户和我们都没法知道 AE 到底嫌什么。 */
    var lastWriteError = "";

    function collect(comp) {
        var list = [];
        var seen = {};
        var filtered = 0;

        function push(prop) {
            if (!prop) return;
            var nk = -1;
            try {
                nk = prop.numKeys;
            } catch (e) {
                return;
            }
            if (typeof nk !== "number" || nk <= 0) return;
            // 路径 / 文本 / 标记吃不进 ease，收进来只会让写回整批失败
            if (!isNumericValue(prop)) {
                filtered++;
                return;
            }
            var loc = locOf(prop, comp);
            if (seen[loc]) return;
            seen[loc] = true;
            list.push({ prop: prop, loc: loc });
        }

        /* 关键：fallback 的判据是「用户到底有没有选中东西」，不是「收上来几条」。
           选了蒙版路径这种不支持缓动的属性时，list 同样是空的 —— 旧写法会因此
           退回到「遍历整层的所有属性」，把用户没选中的属性也一起改了。 */
        var hadSelection = false;

        try {
            var sp = comp.selectedProperties;
            if (sp && sp.length > 0) {
                hadSelection = true;
                for (var i = 0; i < sp.length; i++) push(sp[i]);
            }
        } catch (e1) {}

        if (!hadSelection) {
            var layers = null;
            try {
                layers = comp.selectedLayers;
            } catch (e2) {}
            if (layers && layers.length > 0) hadSelection = true;
            for (var l = 0; layers && l < layers.length; l++) {
                var layer = layers[l];
                var usedLayerProps = false;
                try {
                    var lp = layer.selectedProperties;
                    if (lp && lp.length > 0) {
                        usedLayerProps = true;
                        for (var j = 0; j < lp.length; j++) push(lp[j]);
                    }
                } catch (e3) {}
                // 图层里也没单独选中属性时，才遍历整层
                if (!usedLayerProps) walkGroup(layer, 0, push);
            }
        }

        lastFiltered = filtered;
        return list;
    }

    function snapshotJson() {
        lastFiltered = 0;
        var comp = activeComp();
        if (!comp) {
            return "{" + jfield("status", jstr("error")) + "," +
                jfield("reason", jstr("no_comp")) + "}";
        }

        var list = collect(comp);
        var props = [];
        for (var i = 0; i < list.length; i++) {
            try {
                props.push(propJson(list[i].prop, list[i].loc, i, comp));
            } catch (e) {}
        }

        var time = 0;
        try {
            time = comp.time;
        } catch (e2) {}

        var version = "";
        try {
            version = String(app.version);
        } catch (e3) {}

        return "{" + [
            jfield("status", jstr("ok")),
            jfield("version", jstr(VERSION)),
            jfield("ae", jstr(version)),
            jfield("comp", jstr(String(comp.name))),
            jfield("time", jnum(time)),
            /* 被丢掉的非数值属性数：面板据此区分「没选中」与「选中的不支持缓动」 */
            jfield("filtered", String(lastFiltered)),
            jfield("props", "[" + props.join(",") + "]")
        ].join(",") + "}";
    }

    /** 只取指纹：写回前用它做乐观并发校验（比整份快照便宜） */
    function signatureText(locsText) {
        var comp = activeComp();
        if (!comp) return "{" + jfield("status", jstr("error")) + "}";
        var list = collect(comp);
        var byLoc = {};
        for (var i = 0; i < list.length; i++) byLoc[list[i].loc] = list[i].prop;

        var lines = String(locsText || "").split("\n");
        var out = [];
        for (var j = 0; j < lines.length; j++) {
            var loc = lines[j];
            if (!loc) continue;
            var prop = byLoc[loc];
            var sig = "";
            if (prop) {
                try {
                    sig = propSignature(prop);
                } catch (e) {}
            }
            out.push("{" + jfield("loc", jstr(loc)) + "," + jfield("sig", jstr(sig)) + "}");
        }
        return "{" + jfield("status", jstr("ok")) + "," + jfield("sigs", "[" + out.join(",") + "]") + "}";
    }

    /* ============================================================
     * 三、AE 侧写
     * ============================================================ */

    /* AE 的插值枚举（实机确认，不是文档猜的）：
         KeyframeInterpolationType.LINEAR = 6612
         KeyframeInterpolationType.BEZIER = 6613
         KeyframeInterpolationType.HOLD   = 6614
       夹具证据：显式设 HOLD 的关键帧回读 6614；脚本写 ease 之后回读 6613；
       没动过的关键帧回读 6612。 */
    var ENUM_LINEAR = 6612;
    var ENUM_BEZIER = 6613;
    var ENUM_HOLD = 6614;

    /** AE 枚举 → 内部 1/2/3。快照必须走这一步：
     *  否则 6612/6613 直接进模型，`type === TYPE_LINEAR(1)` 永远不成立。 */
    function typeCode(value) {
        var raw = num(value);
        if (raw === ENUM_LINEAR) return TYPE_LINEAR;
        if (raw === ENUM_HOLD) return TYPE_HOLD;
        if (raw === ENUM_BEZIER) return TYPE_BEZIER;
        return TYPE_BEZIER;
    }

    function typeConst(code) {
        try {
            if (code === TYPE_LINEAR) return KeyframeInterpolationType.LINEAR;
            if (code === TYPE_HOLD) return KeyframeInterpolationType.HOLD;
            return KeyframeInterpolationType.BEZIER;
        } catch (e) {
            if (code === TYPE_LINEAR) return ENUM_LINEAR;
            if (code === TYPE_HOLD) return ENUM_HOLD;
            return ENUM_BEZIER;
        }
    }

    /** 异常文本里用的短数字，避免一串 0.33333333333 */
    function numTextOf(v) {
        var n = Number(v);
        if (!isFinite(n)) return String(v);
        return String(Math.round(n * 1000) / 1000);
    }

    function makeEase(speed, influence) {
        return new KeyframeEase(num(speed), clamp(num(influence), MIN_INFLUENCE, MAX_INFLUENCE));
    }

    /** 该键某一侧的 ease 数组（长度必须等于维度数）。
     *  入参 inf / m 都是**图表空间**的值，这里换算回 AE 的原始单位。 */
    function buildEase(keys, keyIndex, side, dims, inf, m, spatial) {
        // keyIndex 是快照里的 0 基序号
        var chord = [];
        var d;
        var dt = 0;
        var a, b;
        if (side === "out") {
            a = keys[keyIndex];
            b = keys[keyIndex + 1];
        } else {
            a = keys[keyIndex - 1];
            b = keys[keyIndex];
        }
        if (!a || !b) return null;
        dt = num(b.t) - num(a.t);
        if (dt <= 0) return null;
        for (d = 0; d < dims; d++) {
            chord.push((num(at(b.v, d, 0)) - num(at(a.v, d, 0))) / dt);
        }
        var mag = 0;
        for (d = 0; d < dims; d++) {
            var dv = num(at(b.v, d, 0)) - num(at(a.v, d, 0));
            mag += dv * dv;
        }
        mag = Math.sqrt(mag);
        var chordMag = dt > 0 ? mag / dt : 0;

        var aeInf = num(inf) / CALIBRATION.influenceScale;
        var aeM = num(m) / CALIBRATION.speedScale;

        /* ease 数组长度按属性类型分（2026-11-04 实机矩阵实测）：
           · 空间属性：**必须 1 个**（位置传 2/3 个会报「值数组没有 1 元素」），
             AE 把它当整条路径的统一时间重映射，速度是沿路径的模长速度
           · 非空间属性：长度**必须等于值分量数** —— 缩放是 [x,y,z]，传 1 个
             会报「值数组没有 3 元素」，这就是之前 write_failed 的真凶 */
        if (spatial) {
            return [makeEase(aeM * chordMag, aeInf)];
        }
        var list = [];
        for (d = 0; d < dims; d++) {
            // 各维用**自己的**弦斜率，才能保证每维的归一化进度一致
            list.push(makeEase(aeM * chord[d], aeInf));
        }
        return list.length ? list : [makeEase(aeM * chordMag, aeInf)];
    }

    /** 取当前 ease 并原样重建（setTemporalEaseAtKey 要求两侧都给） */
    function currentEase(prop, aeIndex, side, dims, spatial) {
        var raw = null;
        try {
            raw = side === "in" ? prop.keyInTemporalEase(aeIndex) : prop.keyOutTemporalEase(aeIndex);
        } catch (e) {
            return null;
        }
        if (!isArr(raw) || raw.length === 0) return null;
        /* 与 buildEase 对称：空间属性只有 1 条 ease，非空间属性每条对应一维。
           写回时两侧数组长度必须一致，否则 setTemporalEaseAtKey 会报
           「值数组没有 N 元素」。 */
        if (spatial) {
            return [makeEase(easeField(raw, 0, "speed"), easeField(raw, 0, "influence"))];
        }
        var list = [];
        for (var d = 0; d < dims; d++) {
            list.push(makeEase(easeField(raw, d, "speed"), easeField(raw, d, "influence")));
        }
        return list.length ? list : [makeEase(easeField(raw, 0, "speed"), easeField(raw, 0, "influence"))];
    }

    /**
     * 写一个键的一侧。
     *
     * 语义要点：
     *   · 拖把手隐含「这一侧改成贝塞尔」—— 线性/定格关键帧根本不吃 ease，
     *     不先把插值类型改掉，写进去的 ease 会被 AE 静默忽略。
     *   · 自动贝塞尔（keyTemporalAutoBezier）开着时 AE 会自己重算把手，
     *     脚本写的 ease 会被覆盖 → 先关掉。
     *   · roving 键的时间由 AE 自己排，写 ease 没有意义 → 直接跳过并报出来。
     */
    function writeSide(prop, keys, keyIndex, side, inf, m, dims, aeIndex) {
        if (side === "in" && keyIndex <= 0) return "edge";
        if (side === "out" && keyIndex >= keys.length - 1) return "edge";

        var roving = false;
        try {
            roving = boolOf(prop.keyRoving(aeIndex), 0);
        } catch (e) {}
        if (roving) return "roving";

        try {
            prop.setTemporalAutoBezierAtKey(aeIndex, false);
        } catch (e2) {}

        var inType = TYPE_BEZIER;
        var outType = TYPE_BEZIER;
        try {
            inType = typeCode(prop.keyInInterpolationType(aeIndex));
            outType = typeCode(prop.keyOutInterpolationType(aeIndex));
        } catch (e3) {}
        if (side === "in") inType = TYPE_BEZIER;
        else outType = TYPE_BEZIER;

        try {
            prop.setInterpolationTypeAtKey(aeIndex, typeConst(inType), typeConst(outType));
        } catch (e4) {}

        var spatial = false;
        try { spatial = !!prop.isSpatial; } catch (eSp) {}

        var eases = buildEase(keys, keyIndex, side, dims, inf, m, spatial);
        if (!eases) return "edge";

        var inArr = null;
        var outArr = null;
        if (side === "in") {
            inArr = eases;
            outArr = currentEase(prop, aeIndex, "out", dims, spatial);
        } else {
            inArr = currentEase(prop, aeIndex, "in", dims, spatial);
            outArr = eases;
        }
        if (!inArr || !outArr) return "edge";

        try {
            prop.setTemporalEaseAtKey(aeIndex, inArr, outArr);
        } catch (e5) {
            /* 单条写不进去就跳过这条，别让整批失败 —— 用户选中十条属性，
               其中一条是 AE 自己也不认的，其余九条应该照写。
               异常文本留下来，面板会把它显示出来。 */
            lastWriteError = (side === "in" ? "in" : "out") + " key" + (keyIndex + 1) +
                " (" + eases.length + " ease, inf=" + numTextOf(inf) +
                " m=" + numTextOf(m) + "): " + String(e5);
            return "failed";
        }
        return "ok";
    }

    function writeLinear(prop, keys, keyIndex, aeIndex) {
        try {
            prop.setInterpolationTypeAtKey(aeIndex, typeConst(TYPE_LINEAR), typeConst(TYPE_LINEAR));
            return "ok";
        } catch (e) {
            return "failed";
        }
    }

    function writeTangents(prop, keys, keyIndex, side, coords, dims, aeIndex) {
        /* AE 2021 实测：setSpatialTangentsAtKey 对 2D 位置也要求 **3 个**元素
           （传 2 个报「值数组没有 3 元素」），所以按 max(维度, 3) 补齐。 */
        var n = dims > 3 ? dims : 3;
        var inTans = [];
        var outTans = [];
        var i;
        for (i = 0; i < n; i++) {
            inTans.push(0);
            outTans.push(0);
        }
        var key = keys[keyIndex];
        try {
            for (i = 0; i < n; i++) {
                var keepIn = num(at(key.it, i, 0));
                var keepOut = num(at(key.ot, i, 0));
                var next = coords.length > i ? num(coords[i]) : 0;
                inTans[i] = side === "in" ? next : keepIn;
                outTans[i] = side === "out" ? next : keepOut;
            }
            prop.setSpatialTangentsAtKey(aeIndex, inTans, outTans);
            // 空间切线只在贝塞尔空间插值下生效
            try {
                prop.setSpatialAutoBezierAtKey(aeIndex, false);
            } catch (e2) {}
            return "ok";
        } catch (e3) {
            return "failed";
        }
    }

    var PRESETS = [
        { id: "linear", zh: "线性", en: "Linear", inf: 33.33, m: 1, sides: "both", linear: true },
        { id: "ease", zh: "缓动", en: "Easy Ease", inf: 33.33, m: 0, sides: "both" },
        { id: "ease-in", zh: "缓入", en: "Ease In", inf: 33.33, m: 0, sides: "in" },
        { id: "ease-out", zh: "缓出", en: "Ease Out", inf: 33.33, m: 0, sides: "out" },
        { id: "strong", zh: "强缓动", en: "Strong Ease", inf: 75, m: 0, sides: "both" },
        { id: "strong-in", zh: "强缓入", en: "Strong In", inf: 75, m: 0, sides: "in" },
        { id: "strong-out", zh: "强缓出", en: "Strong Out", inf: 75, m: 0, sides: "out" },
        { id: "hold", zh: "定格", en: "Hold", inf: 33.33, m: 1, sides: "both", hold: true }
    ];

    function presetById(id) {
        for (var i = 0; i < PRESETS.length; i++) {
            if (PRESETS[i].id === id) return PRESETS[i];
        }
        return null;
    }

    function presetsJson() {
        var out = [];
        for (var i = 0; i < PRESETS.length; i++) {
            out.push("{" + [
                jfield("id", jstr(PRESETS[i].id)),
                jfield("zh", jstr(PRESETS[i].zh)),
                jfield("en", jstr(PRESETS[i].en)),
                jfield("inf", jnum(PRESETS[i].inf)),
                jfield("m", jnum(PRESETS[i].m)),
                jfield("sides", jstr(PRESETS[i].sides))
            ].join(",") + "}");
        }
        return "{" + jfield("status", jstr("ok")) + "," + jfield("presets", "[" + out.join(",") + "]") + "}";
    }

    function writePreset(prop, keys, keyIndex, aeIndex, preset, dims) {
        if (!preset) return "unknown_preset";
        if (preset.linear) return writeLinear(prop, keys, keyIndex, aeIndex);
        if (preset.hold) {
            try {
                prop.setInterpolationTypeAtKey(aeIndex, typeConst(TYPE_HOLD), typeConst(TYPE_HOLD));
                return "ok";
            } catch (e) {
                return "failed";
            }
        }
        var result = "ok";
        var sides = preset.sides === "both" ? ["in", "out"] : [preset.sides];
        for (var i = 0; i < sides.length; i++) {
            var r = writeSide(prop, keys, keyIndex, sides[i], preset.inf, preset.m, dims, aeIndex);
            if (r !== "ok" && r !== "edge") result = r;
        }
        return result;
    }

    /* ============================================================
     * 四、文本协议（面板 → AE）
     *
     * 为什么不用 JSON：ExtendScript 没有 JSON.parse。整份 payload 只有几十行
     * 定长字段，用 \t 分隔比塞一个 JSON 解析器可靠得多。
     *
     * 行格式：
     *   expect\t loc \t sig
     *   force
     *   out   \t loc \t keyIndex(0基) \t influence \t m
     *   in    \t loc \t keyIndex(0基) \t influence \t m
     *   tan   \t loc \t keyIndex(0基) \t side(in|out) \t x \t y \t z
     *   linear\t loc \t keyIndex(0基)
     *   preset\t loc \t keyIndex(0基) \t presetId
     * ============================================================ */

    function speedsOf(prop, k, side, dims) {
        var raw = null;
        var out = [];
        try {
            raw = side === "in" ? prop.keyInTemporalEase(k) : prop.keyOutTemporalEase(k);
        } catch (e) {}
        /* 空间属性只有 1 条 ease：不能按维索引去取（第 2、3 维会变成默认 0，
           于是「位置」的斜率倍率被读成 0，曲线整条变平）。 */
        var idx0 = isSpatialProp(prop) ? 0 : -1;
        for (var d = 0; d < dims; d++) {
            out.push(easeField(raw, idx0 === 0 ? 0 : d, "speed"));
        }
        return out;
    }

    function isSpatialProp(prop) {
        try {
            return !!prop.isSpatial;
        } catch (e) {
            return false;
        }
    }

    function infsOf(prop, k, side, dims) {
        var raw = null;
        var out = [];
        try {
            raw = side === "in" ? prop.keyInTemporalEase(k) : prop.keyOutTemporalEase(k);
        } catch (e) {}
        // 与 speedsOf 同理：空间属性只有 1 条 ease
        var one = isSpatialProp(prop);
        for (var d = 0; d < dims; d++) out.push(easeField(raw, one ? 0 : d, "influence"));
        return out;
    }

    function tangentsOf(prop, k, side, dims) {
        var raw = null;
        var out = [];
        try {
            raw = side === "in" ? prop.keyInSpatialTangent(k) : prop.keyOutSpatialTangent(k);
        } catch (e) {}
        for (var d = 0; d < dims; d++) out.push(tangentOf(raw, d, dims));
        return out;
    }

    function parseKeyFromSnapshot(prop, dims) {
        var keys = [];
        var n = 0;
        try {
            n = prop.numKeys;
        } catch (e) {
            return keys;
        }
        for (var k = 1; k <= n; k++) {
            keys.push({
                t: prop.keyTime(k),
                v: valueArr(prop.keyValue(k)),
                tin: typeCode(prop.keyInInterpolationType(k)),
                tout: typeCode(prop.keyOutInterpolationType(k)),
                is: speedsOf(prop, k, "in", dims),
                ii: infsOf(prop, k, "in", dims),
                os: speedsOf(prop, k, "out", dims),
                oi: infsOf(prop, k, "out", dims),
                it: tangentsOf(prop, k, "in", dims),
                ot: tangentsOf(prop, k, "out", dims)
            });
        }
        return keys;
    }

    /**
     * 执行面板下发的写操作（不含 undo 组，由 applyText 包住）。
     *
     * expect 行存在时做乐观并发校验：只有在「AE 现值指纹 == 面板快照指纹」
     * 时才写。AE 没有属性变化事件，这是唯一能避免静默覆盖外部改动的办法。
     * 面板选择「覆盖」时会带 force 行。
     */
    function applyTextRaw(text) {
        lastWriteError = "";
        var comp = activeComp();
        if (!comp) {
            return "{" + jfield("status", jstr("error")) + "," + jfield("reason", jstr("no_comp")) + "}";
        }

        var list = collect(comp);
        var byLoc = {};
        var i;
        for (i = 0; i < list.length; i++) byLoc[list[i].loc] = list[i].prop;

        var lines = String(text === undefined || text === null ? "" : text).split("\n");
        var ops = [];
        var expects = {};
        var force = false;
        var graphBlocks = {};
        var graphOrder = [];
        var graphOpen = null;
        var tools = [];
        var j;

        for (j = 0; j < lines.length; j++) {
            var line = lines[j];
            if (!line) continue;
            var f = line.split("\t");
            var kind = f[0];
            if (kind === "force") {
                force = true;
            } else if (kind === "expect") {
                expects[f[1]] = f[2];
            } else if (kind === "graph_begin") {
                graphOpen = {
                    loc: f[1] || "",
                    mode: f[4] || "numeric",
                    nodes: [],
                    startKey: 0,
                    endKey: 0
                };
            } else if (kind === "graph_node") {
                if (!graphOpen || f.length < 9) {
                    return "{" + jfield("status", jstr("error")) + "," +
                        jfield("reason", jstr("graph_block_invalid")) + "}";
                }
                graphOpen.nodes.push({
                    id: f[1],
                    role: f[2],
                    t: num(f[3]),
                    v: num(f[4]),
                    inHandle: f[5] === "-" ? null : { dt: num(f[5]), dv: num(f[6]) },
                    outHandle: f[7] === "-" ? null : { dt: num(f[7]), dv: num(f[8]) }
                });
            } else if (kind === "graph_end") {
                if (!graphOpen) {
                    return "{" + jfield("status", jstr("error")) + "," +
                        jfield("reason", jstr("graph_block_invalid")) + "}";
                }
                graphOpen.loc = graphOpen.loc || (f[1] || "");
                graphBlocks[graphOpen.loc] = graphOpen;
                graphOrder.push(graphOpen.loc);
                graphOpen = null;
            } else if (kind === "tool") {
                tools.push(f);
            } else if (kind === "out" || kind === "in" || kind === "tan" ||
                       kind === "linear" || kind === "preset") {
                ops.push(f);
            }
        }

        if (!force) {
            for (var checkLoc in expects) {
                if (!expects.hasOwnProperty(checkLoc)) continue;
                var p = byLoc[checkLoc];
                if (!p) {
                    return "{" + jfield("status", jstr("conflict")) + "," +
                        jfield("reason", jstr("loc_missing")) + "," +
                        jfield("loc", jstr(checkLoc)) + "}";
                }
                var cur = "";
                try {
                    cur = propSignature(p);
                } catch (e) {}
                if (cur !== expects[checkLoc]) {
                    return "{" + jfield("status", jstr("conflict")) + "," +
                        jfield("reason", jstr("changed")) + "," +
                        jfield("loc", jstr(checkLoc)) + "," +
                        jfield("sig", jstr(cur)) + "," +
                        jfield("expect", jstr(expects[checkLoc])) + "}";
                }
            }
        }

        var applied = 0;
        var skipped = [];
        var graphsOut = [];

        /* 图块优先处理：它要重建关键帧，和逐键 ease 操作混在一起会互相覆盖 */
        for (var gi = 0; gi < graphOrder.length; gi++) {
            var gLoc = graphOrder[gi];
            var gProp = byLoc[gLoc];
            if (!gProp) {
                /* 脚本通道的 loc 可能指向没被选中的属性，补一次按 loc 查找 */
                var foundGraphProp = findPropByLoc(comp, gLoc);
                if (foundGraphProp) {
                    gProp = foundGraphProp.prop;
                    byLoc[gLoc] = gProp;
                }
            }
            if (!gProp) {
                skipped.push("loc_missing");
                continue;
            }
            var block = graphBlocks[gLoc];
            /* 脚本通道可以用显式键号覆盖（面板在时间轴上选不到时走这条） */
            if (pendingGraphRange && pendingGraphRange.loc === gLoc) {
                block.startKey = pendingGraphRange.startKey;
                block.endKey = pendingGraphRange.endKey;
            }
            var gRes;
            try {
                gRes = applyGraphBlock(gProp, block);
            } catch (eGraph) {
                return "{" + jfield("status", jstr("error")) + "," +
                    jfield("reason", jstr("write_failed")) + "," +
                    jfield("detail", jstr(String(eGraph))) + "," +
                    jfield("loc", jstr(gLoc)) + "}";
            }
            if (gRes.status === "ok") {
                applied++;
                graphsOut.push("{" + jfield("loc", jstr(gLoc)) + "," +
                    jfield("graph", graphJson(gRes.graph)) + "}");
            } else {
                skipped.push(gRes.reason || "failed");
            }
        }

        /* 快捷工具：换键 / 冻结，一条属性失败不影响其它属性 */
        for (var ti = 0; ti < tools.length; ti++) {
            var tLoc = tools[ti][1];
            var tProp = byLoc[tLoc];
            if (!tProp) {
                var foundToolProp = findPropByLoc(comp, tLoc);
                if (foundToolProp) {
                    tProp = foundToolProp.prop;
                    byLoc[tLoc] = tProp;
                }
            }
            if (!tProp) {
                skipped.push("loc_missing");
                continue;
            }
            var tRes;
            try {
                tRes = applyQuickTool(tProp, tools[ti][2]);
            } catch (eTool) {
                tRes = "failed";
            }
            if (tRes === "ok") applied++;
            else skipped.push(tRes);
        }

        for (j = 0; j < ops.length; j++) {
            var op = ops[j];
            var opLoc = op[1];
            var prop = byLoc[opLoc];
            if (!prop) {
                skipped.push("loc_missing");
                continue;
            }
            var dims = 1;
            try {
                dims = valueDims(prop.value);
            } catch (e2) {}
            var keys = parseKeyFromSnapshot(prop, dims);
            var keyIndex = parseInt(op[2], 10);
            if (isNaN(keyIndex) || keyIndex < 0 || keyIndex >= keys.length) {
                skipped.push("key_out_of_range");
                continue;
            }
            var aeIndex = keyIndex + 1;
            var status = "failed";

            try {
                if (op[0] === "out" || op[0] === "in") {
                    status = writeSide(prop, keys, keyIndex, op[0],
                        num(op[3]), num(op[4]), dims, aeIndex);
                } else if (op[0] === "tan") {
                    var coords = [];
                    for (var c = 4; c < op.length; c++) coords.push(num(op[c]));
                    status = writeTangents(prop, keys, keyIndex, op[3], coords, dims, aeIndex);
                } else if (op[0] === "linear") {
                    status = writeLinear(prop, keys, keyIndex, aeIndex);
                } else if (op[0] === "preset") {
                    status = writePreset(prop, keys, keyIndex, aeIndex, presetById(op[3]), dims);
                }
            } catch (e3) {
                return "{" + jfield("status", jstr("error")) + "," +
                    jfield("reason", jstr("write_failed")) + "," +
                    jfield("detail", jstr(String(e3))) + "," +
                    jfield("loc", jstr(opLoc)) + "}";
            }

            if (status === "ok") applied++;
            else skipped.push(status);
        }

        // 写回后把指纹回传给面板，面板据此更新自己的并发基线
        var sigs = [];
        for (var sigLoc in expects) {
            if (!expects.hasOwnProperty(sigLoc)) continue;
            var p2 = byLoc[sigLoc];
            var s = "";
            if (p2) {
                try {
                    s = propSignature(p2);
                } catch (e4) {}
            }
            sigs.push("{" + jfield("loc", jstr(sigLoc)) + "," + jfield("sig", jstr(s)) + "}");
        }

        var skipText = [];
        for (j = 0; j < skipped.length; j++) skipText.push(jstr(skipped[j]));

        var out = jfield("status", jstr("ok")) + "," +
            jfield("applied", String(applied)) + "," +
            jfield("skipped", "[" + skipText.join(",") + "]") + "," +
            jfield("sigs", "[" + sigs.join(",") + "]") + "," +
            jfield("graphs", "[" + graphsOut.join(",") + "]");
        /* 有失败时把 AE 的原话带上：面板只报「N 条不支持缓动」是不够的 */
        if (lastWriteError) out += "," + jfield("detail", jstr(lastWriteError));
        return "{" + out + "}";
    }

    /**
     * 带 undo 组的批量写入。
     *
     * beginUndoGroup 必须与 endUndoGroup 严格配对：中途抛异常时 end 被跳过，
     * AE 之后的撤销栈都会错位。所以异常在 applyTextRaw 内部被吃掉并转成
     * 返回值，这里只负责成对调用。
     */
    function applyText(text) {
        var started = false;
        var result;
        try {
            app.beginUndoGroup("DreamEngine 曲线编辑");
            started = true;
        } catch (e0) {
            // 已有别的 undo 组开着：不强行嵌套，直接写（代价是撤销粒度变粗）
            started = false;
        }
        try {
            result = applyTextRaw(text);
        } catch (e) {
            result = "{" + jfield("status", jstr("error")) + "," +
                jfield("reason", jstr("write_exception")) + "," +
                jfield("detail", jstr(String(e))) + "}";
        }
        if (started) {
            try {
                app.endUndoGroup();
            } catch (e2) {}
        }
        return result;
    }

    /* ============================================================
     * 五、多点图：选区解析、托管元数据与回读
     *
     * 与面板的约定：
     *   · 用户必须在时间轴上**正好选中两个关键帧**才有「这一段」的概念；
     *   · 区间内部的原生关键帧一律不许动（那是用户自己的动画），
     *     所以能不能编辑由「内部键是否都在托管清单里」决定；
     *   · 托管信息写在属性注释里（属性名旁边能看到的那个 comment），
     *     块外的普通文字必须原样保留。
     * ============================================================ */

    var META_OPEN = "[[DREAMENGINE_CURVE_META_V1]]";
    var META_CLOSE = "[[/DREAMENGINE_CURVE_META_V1]]";
    var TIME_EPS = 0.0001;

    /**
     * 找到属性所属的图层。
     *
     * 为什么要向上找：托管元数据存在**图层注释**里，而不是属性注释。
     * AE 2021 实测（tools/diag_curve_comment.jsx）：
     *   · prop.comment  写完同一句柄能读回，换个句柄就没了 —— 它不是真的
     *     AE 属性，赋值只是挂在 JS 代理上，不会进 .aep；
     *   · 效果组的 comment 同样；
     *   · 只有 layer.comment 换句柄仍能读回，是真持久。
     * 图层用 `index`（图层号）与属性组区分：PropertyGroup 只有 propertyIndex。
     */
    function layerOfProp(prop) {
        var node = prop;
        for (var i = 0; i < 8; i++) {
            var parent = null;
            try {
                parent = node.propertyGroup(1);
            } catch (e) {
                return null;
            }
            if (!parent) return null;
            try {
                if (typeof parent.index === "number") return parent;
            } catch (e2) {}
            node = parent;
        }
        return null;
    }

    function metaTextOf(prop, layer) {
        var target = layer || layerOfProp(prop);
        if (target) {
            try {
                return String(target.comment === undefined || target.comment === null ? "" : target.comment);
            } catch (e) {}
        }
        /* 兜底：拿不到图层时退回属性注释（单元测试的假属性就走这条） */
        try {
            return String(prop.comment === undefined || prop.comment === null ? "" : prop.comment);
        } catch (e2) {}
        return "";
    }

    function setMetaText(prop, layer, text) {
        var target = layer || layerOfProp(prop);
        if (target) {
            target.comment = text;
            return;
        }
        prop.comment = text;
    }

    function fmt4(value) {
        return G.round4(value).toFixed(4);
    }

    function toNumber(text) {
        var n = Number(text);
        return isFinite(n) ? n : NaN;
    }

    function handleFromPair(text) {
        if (!text || text === "-") return null;
        var parts = String(text).split(",");
        if (parts.length !== 2) return null;
        var dt = toNumber(parts[0]);
        var dv = toNumber(parts[1]);
        if (isNaN(dt) || isNaN(dv)) return null;
        return { dt: dt, dv: dv };
    }

    function handlePairText(handle) {
        if (!handle) return "-";
        return fmt4(handle.dt) + "," + fmt4(handle.dv);
    }

    /**
     * loc 用 "|" 分隔各层级，而托管块本身也是 "|" 分隔的 —— 不转义的话
     * "Comp|Slider" 会把 I 行拆成 10 段，整块被判成损坏。只转义会破坏格式
     * 的三个字符，读回来再还原（顺序：先转义 % 再转义 |）。
     */
    function escLoc(loc) {
        var s = String(loc === undefined || loc === null ? "" : loc);
        s = s.replace(/%/g, "%25").replace(/\|/g, "%7C");
        s = s.replace(/\r/g, "%0D").replace(/\n/g, "%0A");
        return s;
    }

    function unescLoc(text) {
        var s = String(text === undefined || text === null ? "" : text);
        s = s.replace(/%0A/gi, "\n").replace(/%0D/gi, "\r");
        s = s.replace(/%7C/gi, "|");
        s = s.replace(/%25/gi, "%");
        return s;
    }

    /** 解析托管注释块。
     * 返回 { ok, plain, entries }：
     *   · plain 永远是「去掉托管块之后」的正文，块坏掉也不会污染用户文字；
     *   · ok=false 表示没有块或块不可信，调用方据此拒绝改写。
     */
    function parseGraphMeta(comment) {
        var text = String(comment === undefined || comment === null ? "" : comment);
        var result = { ok: false, plain: text, entries: [] };
        var start = text.indexOf(META_OPEN);
        var end = text.indexOf(META_CLOSE);
        if (start < 0 && end < 0) return result;

        var plain;
        var body;
        if (start >= 0 && end > start) {
            plain = text.substring(0, start) + text.substring(end + META_CLOSE.length);
            body = text.substring(start + META_OPEN.length, end);
        } else if (start >= 0) {
            plain = text.substring(0, start) + text.substring(start + META_OPEN.length);
            body = "";
        } else {
            plain = text.substring(0, end) + text.substring(end + META_CLOSE.length);
            body = "";
        }
        result.plain = plain.replace(/^\n+/, "").replace(/\n+$/, "");

        if (!body) return result;

        var lines = body.split("\n");
        var entries = [];
        var current = null;
        var ok = true;
        var i;
        var m;

        for (i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line) continue;
            var f = line.split("|");

            if (f[0] === "I") {
                /* 9 段 = 带属性路径（当前格式）；8 段 = 早期不带 loc 的块 */
                var locField = "";
                var base = 1;
                if (f.length === 9) {
                    locField = unescLoc(f[1]);
                    base = 2;
                } else if (f.length !== 8) {
                    ok = false;
                    break;
                }
                var startTime = toNumber(f[base]);
                var endTime = toNumber(f[base + 1]);
                if (isNaN(startTime) || isNaN(endTime) || endTime <= startTime) { ok = false; break; }
                current = {
                    loc: locField,
                    startTime: startTime,
                    endTime: endTime,
                    signature: f[base + 2],
                    mode: f[base + 3] || "numeric",
                    startKey: parseInt(f[base + 4], 10),
                    stamp: toNumber(f[base + 5]),
                    complete: f[base + 6] === "1",
                    managedTimes: [],
                    nodes: []
                };
                entries.push(current);
            } else if (f[0] === "M") {
                if (!current || f.length !== 2) { ok = false; break; }
                var times = f[1] ? String(f[1]).split(",") : [];
                for (m = 0; m < times.length; m++) {
                    if (!times[m]) continue;
                    var tv = toNumber(times[m]);
                    if (isNaN(tv)) { ok = false; break; }
                    current.managedTimes.push(tv);
                }
                if (!ok) break;
            } else if (f[0] === "N") {
                if (!current || f.length !== 7) { ok = false; break; }
                var nt = toNumber(f[3]);
                var nv = toNumber(f[4]);
                if (isNaN(nt) || isNaN(nv)) { ok = false; break; }
                current.nodes.push({
                    id: f[1],
                    role: f[2],
                    t: nt,
                    v: nv,
                    inHandle: handleFromPair(f[5]),
                    outHandle: handleFromPair(f[6])
                });
            } else {
                ok = false;
                break;
            }
        }

        if (!ok) return result;
        for (m = 0; m < entries.length; m++) {
            if (entries[m].nodes.length < 2) return result;
        }
        result.ok = entries.length > 0;
        result.entries = entries;
        return result;
    }

    /** 把 entries 写回注释：块外正文原样保留，托管块整段重写 */
    function mergeGraphMeta(comment, entries) {
        var parsed = parseGraphMeta(comment);
        var lines = [META_OPEN];
        var list = entries || [];
        var i;
        var k;
        for (i = 0; i < list.length; i++) {
            var en = list[i];
            lines.push([
                "I", escLoc(en.loc), fmt4(en.startTime), fmt4(en.endTime),
                String(en.signature || ""), String(en.mode || "numeric"),
                String(en.startKey === undefined ? 0 : en.startKey),
                String(en.stamp === undefined ? 0 : en.stamp),
                en.complete ? "1" : "0"
            ].join("|"));

            var times = [];
            var managed = en.managedTimes || [];
            for (k = 0; k < managed.length; k++) times.push(fmt4(managed[k]));
            lines.push("M|" + times.join(","));

            var nodes = en.nodes || [];
            for (k = 0; k < nodes.length; k++) {
                var n = nodes[k];
                lines.push([
                    "N", n.id, n.role, fmt4(n.t), fmt4(n.v),
                    handlePairText(n.inHandle), handlePairText(n.outHandle)
                ].join("|"));
            }
        }
        lines.push(META_CLOSE);

        var plain = parsed.plain ? parsed.plain.replace(/\s+$/, "") : "";
        var block = lines.join("\n");
        return plain ? plain + "\n" + block : block;
    }

    /* ---------- 选区解析 ---------- */

    /**
     * 决定「改哪一段」：优先用 AE 的选中键；拿不到选中态时，
     * 只有属性本身正好两个键才敢默认首尾（否则无从判断用户想改哪段）。
     * 绝不写 selectedKeys。
     */
    /**
     * 决定「改哪一段」：优先用 AE 的选中键；拿不到选中态时，
     * 只有属性本身正好两个键才敢默认首尾（否则无从判断用户想改哪段）。
     * 绝不写 selectedKeys。
     *
     * 选中 N 个键（N>=2）视为「改首尾之间那 N-1 段」——这样面板里
     * 「模板」和「多点图」两个入口的作用范围完全一致；
     * 旧实现只认正好两个键，选 3 个及以上会被判成 selection_needs_two。
     */
    function resolveGraphKeys(prop) {
        var nk = 0;
        try {
            nk = prop.numKeys;
        } catch (e) {}

        var sel = null;
        try {
            sel = prop.selectedKeys;
        } catch (e2) {}

        if (sel && typeof sel.length === "number" && sel.length >= 2) {
            var lo = 0;
            var hi = 0;
            for (var si = 0; si < sel.length; si++) {
                var v = Number(sel[si]);
                if (!(v >= 1) || v > nk) continue;
                if (!lo || v < lo) lo = v;
                if (v > hi) hi = v;
            }
            if (lo && hi && hi > lo) {
                return { ok: true, startKey: lo, endKey: hi, reason: "" };
            }
        }
        if (nk === 2) return { ok: true, startKey: 1, endKey: 2, reason: "" };
        return { ok: false, startKey: 0, endKey: 0, reason: "selection_needs_two" };
    }

    function selectedPropsRaw(comp) {
        var out = [];
        try {
            var sp = comp.selectedProperties;
            if (sp) {
                for (var i = 0; i < sp.length; i++) {
                    if (sp[i]) out.push(sp[i]);
                }
            }
        } catch (e) {}
        return out;
    }

    function findPropByLoc(comp, loc) {
        var list = collect(comp);
        var i;
        for (i = 0; i < list.length; i++) {
            if (list[i].loc === loc) return list[i];
        }
        var extra = selectedPropsRaw(comp);
        for (i = 0; i < extra.length; i++) {
            var l = "";
            try {
                l = locOf(extra[i], comp);
            } catch (e) {}
            if (l === loc) return { prop: extra[i], loc: l };
        }

        /* 脚本通道：目标属性可能根本没被选中（AE 的 layer.selected = true
           是「替换」选中而非累加，多图层时只有最后一个在选）。按 loc 在
           整个合成里找一遍 —— 只读遍历，不碰任何选中态。 */
        try {
            for (var li = 1; li <= comp.numLayers; li++) {
                var hit = null;
                walkGroup(comp.layer(li), 0, function (prop) {
                    if (hit) return;
                    var lp = "";
                    try {
                        lp = locOf(prop, comp);
                    } catch (e2) {}
                    if (lp === loc) hit = prop;
                });
                if (hit) return { prop: hit, loc: loc };
            }
        } catch (e3) {}
        return null;
    }

    /* ---------- 图数据 ---------- */

    function handleJson(handle) {
        if (!handle) return "null";
        return "{" + jfield("dt", jnum(handle.dt)) + "," +
            jfield("dv", jnum(handle.dv)) + "}";
    }

    function graphJson(graph) {
        if (!graph) return "null";
        var parts = [];
        for (var i = 0; i < graph.nodes.length; i++) {
            var n = graph.nodes[i];
            parts.push("{" + [
                jfield("id", jstr(n.id)),
                jfield("role", jstr(n.role)),
                jfield("t", jnum(n.t)),
                jfield("v", jnum(n.v)),
                jfield("inHandle", handleJson(n.inHandle)),
                jfield("outHandle", handleJson(n.outHandle))
            ].join(",") + "}");
        }
        return "{" + [
            jfield("version", String(G.VERSION)),
            jfield("kind", jstr(G.KIND)),
            jfield("propertyMode", jstr(String(graph.propertyMode || "numeric"))),
            jfield("nodes", "[" + parts.join(",") + "]")
        ].join(",") + "}";
    }

    /** 快照里某一段 → 两节点图（与面板 keysBezier 同一套换算） */
    function graphFromSegment(keys, segIndex) {
        var seg = segmentOf(keys, segIndex);
        if (!seg) return null;
        if (seg.type === TYPE_LINEAR) return G.fromBezier([0, 0, 1, 1], "numeric");
        var x1 = clamp(seg.infOut / 100, 0, 1);
        var x2 = clamp(1 - seg.infIn / 100, 0, 1);
        return G.fromBezier([x1, seg.mOut * x1, x2, 1 - seg.mIn * (1 - x2)], "numeric");
    }

    /**
     * 读一个属性的某一段。
     * 返回 { ok, reason, graph, source, editable, mode, startTime, endTime, managed }
     */
    function graphPayloadFor(prop, comp, startKey, endKey, loc) {
        var nk = 0;
        try {
            nk = prop.numKeys;
        } catch (e) {}
        if (!(startKey >= 1 && endKey <= nk && startKey < endKey)) {
            return { ok: false, reason: "key_out_of_range" };
        }

        var startTime = num(prop.keyTime(startKey));
        var endTime = num(prop.keyTime(endKey));
        if (endTime - startTime <= 1e-9) return { ok: false, reason: "zero_duration" };

        var comment = metaTextOf(prop, null);
        var meta = parseGraphMeta(comment);

        var managed = [];
        var entry = null;
        var i;
        var wantLoc = loc === undefined || loc === null ? "" : String(loc);
        if (meta.ok) {
            for (i = 0; i < meta.entries.length; i++) {
                var candidate = meta.entries[i];
                if (Math.abs(candidate.startTime - startTime) > TIME_EPS) continue;
                /* loc 为空的是早期块，只按时间匹配 */
                if (candidate.loc && wantLoc && candidate.loc !== wantLoc) continue;
                entry = candidate;
                managed = candidate.managedTimes;
                break;
            }
        }

        var interior = [];
        for (var k = startKey + 1; k < endKey; k++) {
            var kt = num(prop.keyTime(k));
            var isManaged = false;
            for (i = 0; i < managed.length; i++) {
                if (Math.abs(managed[i] - kt) <= TIME_EPS) {
                    isManaged = true;
                    break;
                }
            }
            if (!isManaged) interior.push(kt);
        }

        var graph = null;
        var source = "ease";
        var mode = "numeric";

        if (entry && entry.nodes.length >= 2) {
            graph = G.normalize({
                version: G.VERSION,
                kind: G.KIND,
                propertyMode: entry.mode,
                nodes: entry.nodes
            });
            if (graph) {
                source = "metadata";
                mode = entry.mode;
            }
        }

        if (!graph) {
            var numeric = isNumericValue(prop);
            if (!numeric) {
                return {
                    ok: false,
                    reason: "no_temporal_ease",
                    editable: false,
                    mode: "readonly_value"
                };
            }
            var dims = 1;
            try {
                dims = valueDims(prop.value);
            } catch (e3) {}
            var keys = parseKeyFromSnapshot(prop, dims);
            graph = graphFromSegment(keys, startKey - 1);
            if (!graph) return { ok: false, reason: "no_segment" };
        }

        var editable = true;
        var reason = "";
        if (interior.length > 0) {
            editable = false;
            reason = "native_intermediate";
        }

        return {
            ok: true,
            reason: reason,
            graph: graph,
            source: source,
            editable: editable,
            mode: mode,
            startKey: startKey,
            endKey: endKey,
            startTime: startTime,
            endTime: endTime,
            managed: managed
        };
    }

    function propGraphJson(prop, comp, loc, payload) {
        var sig = "";
        try {
            sig = propSignature(prop);
        } catch (e) {}
        return "{" + [
            jfield("loc", jstr(loc)),
            jfield("name", jstr(prop.name)),
            jfield("matchName", jstr(safeMatchName(prop))),
            jfield("sig", jstr(sig)),
            jfield("startKey", String(payload.startKey)),
            jfield("endKey", String(payload.endKey)),
            jfield("startTime", jnum(payload.startTime)),
            jfield("endTime", jnum(payload.endTime)),
            jfield("source", jstr(payload.source)),
            jfield("mode", jstr(payload.mode)),
            jfield("editable", jbool(payload.editable)),
            jfield("reason", jstr(payload.reason || "")),
            jfield("graph", graphJson(payload.graph))
        ].join(",") + "}";
    }

    /** 指定属性的回读（脚本通道与面板都走这里） */
    function readGraphForPropertyJson(loc, startKey, endKey) {
        var comp = activeComp();
        if (!comp) {
            return resultJson([["status", jstr("error")], ["reason", jstr("no_comp")]]);
        }
        var found = findPropByLoc(comp, loc);
        if (!found) {
            return resultJson([
                ["status", jstr("error")],
                ["reason", jstr("loc_missing")],
                ["loc", jstr(loc)]
            ]);
        }
        var payload = graphPayloadFor(found.prop, comp, Number(startKey), Number(endKey), found.loc);
        if (!payload.ok) {
            return resultJson([
                ["status", jstr("error")],
                ["reason", jstr(payload.reason || "unreadable")],
                ["loc", jstr(loc)]
            ]);
        }
        return "{" + jfield("status", jstr("ok")) + "," +
            propGraphJson(found.prop, comp, found.loc, payload).substring(1);
    }

    /** 面板入口：取第一个可用属性 + 跳过原因清单 */
    function readGraphJson() {
        var comp = activeComp();
        if (!comp) {
            return "{" + jfield("status", jstr("error")) + "," +
                jfield("reason", jstr("no_comp")) + "}";
        }

        var skipped = [];
        var props = [];
        var seen = {};
        var list = collect(comp);
        var i;

        /* 数值属性走 collect；非数值属性（路径/文本）也要能被读成只读图 */
        var candidates = [];
        for (i = 0; i < list.length; i++) {
            candidates.push(list[i]);
            seen[list[i].loc] = true;
        }
        var extra = selectedPropsRaw(comp);
        for (i = 0; i < extra.length; i++) {
            var l = "";
            try {
                l = locOf(extra[i], comp);
            } catch (e) {}
            if (l && !seen[l]) {
                seen[l] = true;
                candidates.push({ prop: extra[i], loc: l });
            }
        }

        for (i = 0; i < candidates.length && props.length === 0; i++) {
            var cand = candidates[i];
            var rk = resolveGraphKeys(cand.prop);
            if (!rk.ok) {
                skipped.push(rk.reason);
                continue;
            }
            var payload = graphPayloadFor(cand.prop, comp, rk.startKey, rk.endKey, cand.loc);
            if (!payload.ok) {
                skipped.push(payload.reason || "unreadable");
                continue;
            }
            props.push(propGraphJson(cand.prop, comp, cand.loc, payload));
        }

        var time = 0;
        try {
            time = comp.time;
        } catch (e2) {}
        var version = "";
        try {
            version = String(app.version);
        } catch (e3) {}

        return "{" + [
            jfield("status", jstr("ok")),
            jfield("version", jstr(VERSION)),
            jfield("ae", jstr(version)),
            jfield("comp", jstr(String(comp.name))),
            jfield("time", jnum(time)),
            jfield("filtered", String(lastFiltered)),
            jfield("skipped", skippedArray(skipped)),
            jfield("props", "[" + props.join(",") + "]")
        ].join(",") + "}";
    }

    /* ============================================================
     * 六、多点图：安全应用（托管关键帧）
     *
     * 三条铁律：
     *   1. 区间里只要有一个「不是本产品建的」中间键，整条属性拒绝改写，
     *      绝不删用户的关键帧；
     *   2. 重写时先删旧的托管键、再建新键、最后写 ease，全程一个 undo 组；
     *   3. 元数据写失败必须把刚建的键删掉并还原注释，不能留下无主的关键帧。
     * ============================================================ */

    /** 脚本通道指定区间时用：applyTextRaw 从这里取显式的 start/end 键号 */
    var pendingGraphRange = null;

    function withLoc(payload, loc) {
        var lines = String(payload === undefined || payload === null ? "" : payload).split("\n");
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var f = lines[i].split("\t");
            if (f[0] === "graph_begin" || f[0] === "graph_end") {
                f[1] = String(loc);
                out.push(f.join("\t"));
            } else {
                out.push(lines[i]);
            }
        }
        return out.join("\n");
    }

    function findKeyIndexByTime(prop, time) {
        var n = 0;
        try {
            n = prop.numKeys;
        } catch (e) {
            return 0;
        }
        for (var k = 1; k <= n; k++) {
            if (Math.abs(num(prop.keyTime(k)) - num(time)) <= TIME_EPS) return k;
        }
        return 0;
    }

    function inTimes(list, time) {
        for (var i = 0; i < list.length; i++) {
            if (Math.abs(list[i] - time) <= TIME_EPS) return true;
        }
        return false;
    }

    /** 按比例在两端的值之间插值（多维按维独立，与图的 v 语义一致） */
    /** 两个端点值之间按比例取值（端点值先取好再传进来，避免键索引位移） */
    function lerpValue(vA, vB, ratio, dims) {
        var out = [];
        for (var d = 0; d < dims; d++) {
            var a = num(at(vA, d, 0));
            var b = num(at(vB, d, 0));
            out.push(a + (b - a) * num(ratio));
        }
        return dims === 1 ? out[0] : out;
    }

    function removeKeysSafely(prop, indices) {
        indices.sort(function (a, b) { return b - a; });
        for (var i = 0; i < indices.length; i++) {
            try {
                prop.removeKey(indices[i]);
            } catch (e) {}
        }
    }

    /**
     * 把一张图写进一个属性的某一段。返回 { status, reason, graph, managedTimes, complete }。
     * 调用方负责 undo 组（applyText 已经包好），这里绝不自己再开一层。
     */
    function applyGraphBlock(prop, block) {
        var graph = G.normalize({
            version: G.VERSION,
            kind: G.KIND,
            propertyMode: block.mode || "numeric",
            nodes: block.nodes
        });
        if (!graph || graph.nodes.length < 2) {
            return { status: "skipped", reason: "graph_invalid" };
        }

        var startKey = num(block.startKey);
        var endKey = num(block.endKey);
        if (!(startKey >= 1 && endKey >= 1 && startKey < endKey)) {
            var rk = resolveGraphKeys(prop);
            if (!rk.ok) return { status: "skipped", reason: rk.reason };
            startKey = rk.startKey;
            endKey = rk.endKey;
        }

        var nk = 0;
        try {
            nk = prop.numKeys;
        } catch (e) {}
        if (endKey > nk) return { status: "skipped", reason: "key_out_of_range" };

        var startTime = num(prop.keyTime(startKey));
        var endTime = num(prop.keyTime(endKey));
        if (endTime - startTime <= 1e-9) return { status: "skipped", reason: "zero_duration" };

        /* 元数据存在图层注释里：一个图层下所有属性共用一个块，按 loc 分行 */
        var layer = layerOfProp(prop);
        var blockLoc = block.loc === undefined || block.loc === null ? "" : String(block.loc);
        var comment = metaTextOf(prop, layer);
        var meta = parseGraphMeta(comment);
        /* 注释里有托管标记但解析不出来 → 元数据不可信，不做任何改写 */
        if (!meta.ok && meta.plain !== comment) {
            return { status: "skipped", reason: "metadata_corrupt" };
        }

        var managed = [];
        var i;
        if (meta.ok) {
            for (i = 0; i < meta.entries.length; i++) {
                var found = meta.entries[i];
                if (Math.abs(found.startTime - startTime) > TIME_EPS) continue;
                if (found.loc && blockLoc && found.loc !== blockLoc) continue;
                managed = found.managedTimes;
                break;
            }
        }

        /* 原生中间键保护：区间内每个中间键都必须在托管清单里 */
        var k;
        for (k = startKey + 1; k < endKey; k++) {
            if (!inTimes(managed, num(prop.keyTime(k)))) {
                return { status: "skipped", reason: "native_intermediate" };
            }
        }

        var dims = 1;
        try {
            dims = valueDims(prop.value);
        } catch (e3) {}

        /* 1) 删旧的托管键（从后往前，避免索引位移） */
        var stale = [];
        for (i = 0; i < managed.length; i++) {
            var at = findKeyIndexByTime(prop, managed[i]);
            if (at > 0 && at > startKey && at < endKey) stale.push(at);
        }
        removeKeysSafely(prop, stale);

        /* 2) 端点按时间重新定位（删键之后索引会变） */
        var sIdx = findKeyIndexByTime(prop, startTime);
        var eIdx = findKeyIndexByTime(prop, endTime);
        if (!sIdx || !eIdx) return { status: "skipped", reason: "endpoint_missing" };

        /* 3) 按节点重建中间键
           端点值必须在插入前取一次：每插入一个中间键，后面的索引就位移一格，
           再按 eIdx 取值会取到刚插入的那个键。曾经因此在第二个中间节点上把
           0.9（=90）算成 9 —— 曲线形状没错、运动完全不对，且三项以内的图看不出来。 */
        var vStart = valueArr(prop.keyValue(sIdx));
        var vEnd = valueArr(prop.keyValue(eIdx));
        var created = [];
        for (i = 1; i + 1 < graph.nodes.length; i++) {
            var node = graph.nodes[i];
            var when = startTime + node.t * (endTime - startTime);
            try {
                prop.setValueAtTime(when, lerpValue(vStart, vEnd, node.v, dims));
                created.push(when);
            } catch (e4) {
                removeKeysSafely(prop, keyIndicesOf(prop, created));
                return { status: "skipped", reason: "key_create_failed" };
            }
        }

        /* 4) 逐段写 ease：每段两侧各写一次，和单曲线写入同一条路径 */
        var keys = parseKeyFromSnapshot(prop, dims);
        var complete = true;
        /* graph.nodes 的 0 是选区起点，但 keys 是整条属性。
           两者之间必须加上选区偏移，否则改第 3、4 个键时会写到第 1、2 个键。 */
        var graphOffset = sIdx - 1;
        for (i = 0; i + 1 < graph.nodes.length; i++) {
            var ease = G.segmentEase(graph, i);
            if (!ease) continue;
            var keyOut = graphOffset + i;
            var keyIn = graphOffset + i + 1;
            var rOut = writeSide(prop, keys, keyOut, "out", ease.infOut, ease.mOut, dims, keyOut + 1);
            var rIn = writeSide(prop, keys, keyIn, "in", ease.infIn, ease.mIn, dims, keyIn + 1);
            if (rOut !== "ok" && rOut !== "edge") complete = false;
            if (rIn !== "ok" && rIn !== "edge") complete = false;
        }

        /* 5) 写托管元数据；失败就把刚建的键删掉并还原注释 */
        var others = [];
        if (meta.ok) {
            for (i = 0; i < meta.entries.length; i++) {
                var keep = meta.entries[i];
                var sameLoc = !keep.loc || !blockLoc || keep.loc === blockLoc;
                var sameTime = Math.abs(keep.startTime - startTime) <= TIME_EPS;
                if (!(sameLoc && sameTime)) others.push(keep);
            }
        }
        others.push({
            loc: blockLoc,
            startTime: startTime,
            endTime: endTime,
            signature: "",
            mode: graph.propertyMode,
            startKey: sIdx,
            stamp: new Date().getTime(),
            complete: complete,
            managedTimes: created,
            nodes: graph.nodes
        });

        try {
            setMetaText(prop, layer, mergeGraphMeta(comment, others));
        } catch (e5) {
            removeKeysSafely(prop, keyIndicesOf(prop, created));
            try {
                setMetaText(prop, layer, comment);
            } catch (e6) {}
            return { status: "skipped", reason: "metadata_write_failed" };
        }

        /* 写完必须能读回托管块。读不回来说明这条路径不持久 —— 此时
           刚建的关键帧会变成「无主键」，下次写入时会被当成用户的原生键，
           整条属性再也改不动。宁可回滚，也不留下一堆无主关键帧。 */
        var verify = metaTextOf(prop, layer);
        if (verify.indexOf(META_OPEN) < 0 || verify.indexOf(META_CLOSE) < 0) {
            removeKeysSafely(prop, keyIndicesOf(prop, created));
            try {
                setMetaText(prop, layer, comment);
            } catch (e8) {}
            return { status: "skipped", reason: "metadata_write_failed" };
        }

        if (!complete) {
            return {
                status: "skipped",
                reason: "ease_write_failed",
                graph: graph,
                managedTimes: created,
                complete: false
            };
        }
        return {
            status: "ok",
            graph: graph,
            managedTimes: created,
            complete: true
        };
    }

    function keyIndicesOf(prop, times) {
        var out = [];
        for (var i = 0; i < times.length; i++) {
            var k = findKeyIndexByTime(prop, times[i]);
            if (k > 0) out.push(k);
        }
        return out;
    }

    /* ---------- 快捷工具：换键 / 冻结 ---------- */

    function selectedKeyList(prop) {
        var out = [];
        var sel = null;
        try {
            sel = prop.selectedKeys;
        } catch (e) {
            return out;
        }
        if (!sel || typeof sel.length !== "number") return out;
        var nk = 0;
        try {
            nk = prop.numKeys;
        } catch (e2) {}
        for (var i = 0; i < sel.length; i++) {
            var k = Number(sel[i]);
            if (k >= 1 && k <= nk) out.push(k);
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    function easeSnapshot(prop, k, side) {
        var raw = null;
        try {
            raw = side === "in" ? prop.keyInTemporalEase(k) : prop.keyOutTemporalEase(k);
        } catch (e) {}
        var out = [];
        if (isArr(raw)) {
            for (var i = 0; i < raw.length; i++) {
                out.push({ speed: num(raw[i].speed), influence: num(raw[i].influence) });
            }
        }
        return out;
    }

    function applyEaseSnapshot(prop, k, side, list) {
        if (!list || !list.length) return;
        var arr = [];
        for (var i = 0; i < list.length; i++) arr.push(makeEase(list[i].speed, list[i].influence));
        try {
            if (side === "in") {
                prop.setTemporalEaseAtKey(k, arr, currentEase(prop, k, "out", arr.length, isSpatialProp(prop)));
            } else {
                prop.setTemporalEaseAtKey(k, currentEase(prop, k, "in", arr.length, isSpatialProp(prop)), arr);
            }
        } catch (e) {}
    }

    function tangentSnapshot(prop, k, dims) {
        if (!isSpatialProp(prop)) return null;
        return {
            incoming: tangentsOf(prop, k, "in", dims),
            outgoing: tangentsOf(prop, k, "out", dims)
        };
    }

    function applyTangentSnapshot(prop, k, snapshot, dims) {
        if (!isSpatialProp(prop)) return true;
        var n = dims > 3 ? dims : 3;
        var inTans = [];
        var outTans = [];
        var i;
        for (i = 0; i < n; i++) {
            inTans.push(snapshot && snapshot.incoming ? num(at(snapshot.incoming, i, 0)) : 0);
            outTans.push(snapshot && snapshot.outgoing ? num(at(snapshot.outgoing, i, 0)) : 0);
        }
        try {
            prop.setSpatialTangentsAtKey(k, inTans, outTans);
            try {
                prop.setSpatialAutoBezierAtKey(k, false);
            } catch (e2) {}
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 交换 / 冻结。选区信息拿不到时返回 selection_unavailable ——
     * 绝不退化成「删键」或「加键」。
     */
    function applyQuickTool(prop, tool) {
        var picked = selectedKeyList(prop);
        if (!picked.length) return "selection_unavailable";

        var dims = 1;
        try {
            dims = valueDims(prop.value);
        } catch (e) {}

        if (tool === "swap") {
            if (picked.length !== 2) return "selection_unavailable";
            var k1 = picked[0];
            var k2 = picked[1];
            var t1 = prop.keyTime(k1);
            var t2 = prop.keyTime(k2);
            var v1 = valueArr(prop.keyValue(k1));
            var v2 = valueArr(prop.keyValue(k2));

            var in1 = easeSnapshot(prop, k1, "in");
            var out1 = easeSnapshot(prop, k1, "out");
            var in2 = easeSnapshot(prop, k2, "in");
            var out2 = easeSnapshot(prop, k2, "out");
            var tan1 = tangentSnapshot(prop, k1, dims);
            var tan2 = tangentSnapshot(prop, k2, dims);

            var tin1 = typeCode(prop.keyInInterpolationType(k1));
            var tout1 = typeCode(prop.keyOutInterpolationType(k1));
            var tin2 = typeCode(prop.keyInInterpolationType(k2));
            var tout2 = typeCode(prop.keyOutInterpolationType(k2));

            try {
                prop.setValueAtTime(t1, dims === 1 ? num(v2[0]) : v2);
                prop.setValueAtTime(t2, dims === 1 ? num(v1[0]) : v1);
                prop.setInterpolationTypeAtKey(k1, typeConst(tin2), typeConst(tout2));
                prop.setInterpolationTypeAtKey(k2, typeConst(tin1), typeConst(tout1));
            } catch (e2) {
                return "failed";
            }
            applyEaseSnapshot(prop, k1, "in", in2);
            applyEaseSnapshot(prop, k1, "out", out2);
            applyEaseSnapshot(prop, k2, "in", in1);
            applyEaseSnapshot(prop, k2, "out", out1);
            var swappedTangents =
                applyTangentSnapshot(prop, k1, tan2, dims) &&
                applyTangentSnapshot(prop, k2, tan1, dims);
            return swappedTangents ? "ok" : "failed";
        }

        if (tool === "freeze_left" || tool === "freeze_right") {
            if (picked.length < 2) return "selection_unavailable";
            var src = tool === "freeze_left" ? picked[0] : picked[picked.length - 1];
            var value = valueArr(prop.keyValue(src));
            var written = 0;
            for (var i = 0; i < picked.length; i++) {
                if (picked[i] === src) continue;
                try {
                    prop.setValueAtTime(prop.keyTime(picked[i]), dims === 1 ? num(value[0]) : value);
                    written++;
                } catch (e3) {}
            }
            var zeroTangents = true;
            if (isSpatialProp(prop)) {
                for (var z = 0; z < picked.length; z++) {
                    if (!applyTangentSnapshot(prop, picked[z], null, dims)) {
                        zeroTangents = false;
                        break;
                    }
                }
            }
            return written > 0 && zeroTangents ? "ok" : "failed";
        }

        return "unknown_tool";
    }

    /** 脚本通道：按显式键号把一张图写进某段 */
    function applyGraphForPropertyJson(loc, startKey, endKey, graphText, expectSig) {
        var lines = [];
        var sig = String(expectSig === undefined || expectSig === null ? "" : expectSig);
        if (sig) lines.push(["expect", String(loc), sig].join("\t"));
        else lines.push("force");
        lines.push(withLoc(graphText, String(loc)));

        pendingGraphRange = {
            loc: String(loc),
            startKey: Number(startKey),
            endKey: Number(endKey)
        };
        var out;
        try {
            out = applyText(lines.join("\n"));
        } finally {
            pendingGraphRange = null;
        }
        return out;
    }

    /* ============================================================
     * 七、脚本通道：把预设套到当前选中属性
     *
     * 面板走的是「快照 → 逐条 op → applyText」，脚本侧（离线验证、批处理）
     * 没有面板那层，需要一条等价入口。刻意复用同一套 writePreset /
     * 指纹校验，这样无人值守的实机验证测到的就是面板真实走的路。
     * ============================================================ */

    function resultJson(fields) {
        var parts = [];
        for (var i = 0; i < fields.length; i++) {
            parts.push(jfield(fields[i][0], fields[i][1]));
        }
        return "{" + parts.join(",") + "}";
    }

    function skippedArray(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) out.push(jstr(list[i]));
        return "[" + out.join(",") + "]";
    }

    /**
     * presetId 为空 = 只读，不写（返回 loc / sig / 关键帧数）。
     * expectSig 非空时先比指纹，不一致返回 conflict —— 与面板同一逻辑。
     */
    function applyPresetToSelectionJson(presetId, expectSig) {
        var comp = activeComp();
        if (!comp) {
            return resultJson([["status", jstr("error")], ["reason", jstr("no_comp")]]);
        }
        var list = collect(comp);
        if (!list.length) {
            return resultJson([["status", jstr("error")], ["reason", jstr("no_property")]]);
        }

        var prop = list[0].prop;
        var loc = list[0].loc;
        var sig = propSignature(prop);
        var id = String(presetId === undefined || presetId === null ? "" : presetId);
        var keysCount = 0;
        try {
            keysCount = prop.numKeys;
        } catch (e0) {}

        if (id && expectSig && String(expectSig) !== sig) {
            return resultJson([
                ["status", jstr("conflict")],
                ["reason", jstr("changed")],
                ["loc", jstr(loc)],
                ["sig", jstr(sig)],
                ["expect", jstr(String(expectSig))]
            ]);
        }

        if (!id) {
            return resultJson([
                ["status", jstr("ok")],
                ["loc", jstr(loc)],
                ["sig", jstr(sig)],
                ["keys", String(keysCount)],
                ["applied", "0"]
            ]);
        }

        var preset = presetById(id);
        if (!preset) {
            return resultJson([
                ["status", jstr("error")],
                ["reason", jstr("unknown_preset")],
                ["preset", jstr(id)]
            ]);
        }

        var dims = 1;
        try {
            dims = valueDims(prop.value);
        } catch (e1) {}

        var keys = parseKeyFromSnapshot(prop, dims);
        var applied = 0;
        var skipped = [];
        var started = false;

        try {
            app.beginUndoGroup("DreamEngine 应用缓动预设");
            started = true;
        } catch (e2) {}

        for (var k = 0; k < keys.length; k++) {
            var r = "failed";
            try {
                r = writePreset(prop, keys, k, k + 1, preset, dims);
            } catch (e3) {
                r = "failed:" + e3.toString();
            }
            if (r === "ok") applied++;
            else skipped.push(r);
        }

        if (started) {
            try {
                app.endUndoGroup();
            } catch (e4) {}
        }

        return resultJson([
            ["status", jstr("ok")],
            ["loc", jstr(loc)],
            ["sig", jstr(propSignature(prop))],
            ["sigBefore", jstr(sig)],
            ["keys", String(keys.length)],
            ["applied", String(applied)],
            ["preset", jstr(id)],
            ["skipped", skippedArray(skipped)]
        ]);
    }

    /* ============================================================
     * 七、导出
     * ============================================================ */

    return {
        VERSION: VERSION,
        TYPE_LINEAR: TYPE_LINEAR,
        TYPE_BEZIER: TYPE_BEZIER,
        TYPE_HOLD: TYPE_HOLD,
        MIN_INFLUENCE: MIN_INFLUENCE,
        MAX_INFLUENCE: MAX_INFLUENCE,
        CALIBRATION: CALIBRATION,

        // 纯数学（node 测试直接用；实现见 curve_math.js）
        clamp: clamp,
        bezier1: M.bezier1,
        solveU: M.solveU,
        segmentOf: segmentOf,
        handles: M.handles,
        sampleValue: sampleValue,
        speedAt: speedAt,
        pathPoint: pathPoint,
        easeFromHandle: easeFromHandle,

        // AE 侧
        snapshotJson: snapshotJson,
        signatureText: signatureText,
        applyText: applyText,
        presetsJson: presetsJson,
        // 多点图：选区解析、托管元数据与回读
        readGraphJson: readGraphJson,
        readGraphForPropertyJson: readGraphForPropertyJson,
        applyGraphForPropertyJson: applyGraphForPropertyJson,
        parseGraphMeta: parseGraphMeta,
        mergeGraphMeta: mergeGraphMeta,
        resolveGraphKeys: resolveGraphKeys,
        // 脚本夹具用：拿到与面板完全一致的属性路径（避免夹具自己拼错）
        locOfProp: function (prop) {
            return locOf(prop, activeComp());
        },
        // 脚本通道（离线验证 / 批处理）：把预设套到当前选中的第一个动画属性
        applyPresetToSelectionJson: applyPresetToSelectionJson,
        activeComp: activeComp,
        // 标定夹具用：直接 dump 某个属性，不依赖用户在时间轴上的选中态
        // （脚本改选中态在 AE 2021 上有崩溃风险，夹具一律不碰）
        dumpPropJson: propJson
    };
})();
