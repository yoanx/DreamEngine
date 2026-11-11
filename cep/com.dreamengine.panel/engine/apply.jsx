// ============================================================
// apply.jsx —— 把预览里的效果直接加到 AE 当前选中的图层上
//
// 用途：面板上双击一张预览卡片 → 效果落到用户在 AE 里选中的图层。
//
// 依据的实机结论（AE 2021）：
//   · app.project.items.getItemByName 会崩 AE → 只遍历 items
//   · app.project.activeItem 未必是合成 → 两条路都找
//   · 给 comp.selectedLayers 赋值会崩 AE → 只读取，不赋值
//   · 应用到用户图层时只 addProperty：预览配方、手动覆盖参数和启发式
//     都只服务于预览，不能写进用户工程
//   · 给插件效果写任何参数都会让整条效果废掉（报「需要数字、数组或
//     属性的位置找到类型为 Error 的对象」）
//
// 不做的事：不套配方、不写参数、不打关键帧。
//   关键帧是缩略图用来「演一遍」的，落到用户图层上会污染时间线；
//   启发式会把颜色改成橙色、模糊改一半，在真实图层上是破坏性的。
//
// 语法：ES3 only。
// ============================================================

var AEV_Apply = (function () {
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

    /**
     * 判断 item 是不是合成。
     *
     * AE 2021 的 typeName 是本地化的（「合成」），不能做字符串比较；
     * 改成看有没有 numLayers。
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
     * 找当前该往哪个合成上加效果。
     *
     * 先看 app.project.activeItem（用户在时间轴里点着某个合成时它就是合成）；
     * 拿不到就遍历工程里的所有合成，找**有选中图层**的那个。
     */
    function activeComp() {
        var active = null;
        try {
            active = app.project.activeItem;
        } catch (e) {}
        if (isComp(active)) return active;

        var items = null;
        try {
            items = app.project.items;
        } catch (e2) {
            return null;
        }
        for (var i = 1; i <= items.length; i++) {
            var item = null;
            try {
                item = items[i];
            } catch (e3) {
                continue;
            }
            if (!isComp(item)) continue;
            if (selectedLayerIndex(item)) return item;
        }
        return null;
    }

    /**
     * 选中图层在合成里的序号（1 起）；0 表示没有选中。
     *
     * 只读 comp.selectedLayers（读是安全的，赋值才崩）；读不到再逐层
     * 看 layer.selected。
     */
    function selectedLayerIndex(comp) {
        if (!comp) return 0;
        var list = null;
        try {
            list = comp.selectedLayers;
        } catch (e) {}
        if (list && list.length > 0) {
            try {
                return Number(list[0].index) || 0;
            } catch (e2) {}
        }
        try {
            for (var i = 1; i <= comp.numLayers; i++) {
                var layer = null;
                try {
                    layer = comp.layer(i);
                } catch (e3) {
                    continue;
                }
                if (layer && layer.selected) return i;
            }
        } catch (e4) {}
        return 0;
    }

    /**
     * 把 matchName 对应的效果加到当前选中图层。
     *
     * 返回 JSON：
     *   {status:"ok", effect, comp, layer, mode}
     *   {status:"error", reason:"no_comp"|"no_layer"|"add_failed", ...}
     * mode: "default"（原始效果，参数一个没动）
     */
    function addToSelectedJson(matchName) {
        var name = String(matchName || "");
        if (!name) {
            return result("error", [["reason", "empty_match_name"]]);
        }

        var comp = activeComp();
        if (!comp) {
            return result("error", [["reason", "no_comp"]]);
        }
        var layerIndex = selectedLayerIndex(comp);
        if (!layerIndex) {
            return result("error", [["reason", "no_layer"], ["comp", String(comp.name)]]);
        }

        var layer = null;
        try {
            layer = comp.layer(layerIndex);
        } catch (e) {}
        if (!layer) {
            return result("error", [["reason", "no_layer"], ["comp", String(comp.name)]]);
        }

        var group = null;
        try {
            group = layer.property("ADBE Effect Parade");
        } catch (e2) {}
        if (!group) {
            return result("error", [["reason", "no_effect_parade"]]);
        }

        var effect = null;
        try {
            effect = group.addProperty(name);
        } catch (e3) {
            return result("error", [
                ["reason", "add_failed"],
                ["effect", name],
                ["detail", String(e3)]
            ]);
        }
        if (!effect) {
            return result("error", [["reason", "add_failed"], ["effect", name]]);
        }

        var mode = "default";

        var layerName = "";
        try {
            layerName = String(layer.name || "");
        } catch (e6) {}

        return result("ok", [
            ["effect", name],
            ["comp", String(comp.name)],
            ["layer", layerName],
            ["mode", mode]
        ]);
    }

    /** 当前上下文的快照：面板用来在双击前提示「会加到哪一层」 */
    function contextJson() {
        var comp = activeComp();
        if (!comp) return result("error", [["reason", "no_comp"]]);
        var layerIndex = selectedLayerIndex(comp);
        var layerName = "";
        if (layerIndex) {
            try {
                layerName = String(comp.layer(layerIndex).name || "");
            } catch (e) {}
        }
        return result("ok", [
            ["comp", String(comp.name)],
            ["layer", layerName],
            ["layerIndex", String(layerIndex)]
        ]);
    }

    return {
        addToSelectedJson: addToSelectedJson,
        contextJson: contextJson,
        isComp: isComp
    };
})();
