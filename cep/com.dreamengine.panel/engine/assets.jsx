// ============================================================
// assets.jsx —— 标准素材
//
// 设计文档 §4.4 要求四套固定素材，一次配置长期复用。这里做成按需生成 + 会话内缓存：
//   photo  复合画面（底 + 色块 + 文字 + 高频细线）—— 默认场景，能同时体现
//          模糊、发光、变形、调色、锐化、噪波
//   text   纯文本层 —— 文本类效果专用（文本预设作用在非文本层上会静默失效）
//   solid  纯色 —— 少数只作用于纯色/背景的效果
//   shape  形状层（圆 + 星）—— 形状/描边/蒙版类
//   pattern 高对比黑白图案 —— 两层输入类（置换图/复合模糊/设置遮罩）当第二输入
//
// 为什么默认是 photo 而不是设计文档写的 solid-2d：
//   M1 实测发现纯色层上高斯模糊、锐化、噪波几乎看不出变化，
//   而多层复合素材能让绝大多数效果"看得出名堂"。这是按实测调整，不是偏离。
//
// 缓存策略：一轮生成内按 kind+size 复用同一个 comp；整轮结束后 dispose，
// 不把中间素材合成留在用户工程里。
//
// 语法：ES3 only。
// ============================================================

var AEV_Assets = (function () {
    var VERSION = "photo-v3";
    var cache = {};
    var temporaryDeps = [];

    function backgroundFingerprint(path) {
        var text = String(path || "");
        if (!text) return "default";
        var file = new File(text);
        if (!file.exists) return "missing";
        var modified = 0;
        try {
            modified = file.modified ? file.modified.getTime() : 0;
        } catch (e) {}
        return String(file.length || 0) + ":" + String(modified);
    }

    /**
     * 内置 photo 背景解析为随包默认图；其它专用素材仍返回空串，
     * 由各调用方继续走 text / solid / shape / pattern 的原有分支。
     */
    function resolveBackground(id, extensionPath) {
        if (String(id || "") !== "photo") return "";
        var root = String(extensionPath || "");
        if (!root) return "";
        var file = new File(root + "/assets/preview-default.png");
        return file.exists ? file.fsName : "";
    }

    function key(kind, size, background) {
        return kind + "@" + size + "@" + backgroundFingerprint(background);
    }

    /** 素材版本指纹：素材内容一变，所有基于它的缓存都必须失效 */
    function fingerprint() {
        return VERSION;
    }

    function existing(kind, size, background) {
        var k = key(kind, size, background);
        var cached = cache[k];
        if (cached && cached.item) {
            // comp 可能已被用户删除，确认还能用
            try {
                if (cached.item.numLayers >= 0) return cached.item;
            } catch (e) {}
        }
        return null;
    }

    function remember(kind, size, background, comp, deps) {
        cache[key(kind, size, background)] = { item: comp, deps: deps || [] };
        return comp;
    }

    /** 深色底 + 青色块 + 暖色块 + 文字 + 细线（高频细节） */
    function buildPhoto(size) {
        var scene = app.project.items.addComp("DE_asset_photo_" + size, size, size, 1, 1, 30);

        var bg = scene.layers.addSolid([0.055, 0.065, 0.075], "bg", size, size, 1);
        bg.moveToEnd();

        // 细线：给模糊/锐化/噪波这类效果提供高频内容，纯色块看不出这些效果
        var lineColor = [0.72, 0.76, 0.78];
        for (var i = 0; i < 5; i++) {
            var y = Math.round(size * (0.14 + i * 0.16));
            var line = scene.layers.addSolid(lineColor, "line" + i, size, 2, 1);
            line.property("ADBE Transform Group").property("ADBE Position")
                .setValue([Math.round(size * 0.5), y]);
        }

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

    /** 用用户图片替换通用 photo 素材；文字/形状等专用素材保持不变。 */
    function buildImportedPhoto(size, background) {
        var source = new File(String(background || ""));
        if (!source.exists) return null;

        var imported = null;
        try {
            var importOptions = new ImportOptions(source);
            importOptions.sequence = false;
            imported = app.project.importFile(importOptions);
        } catch (eImport) {
            return null;
        }
        if (!imported) return null;

        var scene = null;
        var layer = null;
        try {
            scene = app.project.items.addComp("DE_asset_photo_" + size, size, size, 1, 1, 30);
            layer = scene.layers.add(imported);
        } catch (eBuild) {
            try { imported.remove(); } catch (eCleanup) {}
            try { if (scene) scene.remove(); } catch (eScene) {}
            return null;
        }
        try {
            var width = Number(imported.width) || size;
            var height = Number(imported.height) || size;
            var scale = Math.max(size / width, size / height) * 100;
            layer.property("ADBE Transform Group").property("ADBE Scale").setValue([scale, scale]);
            layer.property("ADBE Transform Group").property("ADBE Position")
                .setValue([size / 2, size / 2]);
        } catch (eLayout) {}
        return { comp: scene, dep: imported };
    }

    function buildText(size) {
        var scene = app.project.items.addComp("DE_asset_text_" + size, size, size, 1, 1, 30);
        var bg = scene.layers.addSolid([0.07, 0.08, 0.09], "bg", size, size, 1);
        bg.moveToEnd();

        // 文字类预设必须只作用于一个文字图层；双文字层会让预设重复求值并铺满整帧。
        var title = scene.layers.addText("Dream\rEngine");
        var titleProp = title.property("ADBE Text Properties").property("ADBE Text Document");
        var titleDoc = titleProp.value;
        titleDoc.fontSize = Math.round(size * 0.22);
        titleDoc.fillColor = [0.93, 0.94, 0.9];
        titleProp.setValue(titleDoc);
        title.property("ADBE Transform Group").property("ADBE Position")
            .setValue([Math.round(size * 0.5), Math.round(size * 0.5)]);

        return scene;
    }

    /**
     * 文字图层内部保持预设应用时的原始文档状态；居中通过父级嵌套图层的
     * transform 完成，避免修改 TextDocument 后触发预设重新铺满整帧。
     */
    function centerTextAsset(asset, nested, size) {
        var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (var i = 1; i <= asset.numLayers; i++) {
            var layer = asset.layer(i);
            if (!(layer instanceof TextLayer)) continue;
            var rect = layer.sourceRectAtTime(0, false);
            var transform = layer.property("ADBE Transform Group");
            var position = transform.property("ADBE Position").value;
            var anchor = transform.property("ADBE Anchor Point").value;
            left = Math.min(left, position[0] + rect.left - anchor[0]);
            top = Math.min(top, position[1] + rect.top - anchor[1]);
            right = Math.max(right, position[0] + rect.left + rect.width - anchor[0]);
            bottom = Math.max(bottom, position[1] + rect.top + rect.height - anchor[1]);
        }
        if (left === Infinity) return;
        var nestedTransform = nested.property("ADBE Transform Group");
        var nestedAnchor = nestedTransform.property("ADBE Anchor Point").value;
        nestedTransform.property("ADBE Position").setValue([
            Math.round(size * 0.5) - (left + right) / 2 + nestedAnchor[0],
            Math.round(size * 0.5) - (top + bottom) / 2 + nestedAnchor[1]
        ]);
    }

    function buildSolid(size) {
        var scene = app.project.items.addComp("DE_asset_solid_" + size, size, size, 1, 1, 30);
        var base = scene.layers.addSolid([0.22, 0.42, 0.5], "base", size, size, 1);
        base.moveToEnd();
        return scene;
    }

    function buildShape(size) {
        var scene = app.project.items.addComp("DE_asset_shape_" + size, size, size, 1, 1, 30);
        var bg = scene.layers.addSolid([0.06, 0.07, 0.08], "bg", size, size, 1);
        bg.moveToEnd();

        // 用纯色层 + 蒙版模拟形状，避免依赖 shape layer API 的版本差异
        var body = scene.layers.addSolid([0.18, 0.68, 0.76], "body", size, size, 1);
        var mask = body.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        var shape = mask.property("ADBE Mask Shape");
        var radius = Math.round(size * 0.32);
        shape.setValue(ellipseAt(size * 0.5, size * 0.5, radius, radius));
        return scene;
    }

    /** 高对比黑白图案：黑底 + 白色竖条 + 白色中心圆。
     *  用途是给「置换图 / 复合模糊 / 设置遮罩」这类需要第二图层的效果当输入源——
     *  它按亮度工作，所以用竖条（水平方向高频）+ 中心圆（径向过渡）两种梯度，
     *  既能看到明显的位移量，也能看到边缘软硬。
     */
    function buildPattern(size) {
        var scene = app.project.items.addComp("DE_asset_pattern_" + size, size, size, 1, 1, 30);
        var bg = scene.layers.addSolid([0, 0, 0], "black", size, size, 1);
        bg.moveToEnd();

        var barW = Math.round(size * 0.08);
        var gap = Math.round(size * 0.14);
        var x = Math.round(size * 0.06);
        var barIndex = 0;
        while (x < size - barW) {
            var bar = scene.layers.addSolid([1, 1, 1], "bar" + barIndex, barW, size, 1);
            bar.property("ADBE Transform Group").property("ADBE Position")
                .setValue([x + Math.round(barW / 2), Math.round(size * 0.5)]);
            x += barW + gap;
            barIndex++;
        }

        // 中心白圆：径向亮暗过渡，让置换/模糊后的边缘更有可读性
        var disc = scene.layers.addSolid([1, 1, 1], "disc", size, size, 1);
        var mask = disc.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        var radius = Math.round(size * 0.2);
        mask.property("ADBE Mask Shape").setValue(ellipseAt(size * 0.5, size * 0.5, radius, radius));

        return scene;
    }

    function ellipseAt(cx, cy, rx, ry) {        var k = 0.5523;
        var shape = new Shape();
        shape.vertices = [
            [cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]
        ];
        shape.inTangents = [
            [k * rx, 0], [0, k * ry], [-k * rx, 0], [0, -k * ry]
        ];
        shape.outTangents = [
            [-k * rx, 0], [0, -k * ry], [k * rx, 0], [0, k * ry]
        ];
        shape.closed = true;
        return shape;
    }

    /**
     * 取（必要时生成）指定类型的标准素材。
     * kind: "photo" | "text" | "solid" | "shape" | "pattern"
     */
    function get(kind, size, background) {
        var resolvedSize = size || 256;
        var resolvedKind = kind || "photo";
        var cached = existing(resolvedKind, resolvedSize, background);
        if (cached) return cached;

        var comp;
        var deps = [];
        if (resolvedKind === "photo" && background) {
            var custom = buildImportedPhoto(resolvedSize, background);
            if (custom) {
                comp = custom.comp;
                deps.push(custom.dep);
            }
        }
        if (comp) return remember(resolvedKind, resolvedSize, background, comp, deps);
        if (resolvedKind === "text") comp = buildText(resolvedSize);
        else if (resolvedKind === "solid") comp = buildSolid(resolvedSize);
        else if (resolvedKind === "shape") comp = buildShape(resolvedSize);
        else if (resolvedKind === "pattern") comp = buildPattern(resolvedSize);
        else comp = buildPhoto(resolvedSize);

        return remember(resolvedKind, resolvedSize, background, comp, deps);
    }

    /**
     * 新建一份独立素材（不进缓存）。
     *
     * 为什么需要：AE 会缓存嵌套合成 comp 的渲染帧。同一个素材 comp 被反复引用时，
     * 后一次渲染可能直接复用上一次的缓存帧 —— 表现为「效果明明加上了，
     * 渲出来的画面却和没加效果一模一样」（实测：singleCell 下带效果与裸素材
     * 逐像素相同）。
     *
     * 逐条渲染插件效果时，每条都用一份独立素材，保证每次都是首次求值。
     */
    function getFresh(kind, size, background) {
        var resolvedSize = size || 256;
        var resolvedKind = kind || "photo";
        if (resolvedKind === "photo" && background) {
            var custom = buildImportedPhoto(resolvedSize, background);
            if (custom) {
                temporaryDeps.push(custom.dep);
                return custom.comp;
            }
        }
        if (resolvedKind === "text") return buildText(resolvedSize);
        if (resolvedKind === "solid") return buildSolid(resolvedSize);
        if (resolvedKind === "shape") return buildShape(resolvedSize);
        if (resolvedKind === "pattern") return buildPattern(resolvedSize);
        return buildPhoto(resolvedSize);
    }

    /** 新工程/换项目后清空缓存 */
    function clear() {
        cache = {};
        temporaryDeps = [];
    }

    /** 删除本次进程创建的标准素材 comp，并清空引用缓存 */
    function dispose() {
        var removed = 0;
        for (var keyName in cache) {
            if (!cache.hasOwnProperty(keyName)) continue;
            var entry = cache[keyName];
            if (!entry || !entry.item) continue;
            try {
                entry.item.remove();
                removed++;
            } catch (e) {}
            for (var d = 0; d < (entry.deps || []).length; d++) {
                try {
                    entry.deps[d].remove();
                    removed++;
                } catch (eDep) {}
            }
        }
        for (var t = 0; t < temporaryDeps.length; t++) {
            try {
                temporaryDeps[t].remove();
                removed++;
            } catch (eTemp) {}
        }
        cache = {};
        temporaryDeps = [];
        return removed;
    }

    return {
        VERSION: VERSION,
        fingerprint: fingerprint,
        backgroundFingerprint: backgroundFingerprint,
        resolveBackground: resolveBackground,
        get: get,
        getFresh: getFresh,
        centerTextAsset: centerTextAsset,
        clear: clear,
        dispose: dispose
    };
})();
